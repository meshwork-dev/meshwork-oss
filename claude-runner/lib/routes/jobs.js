// jobs.js — routes/jobs routes
// Extracted from runner.js.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("../../db");
const { validateObservations } = require("../observations");
const { DEFAULT_WORKING_DIR, LOG_DIR, SSE_ENABLED, config } = require("../config");
const { metrics, saveMetrics } = require("../metrics");
const { requireSecret, secretMatches } = require("../middleware");
const { resolveProduct } = require("../products");
const { getJob, jobEmitter, jobs, queue, verificationStats, worktrees } = require("../state");
const { appendLog, nowIso, readTaskProgress } = require("../util");

const { getSubtaskGroup } = require("../subtasks");
const { resolveWorktreeBaseDir } = require("../worktrees");

function registerJobRoutes(app) {

  /**
   * GET /agents - List available agents
   */
  app.get("/agents", requireSecret, (req, res) => {
    const routing = config.routing || {};
    const agentToModel = routing.agentToModel || {};
    const agentToProvider = routing.agentToProvider || {};
    const teamLeads = (config.teams?.enabled && config.teams.teamLeads) || {};

    const agents = Object.keys(agentToModel).map(name => {
      const leadConfig = teamLeads[name];
      return {
        name,
        model: agentToModel[name] || "sonnet",
        provider: agentToProvider[name] || "claude",
        isTeamLead: !!leadConfig,
        teammates: leadConfig?.teammates || [],
        disallowedTools: leadConfig?.disallowedTools || [],
      };
    });

    res.json({ ok: true, agents });
  });

  /**
   * GET /api/teams/active - Active and recent team sessions
   */
  app.get("/api/teams/active", requireSecret, (req, res) => {
    const teamSessions = [];

    for (const job of jobs.values()) {
      if (!job.teamSessionId || job.teamRole !== "lead") continue;

      const isActive = job.status === "running" || job.status === "queued" || job.status === "retry-pending";
      const duration = job.startedAt
        ? (job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now()) - new Date(job.startedAt).getTime()
        : null;

      teamSessions.push({
        teamSessionId: job.teamSessionId,
        leadJobId: job.jobId,
        leadAgent: job.agent,
        teammates: job.teammates || [],
        status: job.status,
        issueKey: job.issueKey || null,
        model: job.selectedModel || job.model || null,
        startedAt: job.startedAt || null,
        finishedAt: job.finishedAt || null,
        duration,
        active: isActive,
      });
    }

    // Sort: active first, then by startedAt descending
    teamSessions.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return bTime - aTime;
    });

    res.json({
      ok: true,
      active: teamSessions.filter(s => s.active).length,
      total: teamSessions.length,
      sessions: teamSessions,
    });
  });

  app.get("/jobs/:jobId", requireSecret, async (req, res) => {
    let job = await getJob(req.params.jobId);

    // Fall back to disk for historical jobs not yet in DB
    if (!job) {
      const metaFile = path.join(LOG_DIR, `${req.params.jobId}.json`);
      if (fs.existsSync(metaFile)) {
        try {
          job = JSON.parse(fs.readFileSync(metaFile, "utf8"));
        } catch {}
      }
    }
    if (!job) return res.status(404).json({ ok: false, error: "job not found" });

    res.json({ ok: true, job: { ...job, stdout: undefined, stderr: undefined } });
  });

  app.get("/jobs/:jobId/output", requireSecret, async (req, res) => {
    let job = await getJob(req.params.jobId);

    // Fall back to disk for historical jobs not yet in DB
    if (!job) {
      const metaFile = path.join(LOG_DIR, `${req.params.jobId}.json`);
      if (fs.existsSync(metaFile)) {
        try {
          job = JSON.parse(fs.readFileSync(metaFile, "utf8"));
        } catch {}
      }
    }
    if (!job) return res.status(404).json({ ok: false, error: "job not found" });

    res.json({
      ok: true,
      jobId: job.jobId,
      status: job.status,
      mode: job.mode,
      parsedOutput: job.parsedOutput,
      error: job.error,
    });
  });

  app.get("/jobs/:jobId/stream-events", requireSecret, async (req, res) => {
    const job = await getJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: "job not found" });
    res.json({
      ok: true,
      jobId: job.jobId,
      events: job.streamEvents || [],
      sessionId: job.sessionId || null,
    });
  });

  app.get("/jobs/:jobId/log", requireSecret, async (req, res) => {
    const job = await getJob(req.params.jobId);
    // For historical jobs, try the log file by convention
    const logFile = job?.logFile || path.join(LOG_DIR, `${req.params.jobId}.log`);
    if (!fs.existsSync(logFile)) return res.status(404).json({ ok: false, error: "log not found" });

    res.setHeader("content-type", "text/plain; charset=utf-8");
    fs.createReadStream(logFile).pipe(res);
  });

  /**
   * LIVE LOG STREAMING ENDPOINT
   * Sends existing log content then watches for new lines via fs.watch.
   * Auto-closes when job completes. Heartbeat every 15s.
   * Auth via x-runner-secret header (clients must proxy server-side).
   */
  app.get("/jobs/:jobId/log/stream", requireSecret, async (req, res) => {
    const job = await getJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: "job not found" });
    if (!job.logFile) return res.status(404).json({ ok: false, error: "no log file" });

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");

    let byteOffset = 0;
    let closed = false;

    // Send existing log content
    if (fs.existsSync(job.logFile)) {
      try {
        const existing = fs.readFileSync(job.logFile, "utf8");
        if (existing.length > 0) {
          res.write(existing);
          byteOffset = Buffer.byteLength(existing, "utf8");
        }
      } catch {}
    }

    // If job is already finished, close immediately
    if (["succeeded", "failed", "cancelled"].includes(job.status)) {
      return res.end();
    }

    // Watch for new content
    let watcher = null;
    try {
      watcher = fs.watch(job.logFile, () => {
        if (closed) return;
        try {
          const stat = fs.statSync(job.logFile);
          if (stat.size > byteOffset) {
            const fd = fs.openSync(job.logFile, "r");
            const buf = Buffer.alloc(stat.size - byteOffset);
            fs.readSync(fd, buf, 0, buf.length, byteOffset);
            fs.closeSync(fd);
            res.write(buf.toString("utf8"));
            byteOffset = stat.size;
          }
        } catch {}
      });
    } catch {}

    // Heartbeat every 15s
    const heartbeat = setInterval(() => {
      if (closed) return;
      try { res.write(""); } catch { cleanup(); }
    }, 15000);

    // Auto-close when job completes
    const onComplete = (eventData) => {
      if (eventData.jobId === job.jobId) {
        // Small delay to catch final log writes
        setTimeout(() => {
          if (!closed) {
            try {
              // Read any remaining content
              if (fs.existsSync(job.logFile)) {
                const stat = fs.statSync(job.logFile);
                if (stat.size > byteOffset) {
                  const fd = fs.openSync(job.logFile, "r");
                  const buf = Buffer.alloc(stat.size - byteOffset);
                  fs.readSync(fd, buf, 0, buf.length, byteOffset);
                  fs.closeSync(fd);
                  res.write(buf.toString("utf8"));
                }
              }
            } catch {}
            cleanup();
            res.end();
          }
        }, 500);
      }
    };

    jobEmitter.on("job:succeeded", onComplete);
    jobEmitter.on("job:failed", onComplete);
    jobEmitter.on("job:cancelled", onComplete);

    function cleanup() {
      closed = true;
      clearInterval(heartbeat);
      if (watcher) { try { watcher.close(); } catch {} }
      jobEmitter.off("job:succeeded", onComplete);
      jobEmitter.off("job:failed", onComplete);
      jobEmitter.off("job:cancelled", onComplete);
    }

    req.on("close", () => cleanup());
  });

  /**
   * JOB CANCELLATION ENDPOINT (Phase 1.3)
   */
  app.delete("/jobs/:jobId", requireSecret, async (req, res) => {
    const job = await getJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: "not found" });

    // If running, try to kill the process
    if (job.status === "running" && job.processPid) {
      try {
        process.kill(job.processPid, "SIGTERM");
        appendLog(job.logFile, `\n[${nowIso()}] Job cancelled, process killed\n`);
      } catch (e) {
        appendLog(job.logFile, `\n[${nowIso()}] Failed to kill process: ${e.message}\n`);
      }
    }

    // If queued, remove from queue
    if (job.status === "queued") {
      const idx = queue.findIndex(q => q.jobId === req.params.jobId);
      if (idx >= 0) queue.splice(idx, 1);
    }

    job.status = "cancelled";
    job.cancelledAt = nowIso();
    job.finishedAt = nowIso();

    // Update metrics
    metrics.jobs.cancelled++;
    saveMetrics();

    // Emit cancelled event
    jobEmitter.emit("job:cancelled", {
      jobId: job.jobId,
      agent: job.agent,
      issueKey: job.issueKey,
      cancelledAt: job.cancelledAt
    });

    fs.writeFileSync(job.metaFile, JSON.stringify({ ...job, stdout: undefined, stderr: undefined }, null, 2), "utf8");


    // Persist to DB and evict from in-memory cache
    db.jobs.set(job).then(() => {
      jobs.delete(job.jobId);
    }).catch(e => console.error(`[db] Failed to persist cancelled job ${job.jobId}: ${e.message}`));

    res.json({ ok: true, status: "cancelled", jobId: job.jobId });
  });

  /**
   * RETRY A FAILED/CANCELLED JOB
   */
  app.post("/jobs/:jobId/retry", requireSecret, async (req, res) => {
    let job = await getJob(req.params.jobId);

    // Fall back to disk for historical jobs not yet in DB
    if (!job) {
      const metaFile = path.join(LOG_DIR, `${req.params.jobId}.json`);
      if (fs.existsSync(metaFile)) {
        try {
          job = JSON.parse(fs.readFileSync(metaFile, "utf8"));
        } catch {}
      }
    }
    if (!job) return res.status(404).json({ ok: false, error: "job not found" });

    if (!["failed", "cancelled"].includes(job.status)) {
      return res.status(400).json({ ok: false, error: `cannot retry job with status '${job.status}'` });
    }

    // Resolve workingDir — worktree paths always fall back to base repo
    let retryWorkingDir = job.workingDir;
    const wtBaseDir = resolveWorktreeBaseDir();
    if (retryWorkingDir && retryWorkingDir.startsWith(wtBaseDir)) {
      const wtRecord = Array.from(worktrees.values()).find(w => w.path === retryWorkingDir);
      retryWorkingDir = wtRecord?.baseRepo || DEFAULT_WORKING_DIR;
      console.log(`[${nowIso()}] Retry: worktree path resolved to ${retryWorkingDir}`);
    }

    // Re-submit based on original mode
    const modeEndpoints = { agent: "/agent", delivery: "/run", chat: "/chat" };
    const endpoint = modeEndpoints[job.mode];
    if (!endpoint) {
      return res.status(400).json({ ok: false, error: `cannot retry mode '${job.mode}'` });
    }

    if (job.mode === "agent") {
      req.body = {
        agent: job.agent,
        prompt: job.prompt,
        context: job.context || "",
        workingDir: retryWorkingDir,
        model: job.model,
      };
    } else if (job.mode === "delivery") {
      req.body = {
        issueKey: job.issueKey,
        summary: job.summary,
        description: job.description,
        agent: job.agent,
        workingDir: retryWorkingDir,
        model: job.model,
        callbackUrl: job.callbackUrl || null,
      };
    } else if (job.mode === "chat") {
      req.body = {
        agent: job.agent,
        message: job.message || job.prompt,
        conversationId: job.conversationId,
        workingDir: retryWorkingDir,
        model: job.model,
        callbackUrl: job.callbackUrl || null,
        telegram: job.telegram || null,
      };
    }

    // Forward to the appropriate endpoint handler
    req.url = endpoint;
    req.method = "POST";
    app.handle(req, res);
  });

  /**
   * REAL-TIME SSE ENDPOINT (Phase 1.4)
   */
  /**
   * Structured observations intake — the HTTP transport of the observations
   * channel (the worktree file is the other). Auth: the job-scoped token issued
   * into the agent's environment (preferred; a leaked token can't touch other
   * jobs) or the global runner secret. Once a job is terminal and evicted from
   * memory, submission is rejected — observations inform the gate, they don't
   * trail it.
   */
  app.post("/jobs/:jobId/observations", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Unknown or already-finalised job" });

    const token = req.header("x-meshwork-job-token") || "";
    const tokenOk = !!job.jobToken && token.length > 0 && (() => {
      const a = crypto.createHash("sha256").update(token).digest();
      const b = crypto.createHash("sha256").update(job.jobToken).digest();
      return crypto.timingSafeEqual(a, b);
    })();
    if (!tokenOk && !secretMatches(req.header("x-runner-secret"))) {
      return res.status(401).json({ error: "Invalid job token" });
    }

    const { ok, errors, observations } = validateObservations(req.body);
    if (!ok) {
      return res.status(400).json({ error: "Invalid observations payload", details: errors });
    }

    job.observations = observations;
    job.observationsSource = "http";
    db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${job.jobId}: ${e.message}`));
    appendLog(job.logFile, `\n[${nowIso()}] Observations submitted via HTTP (${observations.findings.length} finding(s), ${observations.acChecks.length} AC check(s))\n`);
    jobEmitter.emit("job:observations", { jobId: job.jobId, source: "http", findings: observations.findings.length });
    res.json({ ok: true, findings: observations.findings.length, acChecks: observations.acChecks.length });
  });

  /**
   * Verification sampling metrics — the overturn-rate instrumentation.
   * In-memory since last restart; per-pipeline results live on the persisted
   * pipeline records (phases[].verification).
   */
  app.get("/api/verification-stats", requireSecret, (_req, res) => {
    const overturnRate = verificationStats.completed > 0
      ? Number((verificationStats.overturned / verificationStats.completed).toFixed(4))
      : null;
    res.json({ ...verificationStats, overturnRate });
  });

  app.get("/events", requireSecret, (req, res) => {
    if (!SSE_ENABLED) {
      return res.status(403).json({ ok: false, error: "SSE disabled" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

    // Send initial connection message
    res.write(`event: connected\ndata: ${JSON.stringify({ time: nowIso() })}\n\n`);

    const events = [
      "job:queued", "job:started", "job:succeeded", "job:failed", "job:cancelled", "job:retry", "job:team-started",
      "job:hybrid-team-start", "job:hybrid-team-done", "job:local-teammate-start", "job:local-teammate-done",
      "job:progress",
      "pipeline:created", "pipeline:phase-started", "pipeline:phase-complete",
      "pipeline:gate-passed", "pipeline:gate-failed", "pipeline:completed", "pipeline:failed",
      "pipeline:fix-loop", "pipeline:verify-fix-loop",
    ];
    const listeners = events.map(event => {
      const listener = (data) => {
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {}
      };
      jobEmitter.on(event, listener);
      return { event, listener };
    });

    // Send heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      try {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ time: nowIso() })}\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 30000);

    // Cleanup on close
    req.on("close", () => {
      clearInterval(heartbeat);
      listeners.forEach(l => jobEmitter.off(l.event, l.listener));
    });
  });

  /**
   * LIST ENDPOINTS (for dashboard)
   */

  // GET /api/jobs - List all jobs (active + historical) with pagination and filtering
  app.get("/api/jobs", requireSecret, async (req, res) => {
    // Helper to resolve product id/name from workingDir
    function productForDir(workingDir) {
      const p = resolveProduct(workingDir);
      return p ? { id: p.id, name: p.name } : null;
    }

    const statusFilter = req.query.status;
    const agentFilter = req.query.agent;
    const productFilter = req.query.product;
    const search = req.query.search;
    const sortField = req.query.sort || "createdAt";
    const sortOrder = req.query.order === "asc" ? "asc" : "desc";
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    // Fetch from DB (includes all terminal + recently-synced non-terminal jobs)
    let dbResult = { jobs: [], total: 0 };
    try {
      dbResult = await db.jobs.listAll({
        status: statusFilter,
        agent: agentFilter,
        search,
        sort: sortField,
        order: sortOrder,
        limit,
        offset,
      });
    } catch (e) {
      console.error(`[db] /api/jobs listAll failed: ${e.message}`);
    }

    // Enrich DB results with product info and merge in active in-memory jobs
    // that may not yet be in the DB (just created, queued/running)
    const allJobs = new Map();
    for (const j of dbResult.jobs) {
      allJobs.set(j.jobId, { ...j, product: productForDir(j.workingDir) });
    }

    // Override/add active in-memory jobs (more current data)
    for (const j of jobs.values()) {
      // Apply filters manually for in-memory jobs
      if (statusFilter && j.status !== statusFilter) continue;
      if (agentFilter && j.agent !== agentFilter) continue;
      const prod = productForDir(j.workingDir);
      if (productFilter && prod?.id !== productFilter) continue;
      if (search) {
        const q = String(search).toLowerCase();
        if (!(j.jobId && j.jobId.toLowerCase().includes(q)) &&
            !(j.agent && j.agent.toLowerCase().includes(q)) &&
            !(j.issueKey && j.issueKey.toLowerCase().includes(q))) continue;
      }
      allJobs.set(j.jobId, {
        jobId: j.jobId,
        mode: j.mode,
        status: j.status,
        agent: j.agent,
        issueKey: j.issueKey,
        conversationId: j.conversationId,
        batchId: j.batchId,
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        model: j.selectedModel || j.model,
        estimatedCostUsd: j.usage?.estimatedCostUsd || null,
        inputTokens: j.usage?.inputTokens || null,
        outputTokens: j.usage?.outputTokens || null,
        error: j.error,
        lastError: j.lastError,
        parentKey: j.parentKey || null,
        isSubtask: j.isSubtask || false,
        source: j.source || null,
        product: prod,
        workingDir: j.workingDir,
      });
    }

    const jobList = Array.from(allJobs.values());

    // Sort merged list
    const sortDir = sortOrder === "asc" ? 1 : -1;
    jobList.sort((a, b) => {
      const aVal = a[sortField] || "";
      const bVal = b[sortField] || "";
      if (aVal < bVal) return -1 * sortDir;
      if (aVal > bVal) return 1 * sortDir;
      return 0;
    });

    const total = Math.max(dbResult.total, jobList.length);
    const pages = Math.ceil(total / limit);

    return res.json({
      ok: true,
      jobs: jobList.slice(0, limit),
      pagination: { page, limit, total, pages },
    });
  });

  // GET /api/subtasks/:parentKey - Get subtasks for a parent issue
  // Returns subtask progress and status for work breakdown visibility
  app.get("/api/subtasks/:parentKey", requireSecret, (req, res) => {
    const parentKey = req.params.parentKey;
    const group = getSubtaskGroup(parentKey);

    if (!group) {
      return res.json({
        ok: true,
        found: false,
        parentKey,
        subtasks: [],
        message: "No subtask group found for this parent"
      });
    }

    // Enrich subtask info with job status
    const enrichedSubtasks = group.subtasks.map(st => {
      const job = st.jobId ? jobs.get(st.jobId) : null;
      return {
        key: st.key,
        agent: st.agent,
        status: st.status,
        blockedBy: st.blockedBy,
        files: st.files,
        jobId: st.jobId,
        jobStatus: job?.status || null,
        createdAt: st.createdAt,
        updatedAt: st.updatedAt,
      };
    });

    const total = enrichedSubtasks.length;
    const completed = enrichedSubtasks.filter(s => s.status === "completed" || s.jobStatus === "succeeded").length;
    const running = enrichedSubtasks.filter(s => s.status === "running" || s.jobStatus === "running").length;
    const pending = enrichedSubtasks.filter(s => s.status === "pending" || s.jobStatus === "queued").length;
    const failed = enrichedSubtasks.filter(s => s.status === "failed" || s.jobStatus === "failed").length;

    return res.json({
      ok: true,
      found: true,
      parentKey,
      total,
      completed,
      running,
      pending,
      failed,
      progress: total > 0 ? Math.round((completed / total) * 100) : 0,
      subtasks: enrichedSubtasks,
      createdAt: group.createdAt,
    });
  });

  // GET /api/tasks/:issueKey - Get task progress for an issue
  // Tasks are created by Claude Code's Tasks feature and shared across phases
  app.get("/api/tasks/:issueKey", requireSecret, (req, res) => {
    const progress = readTaskProgress(req.params.issueKey);
    if (!progress || !progress.found) {
      return res.json({ ok: true, found: false, issueKey: req.params.issueKey, tasks: [] });
    }
    return res.json({ ok: true, ...progress });
  });
}

module.exports = { registerJobRoutes };
