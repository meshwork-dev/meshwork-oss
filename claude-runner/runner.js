// runner.js — composition root for the Claude Runner.
// Loads config first (validates secrets), wires shared state, mounts routes,
// starts background timers and the HTTP server. Subsystem logic lives in lib/.

const {
  ALERT_SLACK_WEBHOOK,
  ALLOWED_ROOTS,
  CONV_DIR,
  CONV_MAX_CHARS,
  CONV_STALE_DAYS,
  CONV_TURNS,
  DEFAULT_WORKING_DIR,
  FAILED_CALLBACKS_DIR,
  HOST,
  JOB_TIMEOUT_MINUTES,
  LOG_DIR,
  LOG_RETENTION_DAYS,
  MAX_CONCURRENCY_PER_PRODUCT,
  MAX_RETRIES,
  N8N_CALLBACK_URL,
  PORT,
  SSE_ENABLED,
  config,
} = require("./lib/config");
const express = require("express");
const db = require("./db");
const issueTracker = require("./issue-tracker");
const { products } = require("./lib/products");
const {
  TERMINAL_STATUSES,
  jobs,
  lifecycle,
  runningByProduct,
  scheduledItems,
  worktrees,
} = require("./lib/state");
const { nowIso } = require("./lib/util");
const { tickScheduler } = require("./lib/scheduler");
const {
  tickAgentLabelReconciler,
  tickDependencyChecker,
  tickSprintRunner,
} = require("./lib/sprint");
const { loadStateFromDB } = require("./lib/worker");
const { loadDefaultProvider } = require("./lib/oauth");
const {
  pruneWorktrees,
  reconcileMergedWorktrees,
  resolveWorktreeBaseDir,
} = require("./lib/worktrees");
const { registerAdminRoutes } = require("./lib/routes/admin");
const { registerBatchRoutes } = require("./lib/routes/batches");
const { registerDispatchRoutes } = require("./lib/routes/dispatch");
const { registerIssueRoutes } = require("./lib/routes/issues");
const { registerJobRoutes } = require("./lib/routes/jobs");
const { registerMeetingRoutes } = require("./lib/routes/meetings");
const { registerPipelineRoutes } = require("./lib/routes/pipelines");
const { registerScheduleRoutes } = require("./lib/routes/schedule");
const { registerWorktreeRoutes } = require("./lib/routes/worktrees");
const { registerIntegrationRoutes } = require("./lib/routes/integrations");


const app = express();
app.use(express.json({ limit: "20mb", type: "*/*" }));

// CORS – all endpoints are protected by x-runner-secret, so allow any origin
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "x-runner-secret, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Initialize PostgreSQL and load state from DB
(async () => {
  try {
    await db.init(config);
    issueTracker.init(config, db);
    console.log(`[${new Date().toISOString()}] PostgreSQL connected`);
    await loadStateFromDB();
    await loadDefaultProvider();
  } catch (e) {
    console.error(`[${new Date().toISOString()}] PostgreSQL/state load failed: ${e.message}`);
    process.exit(1);
  }
})();

// Prune stale worktrees on startup
if (config.worktrees?.enabled && config.worktrees.pruneOnStartup) {
  try {
    pruneWorktrees(DEFAULT_WORKING_DIR);
    console.log(`[${new Date().toISOString()}] Worktree prune complete: ${worktrees.size} tracked`);
  } catch (e) {
    console.log(`[${new Date().toISOString()}] Worktree prune warning: ${e.message}`);
  }
}

function gracefulShutdown(signal) {
  if (lifecycle.shuttingDown) return;
  lifecycle.shuttingDown = true;
  console.log(`\n[${new Date().toISOString()}] ${signal} received. Shutting down gracefully...`);

  // Stop accepting new requests
  if (httpServer) {
    httpServer.close(() => {
      console.log(`[${new Date().toISOString()}] HTTP server closed`);
    });
  }

  // SIGTERM all running Claude processes
  let killedCount = 0;
  for (const job of jobs.values()) {
    if (job.status === "running" && job.processPid) {
      try {
        process.kill(job.processPid, "SIGTERM");
        killedCount++;
        job.status = "failed";
        job.error = `Process terminated by ${signal}`;
        job.finishedAt = new Date().toISOString();
      } catch {}
    }
  }
  if (killedCount > 0) {
    console.log(`[${new Date().toISOString()}] Terminated ${killedCount} running processes`);
    runningByProduct.clear();
  }

  // Flush interrupted job statuses to DB before closing
  const dbFlushPromises = [];
  for (const job of jobs.values()) {
    if (TERMINAL_STATUSES.has(job.status)) {
      dbFlushPromises.push(db.jobs.set(job).catch(() => {}));
    }
  }
  // Wait briefly for DB writes then close
  Promise.all(dbFlushPromises).finally(() => {
    db.close().catch(e => console.error(`[${new Date().toISOString()}] DB close error: ${e.message}`));
  });

  // Force exit after 10s if something hangs
  setTimeout(() => {
    console.error(`[${new Date().toISOString()}] Forced exit after timeout`);
    process.exit(1);
  }, 10000).unref();

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ── Routes ──────────────────────────────────────────────────────────────────
registerDispatchRoutes(app);
registerMeetingRoutes(app);
registerScheduleRoutes(app);
registerJobRoutes(app);
registerAdminRoutes(app);
registerBatchRoutes(app);
registerIssueRoutes(app);
registerPipelineRoutes(app);
registerWorktreeRoutes(app);
registerIntegrationRoutes(app);

// Scheduler: check for due items every 60 seconds
setInterval(() => {
  try { tickScheduler(); } catch (e) {
    console.error(`[${nowIso()}] Scheduler tick error: ${e.message}`);
  }
}, 60000);

// Worktree reconciler: every 5 minutes, reap worktrees whose remote branch has been
// auto-merged-and-deleted by GitHub (signal that the PR was merged).
setInterval(() => {
  try { reconcileMergedWorktrees(); } catch (e) {
    console.error(`[${nowIso()}] Worktree reconciler error: ${e.message}`);
  }
}, 300000);

// Run scheduler once on startup (for items that became due during downtime)
setTimeout(() => {
  try { tickScheduler(); } catch (e) {
    console.error(`[${nowIso()}] Scheduler initial tick error: ${e.message}`);
  }
}, 5000);

// Sprint Runner: scan active sprints and dispatch To Do issues
if (config.sprintRunner?.enabled) {
  const srIntervalMs = (config.sprintRunner.intervalMinutes || 10) * 60 * 1000;
  setInterval(() => {
    try { tickSprintRunner(); } catch (e) {
      console.error(`[${nowIso()}] Sprint runner tick error: ${e.message}`);
    }
  }, srIntervalMs);
  // Run once after 30s startup delay
  setTimeout(() => {
    try { tickSprintRunner(); } catch (e) {
      console.error(`[${nowIso()}] Sprint runner initial tick error: ${e.message}`);
    }
  }, 30000);
  console.log(`Sprint runner enabled: scanning every ${config.sprintRunner.intervalMinutes || 10}m`);
}

// Agent Label Reconciler: catch agent:* labels that the sprint runner missed
// (in-flight issues, webhook drops, manual labels)
if (config.agentLabelReconciler?.enabled) {
  const alrIntervalMs = (config.agentLabelReconciler.intervalMinutes || 15) * 60 * 1000;
  setInterval(() => {
    try { tickAgentLabelReconciler(); } catch (e) {
      console.error(`[${nowIso()}] Agent label reconciler tick error: ${e.message}`);
    }
  }, alrIntervalMs);
  setTimeout(() => {
    try { tickAgentLabelReconciler(); } catch (e) {
      console.error(`[${nowIso()}] Agent label reconciler initial tick error: ${e.message}`);
    }
  }, 45000);
  console.log(`Agent label reconciler enabled: scanning every ${config.agentLabelReconciler.intervalMinutes || 15}m`);
}

// Dependency Gating: periodic checker for blocked pipelines
if (config.dependencyGating?.enabled) {
  const dgIntervalMs = (config.dependencyGating.recheckIntervalSeconds || 60) * 1000;
  setInterval(() => {
    try { tickDependencyChecker(); } catch (e) {
      console.error(`[${nowIso()}] Dependency checker tick error: ${e.message}`);
    }
  }, dgIntervalMs);
  console.log(`Dependency gating enabled: recheck every ${config.dependencyGating.recheckIntervalSeconds || 60}s, git merge check: ${config.dependencyGating.checkGitMerge !== false}, timeout: ${config.dependencyGating.maxBlockedMinutes || 120}m`);
}

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`\n=== Claude Runner Started ===`);
  console.log(`Server:          http://${HOST}:${PORT}`);
  console.log(`Dashboard:       http://${HOST}:${PORT}/dashboard`);
  console.log(`\nConfiguration:`);
  console.log(`  Working dir:   ${DEFAULT_WORKING_DIR}`);
  console.log(`  Log dir:       ${LOG_DIR}`);
  console.log(`  Conv store:    ${CONV_DIR}`);
  console.log(`  Callback URL:  ${N8N_CALLBACK_URL}`);
  console.log(`\nSettings:`);
  console.log(`  Max concurrency: ${MAX_CONCURRENCY_PER_PRODUCT}/product`);
  console.log(`  Job timeout:     ${JOB_TIMEOUT_MINUTES} min`);
  console.log(`  Max retries:     ${MAX_RETRIES}`);
  console.log(`  SSE enabled:     ${SSE_ENABLED}`);
  console.log(`  Conv turns:      ${CONV_TURNS}`);
  console.log(`  Conv max chars:  ${CONV_MAX_CHARS}`);
  console.log(`  Stale cleanup:   ${CONV_STALE_DAYS} days`);
  console.log(`  Log retention:   ${LOG_RETENTION_DAYS} days`);
  if (ALLOWED_ROOTS.length) console.log(`  Allowed roots:   ${ALLOWED_ROOTS.join(", ")}`);
  console.log(`\nMulti-Model Routing:`);
  console.log(`  Enabled:         ${config.routing.enabled}`);
  console.log(`  Default model:   ${config.routing.modeDefaults.delivery}`);
  console.log(`  Chat model:      ${config.routing.modeDefaults.chat}`);
  console.log(`  Agent routing:   ${Object.keys(config.routing.agentToModel).length} agents configured`);
  console.log(`\nQuality Gate:`);
  console.log(`  Enabled:         ${config.qualityGate.enabled}`);
  console.log(`  Run after:       ${config.qualityGate.runAfterAgents.join(", ")}`);
  console.log(`  Checks:          ${config.qualityGate.checks.map(c => c.name).join(", ")}`);
  console.log(`  Max retries:     ${config.qualityGate.maxRetries}`);
  console.log(`\nFix-Loop:`);
  console.log(`  Enabled:         ${config.fixLoop.enabled}`);
  console.log(`  Max attempts:    ${config.fixLoop.maxAttempts}`);
  console.log(`  Verify fix-loop: ${config.fixLoop.maxVerifyAttempts || 3} (QA→impl→QA cycles)`);
  console.log(`  Gate types:      ${config.fixLoop.gateTypes.join(", ")}`);
  if (config.teams?.enabled) {
    const leads = Object.keys(config.teams.teamLeads || {});
    console.log(`\nAgent Teams:`);
    console.log(`  Enabled:         true`);
    console.log(`  Team leads:      ${leads.join(", ")}`);
    for (const lead of leads) {
      const mates = config.teams.teamLeads[lead].teammates || [];
      console.log(`    ${lead}: ${mates.join(", ")}`);
    }
    if (config.localTeamMembers?.enabled) {
      const localAgents = config.localTeamMembers.agents || [];
      const agentModels = config.localTeamMembers.agentModels || {};
      const localMode = config.localTeamMembers.mode || "raw";
      console.log(`  Local mode:      ${localMode}${localMode === "qwen-code" ? " (agentic CLI with tools)" : " (raw API)"}`);
      console.log(`  Hybrid routing:  ${localAgents.join(", ")} → local model`);
      console.log(`  Local direct:    pipeline phases with ${localAgents.join(", ")} → ${localMode === "qwen-code" ? "Qwen-Code CLI" : "LM Studio API"}`);
      console.log(`  LM Studio:       ${config.localTeamMembers.endpoint}`);
      console.log(`  Default model:   ${config.localTeamMembers.model}`);
      console.log(`  Fallback:        ${config.localTeamMembers.fallbackToClaude ? "Claude" : "disabled"}`);
      if (Object.keys(agentModels).length) {
        console.log(`  Per-agent models:`);
        for (const [agent, cfg] of Object.entries(agentModels)) {
          console.log(`    ${agent}: ${cfg.model} (${cfg.tier || "default"}, max ${cfg.maxOutputTokens || "default"} tokens)`);
        }
      }
    }
  }

  if (config.contextBridge?.enabled) {
    const extractors = Object.keys(config.contextBridge.phaseExtractors || {});
    console.log(`\nContext Bridge:`);
    console.log(`  Enabled:         true`);
    console.log(`  Max words:       ${config.contextBridge.maxSummaryWords} (compact: ${config.contextBridge.compactMaxWords})`);
    console.log(`  Extractors:      ${extractors.join(", ") || "none"}`);
  }
  console.log(`\nReliability:`);
  console.log(`  State persist:   PostgreSQL (runner database)`);
  console.log(`  Callback retry:  3 attempts with backoff`);
  console.log(`  Failed CB dir:   ${FAILED_CALLBACKS_DIR}`);
  console.log(`  Alert webhook:   ${ALERT_SLACK_WEBHOOK || "not configured"}`);
  console.log(`  Budget:          ${config.budget?.enabled ? `$${config.budget.dailyLimitUsd}/day, $${config.budget.hourlyLimitUsd}/hr` : "disabled"}`);
  console.log(`  Worktrees:       ${config.worktrees?.enabled ? `enabled (${resolveWorktreeBaseDir()})` : "disabled"}`);
  const pendingSched = Array.from(scheduledItems.values()).filter(s => !s.status || s.status === "pending").length;
  console.log(`  Scheduler:       ${pendingSched} pending items`);
  console.log(`  Restored jobs:   ${jobs.size}`);
  if (config.sprintRunner?.enabled) {
    const srProducts = Array.from(products.entries()).filter(([, p]) => p.sprint?.enabled).map(([id]) => id);
    console.log(`\nSprint Runner:`);
    console.log(`  Enabled:         true`);
    console.log(`  Interval:        ${config.sprintRunner.intervalMinutes || 10}m`);
    console.log(`  Max per cycle:   ${config.sprintRunner.maxDispatchPerCycle || 5}`);
    console.log(`  Dry run:         ${config.sprintRunner.dryRun || false}`);
    console.log(`  Products:        ${srProducts.length > 0 ? srProducts.join(", ") : "none"}`);
  }
  if (config.dependencyGating?.enabled) {
    console.log(`\nDependency Gating:`);
    console.log(`  Enabled:         true`);
    console.log(`  Git merge check: ${config.dependencyGating.checkGitMerge !== false}`);
    console.log(`  Recheck interval:${config.dependencyGating.recheckIntervalSeconds || 60}s`);
    console.log(`  Block timeout:   ${config.dependencyGating.maxBlockedMinutes || 120}m`);
  }
  console.log(`\n=============================\n`);
});
