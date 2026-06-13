// maintenance.js — periodic cleanup: stale conversations, old logs, finished jobs, retention pruning
// Extracted from runner.js.

const fs = require("fs");
const path = require("path");
const db = require("../db");
const {
  CONV_DIR,
  CONV_STALE_DAYS,
  JOB_STATE_RETENTION_DAYS,
  LOG_DIR,
  LOG_RETENTION_DAYS,
  RETENTION_DAYS,
  config,
} = require("./config");
const { nowIso } = require("./util");

// Function declarations are hoisted: exporting before requiring sibling
// modules keeps require cycles safe (each module's exports are complete
// before any sibling starts loading).
module.exports = {
  pruneCompletedJobs,
  cleanupStaleLogs,
  cleanupStaleConversations,
  runRetentionPrune,
};


function pruneCompletedJobs() {
  db.jobs.pruneTerminal(JOB_STATE_RETENTION_DAYS).then(pruned => {
    if (pruned > 0) console.log(`[${nowIso()}] Pruned ${pruned} terminal jobs from DB`);
  }).catch(e => console.error(`[db] pruneTerminal failed: ${e.message}`));

  db.pipelines.pruneTerminal(JOB_STATE_RETENTION_DAYS).catch(e => console.error(`[db] pipeline pruneTerminal failed: ${e.message}`));
  db.meetings.pruneOld(JOB_STATE_RETENTION_DAYS).catch(e => console.error(`[db] meeting pruneOld failed: ${e.message}`));
  db.scheduled.pruneOld(JOB_STATE_RETENTION_DAYS).catch(e => console.error(`[db] scheduled pruneOld failed: ${e.message}`));
  db.idempotency.prune(config.idempotencyTtlHours || 72).catch(e => console.error(`[db] idempotency prune failed: ${e.message}`));
}

function cleanupStaleLogs() {
  const maxAgeMs = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  try {
    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith(".log") || (f.endsWith(".json") && f.startsWith("job_")));
    for (const file of files) {
      const filePath = path.join(LOG_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (Date.now() - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {}
    }
    if (cleaned > 0) {
      console.log(`[${new Date().toISOString()}] Cleaned up ${cleaned} stale log/meta files`);
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Log cleanup error: ${e.message}`);
  }
}

/**
 * STALE CONVERSATION CLEANUP (Phase 4.4)
 */
async function cleanupStaleConversations() {
  const maxAgeMs = CONV_STALE_DAYS * 24 * 60 * 60 * 1000;
  let cleanedFiles = 0;
  let cleanedDb = 0;

  // 1. Remove any remaining legacy files still in CONV_DIR
  try {
    const files = fs.readdirSync(CONV_DIR).filter(f => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(CONV_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (Date.now() - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          cleanedFiles++;
        }
      } catch {}
    }
  } catch (e) {
    console.error(`[${nowIso()}] Conversation file cleanup error: ${e.message}`);
  }

  // 2. Prune stale rows from PostgreSQL
  try {
    const cutoff = new Date(Date.now() - maxAgeMs);
    cleanedDb = await db.conversations.pruneStale(cutoff);
  } catch (e) {
    console.error(`[${nowIso()}] Conversation DB cleanup error: ${e.message}`);
  }

  const total = cleanedFiles + cleanedDb;
  if (total > 0) {
    console.log(`[${nowIso()}] Cleaned up ${total} stale conversations (${cleanedFiles} files, ${cleanedDb} DB rows)`);
  }
}

// Run cleanup daily (conversations + logs + state pruning)
setInterval(() => {
  cleanupStaleConversations().catch(e => console.error(`[cleanup] cleanupStaleConversations: ${e.message}`));
  cleanupStaleLogs();
  pruneCompletedJobs();
}, 24 * 60 * 60 * 1000);
// Also run on startup after a delay
setTimeout(() => {
  cleanupStaleConversations().catch(e => console.error(`[cleanup] cleanupStaleConversations: ${e.message}`));
  cleanupStaleLogs();
  pruneCompletedJobs();
}, 60000);

function runRetentionPrune() {
  if (!RETENTION_DAYS) return;
  db.retention.prune(RETENTION_DAYS).then(({ jobs: prunedJobs, conversations, notifications }) => {
    console.log(`[${nowIso()}] Retention prune (${RETENTION_DAYS}d): deleted ${prunedJobs} job(s), ${conversations} conversation(s), ${notifications} read notification(s)`);
  }).catch(e => console.error(`[db] retention prune failed: ${e.message}`));
}

if (RETENTION_DAYS > 0) {
  setTimeout(runRetentionPrune, 60 * 1000);
  setInterval(runRetentionPrune, 24 * 60 * 60 * 1000);
}
