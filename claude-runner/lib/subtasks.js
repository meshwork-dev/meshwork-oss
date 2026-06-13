// subtasks.js — subtask tracking, parallelism rules, verification scheduling
// Extracted from runner.js.

const db = require("../db");
const issueTracker = require("../issue-tracker");
const { config } = require("./config");
const { jobEmitter, subtaskGroups } = require("./state");
const { filesOverlap, nowIso } = require("./util");

// Function declarations are hoisted: exporting before requiring sibling
// modules keeps require cycles safe (each module's exports are complete
// before any sibling starts loading).
module.exports = {
  scheduleSubtaskVerification,
  getSubtaskConfig,
  trackSubtask,
  updateSubtaskStatus,
  getRunningSubtaskCount,
  canRunSubtaskParallel,
  getSubtaskGroup,
};


/**
 * ============================================================
 * [CREATE-SUBTASKS] RUNNER-SIDE VERIFICATION
 * Parsing used to live only in the N8N Runner_Callback workflow — if that
 * workflow failed, the work plan silently evaporated. The runner now parses
 * blocks itself (lib/protocol.js), ships the structured result in the
 * callback payload, and later verifies the subtasks exist in the tracker.
 * ============================================================
 */

/**
 * After the callback fires (N8N is expected to create the subtasks), check
 * the tracker and flag the parent issue when subtasks are missing. Catches
 * silent N8N parsing/creation failures that previously lost the work plan.
 */
function scheduleSubtaskVerification(job, blocks) {
  if (!config.subtasks?.verifyCreation) return;
  const delayMs = (config.subtasks.verifyDelaySeconds || 120) * 1000;

  for (const block of blocks) {
    const parent = block.parent || job.issueKey;
    if (!parent) continue;

    const timer = setTimeout(async () => {
      try {
        const existing = await issueTracker.getSubtasks(parent);
        const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
        const missing = block.subtasks.filter((st) => {
          const want = norm(st.summary);
          return !existing.some((e) => {
            const have = norm(e.summary);
            return have === want || have.includes(want.slice(0, 60)) || want.includes(have.slice(0, 60));
          });
        });
        if (missing.length === 0) return;

        const summaryList = missing.map((st) => `- ${st.summary}`).join("\n");
        console.error(`[${nowIso()}] Subtask verification FAILED for ${parent}: ${missing.length}/${block.subtasks.length} subtasks missing (job ${job.jobId})`);
        jobEmitter.emit("subtasks:verification-failed", {
          jobId: job.jobId,
          parentKey: parent,
          expected: block.subtasks.length,
          found: block.subtasks.length - missing.length,
          missing: missing.map((st) => st.summary),
        });
        await issueTracker.addComment(
          parent,
          `[SUBTASK-VERIFICATION-FAILED] Agent output for job ${job.jobId} declared ${block.subtasks.length} subtask(s) but ${missing.length} were never created:\n${summaryList}\nCheck the Runner_Callback N8N workflow execution log.`,
          "runner"
        ).catch((e) => console.error(`[${nowIso()}] Could not flag ${parent}: ${e.message}`));
      } catch (e) {
        console.warn(`[${nowIso()}] Subtask verification for ${parent} errored: ${e.message}`);
      }
    }, delayMs);
    // Don't hold the process open just for a pending verification
    if (typeof timer.unref === "function") timer.unref();
  }
}

/**
 * Get subtask configuration from config
 */
function getSubtaskConfig() {
  return config.subtasks || {
    enabled: true,
    maxConcurrency: 10,
    maxPerParent: 3,
    maxDepth: 3,
    parallelAgents: ["engineer-implementer", "ui-engineer", "creative-assets", "marketing"]
  };
}

/**
 * Track a subtask under its parent
 */
function trackSubtask(parentKey, subtaskKey, subtaskInfo) {
  if (!subtaskGroups.has(parentKey)) {
    subtaskGroups.set(parentKey, {
      parentKey,
      subtasks: [],
      createdAt: nowIso(),
    });
  }
  const group = subtaskGroups.get(parentKey);
  group.subtasks.push({
    key: subtaskKey,
    status: "pending",
    agent: subtaskInfo.agent || null,
    blockedBy: subtaskInfo.blockedBy || [],
    files: subtaskInfo.files || [],
    jobId: null,
    createdAt: nowIso(),
  });
  db.subtaskGroups.set(parentKey, group).catch(e => console.error('[db] subtaskGroup persist failed: ' + e.message));
}

/**
 * Update subtask status
 */
function updateSubtaskStatus(parentKey, subtaskKey, status, jobId = null) {
  const group = subtaskGroups.get(parentKey);
  if (!group) return;

  const subtask = group.subtasks.find(s => s.key === subtaskKey);
  if (subtask) {
    subtask.status = status;
    subtask.jobId = jobId || subtask.jobId;
    subtask.updatedAt = nowIso();
    db.subtaskGroups.set(parentKey, group).catch(e => console.error('[db] subtaskGroup update failed: ' + e.message));
  }
}

/**
 * Get count of running subtasks for a parent
 */
function getRunningSubtaskCount(parentKey) {
  const group = subtaskGroups.get(parentKey);
  if (!group) return 0;
  return group.subtasks.filter(s => s.status === "running").length;
}

/**
 * Check if a subtask can run in parallel with currently running subtasks
 */
function canRunSubtaskParallel(parentKey, subtaskKey, subtaskFiles) {
  const stConfig = getSubtaskConfig();
  const group = subtaskGroups.get(parentKey);
  if (!group) return true;

  // Check maxPerParent limit
  const runningCount = getRunningSubtaskCount(parentKey);
  if (runningCount >= stConfig.maxPerParent) {
    return false;
  }

  // Check for file conflicts with running subtasks
  const runningSubtasks = group.subtasks.filter(s => s.status === "running" && s.key !== subtaskKey);
  for (const running of runningSubtasks) {
    if (filesOverlap(subtaskFiles, running.files)) {
      return false;
    }
  }

  return true;
}

/**
 * Get subtask group for a parent
 */
function getSubtaskGroup(parentKey) {
  return subtaskGroups.get(parentKey) || null;
}
