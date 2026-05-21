"use strict";

/**
 * PostgreSQL data access layer for the CertPilot runner.
 *
 * Usage:
 *   const db = require("./db");
 *   await db.init(config);          // call once at startup
 *   const job = await db.jobs.get(jobId);
 *   await db.jobs.set(job);
 *   await db.close();               // call on graceful shutdown
 */

const { Pool } = require("pg");

let pool = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function camelToSnake(str) {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Convert an arbitrary JS object's keys from snake_case to camelCase.
 * Used as a generic fallback; entity-specific mappers override where needed.
 */
function rowToObject(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[snakeToCamel(k)] = v;
  }
  return out;
}

/** Normalise a value before sending to PG: undefined → null */
function norm(v) {
  return v === undefined ? null : v;
}

/** Serialise a value that will land in a JSONB column. pg handles objects fine
 *  but explicit serialisation avoids edge cases with nested undefined values. */
function jsonb(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v; // already serialised
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Field mappings — jobs
// ---------------------------------------------------------------------------

/**
 * Non-DB fields that live on the in-memory job object but must not be persisted.
 * This list should be kept in sync with whatever runner.js attaches transiently.
 */
const JOB_TRANSIENT_FIELDS = new Set([
  "stdout",
  "stderr",
  "_tmpPluginDir",
  "_process",
  "_streamEmitter",
  "_timer",
]);

/**
 * Explicit camelCase → snake_case mapping for job fields.
 * Fields not listed here fall through to the generic camelToSnake converter.
 */
const JOB_CAMEL_TO_SNAKE = {
  jobId: "job_id",
  issueKey: "issue_key",
  conversationId: "conversation_id",
  workingDir: "working_dir",
  selectedModel: "selected_model",
  requestedProvider: "requested_provider",
  createdAt: "created_at",
  startedAt: "started_at",
  finishedAt: "finished_at",
  logFile: "log_file",
  metaFile: "meta_file",
  processPid: "process_pid",
  lastError: "last_error",
  retryCount: "retry_count",
  maxRetries: "max_retries",
  retryAt: "retry_at",
  qualityGate: "quality_gate",
  qualityGateFailure: "quality_gate_failure",
  qualityGateRetryCount: "quality_gate_retry_count",
  callbackUrl: "callback_url",
  batchId: "batch_id",
  parentKey: "parent_key",
  isSubtask: "is_subtask",
  pipelineId: "pipeline_id",
  pipelinePhase: "pipeline_phase",
  pipelinePhaseIndex: "pipeline_phase_index",
  worktreeId: "worktree_id",
  meetingAction: "meeting_action",
  chromeEnabled: "chrome_enabled",
  chromeUsage: "chrome_usage",
  chromeReason: "chrome_reason",
  teamSessionId: "team_session_id",
  teamRole: "team_role",
  sessionId: "session_id",
  productId: "product_id",
  _productId: "product_id",
  parsedOutput: "parsed_output",
  preReadBrief: "pre_read_brief",
  historyText: "history_text",
  streamEvents: "stream_events",
};

/** Inverse map: snake_case → camelCase for job rows */
const JOB_SNAKE_TO_CAMEL = Object.fromEntries(
  Object.entries(JOB_CAMEL_TO_SNAKE)
    .filter(([k]) => k !== "_productId") // _productId → product_id but reverse is productId
    .map(([k, v]) => [v, k])
);

/** Set of known DB column names for jobs */
const JOB_DB_COLUMNS = new Set([
  "job_id",
  "mode",
  "status",
  "agent",
  "issue_key",
  "conversation_id",
  "summary",
  "description",
  "working_dir",
  "model",
  "selected_model",
  "requested_provider",
  "provider",
  "created_at",
  "started_at",
  "finished_at",
  "log_file",
  "meta_file",
  "process_pid",
  "error",
  "last_error",
  "retry_count",
  "max_retries",
  "retry_at",
  "quality_gate",
  "quality_gate_failure",
  "quality_gate_retry_count",
  "usage",
  "callback_url",
  "slack",
  "telegram",
  "source",
  "batch_id",
  "parent_key",
  "is_subtask",
  "pipeline_id",
  "pipeline_phase",
  "pipeline_phase_index",
  "worktree_id",
  "meeting_action",
  "chrome_enabled",
  "chrome_usage",
  "chrome_reason",
  "team_session_id",
  "team_role",
  "teammates",
  "session_id",
  "product_id",
  "parsed_output",
  "prompt",
  "context",
  "pre_read_brief",
  "history_text",
  "stream_events",
]);

const JOB_JSONB_COLS = new Set([
  "quality_gate",
  "quality_gate_failure",
  "usage",
  "slack",
  "telegram",
  "meeting_action",
  "chrome_usage",
  "parsed_output",
  "stream_events",
]);

function jobToRow(job) {
  const row = {};

  for (const [camel, val] of Object.entries(job)) {
    if (JOB_TRANSIENT_FIELDS.has(camel)) continue;

    const col = JOB_CAMEL_TO_SNAKE[camel] || camelToSnake(camel);

    if (!JOB_DB_COLUMNS.has(col)) continue;

    row[col] = JOB_JSONB_COLS.has(col) ? jsonb(val) : norm(val);
  }

  // Guarantee the primary key is always present
  if (!row["job_id"] && job.jobId) row["job_id"] = job.jobId;

  return row;
}

function rowToJob(row) {
  if (!row) return null;
  const out = {};
  for (const [col, val] of Object.entries(row)) {
    const camel = JOB_SNAKE_TO_CAMEL[col] || snakeToCamel(col);
    out[camel] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field mappings — pipelines
// ---------------------------------------------------------------------------

const PIPELINE_CAMEL_TO_SNAKE = {
  pipelineId: "pipeline_id",
  issueKey: "issue_key",
  parentKey: "parent_key",
  type: "pipeline_type",
  pipelineType: "pipeline_type",
  workingDir: "working_dir",
  callbackUrl: "callback_url",
  requestedProvider: "requested_provider",
  currentPhase: "current_phase",
  contextBridgeFile: "context_bridge_file",
  worktreePath: "worktree_path",
  worktreeBranch: "worktree_branch",
  worktreeId: "worktree_id",
  createdAt: "created_at",
  startedAt: "started_at",
  completedAt: "completed_at",
};

const PIPELINE_SNAKE_TO_CAMEL = {
  pipeline_id: "pipelineId",
  issue_key: "issueKey",
  parent_key: "parentKey",
  pipeline_type: "type",
  working_dir: "workingDir",
  callback_url: "callbackUrl",
  requested_provider: "requestedProvider",
  current_phase: "currentPhase",
  context_bridge_file: "contextBridgeFile",
  worktree_path: "worktreePath",
  worktree_branch: "worktreeBranch",
  worktree_id: "worktreeId",
  created_at: "createdAt",
  started_at: "startedAt",
  completed_at: "completedAt",
};

const PIPELINE_DB_COLUMNS = new Set([
  "pipeline_id",
  "issue_key",
  "parent_key",
  "pipeline_type",
  "description",
  "working_dir",
  "labels",
  "callback_url",
  "slack",
  "telegram",
  "requested_provider",
  "status",
  "current_phase",
  "phases",
  "context_bridge_file",
  "worktree_path",
  "worktree_branch",
  "worktree_id",
  "created_at",
  "started_at",
  "completed_at",
  "error",
]);

const PIPELINE_JSONB_COLS = new Set(["phases", "slack", "telegram"]);

function pipelineToRow(pipeline) {
  const row = {};
  for (const [camel, val] of Object.entries(pipeline)) {
    const col = PIPELINE_CAMEL_TO_SNAKE[camel] || camelToSnake(camel);
    if (!PIPELINE_DB_COLUMNS.has(col)) continue;
    row[col] = PIPELINE_JSONB_COLS.has(col) ? jsonb(val) : norm(val);
  }
  if (!row["pipeline_id"] && pipeline.pipelineId) row["pipeline_id"] = pipeline.pipelineId;
  return row;
}

function rowToPipeline(row) {
  if (!row) return null;
  const out = {};
  for (const [col, val] of Object.entries(row)) {
    const camel = PIPELINE_SNAKE_TO_CAMEL[col] || snakeToCamel(col);
    out[camel] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field mappings — meetings
// ---------------------------------------------------------------------------

const MEETING_CAMEL_TO_SNAKE = {
  meetingId: "meeting_id",
  autoDiscuss: "auto_discuss",
  roundRobin: "round_robin",
  maxRounds: "max_rounds",
  maxTurns: "max_turns",
  turnCount: "turn_count",
  currentSpeaker: "current_speaker",
  callbackUrl: "callback_url",
  workingDir: "working_dir",
  productId: "product_id",
  createdAt: "created_at",
  endedAt: "ended_at",
};

const MEETING_SNAKE_TO_CAMEL = {
  meeting_id: "meetingId",
  auto_discuss: "autoDiscuss",
  round_robin: "roundRobin",
  max_rounds: "maxRounds",
  max_turns: "maxTurns",
  turn_count: "turnCount",
  current_speaker: "currentSpeaker",
  callback_url: "callbackUrl",
  working_dir: "workingDir",
  product_id: "productId",
  created_at: "createdAt",
  ended_at: "endedAt",
};

const MEETING_DB_COLUMNS = new Set([
  "meeting_id",
  "topic",
  "agents",
  "facilitator",
  "chair",
  "mode",
  "transcript",
  "status",
  "telegram",
  "callback_url",
  "working_dir",
  "product_id",
  "created_at",
  "ended_at",
  "current_speaker",
  "round_robin",
  "auto_discuss",
  "max_rounds",
  "max_turns",
  "turn_count",
  "summary",
]);

const MEETING_JSONB_COLS = new Set(["transcript", "telegram"]);

function meetingToRow(meeting) {
  const row = {};
  for (const [camel, val] of Object.entries(meeting)) {
    const col = MEETING_CAMEL_TO_SNAKE[camel] || camelToSnake(camel);
    if (!MEETING_DB_COLUMNS.has(col)) continue;
    row[col] = MEETING_JSONB_COLS.has(col) ? jsonb(val) : norm(val);
  }
  if (!row["meeting_id"] && meeting.meetingId) row["meeting_id"] = meeting.meetingId;
  return row;
}

function rowToMeeting(row) {
  if (!row) return null;
  const out = {};
  for (const [col, val] of Object.entries(row)) {
    const camel = MEETING_SNAKE_TO_CAMEL[col] || snakeToCamel(col);
    out[camel] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field mappings — worktrees
// ---------------------------------------------------------------------------

const WORKTREE_CAMEL_TO_SNAKE = {
  issueKey: "issue_key",
  baseRepo: "base_repo",
  pipelineId: "pipeline_id",
  createdAt: "created_at",
  lastJobId: "last_job_id",
  lastJobAgent: "last_job_agent",
  prUrl: "pr_url",
};

const WORKTREE_SNAKE_TO_CAMEL = {
  issue_key: "issueKey",
  base_repo: "baseRepo",
  pipeline_id: "pipelineId",
  created_at: "createdAt",
  last_job_id: "lastJobId",
  last_job_agent: "lastJobAgent",
  pr_url: "prUrl",
};

const WORKTREE_DB_COLUMNS = new Set([
  "id",
  "issue_key",
  "branch",
  "path",
  "base_repo",
  "pipeline_id",
  "status",
  "created_at",
  "last_job_id",
  "last_job_agent",
  "pr_url",
]);

function worktreeToRow(worktree) {
  const row = {};
  for (const [camel, val] of Object.entries(worktree)) {
    const col = WORKTREE_CAMEL_TO_SNAKE[camel] || camelToSnake(camel);
    if (!WORKTREE_DB_COLUMNS.has(col)) continue;
    row[col] = norm(val);
  }
  return row;
}

function rowToWorktree(row) {
  if (!row) return null;
  const out = {};
  for (const [col, val] of Object.entries(row)) {
    const camel = WORKTREE_SNAKE_TO_CAMEL[col] || snakeToCamel(col);
    out[camel] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field mappings — scheduled items
// ---------------------------------------------------------------------------

const SCHEDULED_CAMEL_TO_SNAKE = {
  scheduledFor: "scheduled_at",
  scheduledAt: "scheduled_at",
  executedAt: "executed_at",
  cancelledAt: "cancelled_at",
  createdAt: "created_at",
};

const SCHEDULED_SNAKE_TO_CAMEL = {
  scheduled_at: "scheduledFor",
  executed_at: "executedAt",
  cancelled_at: "cancelledAt",
  created_at: "createdAt",
};

const SCHEDULED_DB_COLUMNS = new Set([
  "id",
  "type",
  "scheduled_at",
  "status",
  "executed_at",
  "cancelled_at",
  "payload",
  "source",
  "created_at",
]);

function scheduledItemToRow(item) {
  const row = {};
  for (const [camel, val] of Object.entries(item)) {
    const col = SCHEDULED_CAMEL_TO_SNAKE[camel] || camelToSnake(camel);
    if (!SCHEDULED_DB_COLUMNS.has(col)) continue;
    row[col] = col === "payload" ? jsonb(val) : norm(val);
  }
  return row;
}

function rowToScheduledItem(row) {
  if (!row) return null;
  const out = {};
  for (const [col, val] of Object.entries(row)) {
    const camel = SCHEDULED_SNAKE_TO_CAMEL[col] || snakeToCamel(col);
    out[camel] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field mappings — batches
// ---------------------------------------------------------------------------

const BATCH_DB_COLUMNS = new Set([
  "batch_id",
  "total",
  "completed",
  "failed",
  "results",
  "slack",
  "telegram",
  "created_at",
]);

const BATCH_JSONB_COLS = new Set(["results", "slack", "telegram"]);

function batchToRow(batch) {
  const row = {};
  for (const [camel, val] of Object.entries(batch)) {
    const col = camel === "batchId" ? "batch_id" : camel === "createdAt" ? "created_at" : camelToSnake(camel);
    if (!BATCH_DB_COLUMNS.has(col)) continue;
    row[col] = BATCH_JSONB_COLS.has(col) ? jsonb(val) : norm(val);
  }
  if (!row["batch_id"] && batch.batchId) row["batch_id"] = batch.batchId;
  return row;
}

function rowToBatch(row) {
  if (!row) return null;
  const out = {};
  for (const [col, val] of Object.entries(row)) {
    const camel = col === "batch_id" ? "batchId" : col === "created_at" ? "createdAt" : snakeToCamel(col);
    out[camel] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

const MIGRATIONS = [
  // 001 — jobs
  `CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'delivery',
    status TEXT NOT NULL DEFAULT 'queued',
    agent TEXT NOT NULL DEFAULT '',
    issue_key TEXT,
    conversation_id TEXT,
    summary TEXT,
    description TEXT,
    working_dir TEXT,
    model TEXT,
    selected_model TEXT,
    requested_provider TEXT,
    provider TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    log_file TEXT,
    meta_file TEXT,
    process_pid INTEGER,
    error TEXT,
    last_error TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    retry_at TIMESTAMPTZ,
    quality_gate JSONB,
    quality_gate_failure JSONB,
    quality_gate_retry_count INTEGER NOT NULL DEFAULT 0,
    usage JSONB,
    callback_url TEXT,
    slack JSONB,
    telegram JSONB,
    source TEXT,
    batch_id TEXT,
    parent_key TEXT,
    is_subtask BOOLEAN NOT NULL DEFAULT false,
    pipeline_id TEXT,
    pipeline_phase TEXT,
    pipeline_phase_index INTEGER,
    worktree_id TEXT,
    meeting_action JSONB,
    chrome_enabled BOOLEAN DEFAULT false,
    chrome_usage JSONB,
    chrome_reason TEXT,
    team_session_id TEXT,
    team_role TEXT,
    teammates TEXT[],
    session_id TEXT,
    product_id TEXT,
    parsed_output JSONB,
    prompt TEXT,
    context TEXT,
    pre_read_brief TEXT,
    history_text TEXT,
    stream_events JSONB
  )`,

  // 001 — jobs indexes
  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_agent ON jobs (agent)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_issue_key ON jobs (issue_key) WHERE issue_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_finished_at ON jobs (finished_at DESC) WHERE finished_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_pipeline_id ON jobs (pipeline_id) WHERE pipeline_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_batch_id ON jobs (batch_id) WHERE batch_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_product_id ON jobs (product_id) WHERE product_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs (status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_agent_status ON jobs (agent, status)`,

  // 002 — pipelines
  `CREATE TABLE IF NOT EXISTS pipelines (
    pipeline_id TEXT PRIMARY KEY,
    issue_key TEXT NOT NULL,
    parent_key TEXT,
    pipeline_type TEXT NOT NULL,
    description TEXT,
    working_dir TEXT NOT NULL,
    labels TEXT[],
    callback_url TEXT,
    slack JSONB,
    telegram JSONB,
    requested_provider TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    current_phase INTEGER NOT NULL DEFAULT 0,
    phases JSONB NOT NULL DEFAULT '[]'::jsonb,
    context_bridge_file TEXT,
    worktree_path TEXT,
    worktree_branch TEXT,
    worktree_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pipelines_status ON pipelines (status)`,
  `CREATE INDEX IF NOT EXISTS idx_pipelines_issue_key ON pipelines (issue_key)`,
  `CREATE INDEX IF NOT EXISTS idx_pipelines_created_at ON pipelines (created_at DESC)`,

  // 003 — meetings
  `CREATE TABLE IF NOT EXISTS meetings (
    meeting_id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    agents TEXT[] NOT NULL,
    facilitator TEXT,
    chair TEXT,
    mode TEXT NOT NULL DEFAULT 'chair',
    transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'active',
    telegram JSONB,
    callback_url TEXT,
    working_dir TEXT,
    product_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    current_speaker TEXT,
    round_robin BOOLEAN DEFAULT true,
    auto_discuss BOOLEAN DEFAULT false,
    max_rounds INTEGER NOT NULL DEFAULT 2,
    max_turns INTEGER NOT NULL DEFAULT 20,
    turn_count INTEGER NOT NULL DEFAULT 0,
    summary TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings (status)`,

  // 004 — worktrees
  `CREATE TABLE IF NOT EXISTS worktrees (
    id TEXT PRIMARY KEY,
    issue_key TEXT NOT NULL,
    branch TEXT NOT NULL,
    path TEXT NOT NULL,
    base_repo TEXT NOT NULL,
    pipeline_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_job_id TEXT,
    last_job_agent TEXT,
    pr_url TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_worktrees_issue_key ON worktrees (issue_key)`,
  `CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees (status)`,

  // 005 — scheduled_items
  `CREATE TABLE IF NOT EXISTS scheduled_items (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    scheduled_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending',
    executed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    source TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_items (status)`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_time ON scheduled_items (scheduled_at) WHERE status = 'pending'`,

  // 006 — batches
  `CREATE TABLE IF NOT EXISTS batches (
    batch_id TEXT PRIMARY KEY,
    total INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    results JSONB NOT NULL DEFAULT '[]'::jsonb,
    slack JSONB,
    telegram JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // 007 — subtask_groups
  `CREATE TABLE IF NOT EXISTS subtask_groups (
    parent_key TEXT PRIMARY KEY,
    subtasks JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // 008 — idempotency_store
  `CREATE TABLE IF NOT EXISTS idempotency_store (
    key TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_store (created_at)`,

  // 009 — skill_usage
  `CREATE TABLE IF NOT EXISTS skill_usage (
    skill_name TEXT PRIMARY KEY,
    reads INTEGER NOT NULL DEFAULT 0,
    script_runs INTEGER NOT NULL DEFAULT 0,
    last_used TIMESTAMPTZ,
    by_agent JSONB NOT NULL DEFAULT '{}'::jsonb
  )`,

  // 010 — metrics singleton
  `CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `INSERT INTO metrics (id, data) VALUES (1, '{}') ON CONFLICT (id) DO NOTHING`,

  // 011 — issues (built-in issue tracker)
  `CREATE TABLE IF NOT EXISTS issues (
    id SERIAL PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    project TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'task',
    status TEXT NOT NULL DEFAULT 'todo',
    summary TEXT NOT NULL,
    description TEXT,
    priority TEXT DEFAULT 'medium',
    labels TEXT[] DEFAULT '{}',
    assignee TEXT,
    parent_key TEXT,
    story_points INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_issues_key ON issues (key)`,
  `CREATE INDEX IF NOT EXISTS idx_issues_project ON issues (project)`,
  `CREATE INDEX IF NOT EXISTS idx_issues_status ON issues (status)`,
  `CREATE INDEX IF NOT EXISTS idx_issues_type ON issues (type)`,
  `CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues (assignee) WHERE assignee IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_issues_parent_key ON issues (parent_key) WHERE parent_key IS NOT NULL`,

  // 012 — issue_links
  `CREATE TABLE IF NOT EXISTS issue_links (
    id SERIAL PRIMARY KEY,
    source_key TEXT NOT NULL,
    target_key TEXT NOT NULL,
    link_type TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_issue_links_source ON issue_links (source_key)`,
  `CREATE INDEX IF NOT EXISTS idx_issue_links_target ON issue_links (target_key)`,

  // 013 — issue_comments
  `CREATE TABLE IF NOT EXISTS issue_comments (
    id SERIAL PRIMARY KEY,
    issue_key TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_issue_comments_key ON issue_comments (issue_key)`,

  // 014 — issue_transitions
  `CREATE TABLE IF NOT EXISTS issue_transitions (
    id SERIAL PRIMARY KEY,
    issue_key TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_issue_transitions_key ON issue_transitions (issue_key)`,

  // 015 — issue_sequences (auto-key generation per project)
  `CREATE TABLE IF NOT EXISTS issue_sequences (
    project TEXT PRIMARY KEY,
    last_number INTEGER NOT NULL DEFAULT 0
  )`,

  // 016 — notifications (in-app notification system)
  `CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    severity TEXT DEFAULT 'info',
    read BOOLEAN DEFAULT false,
    link TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications (read, created_at DESC)`,
];

async function runMigrations(client) {
  console.log("[db] Running schema migrations…");
  for (const sql of MIGRATIONS) {
    await client.query(sql);
  }
  console.log("[db] Schema migrations complete.");
}

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

/**
 * Initialise the connection pool and run schema migrations.
 * Retries the initial connection with exponential backoff for up to 30 seconds.
 *
 * @param {object} config - runner config object (may include database sub-object)
 */
async function init(config = {}) {
  const dbConfig = {
    host: process.env.RUNNER_DB_HOST || config.database?.host || "localhost",
    port: parseInt(process.env.RUNNER_DB_PORT || config.database?.port || "5432", 10),
    database: process.env.RUNNER_DB_NAME || config.database?.name || "runner",
    user: process.env.RUNNER_DB_USER || config.database?.user || "runner",
    password:
      process.env.RUNNER_DB_PASSWORD ||
      config.database?.password ||
      "runner_secure_password",
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };

  console.log(
    `[db] Connecting to PostgreSQL at ${dbConfig.host}:${dbConfig.port}/${dbConfig.database} as ${dbConfig.user}`
  );

  pool = new Pool(dbConfig);

  // Retry loop — up to 30 seconds with exponential backoff
  const maxAttempts = 6; // 1s + 2s + 4s + 8s + 15s ≈ 30s total wait
  const delays = [1000, 2000, 4000, 8000, 16000];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let client;
    try {
      client = await pool.connect();
      console.log(`[db] Connected to PostgreSQL (attempt ${attempt})`);

      await runMigrations(client);
      client.release();
      console.log("[db] Database initialisation complete.");
      return;
    } catch (err) {
      if (client) {
        try {
          client.release(err);
        } catch (_) {
          // ignore release errors
        }
      }

      if (attempt === maxAttempts) {
        console.error(`[db] Failed to connect to PostgreSQL after ${maxAttempts} attempts:`, err.message);
        throw err;
      }

      const delay = delays[attempt - 1] || 16000;
      console.warn(
        `[db] Connection attempt ${attempt} failed (${err.message}). Retrying in ${delay}ms…`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// close() / isHealthy()
// ---------------------------------------------------------------------------

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log("[db] Connection pool closed.");
  }
}

async function isHealthy() {
  if (!pool) return { connected: false, error: "Pool not initialised" };
  try {
    const start = Date.now();
    await pool.query("SELECT 1");
    return { connected: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Upsert builder helper
// ---------------------------------------------------------------------------

function buildUpsert(tableName, primaryKey, row) {
  const cols = Object.keys(row);
  const vals = Object.values(row);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const updates = cols.filter((c) => c !== primaryKey).map((c) => `${c} = EXCLUDED.${c}`);
  const sql = `INSERT INTO ${tableName} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})
               ON CONFLICT (${primaryKey}) DO UPDATE SET ${updates.join(", ")}`;
  return { sql, vals };
}

// ---------------------------------------------------------------------------
// jobs repository
// ---------------------------------------------------------------------------

const jobsRepo = {
  async get(jobId) {
    const { rows } = await pool.query("SELECT * FROM jobs WHERE job_id = $1", [jobId]);
    return rows[0] ? rowToJob(rows[0]) : null;
  },

  async set(job) {
    const row = jobToRow(job);
    const { sql, vals } = buildUpsert("jobs", "job_id", row);
    await pool.query(sql, vals);
  },

  async delete(jobId) {
    await pool.query("DELETE FROM jobs WHERE job_id = $1", [jobId]);
  },

  /**
   * Lightweight status update — avoids a full round-trip serialisation.
   * @param {string} jobId
   * @param {string} status
   * @param {object} fields - additional camelCase fields to update
   */
  async updateStatus(jobId, status, fields = {}) {
    const sets = ["status = $2"];
    const vals = [jobId, status];
    let i = 3;
    for (const [key, val] of Object.entries(fields)) {
      const col = JOB_CAMEL_TO_SNAKE[key] || camelToSnake(key);
      if (!JOB_DB_COLUMNS.has(col)) continue;
      sets.push(`${col} = $${i}`);
      vals.push(JOB_JSONB_COLS.has(col) ? jsonb(val) : norm(val));
      i++;
    }
    await pool.query(`UPDATE jobs SET ${sets.join(", ")} WHERE job_id = $1`, vals);
  },

  async findByStatus(...statuses) {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map((_, i) => `$${i + 1}`);
    const { rows } = await pool.query(
      `SELECT * FROM jobs WHERE status IN (${placeholders.join(", ")}) ORDER BY created_at DESC`,
      statuses
    );
    return rows.map(rowToJob);
  },

  async findByIssueKey(issueKey) {
    const { rows } = await pool.query(
      "SELECT * FROM jobs WHERE issue_key = $1 ORDER BY created_at DESC",
      [issueKey]
    );
    return rows.map(rowToJob);
  },

  async findByPipelineId(pipelineId) {
    const { rows } = await pool.query(
      "SELECT * FROM jobs WHERE pipeline_id = $1 ORDER BY created_at ASC",
      [pipelineId]
    );
    return rows.map(rowToJob);
  },

  async listAll({ status, agent, product, search, sort, order, limit, offset } = {}) {
    const conditions = [];
    const vals = [];
    let i = 1;

    if (status) {
      conditions.push(`status = $${i++}`);
      vals.push(status);
    }
    if (agent) {
      conditions.push(`agent = $${i++}`);
      vals.push(agent);
    }
    if (product) {
      conditions.push(`product_id = $${i++}`);
      vals.push(product);
    }
    if (search) {
      conditions.push(`(job_id ILIKE $${i} OR agent ILIKE $${i} OR issue_key ILIKE $${i})`);
      vals.push(`%${search}%`);
      i++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sortCol = JOB_CAMEL_TO_SNAKE[sort] || camelToSnake(sort || "createdAt");
    const allowedSortCols = JOB_DB_COLUMNS;
    const safeSortCol = allowedSortCols.has(sortCol) ? sortCol : "created_at";
    const sortOrder = order === "asc" ? "ASC" : "DESC";

    // Build count query using only the filter params (not limit/offset)
    const countVals = vals.slice();
    const countSql = `SELECT COUNT(*) FROM jobs ${where}`;

    const limitClause = limit != null ? `LIMIT $${i++}` : "";
    if (limit != null) vals.push(parseInt(limit, 10));
    const offsetClause = offset != null ? `OFFSET $${i++}` : "";
    if (offset != null) vals.push(parseInt(offset, 10));

    const [{ rows }, countResult] = await Promise.all([
      pool.query(
        `SELECT * FROM jobs ${where} ORDER BY ${safeSortCol} ${sortOrder} ${limitClause} ${offsetClause}`,
        vals
      ),
      pool.query(countSql, countVals),
    ]);

    return { jobs: rows.map(rowToJob), total: parseInt(countResult.rows[0].count, 10) };
  },

  async countByStatus() {
    const { rows } = await pool.query(
      "SELECT status, COUNT(*) AS count FROM jobs GROUP BY status"
    );
    const result = {};
    for (const row of rows) result[row.status] = parseInt(row.count, 10);
    return result;
  },

  async aggregateStats(sinceMs) {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const { rows } = await pool.query(
      `SELECT
         agent,
         status,
         COUNT(*) AS count,
         SUM(COALESCE((usage->>'inputTokens')::int, 0)) AS input_tokens,
         SUM(COALESCE((usage->>'outputTokens')::int, 0)) AS output_tokens,
         SUM(COALESCE((usage->>'estimatedCostUsd')::numeric, 0)) AS cost
       FROM jobs
       WHERE created_at > $1
       GROUP BY agent, status`,
      [since]
    );
    return rows;
  },

  async pruneTerminal(maxAgeDays) {
    const cutoff = new Date(
      Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const { rowCount } = await pool.query(
      `DELETE FROM jobs
       WHERE status IN ('succeeded','failed','quality-gate-failed','cancelled')
         AND finished_at < $1`,
      [cutoff]
    );
    return rowCount;
  },

  async count() {
    const { rows } = await pool.query("SELECT COUNT(*) FROM jobs");
    return parseInt(rows[0].count, 10);
  },
};

// ---------------------------------------------------------------------------
// pipelines repository
// ---------------------------------------------------------------------------

const pipelinesRepo = {
  async get(pipelineId) {
    const { rows } = await pool.query(
      "SELECT * FROM pipelines WHERE pipeline_id = $1",
      [pipelineId]
    );
    return rows[0] ? rowToPipeline(rows[0]) : null;
  },

  async set(pipeline) {
    const row = pipelineToRow(pipeline);
    const { sql, vals } = buildUpsert("pipelines", "pipeline_id", row);
    await pool.query(sql, vals);
  },

  async delete(pipelineId) {
    await pool.query("DELETE FROM pipelines WHERE pipeline_id = $1", [pipelineId]);
  },

  async findByIssueKey(issueKey) {
    const { rows } = await pool.query(
      "SELECT * FROM pipelines WHERE issue_key = $1 ORDER BY created_at DESC",
      [issueKey]
    );
    return rows.map(rowToPipeline);
  },

  async findByStatus(...statuses) {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map((_, i) => `$${i + 1}`);
    const { rows } = await pool.query(
      `SELECT * FROM pipelines WHERE status IN (${placeholders.join(", ")}) ORDER BY created_at DESC`,
      statuses
    );
    return rows.map(rowToPipeline);
  },

  async listAll() {
    const { rows } = await pool.query(
      "SELECT * FROM pipelines ORDER BY created_at DESC"
    );
    return rows.map(rowToPipeline);
  },

  /**
   * Patch a single phase entry inside the JSONB phases array.
   * @param {string} pipelineId
   * @param {number} phaseIndex - 0-based index into the phases array
   * @param {object} phaseData - the updated phase object
   */
  async updatePhase(pipelineId, phaseIndex, phaseData) {
    await pool.query(
      `UPDATE pipelines
       SET phases = jsonb_set(phases, $1::text[], $2::jsonb)
       WHERE pipeline_id = $3`,
      [`{${phaseIndex}}`, JSON.stringify(phaseData), pipelineId]
    );
  },

  async pruneTerminal(maxAgeDays) {
    const cutoff = new Date(
      Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const { rowCount } = await pool.query(
      `DELETE FROM pipelines
       WHERE status IN ('completed','failed') AND completed_at < $1`,
      [cutoff]
    );
    return rowCount;
  },

  async count() {
    const { rows } = await pool.query("SELECT COUNT(*) FROM pipelines");
    return parseInt(rows[0].count, 10);
  },
};

// ---------------------------------------------------------------------------
// meetings repository
// ---------------------------------------------------------------------------

const meetingsRepo = {
  async get(meetingId) {
    const { rows } = await pool.query(
      "SELECT * FROM meetings WHERE meeting_id = $1",
      [meetingId]
    );
    return rows[0] ? rowToMeeting(rows[0]) : null;
  },

  async set(meeting) {
    const row = meetingToRow(meeting);
    const { sql, vals } = buildUpsert("meetings", "meeting_id", row);
    await pool.query(sql, vals);
  },

  async delete(meetingId) {
    await pool.query("DELETE FROM meetings WHERE meeting_id = $1", [meetingId]);
  },

  async findActive() {
    const { rows } = await pool.query(
      "SELECT * FROM meetings WHERE status = 'active' ORDER BY created_at DESC"
    );
    return rows.map(rowToMeeting);
  },

  async listAll() {
    const { rows } = await pool.query(
      "SELECT * FROM meetings ORDER BY created_at DESC"
    );
    return rows.map(rowToMeeting);
  },

  async pruneOld(maxAgeDays) {
    const cutoff = new Date(
      Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const { rowCount } = await pool.query(
      "DELETE FROM meetings WHERE status = 'completed' AND ended_at < $1",
      [cutoff]
    );
    return rowCount;
  },

  async count() {
    const { rows } = await pool.query("SELECT COUNT(*) FROM meetings");
    return parseInt(rows[0].count, 10);
  },
};

// ---------------------------------------------------------------------------
// worktrees repository
// ---------------------------------------------------------------------------

const worktreesRepo = {
  async get(id) {
    const { rows } = await pool.query(
      "SELECT * FROM worktrees WHERE id = $1",
      [id]
    );
    return rows[0] ? rowToWorktree(rows[0]) : null;
  },

  async set(worktree) {
    const row = worktreeToRow(worktree);
    const { sql, vals } = buildUpsert("worktrees", "id", row);
    await pool.query(sql, vals);
  },

  async delete(id) {
    await pool.query("DELETE FROM worktrees WHERE id = $1", [id]);
  },

  async findByIssueKey(issueKey) {
    const { rows } = await pool.query(
      "SELECT * FROM worktrees WHERE issue_key = $1",
      [issueKey]
    );
    return rows.map(rowToWorktree);
  },

  async findActive() {
    const { rows } = await pool.query(
      "SELECT * FROM worktrees WHERE status = 'active'"
    );
    return rows.map(rowToWorktree);
  },

  async listAll() {
    const { rows } = await pool.query(
      "SELECT * FROM worktrees ORDER BY created_at DESC"
    );
    return rows.map(rowToWorktree);
  },

  async count() {
    const { rows } = await pool.query("SELECT COUNT(*) FROM worktrees");
    return parseInt(rows[0].count, 10);
  },
};

// ---------------------------------------------------------------------------
// scheduled repository
// ---------------------------------------------------------------------------

const scheduledRepo = {
  async get(id) {
    const { rows } = await pool.query(
      "SELECT * FROM scheduled_items WHERE id = $1",
      [id]
    );
    return rows[0] ? rowToScheduledItem(rows[0]) : null;
  },

  async set(item) {
    const row = scheduledItemToRow(item);
    const { sql, vals } = buildUpsert("scheduled_items", "id", row);
    await pool.query(sql, vals);
  },

  async delete(id) {
    await pool.query("DELETE FROM scheduled_items WHERE id = $1", [id]);
  },

  async findPending() {
    const { rows } = await pool.query(
      "SELECT * FROM scheduled_items WHERE status = 'pending' ORDER BY scheduled_at ASC"
    );
    return rows.map(rowToScheduledItem);
  },

  async findDue(now) {
    const { rows } = await pool.query(
      `SELECT * FROM scheduled_items
       WHERE status = 'pending' AND scheduled_at <= $1
       ORDER BY scheduled_at ASC`,
      [now.toISOString()]
    );
    return rows.map(rowToScheduledItem);
  },

  async listAll() {
    const { rows } = await pool.query(
      "SELECT * FROM scheduled_items ORDER BY created_at DESC"
    );
    return rows.map(rowToScheduledItem);
  },

  async pruneOld(maxAgeDays) {
    const cutoff = new Date(
      Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const { rowCount } = await pool.query(
      `DELETE FROM scheduled_items
       WHERE status IN ('done','cancelled')
         AND COALESCE(executed_at, created_at) < $1`,
      [cutoff]
    );
    return rowCount;
  },

  async count() {
    const { rows } = await pool.query("SELECT COUNT(*) FROM scheduled_items");
    return parseInt(rows[0].count, 10);
  },
};

// ---------------------------------------------------------------------------
// batches repository
// ---------------------------------------------------------------------------

const batchesRepo = {
  async get(batchId) {
    const { rows } = await pool.query(
      "SELECT * FROM batches WHERE batch_id = $1",
      [batchId]
    );
    return rows[0] ? rowToBatch(rows[0]) : null;
  },

  async set(batch) {
    const row = batchToRow(batch);
    const { sql, vals } = buildUpsert("batches", "batch_id", row);
    await pool.query(sql, vals);
  },

  async listAll() {
    const { rows } = await pool.query(
      "SELECT * FROM batches ORDER BY created_at DESC"
    );
    return rows.map(rowToBatch);
  },

  async count() {
    const { rows } = await pool.query("SELECT COUNT(*) FROM batches");
    return parseInt(rows[0].count, 10);
  },
};

// ---------------------------------------------------------------------------
// subtaskGroups repository
// ---------------------------------------------------------------------------

const subtaskGroupsRepo = {
  async get(parentKey) {
    const { rows } = await pool.query(
      "SELECT subtasks FROM subtask_groups WHERE parent_key = $1",
      [parentKey]
    );
    // subtasks is JSONB so pg returns it as a parsed JS value already
    return rows[0] ? rows[0].subtasks : null;
  },

  async set(parentKey, subtasks) {
    await pool.query(
      `INSERT INTO subtask_groups (parent_key, subtasks)
       VALUES ($1, $2)
       ON CONFLICT (parent_key) DO UPDATE SET subtasks = $2`,
      [parentKey, JSON.stringify(subtasks)]
    );
  },

  async listAll() {
    const { rows } = await pool.query("SELECT * FROM subtask_groups");
    return rows;
  },

  async count() {
    const { rows } = await pool.query("SELECT COUNT(*) FROM subtask_groups");
    return parseInt(rows[0].count, 10);
  },
};

// ---------------------------------------------------------------------------
// idempotency repository
// ---------------------------------------------------------------------------

const idempotencyRepo = {
  async get(key) {
    const { rows } = await pool.query(
      "SELECT * FROM idempotency_store WHERE key = $1",
      [key]
    );
    return rows[0] || null;
  },

  async set(key, jobId) {
    await pool.query(
      `INSERT INTO idempotency_store (key, job_id)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET job_id = $2, created_at = NOW()`,
      [key, jobId]
    );
  },

  async prune(ttlHours) {
    const cutoff = new Date(
      Date.now() - ttlHours * 60 * 60 * 1000
    ).toISOString();
    const { rowCount } = await pool.query(
      "DELETE FROM idempotency_store WHERE created_at < $1",
      [cutoff]
    );
    return rowCount;
  },
};

// ---------------------------------------------------------------------------
// skillUsage repository
// ---------------------------------------------------------------------------

const skillUsageRepo = {
  async getAll() {
    const { rows } = await pool.query("SELECT * FROM skill_usage");
    const result = {};
    for (const row of rows) {
      result[row.skill_name] = {
        reads: row.reads,
        scriptRuns: row.script_runs,
        lastUsed: row.last_used,
        byAgent: row.by_agent,
      };
    }
    return result;
  },

  async increment(skillName, eventType, agentName) {
    const field = eventType === "read" ? "reads" : "script_runs";
    await pool.query(
      `INSERT INTO skill_usage (skill_name, ${field}, last_used, by_agent)
       VALUES ($1::text, 1, NOW(), jsonb_build_object($2::text, 1))
       ON CONFLICT (skill_name) DO UPDATE SET
         ${field} = skill_usage.${field} + 1,
         last_used = NOW(),
         by_agent = CASE
           WHEN skill_usage.by_agent ? $2::text
           THEN jsonb_set(
             skill_usage.by_agent,
             ARRAY[$2::text],
             to_jsonb((skill_usage.by_agent ->> $2::text)::int + 1)
           )
           ELSE skill_usage.by_agent || jsonb_build_object($2::text, 1)
         END`,
      [skillName, agentName]
    );
  },
};

// ---------------------------------------------------------------------------
// metrics repository
// ---------------------------------------------------------------------------

const metricsRepo = {
  async get() {
    const { rows } = await pool.query(
      "SELECT data FROM metrics WHERE id = 1"
    );
    return rows[0]?.data || {};
  },

  async set(metricsObj) {
    await pool.query(
      "UPDATE metrics SET data = $1, updated_at = NOW() WHERE id = 1",
      [JSON.stringify(metricsObj)]
    );
  },
};

// ---------------------------------------------------------------------------
// issues repository (built-in issue tracker)
// ---------------------------------------------------------------------------

const ALLOWED_ISSUE_STATUSES = ["todo", "in_progress", "done", "cancelled"];
const ALLOWED_TRANSITIONS = {
  todo: ["in_progress", "cancelled"],
  in_progress: ["todo", "done", "cancelled"],
  done: ["todo", "in_progress"],
  cancelled: ["todo"],
};

const issuesRepo = {
  /** Generate the next issue key for a project (e.g. "EOS-42") */
  async nextKey(project) {
    const { rows } = await pool.query(
      `INSERT INTO issue_sequences (project, last_number)
       VALUES ($1, 1)
       ON CONFLICT (project) DO UPDATE SET last_number = issue_sequences.last_number + 1
       RETURNING last_number`,
      [project.toUpperCase()]
    );
    return `${project.toUpperCase()}-${rows[0].last_number}`;
  },

  async create({ project, type, summary, description, priority, labels, assignee, parentKey, storyPoints }) {
    const key = await this.nextKey(project);
    const { rows } = await pool.query(
      `INSERT INTO issues (key, project, type, summary, description, priority, labels, assignee, parent_key, story_points)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [key, project.toUpperCase(), type || "task", summary, norm(description), priority || "medium",
       labels || [], norm(assignee), norm(parentKey), norm(storyPoints)]
    );
    return rowToObject(rows[0]);
  },

  async get(key) {
    const { rows } = await pool.query("SELECT * FROM issues WHERE key = $1", [key]);
    return rows[0] ? rowToObject(rows[0]) : null;
  },

  async getById(id) {
    const { rows } = await pool.query("SELECT * FROM issues WHERE id = $1", [id]);
    return rows[0] ? rowToObject(rows[0]) : null;
  },

  async update(key, fields) {
    const allowed = ["summary", "description", "priority", "labels", "assignee", "parent_key", "story_points", "type"];
    const sets = ["updated_at = NOW()"];
    const vals = [key];
    let i = 2;
    for (const [k, v] of Object.entries(fields)) {
      const col = camelToSnake(k);
      if (!allowed.includes(col)) continue;
      sets.push(`${col} = $${i++}`);
      vals.push(v === undefined ? null : v);
    }
    if (sets.length === 1) return this.get(key); // nothing to update
    const { rows } = await pool.query(
      `UPDATE issues SET ${sets.join(", ")} WHERE key = $1 RETURNING *`,
      vals
    );
    return rows[0] ? rowToObject(rows[0]) : null;
  },

  async transition(key, toStatus, actor) {
    const issue = await this.get(key);
    if (!issue) return null;
    const fromStatus = issue.status;
    if (!ALLOWED_ISSUE_STATUSES.includes(toStatus)) {
      throw new Error(`Invalid status: ${toStatus}`);
    }
    const allowed = ALLOWED_TRANSITIONS[fromStatus] || [];
    if (!allowed.includes(toStatus)) {
      throw new Error(`Cannot transition from '${fromStatus}' to '${toStatus}'`);
    }
    const resolvedAt = toStatus === "done" ? "NOW()" : "NULL";
    const { rows } = await pool.query(
      `UPDATE issues SET status = $2, updated_at = NOW(), resolved_at = ${resolvedAt}
       WHERE key = $1 RETURNING *`,
      [key, toStatus]
    );
    // Record the transition
    await pool.query(
      `INSERT INTO issue_transitions (issue_key, from_status, to_status, actor) VALUES ($1, $2, $3, $4)`,
      [key, fromStatus, toStatus, norm(actor)]
    );
    return rows[0] ? rowToObject(rows[0]) : null;
  },

  getTransitions(currentStatus) {
    return (ALLOWED_TRANSITIONS[currentStatus] || []).map((s) => ({
      id: s,
      name: s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      to: { name: s },
    }));
  },

  async search({ project, status, type, label, assignee, search, parentKey, limit, offset } = {}) {
    const conditions = [];
    const vals = [];
    let i = 1;
    if (project) { conditions.push(`project = $${i++}`); vals.push(project.toUpperCase()); }
    if (status) { conditions.push(`status = $${i++}`); vals.push(status); }
    if (type) { conditions.push(`type = $${i++}`); vals.push(type); }
    if (label) { conditions.push(`$${i++} = ANY(labels)`); vals.push(label); }
    if (assignee) { conditions.push(`assignee = $${i++}`); vals.push(assignee); }
    if (parentKey) { conditions.push(`parent_key = $${i++}`); vals.push(parentKey); }
    if (search) {
      conditions.push(`(key ILIKE $${i} OR summary ILIKE $${i} OR description ILIKE $${i})`);
      vals.push(`%${search}%`);
      i++;
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const countVals = vals.slice();
    const lim = limit != null ? `LIMIT $${i++}` : "";
    if (limit != null) vals.push(parseInt(limit, 10));
    const off = offset != null ? `OFFSET $${i++}` : "";
    if (offset != null) vals.push(parseInt(offset, 10));
    const [{ rows }, countResult] = await Promise.all([
      pool.query(`SELECT * FROM issues ${where} ORDER BY created_at DESC ${lim} ${off}`, vals),
      pool.query(`SELECT COUNT(*) FROM issues ${where}`, countVals),
    ]);
    return { issues: rows.map(rowToObject), total: parseInt(countResult.rows[0].count, 10) };
  },

  async getSubtasks(parentKey) {
    const { rows } = await pool.query(
      "SELECT * FROM issues WHERE parent_key = $1 ORDER BY created_at ASC",
      [parentKey]
    );
    return rows.map(rowToObject);
  },

  async delete(key) {
    const { rowCount } = await pool.query("DELETE FROM issues WHERE key = $1", [key]);
    return rowCount > 0;
  },

  async count(project) {
    const q = project
      ? { text: "SELECT COUNT(*) FROM issues WHERE project = $1", values: [project.toUpperCase()] }
      : { text: "SELECT COUNT(*) FROM issues" };
    const { rows } = await pool.query(q);
    return parseInt(rows[0].count, 10);
  },
};

// ---------------------------------------------------------------------------
// issue_comments repository
// ---------------------------------------------------------------------------

const issueCommentsRepo = {
  async create(issueKey, author, body) {
    const { rows } = await pool.query(
      `INSERT INTO issue_comments (issue_key, author, body) VALUES ($1, $2, $3) RETURNING *`,
      [issueKey, author, body]
    );
    return rowToObject(rows[0]);
  },

  async listByIssue(issueKey) {
    const { rows } = await pool.query(
      "SELECT * FROM issue_comments WHERE issue_key = $1 ORDER BY created_at ASC",
      [issueKey]
    );
    return rows.map(rowToObject);
  },

  async delete(id) {
    await pool.query("DELETE FROM issue_comments WHERE id = $1", [id]);
  },
};

// ---------------------------------------------------------------------------
// issue_links repository
// ---------------------------------------------------------------------------

const issueLinksRepo = {
  async create(sourceKey, targetKey, linkType) {
    const { rows } = await pool.query(
      `INSERT INTO issue_links (source_key, target_key, link_type) VALUES ($1, $2, $3) RETURNING *`,
      [sourceKey, targetKey, linkType]
    );
    return rowToObject(rows[0]);
  },

  async listByIssue(issueKey) {
    const { rows } = await pool.query(
      `SELECT * FROM issue_links WHERE source_key = $1 OR target_key = $1 ORDER BY created_at ASC`,
      [issueKey]
    );
    return rows.map(rowToObject);
  },

  async delete(id) {
    await pool.query("DELETE FROM issue_links WHERE id = $1", [id]);
  },
};

// ---------------------------------------------------------------------------
// issue_transitions repository
// ---------------------------------------------------------------------------

const issueTransitionsRepo = {
  async listByIssue(issueKey) {
    const { rows } = await pool.query(
      "SELECT * FROM issue_transitions WHERE issue_key = $1 ORDER BY created_at ASC",
      [issueKey]
    );
    return rows.map(rowToObject);
  },
};

// ---------------------------------------------------------------------------
// notifications repository
// ---------------------------------------------------------------------------

const notificationsRepo = {
  async create({ type, title, body, severity, link }) {
    const { rows } = await pool.query(
      `INSERT INTO notifications (type, title, body, severity, link) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [type, title, norm(body), severity || "info", norm(link)]
    );
    return rowToObject(rows[0]);
  },

  async list({ unreadOnly, limit, offset } = {}) {
    const conditions = [];
    const vals = [];
    let i = 1;
    if (unreadOnly) { conditions.push(`read = false`); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const lim = limit != null ? `LIMIT $${i++}` : "LIMIT 50";
    if (limit != null) vals.push(parseInt(limit, 10));
    const off = offset != null ? `OFFSET $${i++}` : "";
    if (offset != null) vals.push(parseInt(offset, 10));
    const { rows } = await pool.query(
      `SELECT * FROM notifications ${where} ORDER BY created_at DESC ${lim} ${off}`,
      vals
    );
    return rows.map(rowToObject);
  },

  async markRead(id) {
    await pool.query("UPDATE notifications SET read = true WHERE id = $1", [id]);
  },

  async markAllRead() {
    await pool.query("UPDATE notifications SET read = true WHERE read = false");
  },

  async unreadCount() {
    const { rows } = await pool.query("SELECT COUNT(*) FROM notifications WHERE read = false");
    return parseInt(rows[0].count, 10);
  },

  async prune(maxAgeDays) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const { rowCount } = await pool.query(
      "DELETE FROM notifications WHERE read = true AND created_at < $1",
      [cutoff]
    );
    return rowCount;
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  init,
  close,
  isHealthy,
  jobs: jobsRepo,
  pipelines: pipelinesRepo,
  meetings: meetingsRepo,
  worktrees: worktreesRepo,
  scheduled: scheduledRepo,
  batches: batchesRepo,
  subtaskGroups: subtaskGroupsRepo,
  idempotency: idempotencyRepo,
  skillUsage: skillUsageRepo,
  metrics: metricsRepo,
  issues: issuesRepo,
  issueComments: issueCommentsRepo,
  issueLinks: issueLinksRepo,
  issueTransitions: issueTransitionsRepo,
  notifications: notificationsRepo,
  // Exposed for testing / advanced use
  _helpers: { camelToSnake, snakeToCamel, jobToRow, rowToJob, pipelineToRow, rowToPipeline },
};
