// worker.js — job queue worker: job creation, execution loop, recovery, DB state restore
// Extracted from runner.js.

const fs = require("fs");
const path = require("path");
const db = require("../db");
const { parseCreateSubtaskBlocks } = require("./protocol");
const {
  ALLOWED_ROOTS,
  DEFAULT_WORKING_DIR,
  IDEMPOTENCY_TTL_HOURS,
  JOB_HEARTBEAT_INTERVAL_MS,
  LOG_DIR,
  MAX_CONCURRENCY_PER_PRODUCT,
  MAX_RETRIES,
  N8N_CALLBACK_URL,
  RUNNER_PUBLIC_URL,
  STALE_JOB_HEARTBEAT_MINUTES,
  STALE_JOB_SWEEP_INTERVAL_MS,
  config,
} = require("./config");
const { loadConversation, saveConversation, trimConversationMessages } = require("./conversations");
const { idempotencyStore, saveIdempotency } = require("./idempotency");
const { stripDownstreamLabelsAfterMerge, stripOwnAgentLabelsOnSuccess } = require("./jira");
const { appendLesson } = require("./lessons");
const { metrics, saveMetrics, skillUsage, updateMetrics } = require("./metrics");
const { detectChromeUsage, selectModel, shouldRunLocal } = require("./models");
const { cleanupOptimizedPluginDir, getProductIdForJob, resolveProduct } = require("./products");
const {
  TERMINAL_STATUSES,
  getRunningForProduct,
  jobEmitter,
  jobs,
  pipelines,
  queue,
  runningByProduct,
  scheduledItems,
  worktrees,
} = require("./state");
const {
  appendLog,
  getJson,
  makeJobId,
  nowIso,
  readTaskProgress,
  truncateForLesson,
} = require("./util");

// Function declarations are hoisted: exporting before requiring sibling
// modules keeps require cycles safe (each module's exports are complete
// before any sibling starts loading).
module.exports = {
  recoverInterruptedJob,
  sweepStaleRunningJobs,
  loadStateFromDB,
  validateWorkingDir,
  createJob,
  persistTerminalJob,
  tickWorker,
  enqueue,
};

const { sendCallbackWithRetry } = require("./callbacks");
const {
  extractAssistantText,
  extractUsageFromOutput,
  runClaude,
  tryParseClaudeJson,
} = require("./claude-exec");
const { detectHybridTeam, runHybridTeam, runLocalDirect } = require("./local-llm");
const { closeMeetingJiraTask } = require("./meetings");
const {
  checkAndTransitionParent,
  createPipeline,
  executePipelinePhase,
  finalizeMergeConflictResolution,
  moveParentToInProgress,
  onPipelinePhaseComplete,
} = require("./pipelines");
const { preReadCodebase } = require("./prompts");
const {
  buildQualityGateRetryContext,
  repairQualityGateFailure,
  runQualityGate,
} = require("./quality-gate");
const { accelerateScheduledItems } = require("./scheduler");
const { dispatchAgentLabelsForIssue } = require("./sprint");
const { scheduleSubtaskVerification, updateSubtaskStatus } = require("./subtasks");
const {
  handleVerificationJobComplete,
  ingestObservationsFile,
  ingestObservationsFromOutput,
  maybeDispatchIndependentReview,
} = require("./verification");
const { mergeBranchIntoDev, withMergeLock } = require("./worktrees");


// Single shared interval covering all running jobs — it stops touching a job
// the moment it leaves "running", so no per-job timers can leak.
setInterval(() => {
  const runningIds = [];
  const now = nowIso();
  for (const job of jobs.values()) {
    if (job.status === "running") {
      job.heartbeatAt = now;
      runningIds.push(job.jobId);
    }
  }
  if (runningIds.length === 0) return;
  db.jobs.touchHeartbeat(runningIds).catch(e => console.error(`[db] heartbeat update failed: ${e.message}`));
}, JOB_HEARTBEAT_INTERVAL_MS);

/**
 * Mark an interrupted job for retry (through the existing retry path) or as
 * failed when its retry budget is exhausted. Persists to DB and emits the
 * existing job events so SSE/dashboard stay consistent.
 */
function recoverInterruptedJob(job, errorMsg) {
  job.lastError = errorMsg;
  const maxRetries = job.maxRetries ?? MAX_RETRIES;
  if ((job.retryCount || 0) < maxRetries && !job.pipelineId) {
    job.retryCount = (job.retryCount || 0) + 1;
    job.status = "retry-pending";
    job.retryAt = new Date(Date.now() + 5000).toISOString();
    jobs.set(job.jobId, job);
    db.jobs.set(job).catch(e => console.error(`[db] Failed to persist recovered job ${job.jobId}: ${e.message}`));

    jobEmitter.emit("job:retry", {
      jobId: job.jobId,
      agent: job.agent,
      retryCount: job.retryCount,
      retryAt: job.retryAt,
      error: errorMsg
    });

    setTimeout(() => {
      if (job.status === "retry-pending") {
        job.status = "queued";
        job.startedAt = null;
        queue.push({ jobId: job.jobId });
        tickWorker();
      }
    }, 5000);
  } else {
    job.status = "failed";
    job.error = errorMsg;
    job.finishedAt = job.finishedAt || new Date().toISOString();
    db.jobs.set(job).then(() => {
      jobs.delete(job.jobId);
    }).catch(e => console.error(`[db] Failed to persist failed job ${job.jobId}: ${e.message}`));

    jobEmitter.emit("job:failed", {
      jobId: job.jobId,
      agent: job.agent,
      issueKey: job.issueKey,
      error: job.error,
      retryCount: job.retryCount || 0,
      finishedAt: job.finishedAt
    });
  }
}

async function sweepStaleRunningJobs() {
  let staleJobs;
  try {
    staleJobs = await db.jobs.findStaleRunning(STALE_JOB_HEARTBEAT_MINUTES);
  } catch (e) {
    console.error(`[db] stale-job sweep query failed: ${e.message}`);
    return;
  }
  for (const dbJob of staleJobs) {
    // Guard against double-handling: jobs legitimately tracked as running in
    // memory are owned by the heartbeat interval — only sweep orphaned rows.
    const inMemory = jobs.get(dbJob.jobId);
    if (inMemory && inMemory.status === "running") continue;
    const job = inMemory || dbJob;
    console.log(`[${nowIso()}] Stale-job sweep: ${job.jobId} (agent=${job.agent}) no heartbeat for ${STALE_JOB_HEARTBEAT_MINUTES}+ minutes — recovering`);
    recoverInterruptedJob(job, `interrupted: runner lost job (no heartbeat for ${STALE_JOB_HEARTBEAT_MINUTES}+ minutes)`);
  }
}

setInterval(() => {
  sweepStaleRunningJobs().catch(e => console.error(`[${nowIso()}] Stale-job sweep error: ${e.message}`));
}, STALE_JOB_SWEEP_INTERVAL_MS);

async function loadStateFromDB() {
  try {
    // Load active jobs from DB into cache
    const activeJobs = await db.jobs.findByStatus("queued", "running", "retry-pending", "quality-gate-retry");
    const maxStaleMs = 4 * 60 * 60 * 1000; // 4 hours — jobs older than this are stale, not restartable
    let staleCount = 0;
    for (const job of activeJobs) {
      // Skip stale jobs — they were left in non-terminal state from a previous crash
      const jobAge = Date.now() - new Date(job.startedAt || job.createdAt).getTime();
      if (jobAge > maxStaleMs) {
        job.status = "failed";
        job.error = "Stale job from previous runner session (too old to retry)";
        job.finishedAt = job.finishedAt || new Date().toISOString();
        db.jobs.set(job).catch(() => {});
        staleCount++;
        continue;
      }
      // Mark interrupted running jobs as failed with retry budget.
      //
      // KNOWN BUG (deferred fix): when an interrupted job belongs to a pipeline
      // phase, retry-pending here races the pipeline's own resume logic below
      // (line ~5919-5927) — both will spawn a fresh job for the same phase.
      // The orphan from this path runs in parallel against the same worktree
      // and, when it eventually finishes, fires a stale onPipelinePhaseComplete
      // (mitigated by the guard at the top of that function). Two writers
      // against the same worktree is still a correctness risk; the proper fix
      // is to skip retry-pending here when job.pipelineId is set and let the
      // pipeline-resume path own re-execution.
      if (job.status === "running" || job.status === "queued" || job.status === "retry-pending" || job.status === "quality-gate-retry") {
        job.status = "failed";
        job.error = "interrupted: runner restarted mid-job";
        job.lastError = job.error;
        job.finishedAt = job.finishedAt || new Date().toISOString();
        const maxRetries = job.maxRetries ?? MAX_RETRIES;
        if ((job.retryCount || 0) < maxRetries && !job.pipelineId) {
          job.status = "retry-pending";
          job.retryCount = (job.retryCount || 0) + 1;
          job.retryAt = new Date(Date.now() + 5000).toISOString();
          jobEmitter.emit("job:retry", {
            jobId: job.jobId,
            agent: job.agent,
            retryCount: job.retryCount,
            retryAt: job.retryAt,
            error: job.lastError
          });
        } else {
          jobEmitter.emit("job:failed", {
            jobId: job.jobId,
            agent: job.agent,
            issueKey: job.issueKey,
            error: job.error,
            retryCount: job.retryCount || 0,
            finishedAt: job.finishedAt
          });
        }
      }
      if (!TERMINAL_STATUSES.has(job.status)) {
        jobs.set(job.jobId, job);
      }
      db.jobs.set(job).catch(() => {});
    }

    // Load active pipelines — resume running ones
    const activePipelines = await db.pipelines.findByStatus("running", "blocked");
    for (const pipeline of activePipelines) {
      if (pipeline.status === "running") {
        pipelines.set(pipeline.pipelineId, pipeline);
        const phaseIndex = (pipeline.phases || []).findIndex(
          (p) => p.status === "pending" || p.status === "running"
        );
        if (phaseIndex >= 0) {
          if (pipeline.phases[phaseIndex].status === "running") {
            pipeline.phases[phaseIndex].status = "pending";
            pipeline.phases[phaseIndex].jobId = null;
            pipeline.phases[phaseIndex].startedAt = null;
          }
          console.log(`[${nowIso()}] Resuming pipeline ${pipeline.pipelineId} at phase ${pipeline.phases[phaseIndex].name} (index ${phaseIndex})`);
          db.pipelines.set(pipeline).catch(() => {});
          setTimeout(() => executePipelinePhase(pipeline, phaseIndex), 10000);
        } else {
          const allPassed = pipeline.phases.every((p) => p.status === "completed");
          pipeline.status = allPassed ? "completed" : "failed";
          pipeline.error = allPassed ? undefined : "No resumable phase found after restart";
          pipeline.completedAt = pipeline.completedAt || new Date().toISOString();
          console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} resolved on reload: ${pipeline.status}`);
          db.pipelines.set(pipeline).catch(() => {});
        }
      } else {
        pipelines.set(pipeline.pipelineId, pipeline);
      }
    }

    // Load active worktrees
    const activeWorktrees = await db.worktrees.findActive();
    for (const wt of activeWorktrees) {
      worktrees.set(wt.id, wt);
    }

    // Load active meetings — mark interrupted ones as ended
    const activeMeetings = await db.meetings.findActive();
    for (const m of activeMeetings) {
      if (m.status === "active") {
        m.status = "ended";
        m.endedAt = m.endedAt || new Date().toISOString();
        m.summary = m.summary || "(Meeting interrupted by runner restart)";
        db.meetings.set(m).catch(() => {});
      }
    }

    // Load pending scheduled items
    const pendingItems = await db.scheduled.findPending();
    for (const item of pendingItems) {
      scheduledItems.set(item.id, item);
    }

    // Load skill usage
    const skills = await db.skillUsage.getAll();
    Object.assign(skillUsage, skills);

    // Load metrics
    const savedMetrics = await db.metrics.get();
    if (savedMetrics && Object.keys(savedMetrics).length > 0) {
      Object.assign(metrics, savedMetrics);
    }

    const pendingScheduled = Array.from(scheduledItems.values()).filter(s => !s.status || s.status === "pending").length;
    const skillCount = Object.keys(skillUsage).length;
    console.log(`[${new Date().toISOString()}] Restored state from DB: ${jobs.size} active jobs (${staleCount} stale marked failed), ${pipelines.size} active pipelines, ${worktrees.size} worktrees, ${pendingScheduled} scheduled, ${skillCount} skill(s)`);

    // Re-queue jobs that were pending retry
    for (const [id, job] of jobs.entries()) {
      if (job.status === "retry-pending") {
        const delay = Math.max(0, new Date(job.retryAt).getTime() - Date.now());
        setTimeout(() => {
          if (job.status === "retry-pending") {
            job.status = "queued";
            job.startedAt = null;
            queue.push({ jobId: id });
            tickWorker();
          }
        }, Math.min(delay, 10000));
      }
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Failed to load state from DB: ${e.message}`);
  }
}

/**
 * Validate workingDir
 */
function validateWorkingDir(workingDir) {
  if (!workingDir || typeof workingDir !== "string") {
    return { ok: false, error: "workingDir is required" };
  }

  // Apply path mappings (host path → container path)
  let mapped = workingDir;
  const mappings = config.pathMappings || {};
  for (const [from, to] of Object.entries(mappings)) {
    if (mapped === from || mapped.startsWith(from + "/") || mapped.startsWith(from + path.sep)) {
      const candidate = path.resolve(to + mapped.slice(from.length));
      const mappedRoot = path.resolve(to);
      // The mapped result must stay inside the mapping's target root
      // (reject "../" escapes smuggled in via the suffix).
      if (candidate !== mappedRoot && !candidate.startsWith(mappedRoot + path.sep)) {
        return { ok: false, error: `workingDir not allowed: ${candidate}. Escapes mapped root: ${mappedRoot}` };
      }
      mapped = candidate;
      break;
    }
  }

  const resolved = path.resolve(mapped);

  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `workingDir does not exist: ${resolved}` };
  }

  if (ALLOWED_ROOTS.length > 0) {
    const allowed = ALLOWED_ROOTS.some((root) => {
      const rr = path.resolve(root);
      return resolved === rr || resolved.startsWith(rr + path.sep);
    });
    if (!allowed) {
      return {
        ok: false,
        error: `workingDir not allowed: ${resolved}. Must be under one of: ${ALLOWED_ROOTS.join(", ")}`,
      };
    }
  }

  return { ok: true, resolved };
}

/**
 * Build a job object with the construction shared by the /run, /chat and
 * /agent endpoints, then persist it (in-memory map, DB write-through, meta
 * file). Per-mode fields (agent, workingDir, issueKey, message, prompt,
 * subtask fields, slack, …) are passed explicitly via `fields`.
 *
 * Does NOT enqueue — call sites enqueue(job.jobId) themselves so endpoint-
 * specific steps (e.g. /run idempotency registration) keep their ordering.
 *
 * @param {object} opts
 * @param {string} opts.mode - "delivery" | "chat" | "agent"
 * @param {object} opts.jobIn - raw request job payload (model/provider/maxRetries/telegram/batchId/source extraction)
 * @param {string|null} opts.callbackUrl - already-defaulted callback URL (defaults differ per endpoint)
 * @param {object} opts.fields - per-mode job fields, spread into the job object
 * @returns {object} the created job
 */
function createJob({ mode, jobIn, callbackUrl, fields }) {
  const jobId = makeJobId();
  const logFile = path.join(LOG_DIR, `${jobId}.log`);
  const metaFile = path.join(LOG_DIR, `${jobId}.json`);

  const job = {
    jobId,
    mode,

    // Per-mode fields (agent, workingDir, issueKey, message, prompt, …)
    ...fields,

    // Model routing (Phase: Multi-Model)
    model: jobIn.model || null, // Optional override (opus/sonnet/haiku)
    requestedProvider: jobIn.provider || null, // Optional provider override (claude/zai)
    selectedModel: null,  // Set by selectModel() at execution time

    status: "queued",
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,

    logFile,
    metaFile,
    processPid: null,

    error: null,
    lastError: null,
    parsedOutput: null,

    // Retry fields (Phase 1.2)
    retryCount: 0,
    maxRetries: jobIn.maxRetries ?? MAX_RETRIES,
    retryAt: null,

    // Quality gate retry tracking (Phase: Quality Gates)
    qualityGateRetryCount: 0,
    qualityGateFailure: null,
    qualityGate: null,

    // Usage tracking (Phase 1.5)
    usage: null,

    callbackUrl,
    telegram: jobIn.telegram || null,
    batchId: jobIn.batchId || null,
    source: jobIn.source || null,

    // Agent Teams metadata (Phase: Agent Teams Visibility)
    teamSessionId: null,
    teamRole: null,  // "lead" or "teammate"
    teammates: [],
  };

  // Populate team metadata if this agent is a team lead
  if (config.teams?.enabled && config.teams.teamLeads?.[job.agent]) {
    job.teamSessionId = `team-${jobId}`;
    job.teamRole = "lead";
    job.teammates = config.teams.teamLeads[job.agent].teammates || [];
  }

  jobs.set(jobId, job);
  db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
  fs.writeFileSync(metaFile, JSON.stringify(job, null, 2), "utf8");

  return job;
}

/**
 * Persist a terminal job to the DB, evicting it from the in-memory cache only
 * on success. Persistence failures used to be logged-and-forgotten, leaving
 * the job invisible to the stale-job sweep and job history; now they escalate:
 * one delayed retry (DB query-level retries have already run), an emitted
 * event for observability, and an explicit pointer to the retained meta file.
 */
function persistTerminalJob(job) {
  db.jobs.set(job).then(() => {
    jobs.delete(job.jobId);
  }).catch(e => {
    console.error(`[db] Failed to persist terminal job ${job.jobId}: ${e.message} — retrying in 30s`);
    jobEmitter.emit("job:persist-failed", { jobId: job.jobId, status: job.status, error: e.message });
    const t = setTimeout(() => {
      db.jobs.set(job).then(() => {
        jobs.delete(job.jobId);
        console.log(`[db] Terminal job ${job.jobId} persisted on delayed retry`);
      }).catch(e2 => {
        console.error(`[db] PERMANENT: terminal job ${job.jobId} not persisted (${e2.message}). State retained in memory and at ${job.metaFile}`);
      });
    }, 30000);
    if (typeof t.unref === "function") t.unref();
  });
}

/**
 * Worker loop
 */
async function tickWorker() {
  if (queue.length === 0) return;

  // Find first job in queue whose product has available capacity and no unresolved deps
  let idx = -1;
  for (let i = 0; i < queue.length; i++) {
    const candidate = jobs.get(queue[i].jobId);
    if (!candidate || candidate.status === "cancelled") { idx = i; break; } // will be cleaned up
    // Skip jobs still waiting on a dependency to complete
    if (candidate.blockedByJobIds?.length) {
      const isBlocked = candidate.blockedByJobIds.some(id => {
        const dep = jobs.get(id);
        return !dep || dep.status !== "succeeded";
      });
      if (isBlocked) continue;
    }
    const pid = getProductIdForJob(candidate);
    if (getRunningForProduct(pid) < MAX_CONCURRENCY_PER_PRODUCT) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return; // all products at capacity

  const { jobId } = queue.splice(idx, 1)[0];
  const job = jobs.get(jobId);
  if (!job) return;

  // Skip if job was cancelled while in queue
  if (job.status === "cancelled") { setImmediate(tickWorker); return; }

  const productId = getProductIdForJob(job);
  job._productId = productId;
  runningByProduct.set(productId, getRunningForProduct(productId) + 1);
  job.status = "running";
  job.startedAt = nowIso();
  job.heartbeatAt = job.startedAt;
  // Persist the running status + initial heartbeat so the stale-job sweep can
  // detect this job if the runner dies mid-execution.
  db.jobs.set(job).catch(e => console.error(`[db] Failed to persist running job ${job.jobId}: ${e.message}`));

  // Select model before execution
  job.selectedModel = selectModel(job);
  appendLog(job.logFile, `[${nowIso()}] Selected model: ${job.selectedModel}\n`);

  // Emit job started event
  jobEmitter.emit("job:started", {
    jobId: job.jobId,
    agent: job.agent,
    issueKey: job.issueKey,
    mode: job.mode,
    selectedModel: job.selectedModel,
    startedAt: job.startedAt
  });

  // Emit team-started event for team lead jobs
  if (job.teamSessionId && job.teamRole === "lead") {
    const leadConfig = config.teams?.teamLeads?.[job.agent] || {};
    jobEmitter.emit("job:team-started", {
      jobId: job.jobId,
      teamSessionId: job.teamSessionId,
      agent: job.agent,
      teammates: job.teammates || [],
      disallowedTools: leadConfig.disallowedTools || [],
      issueKey: job.issueKey,
      startedAt: job.startedAt
    });
  }

  // Transition parent story to "In Progress" when first subtask starts running
  if (job.parentKey) {
    setImmediate(() => {
      moveParentToInProgress(job.parentKey).catch(e => {
        console.log(`[${nowIso()}] Parent In Progress transition failed for ${job.parentKey}: ${e.message}`);
      });
    });
  }

  // Send "started" callback for Slack progress updates
  if (job.callbackUrl) {
    await sendCallbackWithRetry(job.callbackUrl, {
      jobId: job.jobId,
      event: "started",
      status: "running",
      agent: job.agent,
      selectedModel: job.selectedModel,
      issueKey: job.issueKey || null,
      workingDir: job.workingDir || null,
      slack: job.slack || null,
      telegram: job.telegram || null,
      startedAt: job.startedAt
    }, job, 2);
  }


  let callbackPayload = null;

  try {
    // Pre-read codebase via local model for eligible agents (token compression)
    if (config.preRead?.enabled) {
      const preReadBrief = await preReadCodebase(job);
      if (preReadBrief) {
        job.preReadBrief = preReadBrief;
        appendLog(job.logFile, `[${nowIso()}] Pre-read brief injected (${preReadBrief.length} chars)\n`);
      }
    }

    // Hybrid team: route local teammates through LM Studio, cloud through Claude
    // Skip hybrid team for pipeline triage/planning phases — they should run solo
    const isPlanOnlyPhase = job.pipelinePhase && ["triage", "requirements", "architecture", "ux-design", "code-review", "security-review", "verify", "acceptance"].includes(job.pipelinePhase);
    const hybridTeam = isPlanOnlyPhase ? null : detectHybridTeam(job);
    let result;
    if (hybridTeam) {
      result = await runHybridTeam(job);
    } else if (!isPlanOnlyPhase && shouldRunLocal(job)) {
      // Route eligible agents directly to LM Studio (pipeline or standalone)
      result = await runLocalDirect(job);
    } else {
      // All providers (claude, zai) go through runClaude → Claude CLI
      result = await runClaude(job);
    }

    job.finishedAt = nowIso();
    job.status = "succeeded";
    job.stdout = result.stdout;
    job.stderr = result.stderr;
    // Prefer the pre-parsed lastStreamEvent (result type) over re-parsing stdout
    job.parsedOutput = result.lastStreamEvent?.type === "result" ? result.lastStreamEvent : tryParseClaudeJson(result.stdout);

    // Extract and store usage/cost info (Phase 1.5)
    job.usage = extractUsageFromOutput(job.parsedOutput);

    // Detect and log Chrome tool usage
    if (job.chromeEnabled) {
      const chromeUsage = detectChromeUsage(result.stdout);
      job.chromeUsage = chromeUsage;

      // Update Chrome metrics
      metrics.chrome.sessionsEnabled++;
      if (chromeUsage.used) {
        metrics.chrome.sessionsUsed++;
        metrics.chrome.toolCalls += chromeUsage.count;
        for (const tool of chromeUsage.tools) {
          metrics.chrome.byTool[tool] = (metrics.chrome.byTool[tool] || 0) + 1;
        }
        appendLog(job.logFile, `[${nowIso()}] Chrome tools used: ${chromeUsage.tools.join(", ")} (${chromeUsage.count} calls)\n`);
      } else {
        appendLog(job.logFile, `[${nowIso()}] Chrome available but not used by agent\n`);
      }
      saveMetrics();
    }

    // Run quality gate for configured agents (Phase: Multi-Model + Quality Gates)
    const qgResult = await runQualityGate(job);
    job.qualityGate = qgResult;

    if (!qgResult.passed && !qgResult.skipped) {
      // Quality gate failed - attempt targeted repair
      const qgMaxRetries = config.qualityGate.maxRetries || 2;
      const failedCheck = qgResult.failedCheck;

      if (failedCheck) {
        appendLog(job.logFile, `\n[${nowIso()}] Quality gate check "${failedCheck.name}" failed — starting targeted repair (up to ${qgMaxRetries} attempts)\n`);

        let repaired = false;
        for (let attempt = 1; attempt <= qgMaxRetries; attempt++) {
          job.qualityGateRetryCount = attempt;
          job.status = "quality-gate-retry";

          jobEmitter.emit("job:quality-gate-retry", {
            jobId: job.jobId,
            agent: job.agent,
            failedCheck: failedCheck.name,
            retryCount: attempt,
          });

          fs.writeFileSync(job.metaFile, JSON.stringify({ ...job, stdout: undefined, stderr: undefined }, null, 2), "utf8");
        

          const repair = await repairQualityGateFailure(job, failedCheck, attempt);
          if (repair.repaired) {
            repaired = true;
            appendLog(job.logFile, `[${nowIso()}] Repair attempt ${attempt} succeeded — re-running full quality gate\n`);

            // Re-run ALL checks (the repair may have broken something else)
            const recheckAll = await runQualityGate(job);
            job.qualityGate = recheckAll;

            if (recheckAll.passed) {
              appendLog(job.logFile, `[${nowIso()}] Full quality gate PASSED after repair\n`);
              break;
            } else {
              // Repair fixed the original check but broke another — loop with new failedCheck
              appendLog(job.logFile, `[${nowIso()}] Repair fixed "${failedCheck.name}" but "${recheckAll.failedCheck?.name}" now failing\n`);
              repaired = false;
              if (recheckAll.failedCheck) {
                Object.assign(failedCheck, recheckAll.failedCheck);
              }
            }
          }
        }

        if (repaired && job.qualityGate?.passed) {
          // Repair succeeded — restore succeeded status and continue normal flow
          job.status = "succeeded";
          appendLog(job.logFile, `[${nowIso()}] Quality gate PASSED (after ${job.qualityGateRetryCount} repair attempt(s))\n`);
          // Fall through to success path below
        } else {
          // All repair attempts exhausted
          job.qualityGateFailure = qgResult.retryContext || buildQualityGateRetryContext(job, failedCheck);
        }
      }

      // Check if we're still in a failed state (repair didn't work or no failedCheck)
      if (!job.qualityGate?.passed) {
        job.finishedAt = nowIso();
        job.status = "quality-gate-failed";
        job.error = `Quality gate check "${qgResult.failedCheck?.name || "unknown"}" failed after ${job.qualityGateRetryCount || 0} repair attempts`;

        appendLog(job.logFile, `\n[${nowIso()}] Quality gate failed permanently: ${job.error}\n`);

        // Record for cross-agent learning: future implementer prompts include this
        appendLesson("quality-gate", job.issueKey,
          `Agent ${job.agent} failed check "${qgResult.failedCheck?.name || "unknown"}". ` +
          truncateForLesson(qgResult.failedCheck?.output || job.error, 800));

        fs.writeFileSync(job.metaFile, JSON.stringify({ ...job, stdout: undefined, stderr: undefined }, null, 2), "utf8");
        updateMetrics(job, "failed", job.usage);

        jobEmitter.emit("job:failed", {
          jobId: job.jobId,
          agent: job.agent,
          issueKey: job.issueKey,
          error: job.error,
          qualityGate: qgResult,
          finishedAt: job.finishedAt
        });

        callbackPayload = {
          jobId: job.jobId,
          status: job.status,
          event: "completed",
          mode: job.mode,
          agent: job.agent,
          issueKey: job.issueKey || null,
          workingDir: job.workingDir || null,
          parsedOutput: job.parsedOutput,
          qualityGate: qgResult,
          error: job.error,
          logUrl: `${RUNNER_PUBLIC_URL}/jobs/${job.jobId}/log`,
          finishedAt: job.finishedAt,
          slack: job.slack || null,
          telegram: job.telegram || null,
          batchId: job.batchId || null,
        };

        // Send callback and exit
        if (callbackPayload && job.callbackUrl) {
          await sendCallbackWithRetry(job.callbackUrl, callbackPayload, job);
        }
      

        // Persist terminal job to DB and evict from in-memory cache
        persistTerminalJob(job);

        // Notify pipeline engine so it can mark the phase/pipeline as failed
        // (must happen here because we return early and skip the hook below)
        if (job.pipelineId && job.pipelinePhaseIndex != null) {
          const pipeline = pipelines.get(job.pipelineId);
          if (pipeline && pipeline.status === "running") {
            setImmediate(() => {
              onPipelinePhaseComplete(pipeline, job.pipelinePhaseIndex, job).catch(e => {
                console.error(`[${nowIso()}] Pipeline phase completion error (quality-gate-failed) (${job.pipelineId}): ${e.message}`);
              });
            });
          }
        }

        const _pid = job._productId || getProductIdForJob(job);
        runningByProduct.set(_pid, Math.max(0, getRunningForProduct(_pid) - 1));
        setImmediate(tickWorker);
        return;
      }
    }

    // Structured observations: ingest the worktree file transport (HTTP
    // submissions land on the job directly), then settle any verification
    // review this job was dispatched as.
    try {
      ingestObservationsFile(job);
      ingestObservationsFromOutput(job);
      if (job.verificationOf) handleVerificationJobComplete(job);
    } catch (e) {
      console.error(`[${nowIso()}] Observations processing error for ${job.jobId}: ${e.message}`);
    }

    // Update conversation memory for chat jobs
    if (job.mode === "chat" && job.conversationId) {
      const parsed = job.parsedOutput;
      const assistantText = extractAssistantText(parsed);

      const conv = await loadConversation(job.conversationId);
      const updated = trimConversationMessages([
        ...(conv.messages || []),
        { role: "user", content: job.message, ts: nowIso() },
        ...(assistantText ? [{ role: "assistant", content: assistantText, ts: nowIso() }] : []),
      ]);

      await saveConversation(job.conversationId, updated, job._productId || null);
    }

    fs.writeFileSync(job.metaFile, JSON.stringify({ ...job, stdout: undefined, stderr: undefined }, null, 2), "utf8");

    // Update metrics
    updateMetrics(job, "succeeded", job.usage);

    // Emit job succeeded event
    jobEmitter.emit("job:succeeded", {
      jobId: job.jobId,
      agent: job.agent,
      issueKey: job.issueKey,
      result: job.parsedOutput?.result,
      usage: job.usage,
      finishedAt: job.finishedAt
    });

    // Read task progress for cross-phase visibility
    const taskProgress = job.issueKey ? readTaskProgress(job.issueKey) : null;

    callbackPayload = {
      jobId: job.jobId,
      status: job.status,
      event: "completed",
      mode: job.mode,
      agent: job.agent,
      selectedModel: job.selectedModel,
      issueKey: job.issueKey || null,
      conversationId: job.conversationId || null,
      workingDir: job.workingDir || null,
      parsedOutput: job.parsedOutput,
      usage: job.usage,
      qualityGate: job.qualityGate || null,
      taskProgress,
      error: null,
      logUrl: `${RUNNER_PUBLIC_URL}/jobs/${job.jobId}/log`,
      finishedAt: job.finishedAt,
      slack: job.slack || null,
      telegram: job.telegram || null,
      batchId: job.batchId || null,
      meetingAction: job.meetingAction || null,
      source: job.source || null,
    };

    // Runner-side [CREATE-SUBTASKS] parsing: ship structured blocks in the
    // callback (so N8N doesn't have to re-parse free text) and verify the
    // subtasks actually appear in the tracker afterwards.
    {
      const outputTextFull = (job.parsedOutput?.result || "") + "\n" + (job.stdout || "");
      const subtaskBlocks = parseCreateSubtaskBlocks(outputTextFull);
      if (subtaskBlocks.length) {
        callbackPayload.subtaskBlocks = subtaskBlocks;
        scheduleSubtaskVerification(job, subtaskBlocks);
      }
      // Surface flagged ambiguity so it can't silently pass through to shipping
      callbackPayload.needsClarification =
        /\[NEEDS-CLARIFICATION\]|VERDICT:?\s*NEEDS-CLARIFICATION/i.test(outputTextFull) || false;
    }

    // Independent post-team review: a teammate-reviewer shares the team's
    // context (and its hallucinations). Dispatch an isolated reviewer job so
    // review happens against the actual code, not the team's narrative.
    maybeDispatchIndependentReview(job);
  } catch (err) {
    job.lastError = err?.message || String(err);

    // Retry logic
    const maxRetries = job.maxRetries ?? MAX_RETRIES;
    if ((job.retryCount || 0) < maxRetries) {
      job.retryCount = (job.retryCount || 0) + 1;
      const delay = Math.pow(2, job.retryCount) * 1000 + Math.random() * 1000;
      job.status = "retry-pending";
      job.retryAt = new Date(Date.now() + delay).toISOString();

      appendLog(job.logFile, `\n[${nowIso()}] Retry ${job.retryCount}/${maxRetries} scheduled in ${Math.round(delay)}ms\n`);
      fs.writeFileSync(job.metaFile, JSON.stringify({ ...job, stdout: undefined, stderr: undefined }, null, 2), "utf8");

      metrics.jobs.retried++;
      saveMetrics();

      jobEmitter.emit("job:retry", {
        jobId: job.jobId,
        agent: job.agent,
        retryCount: job.retryCount,
        retryAt: job.retryAt,
        error: job.lastError
      });

      setTimeout(() => {
        if (job.status === "retry-pending") {
          job.status = "queued";
          job.startedAt = null;
          queue.push({ jobId: job.jobId });
          tickWorker();
        }
      }, delay);

      const _pid2 = job._productId || getProductIdForJob(job);
      runningByProduct.set(_pid2, Math.max(0, getRunningForProduct(_pid2) - 1));
      setImmediate(tickWorker);
      return;
    }

    job.finishedAt = nowIso();
    job.status = "failed";
    job.error = job.lastError;

    // Still append the user message to memory so context isn't lost
    if (job.mode === "chat" && job.conversationId) {
      const conv = await loadConversation(job.conversationId);
      const updated = trimConversationMessages([
        ...(conv.messages || []),
        { role: "user", content: job.message, ts: nowIso() },
        { role: "assistant", content: `ERROR: ${job.error}`, ts: nowIso() },
      ]);
      await saveConversation(job.conversationId, updated, job._productId || null);
    }

    fs.writeFileSync(job.metaFile, JSON.stringify({ ...job, stdout: undefined, stderr: undefined }, null, 2), "utf8");

    // Update metrics
    updateMetrics(job, "failed", null);

    // Emit job failed event
    jobEmitter.emit("job:failed", {
      jobId: job.jobId,
      agent: job.agent,
      issueKey: job.issueKey,
      error: job.error,
      retryCount: job.retryCount || 0,
      finishedAt: job.finishedAt
    });

    callbackPayload = {
      jobId: job.jobId,
      status: job.status,
      event: "completed",
      mode: job.mode,
      agent: job.agent,
      issueKey: job.issueKey || null,
      conversationId: job.conversationId || null,
      workingDir: job.workingDir || null,
      parsedOutput: job.parsedOutput || null,
      error: job.error,
      retryCount: job.retryCount || 0,
      logUrl: `${RUNNER_PUBLIC_URL}/jobs/${job.jobId}/log`,
      finishedAt: job.finishedAt,
      slack: job.slack || null,
      telegram: job.telegram || null,
      batchId: job.batchId || null,
      meetingAction: job.meetingAction || null,
      source: job.source || null,
    };
  }

  // Send completion callback (only if not retrying)
  if (callbackPayload && job.callbackUrl) {
    appendLog(job.logFile, `[${nowIso()}] Calling callbackUrl=${job.callbackUrl}\n`);
    await sendCallbackWithRetry(job.callbackUrl, callbackPayload, job);
  }


  // Persist terminal job to DB and evict from in-memory cache
  if (TERMINAL_STATUSES.has(job.status)) {
    persistTerminalJob(job);
  }

  // Post-job: if this was a worktree job, update worktree metadata
  if (job.worktreeId) {
    const wt = worktrees.get(job.worktreeId);
    if (wt) {
      wt.lastJobId = job.jobId;
      wt.lastJobAgent = job.agent;
    
    }
  }

  // Pipeline phase completion hook
  // If this job belongs to a pipeline, notify the pipeline engine
  if (job.pipelineId && job.pipelinePhaseIndex != null) {
    const pipeline = pipelines.get(job.pipelineId);
    if (pipeline && pipeline.status === "running") {
      // Run asynchronously so we don't block the worker loop
      setImmediate(() => {
        onPipelinePhaseComplete(pipeline, job.pipelinePhaseIndex, job).catch(e => {
          console.error(`[${nowIso()}] Pipeline phase completion error (${job.pipelineId}): ${e.message}`);
        });
      });
    }
  }

  // Merge-conflict resolver completion hook
  // Resolver jobs have source=pipeline:<id>:merge-conflict but no pipelinePhaseIndex.
  // When they succeed, finalize the upstream pipeline so Jira auto-transitions and
  // dependency-blocked downstream pipelines unblock on the next ticker pass.
  if (job.pipelineId && typeof job.source === "string" && job.source.endsWith(":merge-conflict") && job.status === "succeeded") {
    const pipeline = pipelines.get(job.pipelineId);
    if (pipeline && !pipeline.merged) {
      setImmediate(() => {
        finalizeMergeConflictResolution(pipeline, job).catch(e => {
          console.error(`[${nowIso()}] finalizeMergeConflictResolution error (${job.pipelineId}): ${e.message}`);
        });
      });
    }
  }

  // Subtask completion tracking + parent auto-transition
  if (job.parentKey && job.issueKey) {
    const finalStatus = job.status === "succeeded" ? "done" : job.status === "failed" ? "failed" : job.status;
    updateSubtaskStatus(job.parentKey, job.issueKey, finalStatus, job.jobId);

    if (job.status === "succeeded") {
      setImmediate(() => {
        checkAndTransitionParent(job.parentKey).catch(e => {
          console.error(`[${nowIso()}] Parent auto-transition check failed for ${job.parentKey}: ${e.message}`);
        });
      });
    }
  }

  // Gate label removal: when a sprint-runner gate agent succeeds, remove the gate label
  // from Jira so the sprint runner dispatches the next gate or the implementation agent.
  // Also clear the idempotency entry so the issue gets re-evaluated on the next tick.
  if (job.gateLabel && job.status === "succeeded" && job.issueKey && job.source === "sprint-runner") {
    const gateLabel = job.gateLabel;
    const allGateLabels = job.allGateLabels || [gateLabel];
    setImmediate(async () => {
      try {
        const { domain, email, apiToken } = config.jira || {};
        if (!domain || !email || !apiToken) return;
        const baseUrl = domain.replace(/\/+$/, "");
        const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
        const headers = { authorization: auth, "content-type": "application/json" };

        // Fetch current labels
        const issueRes = await getJson(`${baseUrl}/rest/api/3/issue/${job.issueKey}?fields=labels`, headers);
        if (!issueRes || issueRes.statusCode !== 200) {
          console.error(`[sprint-runner] Failed to fetch labels for ${job.issueKey}: ${issueRes?.statusCode}`);
          return;
        }
        const currentLabels = issueRes.json?.fields?.labels || [];
        const updatedLabels = currentLabels.filter(l => l !== gateLabel);

        if (updatedLabels.length < currentLabels.length) {
          await new Promise((resolve, reject) => {
            const urlObj = new URL(`${baseUrl}/rest/api/3/issue/${job.issueKey}`);
            const options = {
              hostname: urlObj.hostname,
              port: urlObj.port || 443,
              path: urlObj.pathname,
              method: "PUT",
              headers: { ...headers },
            };
            const req = require("https").request(options, (res) => {
              let body = "";
              res.on("data", d => body += d);
              res.on("end", () => resolve({ statusCode: res.statusCode, body }));
            });
            req.on("error", reject);
            req.write(JSON.stringify({ fields: { labels: updatedLabels } }));
            req.end();
          });
          console.log(`[sprint-runner] Removed gate label "${gateLabel}" from ${job.issueKey} after ${job.agent} succeeded`);

          // Clear idempotency so sprint runner re-evaluates on next tick
          const idempKey = `sprint-run:${job.issueKey}`;
          delete idempotencyStore[idempKey];
          db.idempotency.prune(IDEMPOTENCY_TTL_HOURS).catch(e => console.error('[db] idempotency prune failed: ' + e.message));
          saveIdempotency(idempotencyStore);
        }
      } catch (e) {
        console.error(`[sprint-runner] Failed to remove gate label from ${job.issueKey}: ${e.message}`);
      }
    });
  }

  // Schedule acceleration: bring forward dependent items when predecessor completes early
  if (job.status === "succeeded" && (typeof job.source === "string" ? job.source : job.source?.workflow || "").startsWith("meeting:")) {
    setImmediate(() => accelerateScheduledItems(job));
  }

  // Standalone implementer auto-merge: when engineer-implementer finishes outside
  // a pipeline (label-driven dispatch), the implementer's agent definition tells
  // it the runner will merge into dev. Pipelines do this on completion, but
  // label-driven flows had no equivalent — branches piled up unmerged. This hook
  // mirrors mergePipelineBranchIntoDev() for the non-pipeline path.
  if (job.status === "succeeded" &&
      job.agent === "engineer-implementer" &&
      job.issueKey &&
      job.workingDir &&
      !job.pipelineId &&
      !job.teamSessionId &&
      !job.isSubtask) {
    setImmediate(async () => {
      try {
        await withMergeLock(job.workingDir, async () => {
          const { execSync } = require("child_process");
          const candidates = [
            `${job.issueKey}-auto`,
            `${job.issueKey.toLowerCase()}-auto`,
            `feature/${job.issueKey}`,
          ];
          let branchName = null;
          for (const c of candidates) {
            try {
              execSync(`git rev-parse --verify ${c}`, { cwd: job.workingDir, encoding: "utf8", timeout: 5000, stdio: "pipe" });
              branchName = c; break;
            } catch { /* try next */ }
          }
          if (!branchName) {
            console.log(`[${nowIso()}] standalone-merge: no feature branch found for ${job.issueKey} in ${job.workingDir}`);
            return;
          }
          try {
            const result = mergeBranchIntoDev(job.workingDir, branchName, job.issueKey);
            if (result) {
              console.log(`[${nowIso()}] standalone-merge: ${branchName} -> ${result.mergeBranch}@${(result.devSha || "").slice(0, 8)} (${result.mode})`);
              appendLog(job.logFile, `[${nowIso()}] standalone-merge: ${branchName} -> ${result.mergeBranch}@${(result.devSha || "").slice(0, 8)}\n`);
              // Strip downstream agent labels — the merge supersedes any pending
              // reviewer/QA/PM dispatch on this issue. Without this the reconciler
              // re-fires read-only agents that have nothing to do.
              try {
                await stripDownstreamLabelsAfterMerge(job.issueKey).catch(() => {});
              } catch { /* best-effort */ }
            }
          } catch (e) {
            if (e.conflictContext) {
              console.warn(`[${nowIso()}] standalone-merge conflict for ${job.issueKey}: ${e.conflictContext.branchName}`);
            } else {
              console.error(`[${nowIso()}] standalone-merge failed for ${job.issueKey}: ${e.message}`);
            }
          }
        });
      } catch (e) {
        console.error(`[${nowIso()}] standalone-merge hook error for ${job.issueKey}: ${e.message}`);
      }
    });
  }

  // Hot-path agent-label dispatch: when an agent finishes and writes routing
  // labels to its issue (via Jira MCP), fire the next agent immediately rather
  // than waiting for the periodic reconciler. Before dispatching, strip the
  // just-completed agent's own labels so the periodic reconciler doesn't re-
  // fire it on the next tick. excludeAgent is a belt-and-braces second guard.
  if (job.status === "succeeded" && job.issueKey && config.agentLabelReconciler?.enabled) {
    setImmediate(async () => {
      try {
        await stripOwnAgentLabelsOnSuccess(job);
      } catch (e) {
        console.error(`[strip-own-label] Post-job hook failed for ${job.issueKey}: ${e.message}`);
      }
      try {
        await dispatchAgentLabelsForIssue(job.issueKey, {
          excludeAgent: job.agent,
          reason: `post-job:${job.jobId}`,
        });
      } catch (e) {
        console.error(`[agent-label-reconciler] Post-job hook failed for ${job.issueKey}: ${e.message}`);
      }
    });
  }

  // Auto-dispatch bug-fix pipeline after successful bug-triage
  // This runs in-process — no N8N callback dependency
  if (job.agent === "bug-triage" && job.status === "succeeded" && job.issueKey && !job.pipelineId) {
    setImmediate(async () => {
      try {
        // Check no pipeline already exists for this issue
        const existing = [...pipelines.values()].find(
          p => p.issueKey === String(job.issueKey) && !["completed", "failed"].includes(p.status)
        );
        if (existing) {
          console.log(`[${nowIso()}] Bug-fix pipeline already active for ${job.issueKey} (${existing.pipelineId}), skipping auto-dispatch`);
          return;
        }
        const pipeline = await createPipeline(job.issueKey, "bug-fix", {
          workingDir: job.workingDir || DEFAULT_WORKING_DIR,
          labels: ["bug-triaged"],
          telegram: job.telegram || null,
          callbackUrl: job.callbackUrl || N8N_CALLBACK_URL || null,
          initialContext: job.parsedOutput?.result || "",
          initialContextAgent: "bug-triage",
        });
        console.log(`[${nowIso()}] Auto-dispatched bug-fix pipeline ${pipeline.pipelineId} for ${job.issueKey} after triage`);
        appendLog(job.logFile, `[${nowIso()}] Auto-dispatched bug-fix pipeline: ${pipeline.pipelineId}\n`);
      } catch (e) {
        console.error(`[${nowIso()}] Bug-fix auto-dispatch failed for ${job.issueKey}: ${e.message}`);
      }
    });
  }

  // Close matching [Meeting] Jira task when meeting-dispatched job succeeds
  if (job.meetingAction && job.status === "succeeded" && (job.source || "").startsWith("meeting:")) {
    closeMeetingJiraTask(job).catch(e => {
      console.error(`[${nowIso()}] Meeting Jira task closure failed for ${job.jobId}: ${e.message}`);
    });

    // Unblock any dependent meeting jobs now that this one succeeded
    const completedJobId = job.jobId;
    let unblocked = 0;
    for (const [, queuedJob] of jobs) {
      if (queuedJob.status === "queued" && queuedJob.blockedByJobIds?.includes(completedJobId)) {
        queuedJob.blockedByJobIds = queuedJob.blockedByJobIds.filter(id => id !== completedJobId);
        unblocked++;
      }
    }
    if (unblocked > 0) {
      console.log(`[${nowIso()}] Meeting ${job.meetingAction.meetingId}: Unblocked ${unblocked} dependent job(s) after ${completedJobId} succeeded`);
      setImmediate(tickWorker);
    }
  }

  // Auto-dispatch video-renderer after successful user-guide-agent completion
  if (job.agent === "user-guide-agent" && job.status === "succeeded") {
    setImmediate(async () => {
      try {
        const product = resolveProduct(job.workingDir);
        if (!product || !product.videoConfig?.enabled) {
          appendLog(job.logFile, `[${nowIso()}] Video auto-dispatch skipped: product videoConfig not enabled\n`);
          return;
        }
        const manifestDir = path.join(job.workingDir, "docs/user-guides/video-manifests");
        if (!fs.existsSync(manifestDir)) {
          appendLog(job.logFile, `[${nowIso()}] Video auto-dispatch skipped: no video-manifests directory\n`);
          return;
        }
        const manifests = fs.readdirSync(manifestDir).filter(f => f.endsWith(".json") && !f.startsWith("_rendered"));
        if (manifests.length === 0) {
          appendLog(job.logFile, `[${nowIso()}] Video auto-dispatch skipped: no manifests found\n`);
          return;
        }

        for (const manifestFile of manifests) {
          const manifestPath = path.join(manifestDir, manifestFile);
          const jobId = makeJobId();
          const logFile = path.join(LOG_DIR, `${jobId}.log`);
          const metaFile = path.join(LOG_DIR, `${jobId}.json`);

          const videoJob = {
            jobId,
            mode: "agent",
            agent: "video-renderer",
            prompt: `Render tutorial video from manifest: ${manifestPath}\n\nThis was auto-dispatched after user-guide-agent completed job ${job.jobId}.`,
            context: "",
            workingDir: job.workingDir,
            issueKey: job.issueKey || null,
            model: null,
            selectedModel: null,
            requestedProvider: null,
            status: "queued",
            createdAt: nowIso(),
            startedAt: null,
            finishedAt: null,
            logFile,
            metaFile,
            processPid: null,
            error: null,
            lastError: null,
            parsedOutput: null,
            retryCount: 0,
            maxRetries: MAX_RETRIES,
            retryAt: null,
            qualityGateRetryCount: 0,
            qualityGateFailure: null,
            qualityGate: null,
            usage: null,
            callbackUrl: job.callbackUrl || N8N_CALLBACK_URL || null,
            source: `auto:user-guide-agent:${job.jobId}`,
            telegram: job.telegram || null,
            batchId: null,
          };

          jobs.set(jobId, videoJob);
          db.jobs.set(videoJob).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
          appendLog(logFile, `[${nowIso()}] Video-renderer job created (auto-dispatch from user-guide-agent:${job.jobId})\n`);
          appendLog(logFile, `[${nowIso()}] Manifest: ${manifestFile}\n`);
          fs.writeFileSync(metaFile, JSON.stringify({ ...videoJob, stdout: undefined, stderr: undefined }, null, 2), "utf8");
          enqueue(jobId);
          console.log(`[${nowIso()}] Auto-dispatched video-renderer job ${jobId} for manifest ${manifestFile}`);
          appendLog(job.logFile, `[${nowIso()}] Auto-dispatched video-renderer: ${jobId} (${manifestFile})\n`);
        }
      
      } catch (e) {
        console.error(`[${nowIso()}] Video-renderer auto-dispatch failed for ${job.jobId}: ${e.message}`);
      }
    });
  }

  // Clean up temporary optimized plugin directory
  cleanupOptimizedPluginDir(job);

  const _pid3 = job._productId || getProductIdForJob(job);
  runningByProduct.set(_pid3, Math.max(0, getRunningForProduct(_pid3) - 1));
  setImmediate(tickWorker);
}

function enqueue(jobId) {
  const job = jobs.get(jobId);
  queue.push({ jobId });

  // Emit queued event
  if (job) {
    jobEmitter.emit("job:queued", {
      jobId: job.jobId,
      agent: job.agent,
      issueKey: job.issueKey,
      mode: job.mode,
      createdAt: job.createdAt
    });
  }


  setImmediate(tickWorker);
}
