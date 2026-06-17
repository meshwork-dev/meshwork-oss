// config.js — configuration loading, validation, and derived constants
// Extracted from runner.js.

require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const RUNNER_ROOT = path.join(__dirname, "..");

require("dotenv").config();

/**
 * Load configuration from config.json
 * Falls back to environment variables for secrets only
 */
function loadConfig() {
  const configPath = path.join(RUNNER_ROOT, "config.json");
  let fileConfig = {};

  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      console.log("Loaded configuration from config.json");
    } catch (e) {
      console.error("Warning: Failed to parse config.json:", e.message);
    }
  } else {
    console.log("No config.json found, using defaults");
  }

  // Helper to expand ~ in paths
  const expandPath = (p) => {
    if (!p) return p;
    if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
    return p;
  };

  return {
    // Server settings
    port: fileConfig.port || 3210,
    host: fileConfig.host || "127.0.0.1",

    // Secrets (env vars only - never store in config file)
    secret: process.env.RUNNER_SECRET,

    // Job settings
    jobTimeoutMinutes: fileConfig.jobTimeoutMinutes || 60,
    maxConcurrencyPerProduct: fileConfig.maxConcurrencyPerProduct || 1,
    maxRetries: fileConfig.maxRetries ?? 3,
    sseEnabled: fileConfig.sseEnabled !== false,
    // Admission control: reject new work with 429 once this many jobs are queued (0 disables)
    maxQueueDepth: Number(fileConfig.maxQueueDepth ?? process.env.MAX_QUEUE_DEPTH ?? 200),
    // Hard timeout for all outbound HTTP (callbacks, alerts, consults)
    outboundHttpTimeoutMs: Number(fileConfig.outboundHttpTimeoutMs ?? process.env.OUTBOUND_HTTP_TIMEOUT_MS ?? 30000),

    // Paths
    workingDir: expandPath(fileConfig.workingDir) || process.env.DEFAULT_WORKING_DIR || process.cwd(),
    logDir: expandPath(fileConfig.logDir) || path.join(os.homedir(), "claude-runner-logs"),
    convDir: expandPath(fileConfig.convDir) || null, // Will default to logDir/conversations
    allowedRoots: fileConfig.allowedRoots || [],

    // URLs
    callbackUrl: fileConfig.callbackUrl || process.env.N8N_CALLBACK_URL || null,
    internalCallbackUrl: fileConfig.internalCallbackUrl || null,

    // Conversation settings
    convTurns: fileConfig.convTurns || 16,
    convMaxChars: fileConfig.convMaxChars || 24000,
    convStaleDays: fileConfig.convStaleDays || 30,

    // Idempotency
    idempotencyTtlHours: fileConfig.idempotencyTtlHours || 72,

    // Token pricing
    tokenPricing: {
      inputPerMillion: fileConfig.tokenPricing?.inputPerMillion || 15.00,
      outputPerMillion: fileConfig.tokenPricing?.outputPerMillion || 75.00
    },

    // Security
    protectHealthEndpoint: fileConfig.protectHealthEndpoint || false,
    protectDashboard: fileConfig.protectDashboard || false,

    // Dashboard
    dashboardOrigins: fileConfig.dashboardOrigins || ["http://localhost:3100"],
    dashboardUrl: fileConfig.dashboardUrl || "http://localhost:3100",

    // Reliability (Phase 1)
    logRetentionDays: fileConfig.logRetentionDays || 30,
    alerting: fileConfig.alerting || { slackWebhookUrl: null },
    budget: fileConfig.budget || { enabled: false, dailyLimitUsd: 50, hourlyLimitUsd: 20 },

    // Claude CLI settings
    claude: {
      command: fileConfig.claude?.command || "claude",
      baseArgs: fileConfig.claude?.baseArgs || ["--dangerously-skip-permissions"],
      models: {
        opus: fileConfig.claude?.models?.opus || "claude-opus-4-5-20251101",
        sonnet: fileConfig.claude?.models?.sonnet || "claude-sonnet-4-5-20251101",
        haiku: fileConfig.claude?.models?.haiku || "claude-haiku-4-5-20251101"
      },
      fallbacks: fileConfig.claude?.fallbacks || { opus: "sonnet", sonnet: "haiku" }
    },

    // Provider configuration (claude, zai, etc.)
    providers: fileConfig.providers || {
      claude: { type: "claude-cli", authMode: "auto", baseUrl: null, authTokenEnvVar: "ANTHROPIC_API_KEY" }
    },

    // Model routing configuration
    routing: {
      enabled: fileConfig.routing?.enabled !== false,
      agentToProvider: fileConfig.routing?.agentToProvider || {},
      agentToModel: fileConfig.routing?.agentToModel || {
        "engineer-planner": "opus",
        "engineer-implementer": "sonnet",
        "engineer-reviewer": "opus",
        "product-manager": "opus",
        "marketing": "sonnet",
        "bug-triage": "opus"
      },
      modeDefaults: fileConfig.routing?.modeDefaults || {
        delivery: "sonnet",
        chat: "haiku"
      },
      agentToolRestrictions: fileConfig.routing?.agentToolRestrictions || {}
    },

    // Quality gate configuration
    qualityGate: {
      enabled: fileConfig.qualityGate?.enabled !== false,
      runAfterAgents: fileConfig.qualityGate?.runAfterAgents || ["engineer-implementer", "e2e-builder"],
      checks: fileConfig.qualityGate?.checks || [
        { name: "typecheck", cmd: "npm run typecheck", required: true },
        { name: "lint", cmd: "npm run lint", required: true },
        { name: "test", cmd: "npm test", required: true }
      ],
      maxRetries: fileConfig.qualityGate?.maxRetries ?? 2,
      retryWithContext: fileConfig.qualityGate?.retryWithContext !== false
    },

    // Fix-loop: re-dispatch implementation phases with error context on quality-gate failure
    fixLoop: {
      enabled: fileConfig.fixLoop?.enabled !== false,
      maxAttempts: fileConfig.fixLoop?.maxAttempts ?? 3,
      maxVerifyAttempts: fileConfig.fixLoop?.maxVerifyAttempts ?? 3,
      gateTypes: fileConfig.fixLoop?.gateTypes || ["quality-gate"],
      // Phases whose gate failure loops work back to the implementer instead of
      // failing the pipeline outright (block-recovery loop)
      fixablePhases: fileConfig.fixLoop?.fixablePhases || ["verify", "code-review", "security-review"]
    },

    // Gate semantics: comment-prefix gates parse an explicit verdict and fail closed
    gates: {
      // Require a recognizable verdict after the prefix ([AUTO-X] VERDICT: PASS).
      // When true, a prefix with no parsable verdict fails the gate.
      requireVerdict: fileConfig.gates?.requireVerdict !== false,
      // Legacy behaviour: pass the gate when the job succeeded even if the
      // prefix never appeared in output. Off by default — gates fail closed.
      legacyTrustSucceededJob: fileConfig.gates?.legacyTrustSucceededJob === true,
      // Structured observations: gates with `structured: true` in their
      // pipeline definition compute the verdict from agent-submitted
      // observations via the thin policy layer instead of parsing the
      // agent's self-issued verdict. Dual-run: with no observations the
      // legacy prefix path applies, unless `require` forces fail-closed.
      structuredObservations: {
        enabled: fileConfig.gates?.structuredObservations?.enabled !== false,
        require: fileConfig.gates?.structuredObservations?.require === true,
        policy: fileConfig.gates?.structuredObservations?.policy || { failOnSeverity: "critical", failOnAcGap: true }
      }
    },

    // Verification sampling: adversarial second reviews on a sample of passed
    // review gates. Measures the overturn rate (escaped-defect instrumentation)
    // — never blocks or advances pipelines.
    verification: {
      enabled: fileConfig.verification?.enabled !== false,
      sampleRate: fileConfig.verification?.sampleRate ?? 0.1,
      phases: fileConfig.verification?.phases || ["code-review"],
      triggerOnZeroFindings: fileConfig.verification?.triggerOnZeroFindings !== false,
      agent: fileConfig.verification?.agent || "engineer-reviewer",
      model: fileConfig.verification?.model || "sonnet"
    },

    // Shared cross-agent lessons file (institutional memory). Gate failures and
    // review findings append here; code-writing agents get the tail in prompts.
    lessons: {
      enabled: fileConfig.lessons?.enabled !== false,
      maxChars: fileConfig.lessons?.maxChars || 48000,
      promptChars: fileConfig.lessons?.promptChars || 4000,
      agents: fileConfig.lessons?.agents || ["engineer-implementer", "ui-engineer", "e2e-builder", "qa-agent"]
    },

    // Chrome integration configuration (visual testing)
    chrome: {
      enabled: fileConfig.chrome?.enabled !== false,
      phase: fileConfig.chrome?.phase || "acceptance",
      acceptanceAgents: fileConfig.chrome?.acceptanceAgents || ["product-manager"],
      frontendPatterns: fileConfig.chrome?.frontendPatterns || [
        "apps/web/**", "**/*.tsx", "**/*.jsx", "**/*.css", "**/components/**"
      ],
      triggerLabels: fileConfig.chrome?.triggerLabels || ["needs-visual-test"]
    },

    // Dev server configuration (for Chrome testing)
    devServer: {
      startCommand: fileConfig.devServer?.startCommand || "pnpm dev",
      frontendUrl: fileConfig.devServer?.frontendUrl || "http://localhost:3000",
      backendUrl: fileConfig.devServer?.backendUrl || "http://localhost:3001",
      healthCheckUrl: fileConfig.devServer?.healthCheckUrl || "http://localhost:3000",
      healthCheckTimeout: fileConfig.devServer?.healthCheckTimeout || 60000
    },

    // Subtask-based workflow configuration
    subtasks: {
      enabled: fileConfig.subtasks?.enabled !== false,
      maxConcurrency: fileConfig.subtasks?.maxConcurrency || 10,
      maxPerParent: fileConfig.subtasks?.maxPerParent || 3,
      maxDepth: fileConfig.subtasks?.maxDepth || 3,
      parallelAgents: fileConfig.subtasks?.parallelAgents || ["engineer-implementer", "ui-engineer", "creative-assets", "marketing"],
      // Runner parses [CREATE-SUBTASKS] blocks itself and, after a delay,
      // verifies the subtasks actually exist in the tracker (N8N parsing can
      // fail silently). On mismatch it flags the parent issue.
      verifyCreation: fileConfig.subtasks?.verifyCreation !== false,
      verifyDelaySeconds: fileConfig.subtasks?.verifyDelaySeconds || 120
    },

    // Agent Teams configuration
    teams: {
      enabled: fileConfig.teams?.enabled || false,
      teamLeads: fileConfig.teams?.teamLeads || {},
      // Dispatch an isolated reviewer job after each successful team-lead
      // delivery session, so review happens outside the team's shared context
      independentReview: fileConfig.teams?.independentReview !== false,
      independentReviewAgent: fileConfig.teams?.independentReviewAgent || "engineer-reviewer"
    },

    // Dependency gating: block pipelines until blocker branches are merged to main
    dependencyGating: {
      enabled: fileConfig.dependencyGating?.enabled || false,
      checkGitMerge: fileConfig.dependencyGating?.checkGitMerge !== false,
      recheckIntervalSeconds: fileConfig.dependencyGating?.recheckIntervalSeconds || 60,
      maxBlockedMinutes: fileConfig.dependencyGating?.maxBlockedMinutes || 120,
    },

    // Worktree isolation configuration
    worktrees: {
      enabled: fileConfig.worktrees?.enabled || false,
      baseDir: fileConfig.worktrees?.baseDir || "~/meshwork-worktrees",
      maxPerRepo: fileConfig.worktrees?.maxPerRepo || 20,
      pruneOnStartup: fileConfig.worktrees?.pruneOnStartup !== false
    },

    // Path mappings (host path → container path, for Docker)
    pathMappings: fileConfig.pathMappings || {},

    // Meeting intelligence configuration
    meetings: {
      contextWebhookUrl: fileConfig.meetings?.contextWebhookUrl || null,
      outcomesWebhookUrl: fileConfig.meetings?.outcomesWebhookUrl || null,
      confluenceSpace: fileConfig.meetings?.confluenceSpace || "CE",
      confluenceParentPage: fileConfig.meetings?.confluenceParentPage || "Meetings",
      jiraProject: fileConfig.meetings?.jiraProject || "PROJ",
      scheduledMeetings: fileConfig.meetings?.scheduledMeetings || [],
      allowedTools: fileConfig.meetings?.allowedTools || [],
      autoDispatchActions: fileConfig.meetings?.autoDispatchActions !== false,
      // Implicit gate (auto-pause) tuning — see detectImplicitGateNeed/judgeBorderlineGate
      implicitGateStoryThreshold: fileConfig.meetings?.implicitGateStoryThreshold ?? 3,
      implicitGateActionThreshold: fileConfig.meetings?.implicitGateActionThreshold ?? 5,
      implicitGateLLMEnabled: fileConfig.meetings?.implicitGateLLMEnabled !== false,
      implicitGateLLMThreshold: fileConfig.meetings?.implicitGateLLMThreshold ?? 6,
    },

    // Jira direct API access (for auto-transitions without Claude CLI)
    jira: {
      domain: process.env.JIRA_DOMAIN || fileConfig.jira?.domain || "",
      email: process.env.JIRA_EMAIL || fileConfig.jira?.email || "",
      apiToken: process.env.JIRA_API_TOKEN || fileConfig.jira?.apiToken || "",
    },

    // Per-agent MCP allowlist (agent name -> array of MCP server names; null/missing = all servers)
    // alwaysLoad servers (e.g. n8n-jira-mcp) are always included regardless of allowlist.
    agentMcps: fileConfig.agentMcps || {},

    // Agent label mapping (agent:label -> agent name)
    agentLabels: fileConfig.agentLabels || {
      "agent:planner": "engineer-planner",
      "agent:implementer": "engineer-implementer",
      "agent:reviewer": "engineer-reviewer",
      "agent:pm": "product-manager",
      "agent:ui": "ui-engineer",
      "agent:marketing": "marketing",
      "agent:creative-assets": "creative-assets",
      "agent:bug-triage": "bug-triage",
      "agent:security": "security-agent",
      "agent:sprint-report": "sprint-reporter",
      "agent:standup": "sprint-reporter",
      // Full-name aliases (agents create subtasks with these)
      "agent:engineer-planner": "engineer-planner",
      "agent:engineer-implementer": "engineer-implementer",
      "agent:engineer-reviewer": "engineer-reviewer",
      "agent:product-manager": "product-manager",
      "agent:ui-engineer": "ui-engineer",
      "agent:sprint-reporter": "sprint-reporter",
      "agent:security-agent": "security-agent",
      "agent:qa-agent": "qa-agent",
      "agent:ba-agent": "ba-agent",
      "agent:architect": "architect",
      "agent:ux-agent": "ux-agent",
      "agent:ask-dave-agent": "ask-dave-agent",
      "agent:e2e-builder": "e2e-builder",
      "agent:uat-agent": "uat-agent",
      "agent:sales-development": "sales-development",
      "agent:sales-researcher": "sales-researcher",
      "agent:sales-outreach": "sales-outreach",
      // Malformed short aliases occasionally applied by humans or upstream
      // agents that didn't follow the full-name convention. Map them so the
      // reconciler dispatches the right agent and the post-job strip can
      // remove them, instead of leaving them stuck on the issue forever.
      "agent:ba": "ba-agent",
      "agent:ux": "ux-agent",
      "agent:qa": "qa-agent",
      "agent:architect": "architect",
      "agent:ask-dave": "ask-dave-agent",
      "agent:uat": "uat-agent",
      "agent:e2e": "e2e-builder"
    },

    // Sprint Runner: auto-dispatch To Do issues from active sprints
    sprintRunner: fileConfig.sprintRunner || { enabled: false },

    // Agent Label Reconciler: catch issues with agent:* labels that the sprint
    // runner missed (in-flight status, manual labels, webhook drops). Also fires
    // immediately after every successful agent job to dispatch follow-up routing.
    agentLabelReconciler: {
      enabled: fileConfig.agentLabelReconciler?.enabled !== false,
      intervalMinutes: fileConfig.agentLabelReconciler?.intervalMinutes || 15,
      idempotencyMinutes: fileConfig.agentLabelReconciler?.idempotencyMinutes || 30,
      lookbackDays: fileConfig.agentLabelReconciler?.lookbackDays || 14,
      maxPerProductCycle: fileConfig.agentLabelReconciler?.maxPerProductCycle || 10,
      skipLabels: fileConfig.agentLabelReconciler?.skipLabels || ["on-hold", "blocked"],
    },

    // Local team members: route specified teammates through LM Studio instead of Claude
    localTeamMembers: {
      enabled: fileConfig.localTeamMembers?.enabled || false,
      mode: fileConfig.localTeamMembers?.mode || "raw", // "qwen-code" for agentic CLI, "raw" for direct API
      agents: fileConfig.localTeamMembers?.agents || [],
      endpoint: fileConfig.localTeamMembers?.endpoint || "http://localhost:1234/v1/chat/completions",
      dockerEndpoint: fileConfig.localTeamMembers?.dockerEndpoint || "http://host.docker.internal:1234/v1/chat/completions",
      model: fileConfig.localTeamMembers?.model || "",
      agentModels: fileConfig.localTeamMembers?.agentModels || {},
      timeoutMs: fileConfig.localTeamMembers?.timeoutMs || 300000,
      maxOutputTokens: fileConfig.localTeamMembers?.maxOutputTokens || 16384,
      fallbackToClaude: fileConfig.localTeamMembers?.fallbackToClaude !== false,
      qwenCode: fileConfig.localTeamMembers?.qwenCode || null,
    },

    // Context bridge: structured phase handoff for pipelines
    contextBridge: {
      enabled: fileConfig.contextBridge?.enabled !== false,
      maxSummaryWords: fileConfig.contextBridge?.maxSummaryWords || 300,
      compactMaxWords: fileConfig.contextBridge?.compactMaxWords || 120,
      phaseExtractors: fileConfig.contextBridge?.phaseExtractors || {},
    },

    // Notification configuration (outgoing webhook)
    notifications: {
      webhookUrl: fileConfig.notifications?.webhookUrl || null,
    },

    // Integration toggles (for self-service deployment)
    integrations: {
      jira: { enabled: !!(fileConfig.jira?.domain && fileConfig.jira?.email) || !!(process.env.JIRA_DOMAIN && process.env.JIRA_EMAIL) },
      telegram: { enabled: !!(fileConfig.telegram?.enabled) || !!process.env.TELEGRAM_BOT_TOKEN },
      n8n: { enabled: fileConfig.integrations?.n8n?.enabled !== false },
    },

    // Pre-read: local model codebase summarisation before Claude runs
    preRead: {
      enabled: fileConfig.preRead?.enabled || false,
      endpoint: fileConfig.preRead?.endpoint || "http://localhost:1234/v1/chat/completions",
      dockerEndpoint: fileConfig.preRead?.dockerEndpoint || "http://host.docker.internal:1234/v1/chat/completions",
      model: fileConfig.preRead?.model || "",
      agents: fileConfig.preRead?.agents || [],
      maxFiles: fileConfig.preRead?.maxFiles || 40,
      maxFileLines: fileConfig.preRead?.maxFileLines || 200,
      maxTotalChars: fileConfig.preRead?.maxTotalChars || 80000,
      timeoutMs: fileConfig.preRead?.timeoutMs || 120000,
      scanPatterns: fileConfig.preRead?.scanPatterns || [
        "package.json", "tsconfig.json", "README.md",
        "src/**/*.ts", "src/**/*.tsx", "app/**/*.ts", "app/**/*.tsx"
      ],
      excludePatterns: fileConfig.preRead?.excludePatterns || [
        "node_modules", ".next", "dist", ".git", "coverage"
      ]
    },
  };
}

const config = loadConfig();

// ─── End Product Registry ────────────────────────────────────────────────────

// Validate required secret
if (!config.secret) {
  console.error("RUNNER_SECRET environment variable is not set. Refusing to start.");
  process.exit(1);
}

// Validate secret strength
if (config.secret.length < 16) {
  console.error("RUNNER_SECRET must be at least 16 characters for security. Refusing to start.");
  process.exit(1);
}

/**
 * Apply configuration to constants
 */
const PORT = config.port;
const HOST = config.host;
const SECRET = config.secret;

// Platform root: where products/ and <id>-plugin/ directories live.
// Set PLATFORM_ROOT in env (e.g. /projects/default in Docker) so the runner
// finds scaffolds written by the onboarder in the mounted project volume.
// Defaults to the parent of the runner source dir for standalone / dev use.
const PLATFORM_ROOT = process.env.PLATFORM_ROOT || path.resolve(RUNNER_ROOT, "..");

const LOG_DIR = config.logDir;
fs.mkdirSync(LOG_DIR, { recursive: true });

const JOB_TIMEOUT_MINUTES = config.jobTimeoutMinutes;
const MAX_CONCURRENCY_PER_PRODUCT = config.maxConcurrencyPerProduct || 1;

const DEFAULT_WORKING_DIR = config.workingDir;
const RUNNER_PUBLIC_URL = `http://${HOST}:${PORT}`;
const N8N_CALLBACK_URL = config.callbackUrl;
const MAX_RETRIES = config.maxRetries;
const SSE_ENABLED = config.sseEnabled;
const CONV_STALE_DAYS = config.convStaleDays;

// Token pricing (per million tokens)
const TOKEN_PRICE_INPUT = config.tokenPricing.inputPerMillion;
const TOKEN_PRICE_OUTPUT = config.tokenPricing.outputPerMillion;

const ALLOWED_ROOTS = config.allowedRoots;

// Normalize path-mapping table entries once at load so prefix checks in
// validateWorkingDir compare against canonical paths (no trailing separators,
// no "." / ".." segments).
{
  const normalizedMappings = {};
  for (const [from, to] of Object.entries(config.pathMappings || {})) {
    let nFrom = path.normalize(String(from));
    let nTo = path.normalize(String(to));
    if (nFrom.length > 1 && nFrom.endsWith(path.sep)) nFrom = nFrom.slice(0, -1);
    if (nTo.length > 1 && nTo.endsWith(path.sep)) nTo = nTo.slice(0, -1);
    normalizedMappings[nFrom] = nTo;
  }
  config.pathMappings = normalizedMappings;
}

// Conversation memory
const CONV_DIR = config.convDir || path.join(LOG_DIR, "conversations");
fs.mkdirSync(CONV_DIR, { recursive: true });

/**
 * ============================================================
 * SHARED LESSONS (cross-agent institutional memory)
 * Gate failures, review findings, and quality-gate failures append here.
 * Code-writing agents receive the most recent tail in their prompts so the
 * same failure class isn't rediscovered on every issue.
 * ============================================================
 */
const LESSONS_DIR = path.join(LOG_DIR, "lessons");
const LESSONS_FILE = path.join(LESSONS_DIR, "LESSONS.md");

const CONV_TURNS = config.convTurns;
const CONV_MAX_CHARS = config.convMaxChars;

/**
 * Persisted idempotency store
 */
const IDEMPOTENCY_FILE = path.join(LOG_DIR, "idempotency.json");
const IDEMPOTENCY_TTL_HOURS = config.idempotencyTtlHours;

/**
 * ============================================================
 * STATE PERSISTENCE (Phase 3 — PostgreSQL)
 * All state is persisted to PostgreSQL via db.js write-through.
 * On startup, active state is loaded from DB into in-memory caches.
 * ============================================================
 */

/**
 * Prune terminal records older than retention period from PostgreSQL.
 */
const JOB_STATE_RETENTION_DAYS = config.jobStateRetentionDays || 7;

/**
 * ============================================================
 * STALE-JOB RECOVERY (heartbeat)
 * Running jobs touch a DB heartbeat every ~30s. A periodic sweep
 * fails/retries running jobs whose heartbeat has gone stale (e.g.
 * the runner died mid-job) and that are not tracked in memory.
 * ============================================================
 */
const JOB_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const STALE_JOB_HEARTBEAT_MINUTES = 10;
const STALE_JOB_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * ============================================================
 * CALLBACK RETRY (Phase 1.3)
 * Retry callbacks with exponential backoff. On permanent failure,
 * write to failed-callbacks directory for manual replay.
 *
 * Callback serialization queue: ensures callbacks are sent one at
 * a time to prevent N8N SQLite WAL corruption from concurrent writes.
 * ============================================================
 */
const FAILED_CALLBACKS_DIR = path.join(LOG_DIR, "failed-callbacks");
fs.mkdirSync(FAILED_CALLBACKS_DIR, { recursive: true });

/**
 * ============================================================
 * PIPELINE FAILURE ALERTING (Phase 1.5)
 * On job:failed (after all retries), POST to Slack webhook.
 * ============================================================
 */
const ALERT_SLACK_WEBHOOK = config.alerting?.slackWebhookUrl || null;

// jobIndex listeners removed — DB is the source of truth for terminal jobs

/**
 * ============================================================
 * LOG ROTATION (Phase 1.6)
 * Delete .log and .json meta files older than logRetentionDays.
 * Runs on the existing daily cleanup interval.
 * ============================================================
 */
const LOG_RETENTION_DAYS = config.logRetentionDays || 30;

/**
 * POST JSON helper (callback)
 * All outbound requests carry a hard timeout so dead endpoints can't
 * accumulate hanging sockets (resource-exhaustion vector).
 */
const OUTBOUND_HTTP_TIMEOUT_MS = Number(config.outboundHttpTimeoutMs || process.env.OUTBOUND_HTTP_TIMEOUT_MS || 30000);

/**
 * Optional retention pruning (RETENTION_DAYS env; default 0 = disabled).
 * Deletes terminal jobs, untouched conversations, and read notifications
 * older than the retention window. Runs daily and ~1 min after startup.
 */
const RETENTION_DAYS = Math.max(0, parseInt(process.env.RETENTION_DAYS || "0", 10) || 0);

module.exports = {
  loadConfig,
  config,
  PORT,
  HOST,
  SECRET,
  LOG_DIR,
  JOB_TIMEOUT_MINUTES,
  MAX_CONCURRENCY_PER_PRODUCT,
  DEFAULT_WORKING_DIR,
  RUNNER_PUBLIC_URL,
  N8N_CALLBACK_URL,
  MAX_RETRIES,
  SSE_ENABLED,
  CONV_STALE_DAYS,
  TOKEN_PRICE_INPUT,
  TOKEN_PRICE_OUTPUT,
  ALLOWED_ROOTS,
  CONV_DIR,
  LESSONS_DIR,
  LESSONS_FILE,
  CONV_TURNS,
  CONV_MAX_CHARS,
  IDEMPOTENCY_FILE,
  IDEMPOTENCY_TTL_HOURS,
  JOB_STATE_RETENTION_DAYS,
  JOB_HEARTBEAT_INTERVAL_MS,
  STALE_JOB_HEARTBEAT_MINUTES,
  STALE_JOB_SWEEP_INTERVAL_MS,
  FAILED_CALLBACKS_DIR,
  ALERT_SLACK_WEBHOOK,
  LOG_RETENTION_DAYS,
  OUTBOUND_HTTP_TIMEOUT_MS,
  RETENTION_DAYS,
  RUNNER_ROOT,
  PLATFORM_ROOT,
};
