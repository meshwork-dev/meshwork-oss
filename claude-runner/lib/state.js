// state.js — shared in-memory runtime state (jobs, queues, pipelines, meetings, worktrees, SSE emitter)
// Extracted from runner.js.

const { EventEmitter } = require("events");
const db = require("../db");
const { nowIso } = require("./util");

// Lifecycle flags shared across modules (set by graceful shutdown).
const lifecycle = { shuttingDown: false };


/**
 * Event emitter for job lifecycle events
 */
const jobEmitter = new EventEmitter();
jobEmitter.setMaxListeners(100);

/**
 * In-memory job store — write-through cache for active (non-terminal) jobs only.
 * Terminal jobs (succeeded/failed/quality-gate-failed/cancelled) are evicted to DB.
 */
const jobs = new Map(); // jobId -> jobRecord (active jobs only)
const queue = []; // items: { jobId }
const runningByProduct = new Map(); // productId -> count of running jobs

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "quality-gate-failed", "cancelled"]);

/**
 * Fetch a job: check in-memory cache first (active jobs), then fall back to DB.
 */
async function getJob(jobId) {
  const cached = jobs.get(jobId);
  if (cached) return cached;
  try {
    return await db.jobs.get(jobId);
  } catch {
    return null;
  }
}

/**
 * Fetch a pipeline: check in-memory cache first, then fall back to DB.
 */
async function getPipeline(pipelineId) {
  const cached = pipelines.get(pipelineId);
  if (cached) return cached;
  try {
    return await db.pipelines.get(pipelineId);
  } catch {
    return null;
  }
}

/**
 * Fetch a meeting: check in-memory cache first, then fall back to DB.
 */
async function getMeeting(meetingId) {
  const cached = meetings.get(meetingId);
  if (cached) return cached;
  try {
    return await db.meetings.get(meetingId);
  } catch {
    return null;
  }
}

/**
 * Fetch a worktree: check in-memory cache first, then fall back to DB.
 */
async function getWorktree(id) {
  const cached = worktrees.get(id);
  if (cached) return cached;
  try {
    return await db.worktrees.get(id);
  } catch {
    return null;
  }
}

function getRunningForProduct(productId) {
  return runningByProduct.get(productId) || 0;
}

function getTotalRunningCount() {
  let total = 0;
  for (const count of runningByProduct.values()) total += count;
  return total;
}

// jobIndex removed — historical job lookup now handled by db.jobs.get()

/**
 * Batch tracking store
 * batchId → { batchId, total, completed, failed, results[], slack, createdAt }
 */
const batches = new Map();

/**
 * Subtask tracking store for parent-subtask coordination
 * parentKey → { parentKey, subtasks: [{ key, status, agent, blockedBy, files }], createdAt }
 */
const subtaskGroups = new Map();

/**
 * ============================================================
 * MEETING ENGINE
 * Multi-agent team meetings with shared conversation context.
 * Agents take turns responding, building on each other's input.
 * ============================================================
 */
const meetings = new Map();

/**
 * ============================================================
 * PIPELINE ENGINE
 * Sequential phase-based SDLC orchestration.
 * Each phase creates a standard job. Phases advance when their
 * gate condition is satisfied. A context bridge file accumulates
 * phase outputs for downstream agents.
 * ============================================================
 */

/**
 * In-memory pipeline store
 * pipelineId -> pipelineRecord
 */
const pipelines = new Map();

/**
 * Worktree tracking: worktreeId -> worktreeRecord
 */
const worktrees = new Map();

// In-memory since last restart; per-pipeline results persist via db.pipelines.
const verificationStats = {
  since: nowIso(),
  scheduled: 0,
  completed: 0,
  inconclusive: 0,
  overturned: 0,
  newFindings: 0,
  rootCauses: {},
  byTrigger: { sampled: 0, "zero-findings": 0 },
};

/**
 * ============================================================
 * SCHEDULER — Deferred jobs and scheduled meetings
 * Persisted in state, checked every 60 seconds.
 * ============================================================
 */
const scheduledItems = new Map(); // id -> { type: "job"|"meeting", scheduledAt, data, source, createdAt }

module.exports = {
  jobEmitter,
  jobs,
  queue,
  runningByProduct,
  TERMINAL_STATUSES,
  getJob,
  getPipeline,
  getMeeting,
  getWorktree,
  getRunningForProduct,
  getTotalRunningCount,
  batches,
  subtaskGroups,
  meetings,
  pipelines,
  worktrees,
  verificationStats,
  scheduledItems,
  lifecycle,
};
