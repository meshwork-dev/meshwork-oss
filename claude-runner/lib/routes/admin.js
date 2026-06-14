// admin.js — routes/admin routes
// Extracted from runner.js.

const fs = require("fs");
const path = require("path");
const db = require("../../db");
const { FAILED_CALLBACKS_DIR, SECRET, config } = require("../config");
const {
  listPipelineDefinitions,
  savePipelineDefinition,
  deletePipelineDefinition,
  listPipelineRoutingRules,
  savePipelineRoutingRules,
  BUILTIN_NAMES,
} = require("../pipeline-definitions");
const { checkBudget, metrics, skillUsage, trackSkillUsage } = require("../metrics");
const { requireSecret } = require("../middleware");
const {
  countSkillDirs,
  products,
  productsDir,
  resolveAgentSkills,
  resolvePluginDir,
  resolveSharedSkillsDir,
} = require("../products");
const { getTotalRunningCount, jobs, jobEmitter, pipelines, queue, runningByProduct } = require("../state");
const { nowIso, postJson } = require("../util");
const { RUNNER_ROOT } = require("../config");
const { createJob, enqueue } = require("../worker");
const {
  getProviders,
  getProvider,
  upsertProvider,
  deleteProvider,
  setProviderApiKey,
  hasProviderApiKey,
  resolveApiKey,
  listAgentRouting,
  upsertAgentRouting,
  deleteAgentRouting,
} = require("../provider-store");


function registerAdminRoutes(app) {
  /**
   * PRODUCT REGISTRY ENDPOINTS
   */
  app.get("/api/products", requireSecret, (_req, res) => {
    const list = [];
    for (const [id, p] of products) {
      list.push({
        id,
        name: p.name,
        description: p.description,
        workingDir: p.workingDir,
        pluginDir: p.pluginDir || null,
        projectKey: p.jira?.projectKey || null,
      });
    }
    res.json(list);
  });

  /**
   * GET /api/products/:id/agents - List agents scoped to a single product's pluginDir.
   * Reads <pluginDir>/agents/*.md (excluding _deprecated). Model info comes from
   * the platform routing map so tier/colour logic in the UI stays consistent.
   */
  app.get("/api/products/:id/agents", requireSecret, (req, res) => {
    const { id } = req.params;
    const product = products.get(id);
    if (!product) return res.status(404).json({ ok: false, error: `Product '${id}' not found` });

    const pluginDir = resolvePluginDir(product);
    const agentsDir = path.join(pluginDir, 'agents');
    const routing = config.routing || {};
    const agentToModel = routing.agentToModel || {};
    const agentToProvider = routing.agentToProvider || {};
    const teamLeads = (config.teams?.enabled && config.teams.teamLeads) || {};

    let files = [];
    try {
      files = fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter(d => d.isFile() && d.name.endsWith('.md'))
        .map(d => d.name.replace(/\.md$/, ''));
    } catch (e) {
      return res.json({ ok: true, product: id, agents: [] });
    }

    const agents = files.map(name => {
      const leadConfig = teamLeads[name];
      return {
        name,
        model: agentToModel[name] || "sonnet",
        provider: agentToProvider[name] || "claude",
        isTeamLead: !!leadConfig,
        teammates: leadConfig?.teammates || [],
      };
    });

    res.json({ ok: true, product: id, agents });
  });

  app.post("/api/products/:id/reload", requireSecret, (req, res) => {
    const { id } = req.params;
    const configPath = path.join(productsDir, id, "product.json");
    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ error: `Product '${id}' not found at ${configPath}` });
    }
    try {
      const product = JSON.parse(fs.readFileSync(configPath, "utf8"));
      products.set(id, product);
      res.json({ ok: true, id, name: product.name });
    } catch (e) {
      res.status(500).json({ error: `Failed to reload product '${id}': ${e.message}` });
    }
  });

  /**
   * POST /api/products/onboard — dispatch a product-onboarder Claude job from pre-collected form data.
   * The agent writes products/<id>/product.json and <id>-plugin/ non-interactively.
   * Returns { ok, jobId, productId } immediately; track progress via GET /jobs/:id/log/stream.
   */
  app.post("/api/products/onboard", requireSecret, (req, res) => {
    const body = req.body || {};

    const name = (body.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name is required" });

    const workingDir = (body.workingDir || "").trim();
    if (!workingDir) return res.status(400).json({ ok: false, error: "workingDir is required" });

    // Derive product id: lowercase, hyphens only
    const productId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!productId) return res.status(400).json({ ok: false, error: "could not derive a valid product id from name" });

    // Reject if product already exists
    const existingConfig = path.join(productsDir, productId, "product.json");
    if (fs.existsSync(existingConfig)) {
      return res.status(409).json({ ok: false, error: `Product '${productId}' already exists`, productId });
    }

    // The onboarder agent runs in the platform root so it can write to products/ and <id>-plugin/
    const platformRoot = path.resolve(RUNNER_ROOT, "..");

    const productData = { ...body, id: productId };
    const prompt = `PRODUCT_DATA:\n${JSON.stringify(productData, null, 2)}\n\nGenerate the full product scaffold for product id "${productId}" as described in your instructions. Write all files relative to the current working directory (${platformRoot}).`;

    const job = createJob({
      mode: "agent",
      jobIn: { agent: "product-onboarder", prompt, source: "ui-onboard" },
      callbackUrl: null,
      fields: {
        agent: "product-onboarder",
        prompt,
        context: "",
        workingDir: platformRoot,
        issueKey: null,
        _onboardProductId: productId,
      },
    });

    enqueue(job.jobId);

    res.json({ ok: true, jobId: job.jobId, productId });
  });

  // Auto-reload the product registry after a successful onboard job
  jobEmitter.on("job:succeeded", (event) => {
    const job = jobs.get(event.jobId);
    if (!job || job.agent !== "product-onboarder" || !job._onboardProductId) return;
    const productId = job._onboardProductId;
    const configPath = path.join(productsDir, productId, "product.json");
    if (!fs.existsSync(configPath)) return;
    try {
      const product = JSON.parse(fs.readFileSync(configPath, "utf8"));
      products.set(productId, product);
      console.log(`[${nowIso()}] Auto-registered product '${productId}' after onboarding job ${event.jobId}`);
    } catch (e) {
      console.error(`[${nowIso()}] Failed to auto-register product '${productId}': ${e.message}`);
    }
  });

  /**
   * CONTEXT BUDGET: show what skills each agent would load (optimized vs full)
   */
  app.get("/api/context-budget", requireSecret, (req, res) => {
    const productId = req.query.product;
    const agentFilter = req.query.agent;

    const results = [];
    const targetProducts = productId ? [products.get(productId)].filter(Boolean) : [...products.values()];

    for (const product of targetProducts) {
      const pluginDir = resolvePluginDir(product);
      const sharedDir = resolveSharedSkillsDir();
      const totalSkills = countSkillDirs(pluginDir, sharedDir);

      const agentsDir = path.join(pluginDir, 'agents');
      let agentFiles = [];
      try { agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')); } catch {}

      for (const file of agentFiles) {
        const name = file.replace('.md', '');
        if (agentFilter && name !== agentFilter) continue;

        const agentPath = path.join(agentsDir, file);
        const resolved = resolveAgentSkills(name, product);

        results.push({
          product: product.id,
          agent: name,
          declared: resolved ? resolved.skills.length : null,
          total: totalSkills,
          savings: resolved ? `${Math.round((1 - resolved.skills.length / totalSkills) * 100)}%` : '0%',
          skills: resolved?.skills || null,
          context: resolved?.context || null,
          optimized: !!resolved,
        });
      }
    }

    res.json({ agents: results, summary: {
      total: results.length,
      optimized: results.filter(r => r.optimized).length,
      unoptimized: results.filter(r => !r.optimized).length,
    }});
  });

  /**
   * METRICS & STATS ENDPOINTS (Phase 1.5, 4.3)
   */
  app.get("/api/stats", requireSecret, async (req, res) => {
    const now = Date.now();
    let runningJobs = 0;
    let queuedJobs = 0;
    let recentSucceeded = 0;
    let recentFailed = 0;
    const oneHourAgo = now - (60 * 60 * 1000);

    for (const job of jobs.values()) {
      if (job.status === "running") runningJobs++;
      if (job.status === "queued" || job.status === "retry-pending") queuedJobs++;
      if (job.finishedAt && new Date(job.finishedAt).getTime() > oneHourAgo) {
        if (job.status === "succeeded") recentSucceeded++;
        if (job.status === "failed") recentFailed++;
      }
    }

    const totalJobs = await db.jobs.count().catch(() => jobs.size);

    // Pipeline stats
    let activePipelines = 0;
    let completedPipelines = 0;
    let failedPipelines = 0;
    let pipelineTotalCost = 0;

    for (const pipeline of pipelines.values()) {
      if (pipeline.status === "running") activePipelines++;
      else if (pipeline.status === "completed") completedPipelines++;
      else if (pipeline.status === "failed") failedPipelines++;

      // Sum costs from all phase jobs (active jobs only in cache)
      for (const phase of pipeline.phases) {
        if (phase.jobId) {
          const phaseJob = jobs.get(phase.jobId);
          if (phaseJob) {
            pipelineTotalCost += phaseJob.usage?.estimatedCostUsd || phaseJob.estimatedCostUsd || 0;
          }
        }
      }
    }

    res.json({
      ok: true,
      stats: {
        running: runningJobs,
        queued: queuedJobs,
        totalJobs,
        recentSucceeded,
        recentFailed,
        metrics: {
          totalTokens: metrics.tokens.input + metrics.tokens.output,
          inputTokens: metrics.tokens.input,
          outputTokens: metrics.tokens.output,
          totalCostUsd: Math.round(metrics.costs.total * 100) / 100,
          avgLatencyMs: metrics.latency.count > 0 ? Math.round(metrics.latency.sum / metrics.latency.count) : 0
        },
        byAgent: metrics.byAgent,
        byProduct: metrics.byProduct,
        chrome: {
          sessionsEnabled: metrics.chrome.sessionsEnabled,
          sessionsUsed: metrics.chrome.sessionsUsed,
          toolCalls: metrics.chrome.toolCalls,
          byTool: metrics.chrome.byTool
        },
        pipelines: {
          active: activePipelines,
          completed: completedPipelines,
          failed: failedPipelines,
          total: pipelines.size,
          totalCostUsd: Math.round(pipelineTotalCost * 100) / 100,
        },
        preRead: metrics.preRead || { total: 0, succeeded: 0, failed: 0, skipped: 0, totalCharsRead: 0, totalCharsSummary: 0 },
        hybridTeam: metrics.hybridTeam || { runs: 0, localRuns: 0, cloudRuns: 0, filesWritten: 0, fallbacks: 0 },
      }
    });
  });

  app.get("/api/metrics", requireSecret, async (req, res) => {
    // Load metrics from DB if in-memory is empty
    if (!metrics.jobs || metrics.jobs.total === 0) {
      try {
        const dbMetrics = await db.metrics.get();
        if (dbMetrics) Object.assign(metrics, dbMetrics);
      } catch { /* use in-memory */ }
    }
    // Merge in-memory pipelines with DB pipelines for byPipeline stats
    let allPipelinesForMetrics;
    try {
      allPipelinesForMetrics = await db.pipelines.listAll();
      for (const [id, p] of pipelines) {
        if (!allPipelinesForMetrics.find(x => x.pipelineId === id)) allPipelinesForMetrics.push(p);
      }
    } catch {
      allPipelinesForMetrics = Array.from(pipelines.values());
    }
    const byPipeline = {};
    for (const pipeline of allPipelinesForMetrics) {
      const pt = pipeline.pipelineType;
      if (!byPipeline[pt]) {
        byPipeline[pt] = { total: 0, completed: 0, failed: 0, avgPhases: 0, totalCost: 0 };
      }
      byPipeline[pt].total++;
      if (pipeline.status === "completed") byPipeline[pt].completed++;
      if (pipeline.status === "failed") byPipeline[pt].failed++;

      let cost = 0;
      for (const phase of pipeline.phases) {
        if (phase.jobId) {
          const phaseJob = jobs.get(phase.jobId);
          if (phaseJob) cost += phaseJob.usage?.estimatedCostUsd || phaseJob.estimatedCostUsd || 0;
        }
      }
      byPipeline[pt].totalCost += cost;
      byPipeline[pt].avgPhases = Math.round(
        (byPipeline[pt].avgPhases * (byPipeline[pt].total - 1) + pipeline.phases.filter(p => p.status !== "skipped").length) / byPipeline[pt].total
      );
    }

    res.json({
      ok: true,
      metrics: {
        ...metrics,
        avgLatencyMs: metrics.latency.count > 0 ? Math.round(metrics.latency.sum / metrics.latency.count) : 0,
        byPipeline
      }
    });
  });

  /**
   * GET /api/skill-usage
   * Returns skill usage telemetry tracked from Claude CLI stream output.
   * Optional ?skill=<name> filter to return data for a single skill.
   *
   * Response shape:
   *   { ok: true, skillUsage: { [skillName]: { reads, scriptRuns, lastUsed, byAgent } } }
   */
  app.get("/api/skill-usage", requireSecret, async (req, res) => {
    const filter = req.query.skill;
    if (filter) {
      const entry = skillUsage[filter];
      if (entry) return res.json({ ok: true, skillUsage: { [filter]: entry } });
      // Fall back to DB
      try {
        const dbAll = await db.skillUsage.getAll();
        if (dbAll[filter]) return res.json({ ok: true, skillUsage: { [filter]: dbAll[filter] } });
      } catch { /* fall through */ }
      return res.status(404).json({ ok: false, error: `No telemetry for skill: ${filter}` });
    }
    // Return in-memory; fall back to DB if empty
    if (Object.keys(skillUsage).length > 0) {
      return res.json({ ok: true, skillUsage });
    }
    try {
      const dbAll = await db.skillUsage.getAll();
      return res.json({ ok: true, skillUsage: dbAll });
    } catch {
      return res.json({ ok: true, skillUsage });
    }
  });

  /**
   * POST /api/skill-usage
   * Ingest skill usage events from external sources (e.g. admin bot agent chats).
   * Body: { events: [{ skillName, eventType: "read"|"scriptRun", agentName }] }
   */
  app.post("/api/skill-usage", requireSecret, (req, res) => {
    const { events } = req.body || {};
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ ok: false, error: "events array required" });
    }
    let tracked = 0;
    for (const evt of events) {
      if (evt.skillName && evt.eventType && evt.agentName) {
        trackSkillUsage(evt.skillName, evt.eventType, evt.agentName);
        tracked++;
      }
    }
    res.json({ ok: true, tracked });
  });

  /**
   * ============================================================
   * FAILED CALLBACK REPLAY ENDPOINTS (Phase 1.4)
   * ============================================================
   */
  app.get("/api/failed-callbacks", requireSecret, (req, res) => {
    try {
      const files = fs.readdirSync(FAILED_CALLBACKS_DIR).filter(f => f.endsWith(".json"));
      const callbacks = files.map(f => {
        try {
          return JSON.parse(fs.readFileSync(path.join(FAILED_CALLBACKS_DIR, f), "utf8"));
        } catch { return null; }
      }).filter(Boolean);
      res.json({ ok: true, failedCallbacks: callbacks });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/failed-callbacks/:id/replay", requireSecret, async (req, res) => {
    const filePath = path.join(FAILED_CALLBACKS_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: "Failed callback not found" });
    }

    try {
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const headers = {};
      if (SECRET) headers["X-Runner-Secret"] = SECRET;
      const resp = await postJson(record.url, record.payload, headers);

      if (resp.statusCode >= 200 && resp.statusCode < 500) {
        fs.unlinkSync(filePath);
        return res.json({ ok: true, statusCode: resp.statusCode, message: "Replayed and removed" });
      }
      res.status(502).json({ ok: false, error: `Replay returned ${resp.statusCode}` });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.delete("/api/failed-callbacks/:id", requireSecret, (req, res) => {
    const filePath = path.join(FAILED_CALLBACKS_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: "Failed callback not found" });
    }
    fs.unlinkSync(filePath);
    res.json({ ok: true, message: "Dismissed" });
  });

  /**
   * ============================================================
   * PM TELEMETRY DIGEST ENDPOINT (Phase 4.1)
   * Curated summary for the PM agent: jobs, success rates,
   * cost trends, quality gate pass rates, stalled jobs.
   * ============================================================
   */
  app.get("/api/pm-digest", requireSecret, (req, res) => {
    const now = Date.now();
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);

    let last24h = { total: 0, succeeded: 0, failed: 0, costUsd: 0 };
    let lastWeek = { total: 0, succeeded: 0, failed: 0, costUsd: 0 };
    let qualityGateStats = { total: 0, passed: 0, failed: 0 };
    const stalledJobs = [];
    const agentPerformance = {};

    for (const job of jobs.values()) {
      const created = new Date(job.createdAt).getTime();
      const isLast24h = created > oneDayAgo;
      const isLastWeek = created > oneWeekAgo;

      if (isLast24h) {
        last24h.total++;
        if (job.status === "succeeded") last24h.succeeded++;
        if (job.status === "failed" || job.status === "quality-gate-failed") last24h.failed++;
        last24h.costUsd += job.usage?.estimatedCostUsd || 0;
      }

      if (isLastWeek) {
        lastWeek.total++;
        if (job.status === "succeeded") lastWeek.succeeded++;
        if (job.status === "failed" || job.status === "quality-gate-failed") lastWeek.failed++;
        lastWeek.costUsd += job.usage?.estimatedCostUsd || 0;

        // Quality gate stats
        if (job.qualityGate && !job.qualityGate.skipped) {
          qualityGateStats.total++;
          if (job.qualityGate.passed) qualityGateStats.passed++;
          else qualityGateStats.failed++;
        }
      }

      // Stalled: running for >30min or queued for >10min
      if (job.status === "running" && job.startedAt) {
        const runningMs = now - new Date(job.startedAt).getTime();
        if (runningMs > 30 * 60 * 1000) {
          stalledJobs.push({ jobId: job.jobId, agent: job.agent, issueKey: job.issueKey, runningMinutes: Math.round(runningMs / 60000) });
        }
      }
      if ((job.status === "queued" || job.status === "retry-pending") && job.createdAt) {
        const waitingMs = now - new Date(job.createdAt).getTime();
        if (waitingMs > 10 * 60 * 1000) {
          stalledJobs.push({ jobId: job.jobId, agent: job.agent, issueKey: job.issueKey, waitingMinutes: Math.round(waitingMs / 60000), status: job.status });
        }
      }

      // Agent performance
      if (isLastWeek && job.agent) {
        if (!agentPerformance[job.agent]) {
          agentPerformance[job.agent] = { total: 0, succeeded: 0, failed: 0, avgDurationMs: 0, totalDurationMs: 0 };
        }
        const ap = agentPerformance[job.agent];
        ap.total++;
        if (job.status === "succeeded") ap.succeeded++;
        if (job.status === "failed" || job.status === "quality-gate-failed") ap.failed++;
        if (job.startedAt && job.finishedAt) {
          ap.totalDurationMs += new Date(job.finishedAt) - new Date(job.startedAt);
        }
      }
    }

    // Calculate averages
    for (const ap of Object.values(agentPerformance)) {
      ap.avgDurationMs = ap.total > 0 ? Math.round(ap.totalDurationMs / ap.total) : 0;
      delete ap.totalDurationMs;
      ap.successRate = ap.total > 0 ? Math.round((ap.succeeded / ap.total) * 100) : 0;
    }

    const budgetStatus = checkBudget();

    res.json({
      ok: true,
      digest: {
        generatedAt: nowIso(),
        last24h: {
          ...last24h,
          costUsd: Math.round(last24h.costUsd * 100) / 100,
          successRate: last24h.total > 0 ? Math.round((last24h.succeeded / last24h.total) * 100) : 0
        },
        lastWeek: {
          ...lastWeek,
          costUsd: Math.round(lastWeek.costUsd * 100) / 100,
          successRate: lastWeek.total > 0 ? Math.round((lastWeek.succeeded / lastWeek.total) * 100) : 0
        },
        qualityGate: {
          ...qualityGateStats,
          passRate: qualityGateStats.total > 0 ? Math.round((qualityGateStats.passed / qualityGateStats.total) * 100) : 0
        },
        stalledJobs,
        agentPerformance,
        budget: budgetStatus,
        queueDepth: queue.length,
        runningCount: getTotalRunningCount(),
        runningByProduct: Object.fromEntries(runningByProduct),
      }
    });
  });

  /**
   * ============================================================
   * KPI ENGINE ENDPOINT
   * Computes business, operational, and cost KPIs from
   * in-memory jobs, pipelines, meetings, and DB (historical jobs).
   * ============================================================
   */
  app.get("/api/kpi", requireSecret, async (req, res) => {
    const now = Date.now();
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartMs = todayStart.getTime();

    // Fetch all jobs from DB for KPI aggregation (last 30 days to bound query)
    const allJobs = new Map();
    try {
      const dbResult = await db.jobs.listAll({ limit: 5000, offset: 0, sort: "createdAt", order: "desc" });
      for (const entry of dbResult.jobs) {
        allJobs.set(entry.jobId, {
          jobId: entry.jobId,
          agent: entry.agent,
          status: entry.status,
          createdAt: entry.createdAt,
          startedAt: entry.startedAt,
          finishedAt: entry.finishedAt,
          estimatedCostUsd: entry.estimatedCostUsd || 0,
          source: entry.source || null,
          error: entry.error || null,
          lastError: entry.lastError || null,
        });
      }
    } catch {}
    // Override with active in-memory jobs (most current data + rich fields)
    for (const j of jobs.values()) {
      allJobs.set(j.jobId, {
        jobId: j.jobId,
        agent: j.agent,
        status: j.status,
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        estimatedCostUsd: j.usage?.estimatedCostUsd || 0,
        source: j.source || null,
        error: j.error || null,
        lastError: j.lastError || null,
        retryCount: j.retryCount || 0,
        maxRetries: j.maxRetries || 0,
        qualityGate: j.qualityGate || null,
        qualityGateRetryCount: j.qualityGateRetryCount || 0,
        pipelinePhase: j.pipelinePhase || null,
        stdout: j.stdout || null,
        parsedOutput: j.parsedOutput || null,
      });
    }

    // ── Tier 1: Business Value ──────────────────────────────────

    // featuresShipped: PM acceptance jobs that succeeded in last 7 days
    let featuresShipped = 0;
    for (const job of allJobs.values()) {
      if (job.agent !== "product-manager") continue;
      if (job.status !== "succeeded") continue;
      const created = new Date(job.createdAt).getTime();
      if (created < sevenDaysAgo) continue;
      // Count acceptance phase jobs from pipelines, or PM jobs with acceptance source
      const isAcceptance = job.pipelinePhase === "acceptance" ||
        (job.source && job.source.phase === "acceptance") ||
        (job.stdout && typeof job.stdout === "string" && job.stdout.includes("[AUTO-ACCEPT]")) ||
        (job.parsedOutput?.result && typeof job.parsedOutput.result === "string" && job.parsedOutput.result.includes("[AUTO-ACCEPT]"));
      if (isAcceptance) featuresShipped++;
    }

    // avgTimeToShip: Average pipeline creation-to-completion duration (last 30 days)
    let shipDurationSumMs = 0;
    let shipDurationCount = 0;
    for (const pipeline of pipelines.values()) {
      if (pipeline.status !== "completed") continue;
      if (!pipeline.completedAt) continue;
      const completedMs = new Date(pipeline.completedAt).getTime();
      if (completedMs < thirtyDaysAgo) continue;
      const createdMs = new Date(pipeline.createdAt).getTime();
      const durationMs = completedMs - createdMs;
      if (durationMs > 0) {
        shipDurationSumMs += durationMs;
        shipDurationCount++;
      }
    }
    const avgTimeToShipMs = shipDurationCount > 0 ? Math.round(shipDurationSumMs / shipDurationCount) : null;
    const avgTimeToShipHours = avgTimeToShipMs !== null ? Math.round((avgTimeToShipMs / (1000 * 60 * 60)) * 10) / 10 : null;

    // bugEscapeRate: Bugs created in last 7 days / features shipped in last 30 days
    // Count bug-triage jobs in last 7 days as a proxy for bugs created
    let bugsLast7Days = 0;
    for (const job of allJobs.values()) {
      if (job.agent !== "bug-triage") continue;
      const created = new Date(job.createdAt).getTime();
      if (created >= sevenDaysAgo) bugsLast7Days++;
    }
    // Features shipped in last 30 days
    let featuresShipped30d = 0;
    for (const job of allJobs.values()) {
      if (job.agent !== "product-manager") continue;
      if (job.status !== "succeeded") continue;
      const created = new Date(job.createdAt).getTime();
      if (created < thirtyDaysAgo) continue;
      const isAcceptance = job.pipelinePhase === "acceptance" ||
        (job.source && job.source.phase === "acceptance") ||
        (job.stdout && typeof job.stdout === "string" && job.stdout.includes("[AUTO-ACCEPT]")) ||
        (job.parsedOutput?.result && typeof job.parsedOutput.result === "string" && job.parsedOutput.result.includes("[AUTO-ACCEPT]"));
      if (isAcceptance) featuresShipped30d++;
    }
    const bugEscapeRate = featuresShipped30d > 0
      ? Math.round((bugsLast7Days / featuresShipped30d) * 100) / 100
      : null;

    // humanInterventionRate: Jobs that failed after all retries / total jobs last 7 days
    let totalJobsLast7Days = 0;
    let failedAfterRetriesLast7Days = 0;
    for (const job of allJobs.values()) {
      const created = new Date(job.createdAt).getTime();
      if (created < sevenDaysAgo) continue;
      totalJobsLast7Days++;
      if ((job.status === "failed" || job.status === "quality-gate-failed") &&
          (job.retryCount >= job.maxRetries || !job.maxRetries)) {
        failedAfterRetriesLast7Days++;
      }
    }
    const humanInterventionRate = totalJobsLast7Days > 0
      ? Math.round((failedAfterRetriesLast7Days / totalJobsLast7Days) * 10000) / 10000
      : 0;

    // ── Tier 2: Operational ─────────────────────────────────────

    // pipelineCompletionRate: Completed pipelines / total started (last 30 days)
    let pipelinesStarted30d = 0;
    let pipelinesCompleted30d = 0;
    for (const pipeline of pipelines.values()) {
      const createdMs = new Date(pipeline.createdAt).getTime();
      if (createdMs < thirtyDaysAgo) continue;
      pipelinesStarted30d++;
      if (pipeline.status === "completed") pipelinesCompleted30d++;
    }
    const pipelineCompletionRate = pipelinesStarted30d > 0
      ? Math.round((pipelinesCompleted30d / pipelinesStarted30d) * 10000) / 10000
      : null;

    // firstPassQualityGateRate: Jobs that passed QG on first attempt / total QG runs
    let totalQGRuns = 0;
    let firstPassQG = 0;
    for (const job of allJobs.values()) {
      const qg = job.qualityGate;
      if (!qg || qg.skipped) continue;
      totalQGRuns++;
      if (qg.passed && (job.qualityGateRetryCount || 0) === 0) {
        firstPassQG++;
      }
    }
    const firstPassQualityGateRate = totalQGRuns > 0
      ? Math.round((firstPassQG / totalQGRuns) * 10000) / 10000
      : null;

    // costPerFeature: Total cost last 30 days / features shipped
    let totalCost30d = 0;
    for (const job of allJobs.values()) {
      const created = new Date(job.createdAt).getTime();
      if (created >= thirtyDaysAgo) {
        totalCost30d += job.estimatedCostUsd || 0;
      }
    }
    const costPerFeature = featuresShipped30d > 0
      ? Math.round((totalCost30d / featuresShipped30d) * 100) / 100
      : null;

    // agentSuccessRate: Per-agent success/total counts and rates
    const agentSuccessRate = {};
    for (const job of allJobs.values()) {
      if (!job.agent) continue;
      if (!agentSuccessRate[job.agent]) {
        agentSuccessRate[job.agent] = { total: 0, succeeded: 0, failed: 0, rate: 0 };
      }
      agentSuccessRate[job.agent].total++;
      if (job.status === "succeeded") agentSuccessRate[job.agent].succeeded++;
      if (job.status === "failed" || job.status === "quality-gate-failed") agentSuccessRate[job.agent].failed++;
    }
    for (const agent of Object.keys(agentSuccessRate)) {
      const a = agentSuccessRate[agent];
      a.rate = a.total > 0 ? Math.round((a.succeeded / a.total) * 10000) / 10000 : 0;
    }

    // avgPipelineDuration: By pipeline type
    const avgPipelineDuration = {};
    const pipelineDurationAcc = {}; // type -> { sumMs, count }
    for (const pipeline of pipelines.values()) {
      if (pipeline.status !== "completed" || !pipeline.completedAt) continue;
      const pt = pipeline.pipelineType;
      if (!pipelineDurationAcc[pt]) pipelineDurationAcc[pt] = { sumMs: 0, count: 0 };
      const dur = new Date(pipeline.completedAt).getTime() - new Date(pipeline.createdAt).getTime();
      if (dur > 0) {
        pipelineDurationAcc[pt].sumMs += dur;
        pipelineDurationAcc[pt].count++;
      }
    }
    for (const pt of Object.keys(pipelineDurationAcc)) {
      const acc = pipelineDurationAcc[pt];
      const avgMs = acc.count > 0 ? Math.round(acc.sumMs / acc.count) : 0;
      avgPipelineDuration[pt] = {
        avgMs,
        avgMinutes: Math.round(avgMs / 60000),
        count: acc.count,
      };
    }

    // reworkRate: PM rejections / total acceptance reviews
    let totalAcceptanceReviews = 0;
    let pmRejections = 0;
    for (const job of allJobs.values()) {
      if (job.agent !== "product-manager") continue;
      if (job.status !== "succeeded" && job.status !== "failed") continue;
      const isAcceptance = job.pipelinePhase === "acceptance" ||
        (job.source && job.source.phase === "acceptance");
      if (!isAcceptance) continue;
      totalAcceptanceReviews++;
      // Check for rejection markers in output
      const output = (job.stdout && typeof job.stdout === "string" ? job.stdout : "") +
        (job.parsedOutput?.result && typeof job.parsedOutput.result === "string" ? job.parsedOutput.result : "");
      if (output.includes("[AUTO-REJECT]") || job.status === "failed") {
        pmRejections++;
      }
    }
    const reworkRate = totalAcceptanceReviews > 0
      ? Math.round((pmRejections / totalAcceptanceReviews) * 10000) / 10000
      : null;

    // stalledJobRate: Currently running >30min or queued >10min / total active
    let stalledCount = 0;
    let totalActive = 0;
    const stalledJobs = [];
    for (const job of jobs.values()) {
      if (job.status === "running" || job.status === "queued" || job.status === "retry-pending") {
        totalActive++;
      }
      if (job.status === "running" && job.startedAt) {
        const runningMs = now - new Date(job.startedAt).getTime();
        if (runningMs > 30 * 60 * 1000) {
          stalledCount++;
          stalledJobs.push({ jobId: job.jobId, agent: job.agent, issueKey: job.issueKey, runningMinutes: Math.round(runningMs / 60000) });
        }
      }
      if ((job.status === "queued" || job.status === "retry-pending") && job.createdAt) {
        const waitingMs = now - new Date(job.createdAt).getTime();
        if (waitingMs > 10 * 60 * 1000) {
          stalledCount++;
          stalledJobs.push({ jobId: job.jobId, agent: job.agent, issueKey: job.issueKey, waitingMinutes: Math.round(waitingMs / 60000), status: job.status });
        }
      }
    }
    const stalledJobRate = totalActive > 0
      ? Math.round((stalledCount / totalActive) * 10000) / 10000
      : 0;

    // ── Tier 3: Cost ────────────────────────────────────────────

    let dailySpend = 0;
    let weeklySpend = 0;
    let monthlySpend = 0;
    const costByAgent = {};
    let failedJobCost = 0;
    let totalCostAll = 0;

    for (const job of allJobs.values()) {
      const cost = job.estimatedCostUsd || 0;
      const created = new Date(job.createdAt).getTime();
      totalCostAll += cost;

      if (created >= todayStartMs) dailySpend += cost;
      if (created >= sevenDaysAgo) weeklySpend += cost;
      if (created >= thirtyDaysAgo) monthlySpend += cost;

      if (job.agent && cost > 0) {
        if (!costByAgent[job.agent]) costByAgent[job.agent] = 0;
        costByAgent[job.agent] += cost;
      }

      if (job.status === "failed" || job.status === "quality-gate-failed") {
        failedJobCost += cost;
      }
    }

    const wastedSpend = totalCostAll > 0
      ? Math.round((failedJobCost / totalCostAll) * 10000) / 10000
      : 0;

    // Round cost values
    dailySpend = Math.round(dailySpend * 100) / 100;
    weeklySpend = Math.round(weeklySpend * 100) / 100;
    monthlySpend = Math.round(monthlySpend * 100) / 100;
    for (const agent of Object.keys(costByAgent)) {
      costByAgent[agent] = Math.round(costByAgent[agent] * 100) / 100;
    }

    res.json({
      ok: true,
      generatedAt: nowIso(),
      kpi: {
        tier1_business: {
          featuresShipped,
          avgTimeToShipMs,
          avgTimeToShipHours,
          bugEscapeRate,
          meetingActionCompletionRate: null, // Stub: requires Jira data integration
          humanInterventionRate,
        },
        tier2_operational: {
          pipelineCompletionRate,
          firstPassQualityGateRate,
          costPerFeature,
          agentSuccessRate,
          avgPipelineDuration,
          reworkRate,
          stalledJobRate,
          stalledJobs,
        },
        tier3_cost: {
          dailySpend,
          weeklySpend,
          monthlySpend,
          costByAgent,
          wastedSpend,
        },
      },
    });
  });

  /**
   * ============================================================
   * PIPELINE DEFINITIONS ENDPOINTS
   * Manage user-defined pipeline templates (save/load/delete).
   * Built-in pipelines are read-only.
   * ============================================================
   */

  /**
   * GET /api/pipeline-definitions
   * List all pipeline templates (built-ins + saved user definitions).
   * Returns summary only (no phase arrays) — phase count for display.
   */
  app.get("/api/pipeline-definitions", requireSecret, (req, res) => {
    try {
      const defs = listPipelineDefinitions();
      const definitions = Object.entries(defs).map(([name, def]) => ({
        name,
        description: def.description || null,
        phases: (def.phases || []).length,
        builtin: BUILTIN_NAMES.has(name),
      }));
      res.json({ ok: true, definitions });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * GET /api/pipeline-definitions/:name
   * Return full detail (including phase array) for a single pipeline template.
   */
  app.get("/api/pipeline-definitions/:name", requireSecret, (req, res) => {
    try {
      const defs = listPipelineDefinitions();
      const def = defs[req.params.name];
      if (!def) return res.status(404).json({ ok: false, error: `Pipeline definition "${req.params.name}" not found` });
      res.json({ ok: true, definition: { name: req.params.name, description: def.description || null, phases: def.phases || [] } });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * POST /api/pipeline-definitions
   * Create or update a user-defined pipeline template.
   * Body: { name: string, description?: string, phases: PhaseInput[] }
   */
  app.post("/api/pipeline-definitions", requireSecret, (req, res) => {
    const { name, description, phases } = req.body || {};

    // Validate name
    if (!name || typeof name !== "string") {
      return res.status(400).json({ ok: false, error: "name is required" });
    }
    if (!/^[a-z0-9-]+$/.test(name) || name.length > 50) {
      return res.status(400).json({ ok: false, error: "name must match /^[a-z0-9-]+$/ and be ≤50 chars" });
    }

    // Block built-in overwrite
    if (BUILTIN_NAMES.has(name)) {
      return res.status(400).json({ ok: false, error: "Cannot overwrite built-in pipeline" });
    }

    // Validate phases
    if (!Array.isArray(phases) || phases.length === 0) {
      return res.status(400).json({ ok: false, error: "phases must be a non-empty array" });
    }
    if (phases.length > 20) {
      return res.status(400).json({ ok: false, error: "phases must have ≤20 entries" });
    }

    const VALID_GATE_TYPES = new Set(["comment-prefix", "quality-gate", "file-exists", "human-approval"]);
    const agentToModel = (config.routing || {}).agentToModel || {};

    // Validate and sanitize each phase (allowlist fields — no `condition` to prevent RCE)
    const sanitizedPhases = [];
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i];
      if (!p.name || typeof p.name !== "string") {
        return res.status(400).json({ ok: false, error: `phases[${i}].name is required` });
      }
      if (!p.agent || typeof p.agent !== "string") {
        return res.status(400).json({ ok: false, error: `phases[${i}].agent is required` });
      }
      if (!agentToModel[p.agent]) {
        return res.status(400).json({ ok: false, error: `phases[${i}].agent '${p.agent}' is not a known agent` });
      }

      // Build safe phase object from allowlist only (no `condition`, no extra fields)
      const safe = { name: p.name, agent: p.agent };

      if (p.gate) {
        if (!VALID_GATE_TYPES.has(p.gate.type)) {
          return res.status(400).json({ ok: false, error: `phases[${i}].gate.type must be one of: ${[...VALID_GATE_TYPES].join(", ")}` });
        }
        const safeGate = { type: p.gate.type };
        if (p.gate.type === "comment-prefix") {
          if (!p.gate.prefix || typeof p.gate.prefix !== "string") {
            return res.status(400).json({ ok: false, error: `phases[${i}].gate.prefix is required for comment-prefix gate` });
          }
          safeGate.prefix = p.gate.prefix;
        }
        if (p.gate.type === "file-exists") {
          if (!p.gate.file || typeof p.gate.file !== "string") {
            return res.status(400).json({ ok: false, error: `phases[${i}].gate.file is required for file-exists gate` });
          }
          safeGate.file = p.gate.file;
        }
        safe.gate = safeGate;
      }

      if (p.maxRetries !== undefined && p.maxRetries !== null) {
        if (!Number.isInteger(p.maxRetries) || p.maxRetries < 0 || p.maxRetries > 10) {
          return res.status(400).json({ ok: false, error: `phases[${i}].maxRetries must be an integer 0–10` });
        }
        safe.maxRetries = p.maxRetries;
      }
      if (p.maxCostUsd !== undefined && p.maxCostUsd !== null) {
        if (typeof p.maxCostUsd !== "number" || p.maxCostUsd <= 0) {
          return res.status(400).json({ ok: false, error: `phases[${i}].maxCostUsd must be a positive number` });
        }
        safe.maxCostUsd = p.maxCostUsd;
      }

      sanitizedPhases.push(safe);
    }

    try {
      savePipelineDefinition(name, {
        description: description ? String(description) : undefined,
        phases: sanitizedPhases,
      });
      res.json({ ok: true, name });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * DELETE /api/pipeline-definitions/:name
   * Delete a user-defined pipeline template.
   * Returns 400 if the name is a built-in.
   */
  app.delete("/api/pipeline-definitions/:name", requireSecret, (req, res) => {
    const { name } = req.params;
    if (BUILTIN_NAMES.has(name)) {
      return res.status(400).json({ ok: false, error: "Cannot delete built-in pipeline" });
    }
    try {
      deletePipelineDefinition(name);
      res.json({ ok: true });
    } catch (e) {
      const status = e.message.includes("not found") ? 404 : 500;
      res.status(status).json({ ok: false, error: e.message });
    }
  });

  /**
   * ============================================================
   * PIPELINE ROUTING RULES ENDPOINTS
   * Manage issue-type / label → pipelineType routing rules.
   * ============================================================
   */

  /**
   * GET /api/pipeline-routing
   * Returns the current routing rules.
   */
  app.get("/api/pipeline-routing", requireSecret, (req, res) => {
    try {
      const rules = listPipelineRoutingRules();
      res.json({ ok: true, rules });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * PUT /api/pipeline-routing
   * Replace all routing rules.
   * Body: { rules: RoutingRule[] }
   * Each rule: { match: { issueType?, labels? }, pipelineType }
   */
  app.put("/api/pipeline-routing", requireSecret, (req, res) => {
    const { rules } = req.body || {};

    if (!Array.isArray(rules)) {
      return res.status(400).json({ ok: false, error: "rules must be an array" });
    }
    if (rules.length > 50) {
      return res.status(400).json({ ok: false, error: "rules must have ≤50 entries" });
    }

    const VALID_ISSUE_TYPES = new Set(["story", "bug", "subtask", "task", "epic"]);

    // Gather all known pipeline type names (built-ins + saved user definitions)
    let knownPipelineTypes;
    try {
      const savedDefs = listPipelineDefinitions();
      knownPipelineTypes = new Set([...BUILTIN_NAMES, ...Object.keys(savedDefs)]);
    } catch (e) {
      return res.status(500).json({ ok: false, error: `Failed to load pipeline definitions: ${e.message}` });
    }

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!rule.pipelineType || typeof rule.pipelineType !== "string") {
        return res.status(400).json({ ok: false, error: `rules[${i}].pipelineType is required` });
      }
      if (!knownPipelineTypes.has(rule.pipelineType)) {
        return res.status(400).json({ ok: false, error: `rules[${i}].pipelineType '${rule.pipelineType}' is not a known pipeline type` });
      }

      const m = rule.match || {};
      if (m.issueType !== undefined && !VALID_ISSUE_TYPES.has(m.issueType)) {
        return res.status(400).json({ ok: false, error: `rules[${i}].match.issueType must be one of: ${[...VALID_ISSUE_TYPES].join(", ")}` });
      }
      if (m.labels !== undefined) {
        if (!Array.isArray(m.labels) || !m.labels.every(l => typeof l === "string")) {
          return res.status(400).json({ ok: false, error: `rules[${i}].match.labels must be an array of strings` });
        }
      }
    }

    try {
      savePipelineRoutingRules(rules);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // PROVIDER CONFIG ENDPOINTS (BYOK multi-provider)
  // ---------------------------------------------------------------------------

  app.get("/api/providers", requireSecret, async (_req, res) => {
    try {
      const dbProviders = await getProviders();
      // Merge with file-based config so static providers are always visible
      const fileProviders = config.providers || {};
      const merged = new Map();
      for (const [id, p] of Object.entries(fileProviders)) {
        merged.set(id, { id, ...p, source: "config" });
      }
      for (const p of dbProviders) {
        merged.set(p.id, { ...p, source: "db" });
      }
      // Attach apiKeySet flag; never expose the key value
      const list = await Promise.all([...merged.values()].map(async (p) => {
        const apiKeySet = await hasProviderApiKey(p.id);
        const envFallback = p.authTokenEnvVar ? Boolean(process.env[p.authTokenEnvVar]) : false;
        return { ...p, apiKeySet: apiKeySet || envFallback };
      }));
      res.json(list);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/providers", requireSecret, async (req, res) => {
    const { id, type, displayName, baseUrl, authMode, modelMapping, timeoutMs, enabled } = req.body || {};
    if (!id || !type) return res.status(400).json({ ok: false, error: "id and type are required" });
    const validTypes = ["claude-cli", "openai", "gemini", "anthropic-direct", "github"];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ ok: false, error: `type must be one of: ${validTypes.join(", ")}` });
    }
    try {
      await upsertProvider({ id, type, displayName, baseUrl, authMode, modelMapping, timeoutMs, enabled });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.put("/api/providers/:id", requireSecret, async (req, res) => {
    const { id } = req.params;
    const { type, displayName, baseUrl, authMode, modelMapping, timeoutMs, enabled } = req.body || {};
    try {
      const existing = await getProvider(id);
      if (!existing) return res.status(404).json({ ok: false, error: "Provider not found" });
      await upsertProvider({ id, type: type || existing.type, displayName, baseUrl, authMode, modelMapping, timeoutMs, enabled });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.delete("/api/providers/:id", requireSecret, async (req, res) => {
    const { id } = req.params;
    if (id === "claude") return res.status(400).json({ ok: false, error: "Cannot delete the built-in claude provider" });
    try {
      await deleteProvider(id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Write-only key endpoint — accepts the key, stores it encrypted, never returns the value
  app.post("/api/providers/:id/key", requireSecret, async (req, res) => {
    const { id } = req.params;
    const { key } = req.body || {};
    if (!key || typeof key !== "string" || !key.trim()) {
      return res.status(400).json({ ok: false, error: "key is required" });
    }
    try {
      // Auto-upsert the provider config row if it only exists in config.json
      // (provider_secrets has a FK to provider_configs, so the row must exist first)
      const existing = await getProvider(id);
      if (!existing) {
        const fileProvider = (config.providers || {})[id];
        if (fileProvider) {
          await upsertProvider({ id, type: fileProvider.type || "claude-cli", authMode: fileProvider.authMode, enabled: true });
        } else {
          return res.status(404).json({ ok: false, error: `Provider '${id}' not found — create it first via POST /api/providers` });
        }
      }
      await setProviderApiKey(id, key.trim());
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/providers/:id/key/status", requireSecret, async (req, res) => {
    const { id } = req.params;
    try {
      const set = await hasProviderApiKey(id);
      const providerConfig = await getProvider(id) || (config.providers || {})[id];
      const envFallback = providerConfig?.authTokenEnvVar ? Boolean(process.env[providerConfig.authTokenEnvVar]) : false;
      res.json({ set: set || envFallback, source: set ? "db" : (envFallback ? "env" : "none") });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Test provider connection by making a minimal API call
  app.post("/api/providers/:id/test", requireSecret, async (req, res) => {
    const { id } = req.params;
    try {
      const providerConfig = await getProvider(id) || (config.providers || {})[id];
      if (!providerConfig) return res.status(404).json({ ok: false, error: "Provider not found" });

      const apiKey = await resolveApiKey({ ...providerConfig, id });
      const type = providerConfig.type || "claude-cli";
      const start = Date.now();

      if (type === "openai") {
        const baseUrl = providerConfig.baseUrl || "https://api.openai.com";
        const model = providerConfig.modelMapping?.haiku || "gpt-4o-mini";
        const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "Say: ok" }], max_tokens: 5 }),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          const text = await resp.text();
          return res.status(502).json({ ok: false, error: `API returned ${resp.status}: ${text.slice(0, 200)}` });
        }
        const data = await resp.json();
        return res.json({ ok: true, latencyMs: Date.now() - start, model, response: data.choices?.[0]?.message?.content });
      }

      if (type === "gemini") {
        const model = providerConfig.modelMapping?.haiku || "gemini-2.0-flash-lite";
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: "Say: ok" }] }] }),
            signal: AbortSignal.timeout(15000),
          }
        );
        if (!resp.ok) {
          const text = await resp.text();
          return res.status(502).json({ ok: false, error: `Gemini API returned ${resp.status}: ${text.slice(0, 200)}` });
        }
        const data = await resp.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        return res.json({ ok: true, latencyMs: Date.now() - start, model, response: text });
      }

      if (type === "anthropic-direct") {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: providerConfig.modelMapping?.haiku || "claude-haiku-4-5-20251001",
            max_tokens: 5,
            messages: [{ role: "user", content: "Say: ok" }],
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          const text = await resp.text();
          return res.status(502).json({ ok: false, error: `Anthropic API returned ${resp.status}: ${text.slice(0, 200)}` });
        }
        const data = await resp.json();
        return res.json({ ok: true, latencyMs: Date.now() - start, model: data.model, response: data.content?.[0]?.text });
      }

      // claude-cli: just verify a key or OAuth credential exists
      const hasKey = apiKey || (id === "claude" && process.env.ANTHROPIC_API_KEY);
      res.json({ ok: true, latencyMs: Date.now() - start, note: "claude-cli provider — authentication verified via credential check", credentialPresent: Boolean(hasKey) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // AGENT ROUTING OVERRIDES
  // ---------------------------------------------------------------------------

  app.get("/api/routing/agents", requireSecret, async (_req, res) => {
    try {
      const dbRouting = await listAgentRouting();
      // Merge with config.json routing so static config is visible
      const fileRouting = config.routing || {};
      const agentToProvider = fileRouting.agentToProvider || {};
      const agentToModel = fileRouting.agentToModel || {};
      const merged = new Map();
      const allAgents = new Set([...Object.keys(agentToProvider), ...Object.keys(agentToModel)]);
      for (const agentName of allAgents) {
        merged.set(agentName, {
          agentName,
          providerId: agentToProvider[agentName] || null,
          modelTier: agentToModel[agentName] || null,
          source: "config",
        });
      }
      for (const r of dbRouting) {
        merged.set(r.agentName, { ...r, source: "db" });
      }
      res.json([...merged.values()]);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.put("/api/routing/agents/:name", requireSecret, async (req, res) => {
    const agentName = req.params.name;
    const { providerId, modelTier, effort, toolRestrictions } = req.body || {};
    try {
      await upsertAgentRouting({ agentName, providerId, modelTier, effort, toolRestrictions });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.delete("/api/routing/agents/:name", requireSecret, async (req, res) => {
    const { name } = req.params;
    try {
      await deleteAgentRouting(name);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Dashboard redirect (UI served by separate Next.js app)
  app.get("/dashboard", (req, res) => {
    res.redirect(config.dashboardUrl || "http://localhost:3100");
  });

  app.get("/", (req, res) => {
    res.redirect(config.dashboardUrl || "http://localhost:3100");
  });
}

module.exports = { registerAdminRoutes };
