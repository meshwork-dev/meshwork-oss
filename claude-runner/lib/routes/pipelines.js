// pipelines.js — routes/pipelines routes
// Extracted from runner.js.

const db = require("../../db");
const { config, DEFAULT_WORKING_DIR, N8N_CALLBACK_URL } = require("../config");
const { checkBudget } = require("../metrics");
const { admissionControl, requireSecret } = require("../middleware");
const { products } = require("../products");
const { getPipeline, jobEmitter, jobs, lifecycle, pipelines } = require("../state");
const { nowIso } = require("../util");

const {
  advancePipeline,
  buildTimelineForIssue,
  createPipeline,
  executePipelinePhase,
  loadPipelineDefinitions,
} = require("../pipelines");
const { validateWorkingDir } = require("../worker");

function registerPipelineRoutes(app) {

  /**
   * ============================================================
   * PIPELINE API ROUTES
   * ============================================================
   */

  // POST /pipeline - Create and start a pipeline
  app.post("/pipeline", requireSecret, admissionControl, async (req, res) => {
    if (lifecycle.shuttingDown) return res.status(503).json({ ok: false, error: "Server shutting down" });

    const budgetCheck = checkBudget();
    if (!budgetCheck.ok) return res.status(429).json({ ok: false, error: budgetCheck.reason, status: "budget-exceeded" });

    const body = req.body || {};
    const issueKey = body.issueKey;
    if (!issueKey) return res.status(400).json({ ok: false, error: "issueKey is required" });

    const pipelineType = body.pipelineType || body.pipeline || null;
    const inlinePhases = Array.isArray(body.phases) ? body.phases : null;

    if (!pipelineType && !inlinePhases) {
      return res.status(400).json({ ok: false, error: "pipelineType or phases is required" });
    }

    if (inlinePhases) {
      // Validate inline phases — condition strings are not accepted (they feed new Function())
      if (inlinePhases.length === 0) {
        return res.status(400).json({ ok: false, error: "phases must not be empty" });
      }
      if (inlinePhases.length > 20) {
        return res.status(400).json({ ok: false, error: "phases must not exceed 20 entries" });
      }
      const VALID_GATE_TYPES = new Set(["comment-prefix", "quality-gate", "file-exists", "human-approval"]);
      const agentToModel = config.routing?.agentToModel || {};
      for (let i = 0; i < inlinePhases.length; i++) {
        const p = inlinePhases[i];
        if (!p || typeof p.name !== "string" || !p.name.trim()) {
          return res.status(400).json({ ok: false, error: `phases[${i}].name is required` });
        }
        if (typeof p.agent !== "string" || !p.agent.trim()) {
          return res.status(400).json({ ok: false, error: `phases[${i}].agent is required` });
        }
        if (!agentToModel[p.agent]) {
          return res.status(400).json({ ok: false, error: `phases[${i}].agent "${p.agent}" is not a registered agent`, available: Object.keys(agentToModel) });
        }
        if (p.gate != null) {
          if (!VALID_GATE_TYPES.has(p.gate.type)) {
            return res.status(400).json({ ok: false, error: `phases[${i}].gate.type must be one of: ${[...VALID_GATE_TYPES].join(", ")}` });
          }
          if (p.gate.type === "comment-prefix" && typeof p.gate.prefix !== "string") {
            return res.status(400).json({ ok: false, error: `phases[${i}].gate.prefix is required for comment-prefix gate` });
          }
          if (p.gate.type === "file-exists" && typeof p.gate.file !== "string") {
            return res.status(400).json({ ok: false, error: `phases[${i}].gate.file is required for file-exists gate` });
          }
        }
        if (p.maxRetries !== undefined && p.maxRetries !== null) {
          if (!Number.isInteger(p.maxRetries) || p.maxRetries < 0 || p.maxRetries > 10) {
            return res.status(400).json({ ok: false, error: `phases[${i}].maxRetries must be an integer 0–10` });
          }
        }
        if (p.maxCostUsd !== undefined && p.maxCostUsd !== null) {
          if (typeof p.maxCostUsd !== "number" || p.maxCostUsd <= 0) {
            return res.status(400).json({ ok: false, error: `phases[${i}].maxCostUsd must be a positive number` });
          }
        }
      }
    } else {
      // Validate named pipeline type exists in config
      const definitions = loadPipelineDefinitions();
      if (!definitions[pipelineType]) {
        return res.status(400).json({
          ok: false,
          error: `Unknown pipeline type: ${pipelineType}`,
          available: Object.keys(definitions),
        });
      }
    }

    let resolvedWorkingDir = DEFAULT_WORKING_DIR;
    if (body.workingDir) {
      const wd = validateWorkingDir(body.workingDir);
      if (!wd.ok) return res.status(400).json({ ok: false, error: wd.error });
      resolvedWorkingDir = wd.resolved;
    } else if (body.projectKey) {
      // Resolve workingDir from Jira project key via product config
      for (const [, product] of products) {
        if (product.jira?.projectKey === body.projectKey) {
          resolvedWorkingDir = product.workingDir;
          break;
        }
      }
    }

    const labels = Array.isArray(body.labels) ? body.labels : [];

    // Meeting action items are one-shot jobs — never run them through pipelines
    if (labels.includes("meeting-action")) {
      return res.status(400).json({ ok: false, error: "meeting-action issues should not run as pipelines" });
    }

    const options = {
      workingDir: resolvedWorkingDir,
      parentKey: body.parentKey || null,
      labels,
      callbackUrl: body.callbackUrl || N8N_CALLBACK_URL || null,
      slack: body.slack || null,
      telegram: body.telegram || null,
      provider: body.provider || null,
      inlinePhases: inlinePhases || null,
      description: body.description || null,
    };

    const effectivePipelineType = pipelineType || "custom";
    try {
      const pipeline = await createPipeline(issueKey, effectivePipelineType, options);
      return res.status(202).json({
        ok: true,
        pipelineId: pipeline.pipelineId,
        issueKey: pipeline.issueKey,
        pipelineType: pipeline.pipelineType,
        phases: pipeline.phases.length,
        statusUrl: `/pipelines/${pipeline.pipelineId}`,
      });
    } catch (e) {
      const status = e.message.includes("already active") ? 409 : 500;
      return res.status(status).json({ ok: false, error: e.message });
    }
  });

  // POST /pipelines/:id/cancel - Cancel a running or blocked pipeline
  app.post("/pipelines/:id/cancel", requireSecret, async (req, res) => {
    const pipeline = await getPipeline(req.params.id);
    if (!pipeline) return res.status(404).json({ ok: false, error: "pipeline not found" });
    const cancellable = ["running", "blocked"];
    if (!cancellable.includes(pipeline.status)) return res.status(400).json({ ok: false, error: `Pipeline is ${pipeline.status}, not ${cancellable.join("/")}` });
    pipeline.status = "failed";
    pipeline.error = req.body?.reason || "Cancelled by admin";
    const phase = pipeline.phases[pipeline.currentPhase];
    if (phase && (phase.status === "running" || phase.status === "blocked" || phase.status === "pending")) phase.status = "failed";
    db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} cancelled by admin`);
    res.json({ ok: true, pipelineId: pipeline.pipelineId, status: "failed" });
  });

  // POST /pipelines/:id/restart - Restart a failed pipeline from the failed phase (or a specific phase)
  app.post("/pipelines/:id/restart", requireSecret, async (req, res) => {
    if (lifecycle.shuttingDown) return res.status(503).json({ ok: false, error: "Server shutting down" });

    const budgetCheck = checkBudget();
    if (!budgetCheck.ok) return res.status(429).json({ ok: false, error: budgetCheck.reason, status: "budget-exceeded" });

    const pipeline = await getPipeline(req.params.id);
    if (!pipeline) {
      return res.status(404).json({ ok: false, error: "pipeline not found" });
    }

    if (!["failed", "completed"].includes(pipeline.status)) {
      return res.status(400).json({ ok: false, error: `Pipeline is ${pipeline.status}, only failed or completed pipelines can be restarted` });
    }

    // Optional: restart from a specific phase index or name (defaults to the failed phase)
    const body = req.body || {};
    let fromPhase = body.fromPhase;

    // Resolve phase name to index if a string name was provided
    if (typeof fromPhase === "string" && isNaN(Number(fromPhase))) {
      const idx = pipeline.phases.findIndex(p => p.name === fromPhase);
      if (idx < 0) return res.status(400).json({ ok: false, error: `Unknown phase name: ${fromPhase}` });
      fromPhase = idx;
    } else if (fromPhase !== undefined && fromPhase !== null) {
      fromPhase = Number(fromPhase);
    }

    if (fromPhase === undefined || fromPhase === null) {
      // Find the first failed or interrupted (still "running" after restart) phase
      fromPhase = pipeline.phases.findIndex(p => p.status === "failed");
      if (fromPhase < 0) {
        fromPhase = pipeline.phases.findIndex(p => p.status === "running");
      }
      if (fromPhase < 0) {
        fromPhase = pipeline.phases.findIndex(p => p.status === "pending");
      }
    }

    if (fromPhase < 0 || fromPhase >= pipeline.phases.length) {
      return res.status(400).json({ ok: false, error: "No restartable phase found" });
    }

    // Reset the pipeline and all phases from fromPhase onwards
    pipeline.status = "running";
    pipeline.completedAt = null;
    pipeline.error = null;

    // Re-read phase definitions from config so restarts pick up config changes (agent/model)
    const pipelineDefs = loadPipelineDefinitions();
    const templatePhases = pipelineDefs[pipeline.pipelineType]?.phases || [];

    for (let i = fromPhase; i < pipeline.phases.length; i++) {
      const phase = pipeline.phases[i];
      if (phase.status === "skipped") continue; // Keep skipped phases as-is
      phase.status = "pending";
      phase.jobId = null;
      phase.startedAt = null;
      phase.completedAt = null;
      phase.error = null;
      phase.gateResult = null;
      phase.retryCount = 0;
      // Refresh agent/model from config template if available
      const tmpl = templatePhases.find(t => t.name === phase.name);
      if (tmpl) {
        if (tmpl.agent) phase.agent = tmpl.agent;
        if (tmpl.model) phase.model = tmpl.model;
      }
    }

    db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));


    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} RESTARTED from phase ${fromPhase} (${pipeline.phases[fromPhase].name})`);

    jobEmitter.emit("pipeline:phase-started", {
      pipelineId: pipeline.pipelineId,
      phase: pipeline.phases[fromPhase].name,
      phaseIndex: fromPhase,
      restart: true,
    });

    // Start execution from the target phase
    setImmediate(() => executePipelinePhase(pipeline, fromPhase));

    return res.json({
      ok: true,
      pipelineId: pipeline.pipelineId,
      restartedFromPhase: fromPhase,
      phaseName: pipeline.phases[fromPhase].name,
      statusUrl: `/pipelines/${pipeline.pipelineId}`,
    });
  });

  // POST /pipelines/:id/skip-phase - Skip the current phase and advance
  app.post("/pipelines/:id/skip-phase", requireSecret, async (req, res) => {
    const pipeline = await getPipeline(req.params.id);
    if (!pipeline) return res.status(404).json({ ok: false, error: "pipeline not found" });
    if (pipeline.status !== "running") return res.status(400).json({ ok: false, error: `Pipeline is ${pipeline.status}` });

    const phaseIndex = pipeline.currentPhase;
    const phase = pipeline.phases[phaseIndex];
    if (!phase) return res.status(400).json({ ok: false, error: "No current phase" });

    // Kill any running job for this phase
    if (phase.jobId) {
      const phaseJob = jobs.get(phase.jobId);
      if (phaseJob && phaseJob.status === "running" && phaseJob.processPid) {
        try { process.kill(phaseJob.processPid, "SIGKILL"); } catch {}
        phaseJob.status = "cancelled";
        phaseJob.finishedAt = nowIso();
      }
    }

    // Mark phase as skipped
    phase.status = "skipped";
    phase.completedAt = nowIso();
    phase.error = "Manually skipped";

    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} manually SKIPPED`);

    // Advance to next phase
    setImmediate(() => advancePipeline(pipeline));

    db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));

    return res.json({ ok: true, skippedPhase: phase.name, phaseIndex });
  });

  // POST /pipelines/:id/force-complete - Force-complete the current phase and advance
  app.post("/pipelines/:id/force-complete", requireSecret, async (req, res) => {
    const pipeline = await getPipeline(req.params.id);
    if (!pipeline) return res.status(404).json({ ok: false, error: "pipeline not found" });
    if (pipeline.status !== "running") return res.status(400).json({ ok: false, error: `Pipeline is ${pipeline.status}` });

    const phaseIndex = pipeline.currentPhase;
    const phase = pipeline.phases[phaseIndex];
    if (!phase) return res.status(400).json({ ok: false, error: "No current phase" });

    // Kill any running job for this phase
    if (phase.jobId) {
      const phaseJob = jobs.get(phase.jobId);
      if (phaseJob && phaseJob.status === "running" && phaseJob.processPid) {
        try { process.kill(phaseJob.processPid, "SIGKILL"); } catch {}
        phaseJob.status = "cancelled";
        phaseJob.finishedAt = nowIso();
      }
    }

    // Mark phase as completed with a manual gate pass
    phase.status = "completed";
    phase.completedAt = nowIso();
    phase.gateResult = { passed: true, reason: req.body?.reason || "Manually force-completed by admin" };

    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} manually FORCE-COMPLETED`);

    // Advance to next phase
    setImmediate(() => advancePipeline(pipeline));

    db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));

    return res.json({ ok: true, completedPhase: phase.name, phaseIndex });
  });

  // POST /pipelines/:id/approve — approve the currently awaiting-approval phase
  app.post("/pipelines/:id/approve", requireSecret, async (req, res) => {
    const pipeline = await getPipeline(req.params.id);
    if (!pipeline) return res.status(404).json({ ok: false, error: "pipeline not found" });

    const phase = pipeline.phases.find(p => p.status === "awaiting-approval");
    if (!phase) return res.status(400).json({ ok: false, error: "No phase awaiting approval" });

    phase.humanApproval = { approved: true, reason: req.body?.reason || "Approved", approvedAt: nowIso() };
    phase.status = "completed";
    phase.gateResult = { passed: true, reason: phase.humanApproval.reason };
    phase.completedAt = nowIso();

    db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} APPROVED`);

    jobEmitter.emit("pipeline:gate-passed", {
      pipelineId: pipeline.pipelineId,
      phase: phase.name,
      phaseIndex: phase.index,
      reason: phase.humanApproval.reason,
    });

    setImmediate(() => advancePipeline(pipeline));
    return res.json({ ok: true, pipelineId: pipeline.pipelineId, phase: phase.name });
  });

  // POST /pipelines/:id/reject — reject the currently awaiting-approval phase
  app.post("/pipelines/:id/reject", requireSecret, async (req, res) => {
    const pipeline = await getPipeline(req.params.id);
    if (!pipeline) return res.status(404).json({ ok: false, error: "pipeline not found" });

    const phase = pipeline.phases.find(p => p.status === "awaiting-approval");
    if (!phase) return res.status(400).json({ ok: false, error: "No phase awaiting approval" });

    phase.humanApproval = { approved: false, reason: req.body?.reason || "Rejected", rejectedAt: nowIso() };
    phase.status = "failed";
    phase.gateResult = { passed: false, reason: phase.humanApproval.reason };
    phase.completedAt = nowIso();
    pipeline.status = "failed";
    pipeline.error = `Phase "${phase.name}" rejected: ${phase.humanApproval.reason}`;
    pipeline.completedAt = nowIso();

    db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} REJECTED`);

    jobEmitter.emit("pipeline:gate-failed", {
      pipelineId: pipeline.pipelineId,
      phase: phase.name,
      phaseIndex: phase.index,
      reason: phase.humanApproval.reason,
    });

    return res.json({ ok: true, pipelineId: pipeline.pipelineId, phase: phase.name });
  });

  // GET /pipelines/:id - Get pipeline status
  app.get("/pipelines/:id", requireSecret, async (req, res) => {
    const pipeline = await getPipeline(req.params.id);
    if (!pipeline) {
      return res.status(404).json({ ok: false, error: "pipeline not found" });
    }
    return res.json({ ok: true, pipeline });
  });

  // GET /api/pipelines - List all pipelines
  app.get("/api/pipelines", requireSecret, async (req, res) => {
    let allPipelines;
    try {
      allPipelines = await db.pipelines.listAll();
      // Merge with any in-memory active pipelines not yet in DB
      for (const [id, p] of pipelines) {
        if (!allPipelines.find(x => x.pipelineId === id)) allPipelines.push(p);
      }
    } catch {
      allPipelines = Array.from(pipelines.values());
    }
    const pipelineList = allPipelines.map(p => ({
      pipelineId: p.pipelineId,
      issueKey: p.issueKey,
      pipelineType: p.pipelineType,
      description: p.description,
      status: p.status,
      currentPhase: p.currentPhase,
      totalPhases: (p.phases || []).length,
      completedPhases: (p.phases || []).filter(ph => ph.status === "completed").length,
      skippedPhases: (p.phases || []).filter(ph => ph.status === "skipped").length,
      createdAt: p.createdAt,
      startedAt: p.startedAt,
      completedAt: p.completedAt,
      error: p.error,
    }));

    // Sort by createdAt descending
    pipelineList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.json({ ok: true, pipelines: pipelineList, total: pipelineList.length });
  });

  // GET /api/timeline/:issueKey - Per-issue timeline
  app.get("/api/timeline/:issueKey", requireSecret, async (req, res) => {
    const issueKey = req.params.issueKey;
    const timeline = await buildTimelineForIssue(issueKey);

    // Find any pipelines associated with this issue
    const issuePipelines = Array.from(pipelines.values())
      .filter(p => p.issueKey === issueKey)
      .map(p => ({
        pipelineId: p.pipelineId,
        pipelineType: p.pipelineType,
        status: p.status,
        phases: p.phases.map(ph => ({
          name: ph.name,
          agent: ph.agent,
          status: ph.status,
          jobId: ph.jobId,
          startedAt: ph.startedAt,
          completedAt: ph.completedAt,
          error: ph.error,
        })),
        createdAt: p.createdAt,
        completedAt: p.completedAt,
      }));

    return res.json({
      ok: true,
      issueKey,
      timeline,
      pipelines: issuePipelines,
      total: timeline.length,
    });
  });
}

module.exports = { registerPipelineRoutes };
