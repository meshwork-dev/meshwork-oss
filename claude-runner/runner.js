// runner.js
require("dotenv").config();

const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { EventEmitter } = require("events");
const db = require("./db");
const issueTracker = require("./issue-tracker");

// Optional "big brother" router (the-loop) is only loaded if installed alongside the runner.
let registerBigBrotherRoutes = null;
try {
  registerBigBrotherRoutes = require("../the-loop/router");
} catch (_err) {
  registerBigBrotherRoutes = (app, _opts) => app;
}

/**
 * Event emitter for job lifecycle events
 */
const jobEmitter = new EventEmitter();
jobEmitter.setMaxListeners(100);

const app = express();
app.use(express.json({ limit: "20mb" }));

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

/**
 * Load configuration from config.json
 * Falls back to environment variables for secrets only
 */
function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
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
      }
    },

    // Provider configuration (claude, zai, etc.)
    providers: fileConfig.providers || {
      claude: { baseUrl: null, authTokenEnvVar: "ANTHROPIC_API_KEY" }
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
      gateTypes: fileConfig.fixLoop?.gateTypes || ["quality-gate"]
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
      parallelAgents: fileConfig.subtasks?.parallelAgents || ["engineer-implementer", "ui-engineer", "creative-assets", "marketing"]
    },

    // Agent Teams configuration
    teams: {
      enabled: fileConfig.teams?.enabled || false,
      teamLeads: fileConfig.teams?.teamLeads || {}
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
      baseDir: fileConfig.worktrees?.baseDir || "~/certpilot-worktrees",
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
      jiraProject: fileConfig.meetings?.jiraProject || "CER",
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
      "agent:architect-jets": "architect-jets",
      "agent:ux-agent": "ux-agent",
      "agent:ask-tom-agent": "ask-tom-agent",
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
      "agent:architect": "architect-jets",
      "agent:ask-tom": "ask-tom-agent",
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

// ─── Product Registry ────────────────────────────────────────────────────────

const productsDir = path.join(__dirname, "..", "products");
const products = new Map();

function loadProducts() {
  if (!fs.existsSync(productsDir)) return;
  for (const dir of fs.readdirSync(productsDir)) {
    const configPath = path.join(productsDir, dir, "product.json");
    if (fs.existsSync(configPath)) {
      try {
        const product = JSON.parse(fs.readFileSync(configPath, "utf8"));
        products.set(dir, product);
        console.log(`Loaded product: ${dir}${product.pluginDir ? ` (plugin: ${product.pluginDir})` : ''}`);
      } catch (e) {
        console.error(`Failed to load product ${dir}: ${e.message}`);
      }
    }
  }
}
loadProducts();

/**
 * Find a product by ID, Jira project key, or name (case-insensitive).
 * Checks: exact id match → jira.projectKey → case-insensitive id → case-insensitive name.
 * Returns the matching product object, or null if none matches.
 */
function findProduct(query) {
  if (!query) return null;
  // Exact id match
  if (products.has(query)) return products.get(query);
  const q = query.toLowerCase();
  for (const [, product] of products) {
    // Jira project key match (e.g. "EOS", "CER", "WMS")
    if (product.jira?.projectKey && product.jira.projectKey.toLowerCase() === q) return product;
  }
  for (const [id, product] of products) {
    // Case-insensitive id or name match
    if (id.toLowerCase() === q) return product;
    if (product.name && product.name.toLowerCase() === q) return product;
  }
  return null;
}

/**
 * Resolve a product config from a working directory path.
 * Returns the matching product object, or null if none matches.
 */
function resolveProduct(workingDir) {
  if (!workingDir) return null;
  const resolved = path.resolve(workingDir);
  const mappings = config.pathMappings || {};
  for (const [, product] of products) {
    if (!product.workingDir) continue;
    const productDir = path.resolve(product.workingDir);
    // Direct match (host path)
    if (productDir === resolved) return product;
    // Mapped match (container path via pathMappings)
    const mappedDir = mappings[product.workingDir];
    if (mappedDir && path.resolve(mappedDir) === resolved) return product;
  }

  // Worktree fallback: if workingDir is a worktree path, look up the worktree record
  // and match via its baseRepo (the original product workingDir).
  for (const [, wt] of worktrees) {
    if (wt.path && path.resolve(wt.path) === resolved && wt.baseRepo) {
      const baseResolved = path.resolve(wt.baseRepo);
      for (const [, product] of products) {
        if (!product.workingDir) continue;
        if (path.resolve(product.workingDir) === baseResolved) return product;
        const mappedDir = mappings[product.workingDir];
        if (mappedDir && path.resolve(mappedDir) === baseResolved) return product;
      }
    }
  }

  return null;
}

/**
 * Resolve a product config from a Telegram chat ID.
 * Returns the matching product object, or null if none matches.
 */
function resolveProductFromTelegramChat(chatId) {
  if (!chatId) return null;
  const normalised = String(chatId);
  for (const [, product] of products) {
    if (product.telegram?.chatId && String(product.telegram.chatId) === normalised) return product;
  }
  return null;
}

/**
 * Resolve Jira project key for a meeting or job context.
 * Uses product config, falls back to global config.
 */
function resolveJiraProject(productIdOrWorkingDir) {
  let product = null;
  if (productIdOrWorkingDir) {
    product = products.get(productIdOrWorkingDir) || resolveProduct(productIdOrWorkingDir);
  }
  return product?.jira?.projectKey || config.meetings?.jiraProject || "CER";
}

/**
 * Resolve Confluence space for a meeting or job context.
 * Uses product config, falls back to global config.
 */
function resolveConfluenceSpace(productIdOrWorkingDir) {
  let product = null;
  if (productIdOrWorkingDir) {
    product = products.get(productIdOrWorkingDir) || resolveProduct(productIdOrWorkingDir);
  }
  return product?.confluence?.space || config.meetings?.confluenceSpace || "CE";
}

/**
 * Resolve the shared skills directory (platform-level, product-agnostic).
 */
function resolveSharedSkillsDir() {
  const rel = config.sharedSkillsDir || 'shared-skills';
  const dir = path.isAbsolute(rel) ? rel : path.resolve(__dirname, '..', rel);
  return fs.existsSync(dir) ? dir : null;
}

/**
 * Resolve the product-specific plugin directory.
 * Falls back to the default certpilot-plugin if no product-specific pluginDir is set.
 */
function resolvePluginDir(product) {
  if (product?.pluginDir) {
    return path.resolve(__dirname, '..', product.pluginDir);
  }
  return config.pluginDir || path.resolve(__dirname, '..', 'certpilot-plugin');
}

/**
 * Resolve all plugin directories for a product: shared-skills first, then product-specific.
 * Shared skills provide generic frameworks; product plugins provide domain context.
 * Claude CLI merges skills from all --plugin-dir paths (repeatable flag).
 */
function resolvePluginDirs(product) {
  const dirs = [];
  const shared = resolveSharedSkillsDir();
  if (shared) dirs.push(shared);
  dirs.push(resolvePluginDir(product));
  return dirs;
}

/**
 * Apply plugin directories to a CLI args array.
 * Removes any existing --plugin-dir entries and appends all resolved dirs.
 */
function applyProductPluginDir(args, product) {
  // Remove all existing --plugin-dir pairs
  let idx;
  while ((idx = args.indexOf('--plugin-dir')) >= 0) {
    args.splice(idx, idx + 1 < args.length ? 2 : 1);
  }
  // Append shared + product plugin dirs
  for (const dir of resolvePluginDirs(product)) {
    args.push('--plugin-dir', dir);
  }
  return args;
}

/**
 * Parse agent markdown frontmatter for skill/context declarations.
 * Skills field declares which skill directories the agent needs loaded.
 * Context field declares which context files to include (e.g., company-brief).
 * Returns { skills: string[], context: string[] } or null if no declarations found.
 */
function parseAgentSkills(agentFilePath) {
  try {
    const content = fs.readFileSync(agentFilePath, 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    const fm = fmMatch[1];
    const result = { skills: [], context: [] };

    for (const key of ['skills', 'context']) {
      const block = fm.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.+\\n?)*)`, 'm'));
      if (block) {
        for (const m of block[1].matchAll(/^\s+-\s+(.+)$/gm)) {
          result[key].push(m[1].trim());
        }
      }
    }

    return (result.skills.length || result.context.length) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Resolve all skills needed for an agent, including team member skills.
 * For team leads, merges skill declarations from all teammate agent files.
 */
function resolveAgentSkills(agentName, product) {
  const pluginDir = resolvePluginDir(product);
  const agentFile = path.join(pluginDir, 'agents', `${agentName}.md`);

  const parsed = parseAgentSkills(agentFile);
  if (!parsed) return null;

  const allSkills = new Set(parsed.skills);
  const allContext = new Set(parsed.context);

  // If this is a team lead, also include teammate skills
  const teamConfig = config.teams?.teamLeads?.[agentName];
  if (teamConfig?.teammates?.length) {
    for (const teammate of teamConfig.teammates) {
      const teammateFile = path.join(pluginDir, 'agents', `${teammate}.md`);
      const teammateParsed = parseAgentSkills(teammateFile);
      if (teammateParsed) {
        teammateParsed.skills.forEach(s => allSkills.add(s));
        teammateParsed.context.forEach(c => allContext.add(c));
      }
    }
  }

  return { skills: [...allSkills], context: [...allContext] };
}

/**
 * Count total available skill directories across product + shared.
 */
function countSkillDirs(pluginDir, sharedDir) {
  let count = 0;
  try {
    count += fs.readdirSync(path.join(pluginDir, 'skills')).filter(
      f => fs.statSync(path.join(pluginDir, 'skills', f)).isDirectory()
    ).length;
  } catch {}
  try {
    if (sharedDir) {
      count += fs.readdirSync(path.join(sharedDir, 'skills')).filter(
        f => fs.statSync(path.join(sharedDir, 'skills', f)).isDirectory()
      ).length;
    }
  } catch {}
  return count;
}

/**
 * Build an optimized plugin directory containing only the skills an agent needs.
 * Creates a temp directory with symlinks to required skills from shared-skills
 * and product-plugin, plus essential config files (agents, commands, hooks, .mcp.json).
 * Returns the temp directory path, or null to fall back to full plugin dirs.
 */
function buildOptimizedPluginDir(agentName, product, jobId, provider) {
  if (!agentName || !product) return null;
  const isLocal = provider === 'local';

  const resolved = resolveAgentSkills(agentName, product);
  if (!resolved) return null;

  const pluginDir = resolvePluginDir(product);
  const sharedDir = resolveSharedSkillsDir();
  try {
    const tmpBase = path.join(os.tmpdir(), `certpilot-ctx-${jobId}`);
    const tmpSkills = path.join(tmpBase, 'skills');
    // Clean leftover dir from previous attempt — retries reuse jobId, so existing
    // symlinks would cause EEXIST on subsequent symlinkSync calls.
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.mkdirSync(tmpSkills, { recursive: true });

    // Symlink full agents directory (all agent defs available for team spawning)
    const agentsDir = path.join(pluginDir, 'agents');
    if (fs.existsSync(agentsDir)) {
      fs.symlinkSync(agentsDir, path.join(tmpBase, 'agents'));
    }

    // Symlink only declared skills — product plugin first, then shared
    let skillsResolved = 0;
    for (const skillName of resolved.skills) {
      const productSkill = path.join(pluginDir, 'skills', skillName);
      const sharedSkill = sharedDir ? path.join(sharedDir, 'skills', skillName) : null;
      const source = fs.existsSync(productSkill) ? productSkill :
                     (sharedSkill && fs.existsSync(sharedSkill)) ? sharedSkill : null;
      if (source) {
        fs.symlinkSync(source, path.join(tmpSkills, skillName));
        skillsResolved++;
      }
    }

    // Symlink context files
    for (const ctxName of resolved.context) {
      if (ctxName === 'company-brief') {
        const briefPath = path.join(pluginDir, 'company-brief.md');
        if (fs.existsSync(briefPath)) {
          fs.symlinkSync(briefPath, path.join(tmpBase, 'company-brief.md'));
        }
      }
    }

    // LOCAL MODELS: skip commands, hooks, and MCP config (saves ~15-20K tokens from tool defs)
    // CLAUDE: include everything for full capability
    if (!isLocal) {
      for (const item of ['commands', 'hooks', '.mcp.json']) {
        const src = path.join(pluginDir, item);
        if (fs.existsSync(src)) {
          fs.symlinkSync(src, path.join(tmpBase, item));
        }
      }
    }

    const totalAvailable = countSkillDirs(pluginDir, sharedDir);
    console.log(`[${nowIso()}] Context optimization: ${agentName} gets ${skillsResolved}/${totalAvailable} skills (declared: ${resolved.skills.length})${isLocal ? ' [LOCAL: single-agent, no MCP]' : ''}`);

    return tmpBase;
  } catch (err) {
    console.error(`[${nowIso()}] Failed to build optimized plugin dir: ${err.message}`);
    return null;
  }
}

/**
 * Build a filtered MCP config file for an agent and return its path.
 * Merges product .mcp.json + shared-skills .mcp.json + working-dir .mcp.json,
 * then keeps only servers in config.agentMcps[agent] (plus any with alwaysLoad: true).
 * Used with --mcp-config + --strict-mcp-config to suppress fan-out of unused MCPs.
 * Returns the file path, or null if no allowlist is configured for the agent.
 */
function buildFilteredMcpConfig(agentName, product, jobId, workingDir, optimizedDir) {
  if (!agentName || !product) return null;
  const baseAllow = config.agentMcps?.[agentName];
  if (!Array.isArray(baseAllow)) return null; // No allowlist → fall back to default behaviour

  // Team leads (e.g. engineer-planner) spawn teammates in-process — union their allowlists
  // so the lead's subprocess has every MCP its teammates may need.
  const allowlistSet = new Set(baseAllow);
  const teamConfig = config.teams?.teamLeads?.[agentName];
  if (teamConfig?.teammates?.length) {
    for (const teammate of teamConfig.teammates) {
      const tAllow = config.agentMcps?.[teammate];
      if (Array.isArray(tAllow)) tAllow.forEach(s => allowlistSet.add(s));
    }
  }
  const allowlist = [...allowlistSet];

  const merged = { mcpServers: {} };
  const sources = [];
  const sharedDir = resolveSharedSkillsDir();
  if (sharedDir) sources.push(path.join(sharedDir, '.mcp.json'));
  sources.push(path.join(resolvePluginDir(product), '.mcp.json'));
  if (workingDir) sources.push(path.join(workingDir, '.mcp.json'));

  for (const src of sources) {
    try {
      if (!fs.existsSync(src)) continue;
      const data = JSON.parse(fs.readFileSync(src, 'utf8'));
      if (data.mcpServers) {
        Object.assign(merged.mcpServers, data.mcpServers);
      }
    } catch (err) {
      console.error(`[${nowIso()}] Failed to read ${src}: ${err.message}`);
    }
  }

  const allow = new Set(allowlist);
  const filtered = { mcpServers: {} };
  let kept = 0, alwaysLoadKept = 0, dropped = 0;
  for (const [name, def] of Object.entries(merged.mcpServers)) {
    if (allow.has(name)) {
      filtered.mcpServers[name] = def;
      kept++;
    } else if (def && def.alwaysLoad === true) {
      filtered.mcpServers[name] = def;
      alwaysLoadKept++;
    } else {
      dropped++;
    }
  }

  // Only write into optimizedDir so cleanupOptimizedPluginDir removes it; otherwise we'd leak.
  if (!optimizedDir) return null;

  try {
    const outPath = path.join(optimizedDir, `mcp-${jobId}.json`);
    fs.writeFileSync(outPath, JSON.stringify(filtered, null, 2));
    console.log(`[${nowIso()}] MCP filter: ${agentName} → kept ${kept} (+${alwaysLoadKept} alwaysLoad), dropped ${dropped} → ${outPath}`);
    return outPath;
  } catch (err) {
    console.error(`[${nowIso()}] Failed to write filtered MCP config: ${err.message}`);
    return null;
  }
}

/**
 * Clean up temporary optimized plugin directory after job completion.
 */
function cleanupOptimizedPluginDir(job) {
  if (job._tmpPluginDir) {
    try {
      fs.rmSync(job._tmpPluginDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[${nowIso()}] Failed to cleanup tmp plugin dir: ${err.message}`);
    }
    delete job._tmpPluginDir;
  }
}

/**
 * Build file-routing rules that tell agents where plugin vs project files belong.
 * Prevents agents from creating plugin directories (agents/, skills/, commands/)
 * inside the product working directory instead of the platform plugin directory.
 */
function buildFileRoutingRules(product) {
  if (!product) return null;
  const pluginDir = resolvePluginDir(product);
  const lines = [
    "<file-routing-rules>",
    "CRITICAL — File Location Rules:",
    `Your working directory is for APPLICATION CODE only (source, tests, docs, configs).`,
    `Plugin files (agent definitions, skills, commands, hooks) belong in the PLATFORM plugin directory:`,
    `  Plugin directory: ${pluginDir}`,
    `  - Agent definitions → ${pluginDir}/agents/`,
    `  - Skills → ${pluginDir}/skills/`,
    `  - Commands → ${pluginDir}/commands/`,
    `  - Hooks → ${pluginDir}/hooks/`,
    "",
    "DO NOT create agent/, skill/, command/, or hook/ directories inside the working directory.",
    "If a task requires creating or modifying plugin files, write them to the plugin directory above.",
    "If a task requires creating or modifying application code, write it to the working directory.",
    "</file-routing-rules>",
  ];
  return lines.join("\n");
}

// ─── End Product Registry ────────────────────────────────────────────────────

// Validate required secret
if (!config.secret) {
  console.error("RUNNER_SECRET environment variable is not set. Refusing to start.");
  process.exit(1);
}

/**
 * Select the optimal Claude model for a job
 * Opus for thinking (plan, review, PM), Sonnet for doing (implement), Haiku for quick answers
 */
function selectModel(job) {
  const routing = config.routing || {};

  // Explicit model override in job request
  if (job.model && ["opus", "sonnet", "haiku"].includes(job.model)) {
    return job.model;
  }

  // Routing disabled = default to sonnet
  if (!routing.enabled) {
    return "sonnet";
  }

  // Agent-based routing (primary)
  const agentMapping = routing.agentToModel || {};
  if (job.agent && agentMapping[job.agent]) {
    return agentMapping[job.agent];
  }

  // Mode-based defaults
  const defaults = routing.modeDefaults || {};
  if (job.mode && defaults[job.mode]) {
    return defaults[job.mode];
  }

  // Fallback to sonnet
  return "sonnet";
}

/**
 * Resolve the full Claude model ID for a named agent.
 * Checks routing.agentToModel first, falls back to sonnet.
 * Returns the full model ID string (e.g. "claude-sonnet-4-6").
 */
function resolveModelForAgent(agentName) {
  const routing = config.routing || {};
  const agentToModel = routing.agentToModel || {};
  const modelKey = agentToModel[agentName] || routing.modeDefaults?.delivery || "sonnet";
  return config.claude.models[modelKey] || config.claude.models.sonnet;
}

/**
 * Determine if Chrome integration should be enabled for a job
 * Chrome is made available to acceptance agents - they decide subjectively whether to use it
 */
function shouldEnableChrome(job) {
  const chromeConfig = config.chrome || {};

  // Chrome disabled globally
  if (!chromeConfig.enabled) {
    return { enabled: false, reason: "chrome disabled in config" };
  }

  // Explicit request in job
  if (job.chrome === true) {
    return { enabled: true, reason: "explicit chrome:true in job request" };
  }

  // Explicit disable in job
  if (job.chrome === false) {
    return { enabled: false, reason: "explicit chrome:false in job request" };
  }

  // Always enable for acceptance phase agents - they decide subjectively whether to use it
  const acceptanceAgents = chromeConfig.acceptanceAgents || ["product-manager"];
  if (acceptanceAgents.includes(job.agent)) {
    return { enabled: true, reason: `acceptance agent (${job.agent}) - chrome available` };
  }

  return { enabled: false, reason: "agent not configured for chrome access" };
}

/**
 * Detect Chrome tool usage from Claude's raw output
 * Returns list of Chrome tools that were called and usage count
 */
function detectChromeUsage(rawOutput) {
  if (!rawOutput) return { used: false, tools: [], count: 0 };

  // Match Chrome MCP tool calls in the output
  const chromeToolPattern = /mcp__claude-in-chrome__(\w+)/g;
  const matches = rawOutput.match(chromeToolPattern) || [];
  const uniqueTools = [...new Set(matches)];

  return {
    used: uniqueTools.length > 0,
    tools: uniqueTools,
    count: matches.length
  };
}

/**
 * Read task progress from ~/.claude/tasks/<taskListId>/
 * Tasks are JSON files created by Claude Code's Tasks feature.
 * Returns structured progress info for cross-phase visibility.
 */
function readTaskProgress(taskListId) {
  if (!taskListId) return null;

  const tasksDir = path.join(os.homedir(), ".claude", "tasks", taskListId);

  if (!fs.existsSync(tasksDir)) {
    return { taskListId, found: false, tasks: [] };
  }

  try {
    const files = fs.readdirSync(tasksDir).filter(f => f.endsWith(".json")).sort();
    const tasks = [];

    for (const file of files) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(tasksDir, file), "utf8"));
        tasks.push({
          id: content.id,
          subject: content.subject,
          status: content.status,
          blockedBy: content.blockedBy || [],
          blocks: content.blocks || [],
        });
      } catch {}
    }

    const total = tasks.length;
    const completed = tasks.filter(t => t.status === "completed").length;
    const inProgress = tasks.filter(t => t.status === "in_progress").length;
    const pending = tasks.filter(t => t.status === "pending").length;

    return {
      taskListId,
      found: true,
      total,
      completed,
      inProgress,
      pending,
      progress: total > 0 ? Math.round((completed / total) * 100) : 0,
      tasks,
    };
  } catch {
    return { taskListId, found: false, tasks: [] };
  }
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

// Conversation memory
const CONV_DIR = config.convDir || path.join(LOG_DIR, "conversations");
fs.mkdirSync(CONV_DIR, { recursive: true });

const CONV_TURNS = config.convTurns;
const CONV_MAX_CHARS = config.convMaxChars;

/**
 * Persisted idempotency store
 */
const IDEMPOTENCY_FILE = path.join(LOG_DIR, "idempotency.json");
const IDEMPOTENCY_TTL_HOURS = config.idempotencyTtlHours;

function loadIdempotency() {
  try {
    if (!fs.existsSync(IDEMPOTENCY_FILE)) return {};
    return JSON.parse(fs.readFileSync(IDEMPOTENCY_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function saveIdempotency(store) {
  fs.writeFileSync(IDEMPOTENCY_FILE, JSON.stringify(store, null, 2), "utf8");
}

function pruneIdempotency(store) {
  const now = Date.now();
  const ttlMs = IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000;
  let changed = false;

  for (const [key, rec] of Object.entries(store)) {
    if (!rec || !rec.createdAt) {
      delete store[key];
      changed = true;
      continue;
    }
    if (now - rec.createdAt > ttlMs) {
      delete store[key];
      changed = true;
    }
  }

  if (changed) saveIdempotency(store);
}

let idempotencyStore = loadIdempotency();
pruneIdempotency(idempotencyStore);
// Also prune DB idempotency records (non-blocking, runs after DB init)
setImmediate(() => {
  db.idempotency.prune(IDEMPOTENCY_TTL_HOURS).catch(e => console.error('[db] idempotency startup prune failed: ' + e.message));
});

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

/**
 * Get the product ID for a job (used for per-product concurrency).
 * Falls back to "_default" for jobs without a resolvable product.
 */
function getProductIdForJob(job) {
  if (job._productId) return job._productId;
  const product = resolveProduct(job.workingDir);
  return product?.id || "_default";
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
 * Check if file sets overlap (for detecting conflicts)
 */
function filesOverlap(files1, files2) {
  if (!files1 || !files2 || files1.length === 0 || files2.length === 0) return false;

  for (const f1 of files1) {
    for (const f2 of files2) {
      // Exact match or one is a prefix of the other (directory check)
      if (f1 === f2 || f1.startsWith(f2 + "/") || f2.startsWith(f1 + "/")) {
        return true;
      }
    }
  }
  return false;
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

/**
 * ============================================================
 * MEETING ENGINE
 * Multi-agent team meetings with shared conversation context.
 * Agents take turns responding, building on each other's input.
 * ============================================================
 */
const meetings = new Map();

/**
 * Normalize meeting mode values to canonical internal strings.
 * Accepts both public aliases ("directed", "serial") and legacy values ("chair", "roundRobin").
 *   "directed"   → "chair"      (chair-based, agent called by chair)
 *   "serial"     → "roundRobin" (every agent speaks each round)
 * Unknown values default to "chair".
 */
function normalizeMode(mode) {
  if (!mode) return "chair";
  switch (mode) {
    case "directed": return "chair";
    case "serial":   return "roundRobin";
    case "chair":    return "chair";
    case "roundRobin": return "roundRobin";
    default:
      console.warn(`[normalizeMode] Unknown meeting mode "${mode}", defaulting to "chair"`);
      return "chair";
  }
}

/**
 * Select the best chair agent from a participants list.
 * Prefers "product-manager" if present; falls back to explicit chair arg,
 * then to the first participant, then to "product-manager" as a hardcoded default.
 */
function selectChair(agents, explicitChair) {
  if (explicitChair) return explicitChair;
  if (agents && agents.includes("product-manager")) return "product-manager";
  return (agents && agents[0]) || "product-manager";
}

/**
 * Normalize a meeting topic for dedup comparison.
 * Strips dates, whitespace, punctuation, and lowercases.
 */
function normalizeTopic(topic) {
  return (topic || "")
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}/g, "")   // strip ISO dates
    .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, "") // strip DD/MM/YYYY
    .replace(/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check if a meeting with a similar topic is already active or scheduled.
 * Returns { duplicate: true, reason, existingId } or { duplicate: false }.
 */
/**
 * Build a human-readable summary of active and scheduled meetings.
 * Agents use this to avoid proposing duplicate meetings.
 */
function getActiveMeetingSchedule() {
  const lines = [];

  // Active meetings
  for (const [id, m] of meetings.entries()) {
    if (m.status === "ended") continue;
    lines.push(`- [ACTIVE] "${m.topic}" (agents: ${m.agents.join(", ")}, started: ${m.createdAt})`);
  }

  // Pending scheduled meetings
  for (const [id, item] of scheduledItems.entries()) {
    if (item.type !== "meeting") continue;
    if (item.status === "done" || item.status === "cancelled") continue;
    const d = item.data || {};
    lines.push(`- [SCHEDULED ${item.scheduledAt}] "${d.topic || "unknown"}" (agents: ${(d.agents || []).join(", ")})`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function checkMeetingDuplicate(topic) {
  const normalizedTopic = normalizeTopic(topic);
  if (!normalizedTopic) return { duplicate: false };

  // Check active meetings (not ended)
  for (const [id, m] of meetings.entries()) {
    if (m.status === "ended") continue;
    const existingNorm = normalizeTopic(m.topic);
    if (existingNorm === normalizedTopic) {
      return { duplicate: true, reason: "active", existingId: id, existingTopic: m.topic };
    }
  }

  // Check pending scheduled meetings
  for (const [id, item] of scheduledItems.entries()) {
    if (item.type !== "meeting") continue;
    if (item.status === "done" || item.status === "cancelled") continue;
    const existingNorm = normalizeTopic(item.data?.topic);
    if (existingNorm === normalizedTopic) {
      return { duplicate: true, reason: "scheduled", existingId: id, existingTopic: item.data?.topic, scheduledAt: item.scheduledAt };
    }
  }

  return { duplicate: false };
}

// Detects user requests for a human-in-the-loop gate.
// Deterministic source of truth — runs against the topic AND any user-injected transcript turns.
// Patterns require first-person framing or explicit "any/all/the" determiners to avoid false
// positives on benign meeting topics ("talk through approach before writing tests").
const GATE_INTENT_RE = /(prompt me|ask me first|don'?t (?:write|create|make|do|dispatch)(?: any| anything| yet|\b)|wait for (?:me|my (?:input|approval|decision|sign[- ]?off|review))|before (?:you )?(?:writ(?:e|ing)|creat(?:e|ing)|mak(?:e|ing)|dispatch(?:ing)?) (?:any|all|anything)\b|present (?:me )?(?:the )?options(?: to me)?|let me (?:see|review|decide|weigh|choose|approve)|nothing yet|hold (?:off|on)|check with me|discuss with me first|gate (?:before|on)|approval (?:before|first|required)|i (?:want to|need to|will) (?:approve|review|decide))/i;

function detectGateIntent(text) {
  if (!text) return false;
  return GATE_INTENT_RE.test(String(text).toLowerCase());
}

// Re-scan a meeting at outcomes time. Belt-and-braces fallback in case the in-memory
// gateBeforeDispatch flag was lost (DB reload, restart, alternate creation path).
// Checks: explicit flag, topic, AND any human/user turns in the transcript.
function detectGateIntentForMeeting(meeting) {
  if (meeting.gateBeforeDispatch === true) return { gated: true, source: "flag" };
  if (detectGateIntent(meeting.topic)) return { gated: true, source: "topic" };
  for (const turn of meeting.transcript || []) {
    const role = (turn.role || turn.speaker || "").toLowerCase();
    const isHuman = role === "user" || role === "human" || role === "mark" || turn.fromUser === true;
    if (!isHuman) continue;
    const txt = turn.content || turn.text || turn.message || "";
    if (detectGateIntent(txt)) return { gated: true, source: "transcript" };
  }
  return { gated: false, source: null };
}

// Implicit gate detection: pause for human input when the meeting outcome shows
// signals that warrant review even if the user never asked for it explicitly.
// Cheap, deterministic rules over the generated outcomes summary. Returns a gate
// result on first matching rule, or null if nothing fires.
function detectImplicitGateNeed(meeting, summary) {
  if (!summary || typeof summary !== "string") return null;
  const reasons = [];

  // 1. New stories / epics proposed in bulk
  // (no m-flag here — we want $ to mean end-of-string, not end-of-line, so the
  // lazy [\s\S]*? doesn't terminate immediately at the heading's own newline)
  let storyCount = 0;
  const storyHeading = summary.match(/##+\s*(?:new\s+)?(?:stories|epics)\b[\s\S]*?(?=\n##|$)/i);
  if (storyHeading) {
    storyCount = (storyHeading[0].match(/^\s*[-*]\s+/gm) || []).length;
  }
  const createStoryMentions = (summary.match(/\bcreate\s+(?:a\s+|new\s+|several\s+|multiple\s+)?(?:story|stories|epic|epics)\b/gi) || []).length;
  const totalNewStories = Math.max(storyCount, createStoryMentions);
  const storyThreshold = config.meetings?.implicitGateStoryThreshold ?? 3;
  if (totalNewStories > storyThreshold) reasons.push(`stories>${storyThreshold}(${totalNewStories})`);

  // 2. Schema / migration / DB structural change
  if (/\b(schema\s+(?:change|migration)|database\s+migration|alter\s+table|drop\s+table|drop\s+column|add\s+column|new\s+migration|prisma\s+migrate|knex\s+migrate)\b/i.test(summary)) {
    reasons.push("schema/migration");
  }

  // 3. Multi-product touch (more than one Jira project key or product name)
  // Derives keys/names dynamically from the registered products map so any
  // deployment's product set is honoured (no hardcoded list).
  const projects = new Set();
  const projectKeys = [];
  const productNames = [];
  const nameToKey = {};
  for (const [, p] of products) {
    if (p?.jira?.projectKey) projectKeys.push(p.jira.projectKey);
    if (p?.name) {
      productNames.push(p.name);
      if (p.jira?.projectKey) nameToKey[p.name] = p.jira.projectKey;
    }
  }
  if (projectKeys.length) {
    const keyRe = new RegExp(`\\b(${projectKeys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})-\\d+\\b`, "g");
    const issueKeyMatches = summary.match(keyRe) || [];
    for (const m of issueKeyMatches) projects.add(m.split("-")[0]);
  }
  if (productNames.length) {
    const nameRe = new RegExp(`\\b(${productNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "g");
    const productMatches = summary.match(nameRe) || [];
    for (const m of productMatches) projects.add(nameToKey[m] || m);
  }
  if (projects.size > 1) reasons.push(`products>1(${[...projects].join(",")})`);

  // 4. Closing / superseding / deprecating an existing tracked issue
  if (/\b(close|won'?t\s*do|wont[- ]do|supersede|deprecate|archive|rollback|abandon)\b[^.\n]{0,40}\b[A-Z]{2,5}-\d+\b/i.test(summary)
      || /\b[A-Z]{2,5}-\d+\b[^.\n]{0,40}\b(close|won'?t\s*do|deprecate|supersede|archive)\b/i.test(summary)) {
    reasons.push("closing-existing-issue");
  }

  // 5. Destructive operations on infrastructure / shared resources
  // (verb and noun within ~40 chars on the same line — tolerates object names like "drop the audit_log table")
  if (/\b(?:delete|drop|wipe|purge|truncate|remove|deprecate)\b[^.\n]{0,40}\b(?:database|table|service|component|module|repository|repo|workflow|pipeline|api\s+endpoint|microservice|cluster|namespace)\b/i.test(summary)) {
    reasons.push("destructive-op");
  }

  // 6. Broad action surface — many items dispatched at once
  const actionItemCount = (summary.match(/^\s*-\s*\[\s*\]/gm) || []).length;
  const actionThreshold = config.meetings?.implicitGateActionThreshold ?? 5;
  if (actionItemCount > actionThreshold) reasons.push(`actions>${actionThreshold}(${actionItemCount})`);

  if (reasons.length === 0) return null;
  return { gated: true, source: `rule:${reasons[0]}`, reason: reasons.join("; ") };
}

// Borderline LLM judgment: invoked only when no deterministic rule fires AND
// there are action items to dispatch. Uses Haiku for cost. Fails open (no gate)
// on parse error, timeout, or non-zero exit so this never blocks a meeting.
async function judgeBorderlineGate(meeting, summary) {
  if (!summary) return null;
  if (config.meetings?.implicitGateLLMEnabled === false) return null;
  const actionItemCount = (summary.match(/^\s*-\s*\[\s*\]/gm) || []).length;
  if (actionItemCount === 0) return null;

  const threshold = config.meetings?.implicitGateLLMThreshold ?? 6;
  const truncated = summary.length > 6000 ? summary.substring(0, 6000) + "\n... (truncated)" : summary;
  const prompt = [
    `You are a meeting governance assistant for an AI-driven dev platform.`,
    ``,
    `Score 0-10 the likelihood that the human owner (Mark) should review and approve the action items below BEFORE they are dispatched as Jira issues, code changes, and agent work.`,
    ``,
    `High score (7-10): broad refactor, multi-product impact, ambiguous direction, novel initiative, deletion or deprecation of working features, items contradicting each other, scope creep beyond the meeting topic, business or product strategy decisions.`,
    `Low score (0-3): a few small bug fixes, well-defined narrow tasks, routine maintenance, clear single-component changes, items already discussed and agreed.`,
    ``,
    `Reply on a single line with EXACTLY this format and nothing else:`,
    `SCORE: <0-10> | REASON: <short reason in <=15 words>`,
    ``,
    `Meeting topic: ${meeting.topic}`,
    `Outcomes summary:`,
    truncated,
  ].join("\n");

  const args = [...config.claude.baseArgs];
  args.push("--model", config.claude?.models?.haiku || "claude-haiku-4-5-20251101");
  args.push("-p");
  args.push("--output-format", "stream-json", "--verbose");
  const cliCmd = config.claude?.command || "claude";

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cliCmd, args, {
        cwd: meeting.workingDir,
        env: { ...process.env, ...getOAuthEnvVars() },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: borderline judgment spawn failed: ${e.message}`);
      return resolve(null);
    }
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", () => {});
    try {
      proc.stdin.write(prompt);
      proc.stdin.end();
    } catch {}

    const timeout = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: borderline judgment timed out — failing open (no gate)`);
      resolve(null);
    }, 30_000);

    proc.on("close", () => {
      clearTimeout(timeout);
      const textParts = [];
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t);
          if (ev.type === "assistant" && ev.message) {
            for (const b of (ev.message.content || [])) {
              if (b.type === "text" && b.text) textParts.push(b.text);
            }
          } else if (ev.type === "result" && ev.result) {
            if (!textParts.length) textParts.push(ev.result);
          }
        } catch {}
      }
      const content = textParts.join("").trim();
      const m = content.match(/SCORE:\s*(\d+(?:\.\d+)?)\s*\|\s*REASON:\s*(.+)/i);
      if (!m) {
        console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: borderline judgment unparseable: "${content.substring(0, 200)}"`);
        return resolve(null);
      }
      const score = Math.round(parseFloat(m[1]));
      const reason = m[2].trim();
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: borderline judgment score=${score} threshold=${threshold} reason="${reason}"`);
      if (score >= threshold) {
        return resolve({ gated: true, source: `llm:confidence=${score}`, reason });
      }
      resolve(null);
    });

    proc.on("error", (e) => {
      clearTimeout(timeout);
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: borderline judgment proc error: ${e.message}`);
      resolve(null);
    });
  });
}

function createMeeting(options) {
  const meetingId = `mtg_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  // Normalize mode: "directed"/"chair" → "chair", "serial"/"roundRobin" → "roundRobin".
  // Default is "chair" (directed discussion).
  const mode = normalizeMode(options.mode || "chair");
  const agents = options.agents || ["product-manager", "engineer-planner"];
  // Smart chair selection: prefer product-manager if present, else first participant.
  const chair = selectChair(agents, options.chair);
  const topic = options.topic || "Team Meeting";
  // Gate-before-dispatch: explicit body flag wins; otherwise sniff topic for "prompt me"-style asks.
  const gateBeforeDispatch =
    options.gateBeforeDispatch === true || detectGateIntent(topic);
  const meeting = {
    meetingId,
    topic,
    agents,
    facilitator: options.facilitator || agents[0] || "product-manager",
    chair,
    mode, // canonical: "chair" or "roundRobin"
    transcript: [], // { role: "user"|"agent", agent?: string, name: string, content: string, timestamp: string }
    status: "active", // active, paused, ended, awaiting-approval, rejected
    telegram: options.telegram || null,
    callbackUrl: options.callbackUrl || null,
    workingDir: options.workingDir || DEFAULT_WORKING_DIR,
    productId: null, // resolved below
    createdAt: nowIso(),
    endedAt: null,
    currentSpeaker: null, // agent currently generating a response
    roundRobin: options.roundRobin !== false, // whether agents auto-respond to each other
    autoDiscuss: options.autoDiscuss || false, // agents discuss autonomously without user input
    maxRounds: options.maxRounds || (options.autoDiscuss ? 3 : 2), // rounds of discussion
    maxTurns: options.maxTurns || (mode === "chair" ? 20 : 0), // chair mode turn limit
    turnCount: 0, // total CLI invocations in this meeting
    summary: null,
    gateBeforeDispatch, // true → pause for human approval after outcomes generation
    awaitingApproval: false, // set true when paused waiting for /meeting/:id/decision
    refinementsUsed: 0, // number of refine cycles consumed (cap = 3)
    decision: null, // { decision: "approve"|"reject"|"refine", refinement?, decidedAt }
  };
  // Resolve product from workingDir for cross-project isolation.
  // If workingDir is the default (no explicit override), also try resolving from telegram chatId
  // so that meetings started from product-specific Telegram groups get the correct Jira project.
  let meetingProduct = resolveProduct(meeting.workingDir);
  if (!meetingProduct && meeting.telegram?.chatId) {
    meetingProduct = resolveProductFromTelegramChat(meeting.telegram.chatId);
    if (meetingProduct && meetingProduct.workingDir) {
      meeting.workingDir = meetingProduct.workingDir;
    }
  }
  if (meetingProduct) {
    meeting.productId = meetingProduct.id;
    // Use product's Telegram chat if none provided
    if (!meeting.telegram && meetingProduct.telegram?.chatId) {
      meeting.telegram = { chatId: String(meetingProduct.telegram.chatId) };
    }
  }

  meetings.set(meetingId, meeting);
  db.meetings.set(meeting).catch(e => console.error('[db] meeting persist failed: ' + e.message));


  // Emit SSE event
  if (config.sseEnabled) {
    jobEmitter.emit("meeting:created", {
      meetingId,
      topic: meeting.topic,
      agents: meeting.agents,
      status: "active",
    });
  }

  return meeting;
}

function getMeetingTranscriptText(meeting, lastN) {
  const msgs = lastN ? meeting.transcript.slice(-lastN) : meeting.transcript;
  return msgs
    .map((m) => {
      const label = m.role === "user" ? `[${m.name}]` : `[${m.agent}]`;
      return `${label}: ${m.content}`;
    })
    .join("\n\n");
}

const AGENT_ROLE_DESCRIPTIONS = {
  "product-manager": "Product strategy, user needs, acceptance criteria, prioritization, and business value",
  "engineer-planner": "Technical architecture, implementation planning, codebase structure, and technical feasibility",
  "engineer-implementer": "Hands-on coding, build systems, testing, and practical implementation concerns",
  "engineer-reviewer": "Code quality, patterns, security vulnerabilities, and engineering standards",
  "architect-jets": "System architecture, ADRs, scalability, integration patterns, and technical debt",
  "security-agent": "Security threats, OWASP risks, authentication, authorization, and compliance",
  "qa-agent": "Unified verification: unit/integration tests, type-check, lint, acceptance criteria, Playwright browser tests, and regression",
  "ux-agent": "User experience, accessibility, interaction design, and UI patterns",
  "ba-agent": "Business requirements, acceptance criteria, stakeholder needs, and process flows",
  "marketing": "Market positioning, content strategy, competitive landscape, and messaging",
  "sales-development": "Customer pain points, sales pipeline, prospect feedback, and market demand",
  "ask-tom-agent": "Root cause analysis, debugging complex issues, and creative problem-solving",
  "bug-triage": "Bug analysis, severity assessment, and reproduction steps",
  "sprint-reporter": "Team velocity, sprint metrics, and delivery performance",
};

/**
 * Build product context block for meeting prompts.
 * Tells agents which Jira project, product name, etc. to use.
 */
function getMeetingProductContext(meeting) {
  const product = meeting.productId
    ? products.get(meeting.productId)
    : resolveProduct(meeting.workingDir);
  if (!product) return null;
  const lines = [
    "=== PRODUCT CONTEXT ===",
    `Product: ${product.name || product.id}`,
  ];
  if (product.jira?.projectKey) {
    lines.push(`Jira Project: ${product.jira.projectKey} — ALWAYS use project key "${product.jira.projectKey}" for ALL Jira operations: creating issues, JQL queries, transitions, comments, and searches. Do NOT use any other project key (e.g. CER). Every issue you create or reference MUST be in ${product.jira.projectKey}.`);
  }
  if (product.confluence?.space) {
    lines.push(`Confluence Space: ${product.confluence.space}`);
  }
  if (product.description) {
    lines.push(`Description: ${product.description}`);
  }
  if (product.sprint?.boardId) {
    lines.push(`Sprint Board ID: ${product.sprint.boardId}`);
  }
  // Inject plugin directory paths so agents can find skill files (MASTER.md, OVERRIDES.md, etc.)
  const pluginDirs = resolvePluginDirs(product);
  if (pluginDirs.length > 0) {
    lines.push(`Plugin Directories (skill files live here):`);
    for (const dir of pluginDirs) {
      lines.push(`  - ${dir}`);
    }
    const productPluginDir = resolvePluginDir(product);
    lines.push(`Product Plugin: ${productPluginDir}`);
    lines.push(`When skills reference <product-plugin>, use: ${productPluginDir}`);
    lines.push(`MASTER.md location: ${productPluginDir}/skills/ux-design/MASTER.md`);
  }
  lines.push("");
  lines.push("FILE ROUTING: Plugin files (agents/, skills/, commands/, hooks/) MUST be written to the Plugin directory above, NOT inside the working directory.");
  lines.push("=== END PRODUCT CONTEXT ===");
  return lines.join("\n");
}

function buildMeetingPrompt(meeting, agent, userMessage, options = {}) {
  const agentNames = meeting.agents.join(", ");
  const transcriptText = getMeetingTranscriptText(meeting, 20);
  const roleDesc = AGENT_ROLE_DESCRIPTIONS[agent] || "general expertise";
  const isAutoDiscuss = meeting.autoDiscuss;
  const round = options.round || 0;
  const maxRounds = meeting.maxRounds || 3;
  const isFinalRound = round >= maxRounds;

  const hasMcpTools = (config.meetings?.allowedTools || []).length > 0;
  const rules = [
    "- Be concise (2-4 paragraphs max). This is a discussion, not a monologue.",
    "- Build on what others said. Reference their points by name.",
    "- If you disagree, say so directly and explain why.",
    "- If you have nothing new to add, say 'No further input' — don't repeat others.",
    "- Stay in character as your agent role.",
    "- CRITICAL: Do NOT assume any Jira issue is open or resolved without verifying. If you need to know the status of an issue, USE THE JIRA MCP TOOL to look it up. Do not speculate about ticket statuses.",
  ];

  if (hasMcpTools) {
    rules.push(
      "- You have access to MCP tools (Jira, etc). USE THEM to look up issue statuses, check sprint boards, and verify facts before discussing. Do not say 'I don't have statuses in front of me' — you DO have the tools to check.",
      "- When you commit to doing something (review, implement, investigate), be specific: what exactly, by when, what issue key.",
    );
  }

  if (isAutoDiscuss) {
    rules.push(
      "- Drive towards concrete decisions and actionable outcomes.",
      "- Propose specific solutions, not vague suggestions.",
      "- Raise risks or concerns early — don't just agree with everyone.",
      "- If another agent's proposal has a flaw, challenge it constructively.",
    );
    if (isFinalRound) {
      rules.push(
        "- This is the FINAL round. Converge on decisions. State your final position clearly.",
        "- Identify any remaining blockers or open questions.",
        "- For each action item you propose, specify: what, who (agent name), priority (High/Medium/Low).",
      );
    }
  } else {
    rules.push("- Address the human facilitator's questions directly.");
  }

  const parts = [
    `You are ${agent} in a team meeting.`,
    `Your expertise: ${roleDesc}.`,
    `Topic: ${meeting.topic}`,
    `Participants: ${agentNames}${isAutoDiscuss ? "" : " + the human facilitator"}`,
    isAutoDiscuss ? `Round ${round}/${maxRounds}` : "",
    "",
    "MEETING RULES:",
    ...rules,
  ];

  // Inject product context (Jira project, product name, etc.)
  const productCtx = getMeetingProductContext(meeting);
  if (productCtx) {
    parts.push("", productCtx);
  }

  // Inject external context (Jira statuses + previous meeting minutes)
  if (meeting.externalContext) {
    parts.push("", "=== CURRENT CONTEXT (from Jira & previous meetings) ===");
    parts.push(meeting.externalContext);
    parts.push("=== END CONTEXT ===");
  }

  // Inject active/scheduled meetings so agents don't propose duplicates
  const meetingSchedule = getActiveMeetingSchedule();
  if (meetingSchedule) {
    parts.push("", "=== EXISTING MEETING SCHEDULE ===");
    parts.push("The following meetings are already active or scheduled. Do NOT propose follow-up meetings that overlap with these:");
    parts.push(meetingSchedule);
    parts.push("=== END SCHEDULE ===");
  }

  parts.push(
    "",
    transcriptText ? "=== MEETING TRANSCRIPT ===\n" + transcriptText + "\n=== END TRANSCRIPT ===" : "",
    "",
  );

  if (userMessage) {
    parts.push(isAutoDiscuss ? `Discussion prompt: "${userMessage}"` : `The facilitator just said: "${userMessage}"`);
  } else {
    parts.push("It's your turn to contribute to the discussion.");
  }

  parts.push("", `Respond as ${agent}. Be direct and substantive.`);

  return parts.filter(Boolean).join("\n");
}

/**
 * Build the structured outcomes prompt for the facilitator at end of auto-discussion
 */
function buildOutcomesPrompt(meeting) {
  const transcriptText = getMeetingTranscriptText(meeting);
  const allAgents = Object.values(config.agentLabels || {});
  const productCtx = getMeetingProductContext(meeting);
  return [
    `You are ${meeting.facilitator}, facilitating a team meeting that has concluded.`,
    `Topic: ${meeting.topic}`,
    `Participants: ${meeting.agents.join(", ")}`,
    "",
    productCtx || "",
    "",
    "=== FULL MEETING TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Generate a structured meeting summary. Be specific — reference who said what and extract real commitments.",
    "",
    "HUMAN-APPROVAL CHECK (read carefully):",
    "Look back at the meeting topic and transcript. Did the user (NOT an agent) explicitly request human input or approval before any action is taken? Phrases that count: \"prompt me\", \"ask me first\", \"don't write/create yet\", \"present options to me\", \"discuss with me first\", \"hold off\", \"wait for my input\", \"let me decide\", \"check with me\".",
    "If YES — emit the literal directive `[REQUIRES-APPROVAL]` on its OWN LINE at the very TOP of the summary, before the `## Decisions` heading. This will pause dispatch until the user approves.",
    "If NO — do NOT emit the directive. Default is to dispatch immediately.",
    "Be conservative: only emit it when the user explicitly asked for a gate. Agents flagging caution does NOT count.",
    "",
    "Format your response EXACTLY as follows:",
    "",
    "## Decisions",
    "- [Decision 1: what was agreed, with rationale]",
    "- [Decision 2: ...]",
    "",
    "## Action Items",
    "IMPORTANT: Each action item below will be AUTOMATICALLY DISPATCHED as a real job to the named agent.",
    "Only list items where the agent CAN and SHOULD act autonomously. Be specific enough for the agent to execute without further context.",
    "DEFAULT: All action items are dispatched IMMEDIATELY (no Schedule field). This is the preferred behaviour.",
    "ONLY add a Schedule field if there is a genuine timing dependency (e.g. must wait for another task to finish first, or a specific calendar slot like a meeting).",
    "Do NOT schedule things for 'tomorrow' or 'next week' unless there is a real reason to wait.",
    "",
    "DO NOT list the meeting topic itself as an action item. The topic is the conversation, not a task. Examples of what NOT to write as action items:",
    "  ✗ \"Talk about X\" / \"Discuss Y\" / \"Where do we stand on Z\" / \"Give an update on Q\" — these are meeting topics, not work to be done.",
    "  ✗ Re-statements of the topic prefixed with verbs like 'discuss', 'talk about', 'review', 'cover', 'address'.",
    "Action items must be CONCRETE WORK PRODUCTS — something an agent will produce, change, send, or decide. If you cannot describe the deliverable in one sentence, it is not an action item.",
    `- [ ] [task] — Owner: [agent-name] — Priority: [High/Medium/Low]`,
    `- [ ] [task with timing dependency] — Owner: [agent-name] — Priority: [High/Medium/Low] — Schedule: [ISO datetime or relative like 'in 30 minutes', 'today 14:00']`,
    `- [ ] [task that depends on a prior action item] — Owner: [agent-name] — Priority: [High/Medium/Low] — DependsOn: [N]`,
    "If an action item cannot start until another action item in this list completes, add — DependsOn: [N] where N is the 1-based index of the prerequisite (e.g. DependsOn: [1] means it waits for action item 1; DependsOn: [1, 2] means it waits for both). Omit DependsOn if the task is independent. The runner uses these to set Jira blocks/is-blocked-by links and gates execution order automatically.",
    "",
    `CRITICAL: The Owner field MUST be one of these exact agent names (no prefix): ${[...new Set([...meeting.agents, ...allAgents])].join(", ")}`,
    "Do NOT prefix with 'certpilot:' or any namespace. Just the plain agent name (e.g. 'product-manager', NOT 'certpilot:product-manager').",
    "",
    "## Feature Subtasks",
    "For new features discussed in this meeting, break the work into TYPED SUBTASKS on the parent Jira story.",
    "Each subtask runs through the lean pipeline (implement → code-review → verify) with the appropriate agent.",
    "Use this format — each subtask will be AUTOMATICALLY CREATED as a Jira subtask with the correct agent label:",
    "",
    "[CREATE-SUBTASKS]",
    "parent: [JIRA-KEY of the parent story]",
    "---",
    "summary: [Backend] [concise task description]",
    "agent: engineer-implementer",
    "priority: [High/Medium/Low]",
    "labels: [needs-architecture]  ← ONLY if this subtask needs a gate (DB schema, new services, system design)",
    "description: [Specific implementation details, files to change, API endpoints, etc.]",
    "---",
    "summary: [UI] [concise task description]",
    "agent: ui-engineer",
    "priority: [High/Medium/Low]",
    "labels: [needs-ux-design]  ← ONLY if this subtask needs UX review (new user flows, significant UI work)",
    "description: [Components, pages, design specs, interactions]",
    "---",
    "summary: [Tests] [concise task description]",
    "agent: e2e-builder",
    "priority: [Medium/Low]",
    "description: [What to test, coverage targets, test scenarios]",
    "[/CREATE-SUBTASKS]",
    "",
    "SUBTASK RULES:",
    "- Use [Backend] prefix for API/data/logic work → engineer-implementer",
    "- Use [UI] prefix for frontend/components/styling → ui-engineer",
    "- Use [Tests] prefix for test coverage → e2e-builder or qa-agent",
    "- Use [Security] prefix for security hardening → security-agent",
    "- Keep each subtask focused — one concern per subtask",
    "- Only create subtasks for features that were DECIDED in this meeting (not speculative)",
    "- Add labels: [needs-architecture] for DB schema / new services / system design subtasks",
    "- Add labels: [needs-ux-design] for significant UI / user flow subtasks",
    "- Add labels: [needs-requirements] for vague scope subtasks needing BA enrichment",
    "- Only add gate labels to subtasks that actually need them — not all subtasks",
    "",
    "DEPENDENCY RULES (CRITICAL — get the direction right):",
    "- After creating subtasks, add issue links via POST /rest/api/3/issueLink:",
    "  {\"type\":{\"name\":\"Blocks\"}, \"inwardIssue\":{\"key\":\"BLOCKER_KEY\"}, \"outwardIssue\":{\"key\":\"BLOCKED_KEY\"}}",
    "  inwardIssue = the one that must FINISH FIRST (the prerequisite)",
    "  outwardIssue = the one that WAITS (depends on the prerequisite)",
    "",
    "  Execution order: [Backend] FIRST → [UI] SECOND → [Tests] LAST",
    "  So the links must be:",
    "  • UI is blocked by Backend:   inwardIssue=Backend, outwardIssue=UI",
    "  • Tests is blocked by Backend: inwardIssue=Backend, outwardIssue=Tests",
    "  • Tests is blocked by UI:      inwardIssue=UI, outwardIssue=Tests",
    "  • Security is blocked by Backend: inwardIssue=Backend, outwardIssue=Security",
    "",
    "  [Backend] subtasks get NO inward links (they run first, nothing blocks them)",
    "- This ensures agents don't write UI before the API exists, or tests before the code exists",
    "",
    "SPRINT RULES:",
    "- Move SUBTASKS into the active sprint, NOT the parent story",
    "- Parent stories stay in the backlog as containers",
    "- Only subtasks are executable work units",
    "",
    "## Bugs Identified",
    "If the meeting surfaced any bugs (code defects, broken behaviour, regressions), list them here.",
    "Each bug will be AUTOMATICALLY CREATED as a Jira Bug issue and routed to engineer-planner for immediate fix.",
    "Only list genuine defects — not feature requests or improvements.",
    "- Summary: [one-line bug title] — Severity: [Critical/Major/Minor] — RootCause: [brief root cause or suspected area] — Priority: [High/Medium/Low]",
    "",
    "## Follow-Up Meetings",
    "If the meeting concluded that a follow-up discussion is needed (with same or different agents), list them here.",
    "Each meeting will be AUTOMATICALLY SCHEDULED at the specified time.",
    "Only schedule a follow-up if the current meeting cannot resolve the topic and more agents or time is genuinely needed.",
    "IMPORTANT: Check the existing meeting schedule below BEFORE proposing any follow-up. Do NOT propose a meeting if the same topic is already active or scheduled.",
    (() => {
      const sched = getActiveMeetingSchedule();
      return sched
        ? `\nEXISTING SCHEDULE (do not duplicate):\n${sched}\n`
        : "\n(No meetings currently active or scheduled.)\n";
    })(),
    "- Topic: [what to discuss] — Agents: [comma-separated agent names] — Schedule: [ISO datetime or relative time]",
    "",
    "## Risks & Concerns",
    "- [Risk raised by agent-name: description]",
    "",
    "## Open Questions",
    "- [Unresolved question that needs human input]",
    "",
    "## Next Steps",
    "- [What happens next, by whom, by when]",
    "",
    "Be concrete. No filler. Every action item must have an owner.",
  ].join("\n");
}

/**
 * Run autonomous multi-round discussion.
 * Agents discuss the topic with each other across multiple rounds.
 * Each round, every agent speaks once (building on the full transcript).
 * At the end, the facilitator produces structured outcomes.
 */

/**
 * Fetch real-time Jira + Confluence context for a meeting.
 * Calls N8N Meeting Context webhook to get:
 * - Current status of any issues mentioned in topic
 * - Active sprint issues summary
 * - Recent meeting minutes from Confluence (agent memory)
 * Returns formatted context string to inject into meeting prompts.
 */
async function fetchMeetingContext(meeting) {
  const contextUrl = config.meetings?.contextWebhookUrl;
  if (!contextUrl) {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: No context webhook configured, skipping context fetch`);
    return null;
  }

  try {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Fetching Jira + Confluence context...`);

    const headers = {};
    if (SECRET) headers["X-Runner-Secret"] = SECRET;

    const resp = await postJson(contextUrl, {
      meetingId: meeting.meetingId,
      topic: meeting.topic,
      agents: meeting.agents,
      confluenceSpace: resolveConfluenceSpace(meeting.productId || meeting.workingDir),
      confluenceParentPage: config.meetings?.confluenceParentPage || "Meetings",
      jiraProject: resolveJiraProject(meeting.productId || meeting.workingDir),
    }, headers);

    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      let data;
      try { data = JSON.parse(resp.body); } catch { data = null; }
      if (data?.context) {
        console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Context fetched (${data.context.length} chars)`);
        return data.context;
      }
    }

    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Context fetch returned ${resp.statusCode}`);
    return null;
  } catch (e) {
    console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: Context fetch error: ${e.message}`);
    return null;
  }
}

/**
 * Post meeting outcomes to N8N for:
 * 1. Confluence page creation (meeting minutes with timestamp)
 * 2. Jira task creation from action items
 * 3. Agent dispatch for high-priority action items
 */
async function postMeetingOutcomes(meeting) {
  const outcomesUrl = config.meetings?.outcomesWebhookUrl;
  if (!outcomesUrl) {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: No outcomes webhook configured, skipping outcomes post`);
    return;
  }

  try {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Posting outcomes to N8N...`);

    const headers = {};
    if (SECRET) headers["X-Runner-Secret"] = SECRET;

    const duration = meeting.endedAt && meeting.createdAt
      ? Math.round((new Date(meeting.endedAt) - new Date(meeting.createdAt)) / 1000)
      : null;

    const payload = {
      meetingId: meeting.meetingId,
      topic: meeting.topic,
      agents: meeting.agents,
      facilitator: meeting.facilitator,
      summary: meeting.summary,
      transcript: meeting.transcript,
      createdAt: meeting.createdAt,
      endedAt: meeting.endedAt,
      duration,
      messageCount: meeting.transcript.length,
      telegram: meeting.telegram,
      confluenceSpace: resolveConfluenceSpace(meeting.productId || meeting.workingDir),
      confluenceParentPage: config.meetings?.confluenceParentPage || "Meetings",
      jiraProject: resolveJiraProject(meeting.productId || meeting.workingDir),
      runnerUrl: process.env.RUNNER_INTERNAL_URL || `http://runner:${config.port || 3210}`,
    };

    const resp = await postJson(outcomesUrl, payload, headers);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Outcomes posted successfully`);
    } else {
      console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: Outcomes post failed (${resp.statusCode}): ${resp.body?.substring(0, 200)}`);
    }
  } catch (e) {
    console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: Outcomes post error: ${e.message}`);
  }
}

// Direct callback for meetings — bypasses internalCallbackUrl to use the meeting-specific callback URL
async function sendMeetingCallback(url, payload) {
  try {
    const headers = {};
    if (SECRET) headers["X-Runner-Secret"] = SECRET;
    const resp = await postJson(url, payload, headers);
    if (resp.statusCode >= 200 && resp.statusCode < 300) return;
    console.error(`[${nowIso()}] Meeting callback ${resp.statusCode}: ${resp.body?.substring(0, 200)}`);
  } catch (e) {
    console.error(`[${nowIso()}] Meeting callback error: ${e.message}`);
  }
}

async function runAutoDiscussion(meeting) {
  const { agents, maxRounds, callbackUrl, telegram, topic } = meeting;

  console.log(`[${nowIso()}] Auto-discussion started: ${meeting.meetingId} topic="${topic}" rounds=${maxRounds} agents=[${agents.join(",")}] callbackUrl=${callbackUrl || "NONE"} telegram=${JSON.stringify(telegram)}`);

  // === Fetch external context (Jira statuses + previous meeting minutes) ===
  const externalContext = await fetchMeetingContext(meeting);
  if (externalContext) {
    meeting.externalContext = externalContext;
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: External context loaded (${externalContext.length} chars)`);
  }

  // Send initial "thinking" callback
  if (callbackUrl && telegram) {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Sending initial callback to ${callbackUrl}`);
  } else {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: SKIPPING callbacks - callbackUrl=${callbackUrl || "NONE"} telegram=${JSON.stringify(telegram)}`);
  }
  if (callbackUrl && telegram) {
    const contextNote = externalContext ? " Context loaded from Jira + Confluence." : "";
    const initPayload = {
      event: "meeting:agent-response",
      meetingId: meeting.meetingId,
      agent: "system",
      content: `_Meeting started: "${topic}"_\n_${agents.length} agents, ${maxRounds} rounds_\n_Agents are now discussing...${contextNote}_`,
      telegram,
      topic,
    };
    const logFile = path.join(LOG_DIR, `${meeting.meetingId}.log`);
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, `[${nowIso()}] Meeting ${meeting.meetingId}\n`, "utf8");
    }
    sendMeetingCallback(callbackUrl, initPayload);
  }

  for (let round = 1; round <= maxRounds; round++) {
    if (meeting.status !== "active") break;

    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Round ${round}/${maxRounds}`);

    for (const agent of agents) {
      if (meeting.status !== "active") break;

      const budgetCheck = checkBudget();
      if (!budgetCheck.ok) {
        console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Budget exceeded at round ${round}`);
        meeting.status = "ended";
        meeting.endedAt = nowIso();
        break;
      }

      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: R${round} - ${agent} speaking...`);

      // Send "thinking" status so user sees progress
      if (callbackUrl && telegram) {
        const agentName = agent.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase());
        const thinkingPayload = {
          event: "meeting:agent-response",
          meetingId: meeting.meetingId,
          agent: "status",
          content: `Round ${round}/${maxRounds} — ${agentName} is thinking...`,
          telegram,
          topic,
          round,
          maxRounds,
        };
        sendMeetingCallback(callbackUrl, thinkingPayload);
      }

      // First agent in first round gets the topic as the trigger
      const triggerMessage = (round === 1 && agent === agents[0])
        ? topic
        : null;

      const result = await runMeetingAgentTurn(meeting, agent, triggerMessage, { round, maxRounds });
      if (!result) continue;

      // Post each response to Telegram via callback
      if (callbackUrl && telegram) {
        const payload = {
          event: "meeting:agent-response",
          meetingId: meeting.meetingId,
          agent: result.agent,
          content: result.content,
          telegram,
          topic,
          round,
          maxRounds,
          transcriptLength: meeting.transcript.length,
        };
        sendMeetingCallback(callbackUrl, payload);
      }

      // Emit SSE
      if (config.sseEnabled) {
        jobEmitter.emit("meeting:agent-response", {
          meetingId: meeting.meetingId,
          agent: result.agent,
          round,
          contentLength: result.content.length,
        });
      }
    }
  }

  if (meeting.status !== "active") return;

  // === Generate outcomes and finalize (shared with chair mode) ===
  console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Generating outcomes...`);
  await generateAndFinalizeOutcomes(meeting);
}

/**
 * ============================================================
 * CHAIR-BASED MEETING MODEL
 * The chair agent controls the meeting flow, calling on specific
 * agents by name and deciding when to close items or end the
 * meeting. Replaces serial round-robin with directed discussion.
 * ============================================================
 */

/**
 * Build the prompt for the chair agent.
 * The chair gets: participant roster with expertise, directives syntax, transcript, context.
 */
function buildChairPrompt(meeting, options = {}) {
  const { isOpening, agentResponses, closedItems } = options;
  const chair = meeting.chair;
  const roleDesc = AGENT_ROLE_DESCRIPTIONS[chair] || "meeting facilitation";
  const hasMcpTools = (config.meetings?.allowedTools || []).length > 0;

  // Build participant roster (exclude chair)
  const participants = meeting.agents
    .filter(a => a !== chair)
    .map(a => `  - ${a}: ${AGENT_ROLE_DESCRIPTIONS[a] || "general expertise"}`)
    .join("\n");

  const transcriptText = getMeetingTranscriptText(meeting, 30);

  const parts = [
    `You are ${chair}, CHAIRING this team meeting.`,
    `Your expertise: ${roleDesc}.`,
    `Topic: ${meeting.topic}`,
    "",
    "PARTICIPANTS YOU CAN CALL ON:",
    participants,
    "",
    "=== CHAIR DIRECTIVES ===",
    "You control the meeting flow using these directives:",
    "",
    "[CALL: agent-name] Your question or topic for them",
    "  — Calls a specific agent to speak. Include a focused question.",
    "  — You can call multiple agents in one turn (one [CALL:] per agent).",
    "",
    "[CLOSE-ITEM: description]",
    "  — Close a discussion topic and note the decision/outcome.",
    "  — After you close an item, agents who haven't spoken on it will be given",
    "    a chance to raise their hand. You'll see their names and brief reasons.",
    "    Call on them if their input is relevant; skip if not.",
    "",
    "[OPEN-FLOOR]",
    "  — Mid-topic: invite any participant to raise a concern or add input.",
    "  — Use when you sense someone may have something important to add.",
    "",
    "[END-MEETING]",
    "  — End the meeting. Use this after all items are resolved.",
    "  — IMPORTANT: Before ending, summarize decisions and action items.",
    "",
    "CHAIR RULES:",
    "- Open with a brief agenda. Don't monologue — get agents talking quickly.",
    "- Only call agents whose expertise is relevant to the current topic.",
    "- If an agent's response raises a point for another agent, call them to respond.",
    "- Drive toward decisions. Don't let discussion loop without resolution.",
    "- Challenge vague answers. Ask for specifics: what, who, when.",
    "- You can provide your own analysis between calling agents.",
    "- Close items as they're resolved — don't revisit settled topics.",
    "- Aim for efficiency: a focused 5-turn meeting beats a sprawling 15-turn one.",
  ];

  if (hasMcpTools) {
    parts.push(
      "- You have MCP tools (Jira, etc). Use them to verify facts and check statuses.",
      "- When agents make claims about ticket statuses, verify with Jira if in doubt.",
    );
  }

  // Inject product context (Jira project, product name, etc.)
  const productCtx = getMeetingProductContext(meeting);
  if (productCtx) {
    parts.push("", productCtx);
  }

  // Inject external context
  if (meeting.externalContext) {
    parts.push("", "=== CURRENT CONTEXT (from Jira & previous meetings) ===");
    parts.push(meeting.externalContext);
    parts.push("=== END CONTEXT ===");
  }

  // Transcript
  if (transcriptText) {
    parts.push("", "=== MEETING TRANSCRIPT ===", transcriptText, "=== END TRANSCRIPT ===");
  }

  // Closed items so far
  if (closedItems && closedItems.length > 0) {
    parts.push("", "ITEMS ALREADY CLOSED:", ...closedItems.map(i => `  ✓ ${i}`));
  }

  // Opening vs follow-up
  if (isOpening) {
    parts.push(
      "",
      `Open the meeting on: "${meeting.topic}"`,
      "Set the agenda, provide context, then call on the first agent(s) you need to hear from.",
    );
  } else if (agentResponses && agentResponses.length > 0) {
    const responsesSummary = agentResponses
      .map(r => `${r.agent} just responded.`)
      .join(" ");
    parts.push(
      "",
      responsesSummary,
      "Review their input. Then: call more agents, close items, or end the meeting.",
    );
  } else {
    parts.push("", "Continue chairing. Call on agents, close items, or end the meeting.");
  }

  parts.push("", `Respond as ${chair} (chair). Use directives to control the flow.`);

  // Hand-raisers waiting to speak
  if (options.handRaisers && options.handRaisers.length > 0) {
    const raiserLines = options.handRaisers
      .map(r => `  - ${r.agent}: "${r.reason}"`)
      .join("\n");
    parts.push(
      "",
      "=== AGENTS REQUESTING TO SPEAK ===",
      "These agents raised their hands after the last topic closed:",
      raiserLines,
      "Use [CALL: agent-name] to invite them to speak, or proceed if their input isn't needed.",
      "=== END HAND-RAISERS ===",
    );
  }

  return parts.filter(Boolean).join("\n");
}

/**
 * Build the prompt for an agent called by the chair with a specific question.
 */
function buildCalledAgentPrompt(meeting, agent, question) {
  const roleDesc = AGENT_ROLE_DESCRIPTIONS[agent] || "general expertise";
  const hasMcpTools = (config.meetings?.allowedTools || []).length > 0;
  const transcriptText = getMeetingTranscriptText(meeting, 15);

  const parts = [
    `You are ${agent} in a team meeting chaired by ${meeting.chair}.`,
    `Your expertise: ${roleDesc}.`,
    `Topic: ${meeting.topic}`,
    "",
    `The chair has directed a question to you:`,
    `"${question}"`,
    "",
    "RULES:",
    "- Answer the chair's question directly and concisely (2-4 paragraphs max).",
    "- Reference other participants' points by name if relevant.",
    "- If you disagree with something said earlier, say so directly.",
    "- If you have nothing substantive to add, say so briefly — don't pad your response.",
    "- Stay in character as your agent role.",
    "- CRITICAL: Do NOT assume any Jira issue is open or resolved without verifying.",
  ];

  if (hasMcpTools) {
    parts.push(
      "- You have MCP tools (Jira, etc). USE THEM to verify issue statuses before discussing.",
      "- When you commit to doing something, be specific: what, by when, what issue key.",
    );
  }

  // Inject product context (Jira project, product name, etc.)
  const productCtx = getMeetingProductContext(meeting);
  if (productCtx) {
    parts.push("", productCtx);
  }

  // Inject external context
  if (meeting.externalContext) {
    parts.push("", "=== CURRENT CONTEXT (from Jira & previous meetings) ===");
    parts.push(meeting.externalContext);
    parts.push("=== END CONTEXT ===");
  }

  if (transcriptText) {
    parts.push("", "=== RECENT TRANSCRIPT ===", transcriptText, "=== END TRANSCRIPT ===");
  }

  parts.push("", `Respond as ${agent}. Be direct and substantive.`);

  return parts.filter(Boolean).join("\n");
}

/**
 * Build a short (~100 token) prompt for agents who didn't speak on a topic,
 * asking whether they have relevant input to add before the meeting moves on.
 */
function buildHandRaisePrompt(agentName, topicSummary, meeting) {
  const roleDesc = AGENT_ROLE_DESCRIPTIONS[agentName] || "general expertise";
  return [
    `You are ${agentName} in a team meeting. Your expertise: ${roleDesc}.`,
    `Topic: ${meeting.topic}`,
    "",
    "The chair is about to close the following discussion item:",
    `"${topicSummary}"`,
    "",
    "You have not yet spoken on this item.",
    "If you have relevant information, a concern, or a different perspective that",
    "the group should hear BEFORE the item is closed, reply:",
    "  [RAISE-HAND: one concise sentence explaining what you'd add]",
    "Otherwise reply:",
    "  [PASS]",
    "",
    "Be honest and brief. Do NOT pad your response. One line only.",
  ].join("\n");
}

/**
 * Parse hand-raise responses from agents.
 * Takes an array of {agent, output} and returns {raisers: [{agent, reason}], passers: string[]}.
 */
function parseHandRaiseResponses(responses) {
  const raisers = [];
  const passers = [];
  for (const { agent, output } of responses) {
    const raiseMatch = /\[RAISE-HAND:\s*(.+?)\]/i.exec(output);
    if (raiseMatch) {
      raisers.push({ agent, reason: raiseMatch[1].trim() });
    } else {
      // Treat anything that isn't a RAISE-HAND as a pass (includes [PASS], errors, timeouts)
      passers.push(agent);
    }
  }
  return { raisers, passers };
}

/**
 * Run a hand-raise round: send short prompts in parallel to all non-speakers,
 * parse their responses, and return the list of agents who raised hands.
 * Returns an array of {agent, reason}.
 */
async function runHandRaiseRound(meeting, topicSummary, nonSpeakers) {
  if (!nonSpeakers || nonSpeakers.length === 0) return [];

  console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Hand-raise round for ${nonSpeakers.length} non-speaker(s): [${nonSpeakers.join(",")}]`);

  const cliCmd = config.claude?.command || "claude";

  // Spawn all hand-raise prompts in parallel
  const handRaisePromises = nonSpeakers.map((agentName) => {
    const prompt = buildHandRaisePrompt(agentName, topicSummary, meeting);
    const model = config.routing?.agentToModel?.[agentName] || "sonnet";
    const selectedModel = selectModel(model, agentName, null);

    const args = [...config.claude.baseArgs];
    args.push("--model", selectedModel);
    args.push("-p");
    args.push("--output-format", "stream-json", "--verbose");
    if (agentName) args.push("--agent", agentName);
    // No MCP tools for hand-raise — keep it lightweight

    // Per-product plugin directory for meeting hand-raise — use productId first
    const hrProduct = meeting.productId
      ? products.get(meeting.productId)
      : resolveProduct(meeting.workingDir);
    applyProductPluginDir(args, hrProduct);

    return new Promise((resolve) => {
      const proc = spawn(cliCmd, args, {
        cwd: meeting.workingDir,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });

      proc.stdin.write(prompt);
      proc.stdin.end();

      // Short timeout — hand-raise is just one line
      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        resolve({ agent: agentName, output: "[PASS]" }); // timeout = treat as pass
      }, 60_000); // 60s

      proc.on("close", () => {
        clearTimeout(timeout);
        let output = "[PASS]";
        const textParts = [];
        for (const line of stdout.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          try {
            const ev = JSON.parse(t);
            if (ev.type === "assistant" && ev.message) {
              for (const b of (ev.message.content || [])) {
                if (b.type === "text" && b.text) textParts.push(b.text);
              }
            } else if (ev.type === "result" && ev.result) {
              if (!textParts.length) textParts.push(ev.result);
            }
          } catch {}
        }
        if (textParts.length) output = textParts.join("").trim();
        else if (stdout.trim()) output = stdout.trim();
        else if (stderr.trim()) output = stderr.trim();
        resolve({ agent: agentName, output });
      });
    });
  });

  const responses = await Promise.all(handRaisePromises);
  const { raisers } = parseHandRaiseResponses(responses);

  if (raisers.length > 0) {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Hand-raisers: [${raisers.map(r => r.agent).join(",")}]`);
  } else {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: No agents raised hands.`);
  }

  return raisers;
}

/**
 * Parse chair directives from the chair's response.
 * Returns: { calls: [{agent, question}], closedItems: string[], endMeeting: boolean, openFloor: boolean, commentary: string }
 */
function parseChairDirectives(content) {
  const result = { calls: [], closedItems: [], endMeeting: false, openFloor: false, commentary: "" };

  // Check for [END-MEETING]
  if (/\[END-MEETING\]/i.test(content)) {
    result.endMeeting = true;
  }

  // Check for [OPEN-FLOOR]
  if (/\[OPEN-FLOOR\]/i.test(content)) {
    result.openFloor = true;
  }

  // Parse [CLOSE-ITEM: description]
  const closeRegex = /\[CLOSE-ITEM(?::\s*(.+?))?\]/gi;
  let closeMatch;
  while ((closeMatch = closeRegex.exec(content)) !== null) {
    result.closedItems.push(closeMatch[1] || "Item closed");
  }

  // Parse [CALL: agent-name] question
  // Each [CALL:] starts a question that continues until the next [CALL:], [CLOSE-ITEM], [OPEN-FLOOR], [END-MEETING], or end of text
  const callRegex = /\[CALL:\s*([a-z0-9_-]+)\]\s*/gi;
  const callMatches = [...content.matchAll(callRegex)];

  for (let i = 0; i < callMatches.length; i++) {
    const agent = callMatches[i][1].toLowerCase();
    const startIdx = callMatches[i].index + callMatches[i][0].length;
    // Question extends until next directive or end
    let endIdx = content.length;
    // Find next directive after this one
    const nextDirective = content.slice(startIdx).search(/\[(?:CALL:|CLOSE-ITEM|OPEN-FLOOR|END-MEETING)/i);
    if (nextDirective !== -1) {
      endIdx = startIdx + nextDirective;
    }
    const question = content.slice(startIdx, endIdx).trim();
    if (question) {
      result.calls.push({ agent, question });
    }
  }

  // Everything that's not a directive is commentary
  let commentary = content
    .replace(/\[CALL:\s*[a-z0-9_-]+\]\s*[^[]*(?=\[|$)/gi, "")
    .replace(/\[CLOSE-ITEM(?::\s*.+?)?\]/gi, "")
    .replace(/\[OPEN-FLOOR\]/gi, "")
    .replace(/\[END-MEETING\]/gi, "")
    .trim();
  result.commentary = commentary;

  return result;
}

/**
 * Run a chair-driven meeting. The chair controls who speaks and when.
 * Flow: chair opens → calls agents → reviews → calls more or closes items → ends
 */
async function runChairDiscussion(meeting) {
  const { agents, callbackUrl, telegram, topic, chair, maxTurns } = meeting;

  console.log(`[${nowIso()}] Chair discussion started: ${meeting.meetingId} topic="${topic}" chair=${chair} agents=[${agents.join(",")}] maxTurns=${maxTurns} callbackUrl=${callbackUrl || "NONE"}`);

  // === Fetch external context ===
  const externalContext = await fetchMeetingContext(meeting);
  if (externalContext) {
    meeting.externalContext = externalContext;
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: External context loaded (${externalContext.length} chars)`);
  }

  // Send initial callback
  if (callbackUrl && telegram) {
    const contextNote = externalContext ? " Context loaded from Jira + Confluence." : "";
    const participantList = agents.filter(a => a !== chair).join(", ");
    const initPayload = {
      event: "meeting:agent-response",
      meetingId: meeting.meetingId,
      agent: "system",
      content: `_Meeting started: "${topic}"_\n_Chair: ${chair} | Participants: ${participantList}_\n_Max ${maxTurns} turns. Chair-directed discussion.${contextNote}_`,
      telegram,
      topic,
    };
    const logFile = path.join(LOG_DIR, `${meeting.meetingId}.log`);
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, `[${nowIso()}] Meeting ${meeting.meetingId}\n`, "utf8");
    }
    sendMeetingCallback(callbackUrl, initPayload);
  }

  const closedItems = [];
  let consecutiveNoCall = 0; // safety: end if chair stops calling agents

  // Per-topic speaker tracking for hand-raise rounds.
  // Resets when a new [CLOSE-ITEM] triggers a new item.
  let topicSpeakers = new Set(); // agents who spoke on the current open item
  // Maximum hand-raise rounds per [CLOSE-ITEM] to cap runaway discussion.
  const MAX_HAND_RAISE_ROUNDS = 2;

  // === Chair opening turn ===
  console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Chair (${chair}) opening...`);

  if (callbackUrl && telegram) {
    const chairName = chair.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase());
    sendMeetingCallback(callbackUrl, {
      event: "meeting:agent-response",
      meetingId: meeting.meetingId,
      agent: "status",
      content: `${chairName} (chair) is opening the meeting...`,
      telegram, topic,
    });
  }

  const openingResult = await runMeetingAgentTurn(meeting, chair, topic, { isChairTurn: true });
  meeting.turnCount++;

  if (!openingResult || meeting.status !== "active") {
    meeting.status = "ended";
    meeting.endedAt = nowIso();
    return;
  }

  // Post chair's opening to Telegram
  if (callbackUrl && telegram) {
    sendMeetingCallback(callbackUrl, {
      event: "meeting:agent-response",
      meetingId: meeting.meetingId,
      agent: openingResult.agent,
      content: openingResult.content,
      telegram, topic,
      turn: meeting.turnCount,
      maxTurns,
    });
  }

  // Parse opening directives
  let directives = parseChairDirectives(openingResult.content);

  // === Main chair loop ===
  while (meeting.status === "active" && meeting.turnCount < maxTurns) {
    // Budget check
    const budgetCheck = checkBudget();
    if (!budgetCheck.ok) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Budget exceeded at turn ${meeting.turnCount}`);
      break;
    }

    // Handle [END-MEETING]
    if (directives.endMeeting) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Chair ended meeting at turn ${meeting.turnCount}`);
      break;
    }

    // === Hand-raise round triggered by [CLOSE-ITEM] ===
    // For each item the chair just closed, run a hand-raise round before
    // new agents are called. This happens synchronously (items closed one at
    // a time) using the last closed item description as topic summary.
    let pendingHandRaisers = []; // carried into the next chair turn
    if (directives.closedItems.length > 0 && meeting.turnCount < maxTurns) {
      // The last closed item description is the most relevant summary.
      const topicSummary = directives.closedItems[directives.closedItems.length - 1];

      // Non-speakers = participants minus chair minus anyone who already spoke
      const nonSpeakers = agents.filter(a => a !== chair && !topicSpeakers.has(a));

      if (nonSpeakers.length > 0) {
        let handRaiseRound = 0;
        let handRaisers = [];

        do {
          handRaiseRound++;
          if (callbackUrl && telegram) {
            sendMeetingCallback(callbackUrl, {
              event: "meeting:agent-response",
              meetingId: meeting.meetingId,
              agent: "status",
              content: `_Open floor check (round ${handRaiseRound}): asking ${nonSpeakers.length} agent(s) if they have input on "${topicSummary.substring(0, 60)}"..._`,
              telegram, topic,
            });
          }

          handRaisers = await runHandRaiseRound(meeting, topicSummary, nonSpeakers);

          if (handRaisers.length > 0) {
            // Let the chair know — carried into the next chair turn prompt
            pendingHandRaisers = handRaisers;

            if (callbackUrl && telegram) {
              const raiserNames = handRaisers.map(r => `${r.agent} ("${r.reason.substring(0, 60)}")`).join(", ");
              sendMeetingCallback(callbackUrl, {
                event: "meeting:agent-response",
                meetingId: meeting.meetingId,
                agent: "status",
                content: `_Hand-raisers: ${raiserNames}_`,
                telegram, topic,
              });
            }
          }

          // Only loop for a second round if any agents raised hands the first time
          // (the second round would go to remaining non-speakers after chair calls hand-raisers)
          break; // single round per [CLOSE-ITEM]; chair controls follow-up via [CALL:]
        } while (handRaiseRound < MAX_HAND_RAISE_ROUNDS && handRaisers.length > 0);
      }

      // Reset per-topic speaker tracking for the next agenda item
      topicSpeakers = new Set();
    }

    // Track closed items (after hand-raise processing)
    closedItems.push(...directives.closedItems);

    // === Handle [OPEN-FLOOR] mid-topic ===
    // Chair explicitly invited input — run a hand-raise round for all non-speakers now.
    if (directives.openFloor && meeting.turnCount < maxTurns) {
      const nonSpeakersMidTopic = agents.filter(a => a !== chair && !topicSpeakers.has(a));
      if (nonSpeakersMidTopic.length > 0) {
        if (callbackUrl && telegram) {
          sendMeetingCallback(callbackUrl, {
            event: "meeting:agent-response",
            meetingId: meeting.meetingId,
            agent: "status",
            content: `_Chair opened the floor: checking ${nonSpeakersMidTopic.length} agent(s) for input..._`,
            telegram, topic,
          });
        }
        const midTopicRaisers = await runHandRaiseRound(meeting, topic, nonSpeakersMidTopic);
        if (midTopicRaisers.length > 0) {
          pendingHandRaisers = [...pendingHandRaisers, ...midTopicRaisers];
          if (callbackUrl && telegram) {
            const raiserNames = midTopicRaisers.map(r => `${r.agent} ("${r.reason.substring(0, 60)}")`).join(", ");
            sendMeetingCallback(callbackUrl, {
              event: "meeting:agent-response",
              meetingId: meeting.meetingId,
              agent: "status",
              content: `_Agents requesting to speak: ${raiserNames}_`,
              telegram, topic,
            });
          }
        }
      }
    }

    // If chair called no agents, track it (safety valve)
    if (directives.calls.length === 0) {
      consecutiveNoCall++;
      if (consecutiveNoCall >= 2) {
        console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Chair made no calls for 2 turns, forcing end`);
        break;
      }
    } else {
      consecutiveNoCall = 0;
    }

    // === Run called agents ===
    const agentResponses = [];
    for (const call of directives.calls) {
      if (meeting.status !== "active") break;
      if (meeting.turnCount >= maxTurns) break;

      // Validate agent is in meeting
      if (!agents.includes(call.agent)) {
        console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Chair called unknown agent "${call.agent}", skipping`);
        // Add a system note to transcript
        meeting.transcript.push({
          role: "agent", agent: "system", name: "system",
          content: `(${call.agent} is not in this meeting)`,
          timestamp: nowIso(),
        });
        continue;
      }

      // Don't let chair call themselves
      if (call.agent === chair) {
        console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Chair tried to call themselves, skipping`);
        continue;
      }

      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Chair called ${call.agent}: "${call.question.substring(0, 80)}..."`);

      // Send thinking status
      if (callbackUrl && telegram) {
        const agentName = call.agent.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase());
        sendMeetingCallback(callbackUrl, {
          event: "meeting:agent-response",
          meetingId: meeting.meetingId,
          agent: "status",
          content: `${agentName} was called by the chair...`,
          telegram, topic,
          turn: meeting.turnCount + 1,
          maxTurns,
        });
      }

      const agentResult = await runMeetingAgentTurn(meeting, call.agent, call.question, { calledByChair: true });
      meeting.turnCount++;

      if (agentResult) {
        agentResponses.push(agentResult);
        // Track this agent as having spoken on the current topic
        topicSpeakers.add(call.agent);

        // Post to Telegram
        if (callbackUrl && telegram) {
          sendMeetingCallback(callbackUrl, {
            event: "meeting:agent-response",
            meetingId: meeting.meetingId,
            agent: agentResult.agent,
            content: agentResult.content,
            telegram, topic,
            turn: meeting.turnCount,
            maxTurns,
          });
        }
      }
    }

    // === Chair reviews and decides next action ===
    if (meeting.status !== "active" || meeting.turnCount >= maxTurns) break;

    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Chair (${chair}) reviewing responses... (turn ${meeting.turnCount + 1}/${maxTurns})`);

    if (callbackUrl && telegram) {
      const chairName = chair.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase());
      sendMeetingCallback(callbackUrl, {
        event: "meeting:agent-response",
        meetingId: meeting.meetingId,
        agent: "status",
        content: `${chairName} (chair) is reviewing... (turn ${meeting.turnCount + 1}/${maxTurns})`,
        telegram, topic,
      });
    }

    // Build chair follow-up prompt, including any hand-raisers from this iteration
    const chairResult = await runMeetingAgentTurn(meeting, chair, null, {
      isChairTurn: true,
      agentResponses,
      closedItems,
      handRaisers: pendingHandRaisers,
    });
    meeting.turnCount++;

    if (!chairResult || meeting.status !== "active") break;

    // Post chair response
    if (callbackUrl && telegram) {
      sendMeetingCallback(callbackUrl, {
        event: "meeting:agent-response",
        meetingId: meeting.meetingId,
        agent: chairResult.agent,
        content: chairResult.content,
        telegram, topic,
        turn: meeting.turnCount,
        maxTurns,
      });
    }

    // Parse new directives
    directives = parseChairDirectives(chairResult.content);
  }

  if (meeting.status !== "active") return;

  // === Generate structured outcomes (same as round-robin) ===
  console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Generating outcomes...`);

  // Reuse the shared outcomes generation from endAndFinalizeChairMeeting
  await generateAndFinalizeOutcomes(meeting);
}

/**
 * Shared outcomes generation and finalization for both meeting modes.
 * Generates structured outcomes via Claude, posts to Telegram, N8N, and dispatches actions.
 */
async function generateAndFinalizeOutcomes(meeting) {
  const { callbackUrl, telegram, topic } = meeting;

  const outcomesPrompt = buildOutcomesPrompt(meeting);
  const facilitatorModel = config.routing?.agentToModel?.[meeting.facilitator] || "sonnet";
  const selectedModel = selectModel(facilitatorModel, meeting.facilitator, null);

  const args = [...config.claude.baseArgs];
  args.push("--model", selectedModel);
  args.push("-p");
  args.push("--output-format", "stream-json", "--verbose");
  if (meeting.facilitator) args.push("--agent", meeting.facilitator);

  // Per-product plugin directory for outcomes generation
  const outcomesProduct = resolveProduct(meeting.workingDir);
  applyProductPluginDir(args, outcomesProduct);

  const cliCmd = config.claude?.command || "claude";

  const outcomesResult = await new Promise((resolve) => {
    const proc = spawn(cliCmd, args, {
      cwd: meeting.workingDir,
      env: { ...process.env, ...getOAuthEnvVars() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.stdin.write(outcomesPrompt);
    proc.stdin.end();

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ content: "(outcomes generation timed out)", error: true });
    }, 180_000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      const textParts = [];
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t);
          if (ev.type === "assistant" && ev.message) {
            for (const b of (ev.message.content || [])) {
              if (b.type === "text" && b.text) textParts.push(b.text);
            }
          } else if (ev.type === "result" && ev.result) {
            if (!textParts.length) textParts.push(ev.result);
          }
        } catch {}
      }
      const content = textParts.join("").trim() || stderr.trim() || "(no outcomes generated)";
      resolve({ content, error: code !== 0 });
    });
  });

  // Detect [REQUIRES-APPROVAL] directive emitted by the outcomes LLM (extra signal, not relied on).
  // Strip the directive from the displayed summary so it doesn't leak into Telegram/Confluence.
  const requiresApprovalDirective = /^[ \t]*\[REQUIRES-APPROVAL\][ \t]*\r?\n/im.test(outcomesResult.content);
  const cleanSummary = outcomesResult.content.replace(/^[ \t]*\[REQUIRES-APPROVAL\][ \t]*\r?\n/im, "").trim();
  // Deterministic recompute: defends against lost in-memory flags (restart, DB reload, alt creation paths)
  // and against the LLM forgetting to emit [REQUIRES-APPROVAL]. Source of truth is the user's words.
  const intentResult = detectGateIntentForMeeting(meeting);
  let gated = intentResult.gated || requiresApprovalDirective;
  let gateSource = intentResult.gated ? intentResult.source : (requiresApprovalDirective ? "llm-directive" : null);
  let gateReason = null;

  // Implicit gate — fires when no explicit ask was made but the outcomes show
  // signals warranting human review (broad scope, schema changes, multi-product, etc.).
  // Cheap rules first, then optional LLM borderline judgment for ambiguous cases.
  if (!gated) {
    const ruleResult = detectImplicitGateNeed(meeting, cleanSummary);
    if (ruleResult) {
      gated = true;
      gateSource = ruleResult.source;
      gateReason = ruleResult.reason;
    } else {
      const llmResult = await judgeBorderlineGate(meeting, cleanSummary);
      if (llmResult) {
        gated = true;
        gateSource = llmResult.source;
        gateReason = llmResult.reason;
      }
    }
  }

  meeting.summary = cleanSummary;

  if (gated) {
    // Pause: hold dispatch + Confluence + N8N outcomes until /meeting/:id/decision is called.
    meeting.gateBeforeDispatch = true; // persist canonical truth
    meeting.status = "awaiting-approval";
    meeting.awaitingApproval = true;
    meeting.awaitingApprovalSince = nowIso();
    meeting.gateSource = gateSource;
    meeting.gateReason = gateReason;
    db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));

    // Strip agent:* labels from any issues meeting agents created mid-conversation,
    // BEFORE the user is told the meeting is awaiting approval. Stops the periodic
    // reconciler from racing the human and dispatching the work without approval.
    await quarantineMeetingCreatedIssues(meeting).catch(e =>
      console.error(`[meeting-quarantine] ${meeting.meetingId}: ${e.message}`)
    );

    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: GATED — awaiting approval (source=${gateSource}, reason=${gateReason || "n/a"}, directive=${requiresApprovalDirective}, flag=${meeting.gateBeforeDispatch})`);

    // Post the summary + approval instructions to Telegram (via existing N8N callback path).
    if (callbackUrl && telegram) {
      let outcomesText = cleanSummary;
      if (outcomesText.length > 3400) outcomesText = outcomesText.substring(0, 3400) + "\n…(truncated)";
      const isImplicit = gateSource && (gateSource.startsWith("rule:") || gateSource.startsWith("llm:"));
      const whyLine = isImplicit
        ? `_Auto-paused (${gateSource}): ${gateReason || "needs review"}._`
        : `_Nothing has been written to Jira and no agents have been dispatched._`;
      const prompt = [
        `*⏸ Meeting awaiting your input* — \`${meeting.meetingId}\``,
        ``,
        outcomesText,
        ``,
        whyLine,
        `Reply in admin DM:`,
        `• \`/approve ${meeting.meetingId}\` — dispatch all action items`,
        `• \`/reject ${meeting.meetingId}\` — discard, do nothing`,
        `• \`/refine ${meeting.meetingId} <your guidance>\` — keep discussing (max 3 rounds)`,
      ].join("\n");
      sendMeetingCallback(callbackUrl, {
        event: "meeting:agent-response",
        meetingId: meeting.meetingId,
        agent: "Meeting — Awaiting Approval",
        content: prompt,
        telegram, topic,
      });
    }

    if (config.sseEnabled) {
      jobEmitter.emit("meeting:awaiting-approval", { meetingId: meeting.meetingId, topic });
    }
    return;
  }

  // End meeting (ungated path — original behaviour)
  meeting.status = "ended";
  meeting.endedAt = nowIso();
  db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));


  // Post outcomes to Telegram
  if (callbackUrl && telegram) {
    let outcomesText = meeting.summary;
    if (outcomesText.length > 3800) {
      outcomesText = outcomesText.substring(0, 3790) + "\n...(truncated)";
    }

    sendMeetingCallback(callbackUrl, {
      event: "meeting:agent-response",
      meetingId: meeting.meetingId,
      agent: "Meeting Outcomes",
      content: outcomesText,
      telegram, topic,
    });

    const duration = Math.round((new Date(meeting.endedAt) - new Date(meeting.createdAt)) / 1000);
    sendMeetingCallback(callbackUrl, {
      event: "meeting:ended",
      meetingId: meeting.meetingId,
      topic, summary: meeting.summary, telegram,
      messageCount: meeting.transcript.length,
      agents: meeting.agents,
      duration,
      mode: meeting.mode,
      turnCount: meeting.turnCount || 0,
    });
  }

  console.log(`[${nowIso()}] Meeting finalized: ${meeting.meetingId} mode=${meeting.mode} (${meeting.turnCount || 0} turns, ${meeting.transcript.length} messages)`);

  // Post outcomes to N8N + dispatch actions
  postMeetingOutcomes(meeting).catch(e => {
    console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: postMeetingOutcomes error: ${e.message}`);
  });

  dispatchMeetingActions(meeting).catch(e => {
    console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: dispatchMeetingActions error: ${e.message}`);
  });
}

/**
 * Detect action items that are just echoes of the meeting topic (Bug B).
 * Catches openers like "talk about", "discuss", "give an update on", "where do we stand on",
 * and items whose normalised body substantially overlaps with the topic.
 */
function isMeetingTopicEcho(task, topic) {
  if (!task) return false;
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const t = norm(task);
  if (!t) return false;
  const conversationalOpeners = /^(talk about|discuss|cover|review|address|debate|chat about|give (?:me )?(?:an )?update on|provide (?:an )?update on|where (?:do|are) we stand|read this|need an intro)/;
  if (conversationalOpeners.test(t)) return true;
  const topicNorm = norm(topic);
  if (topicNorm && topicNorm.length >= 8) {
    if (t === topicNorm) return true;
    const topicWords = new Set(topicNorm.split(" ").filter(w => w.length > 3));
    if (topicWords.size >= 3) {
      const taskWords = t.split(" ").filter(w => w.length > 3);
      const overlap = taskWords.filter(w => topicWords.has(w)).length;
      if (overlap / topicWords.size >= 0.8 && taskWords.length <= topicWords.size + 2) return true;
    }
  }
  return false;
}

/**
 * Parse action items from meeting summary and dispatch them as real runner jobs.
 * Pattern: "- [ ] [task] — Owner: [agent-name] — Priority: [High/Medium/Low]"
 * Also parses "## Bugs Identified" section and creates Jira bugs via engineer-planner.
 */
async function dispatchMeetingActions(meeting) {
  const summary = meeting.summary || "";
  if (!summary) return;

  // Map agent names used in meetings to actual agent identifiers
  const agentNameMap = {};
  for (const agentId of Object.values(config.agentLabels || {})) {
    agentNameMap[agentId] = agentId;
  }
  // Also accept natural names
  for (const agent of meeting.agents || []) {
    agentNameMap[agent] = agent;
  }

  // Parse bugs identified in meeting and dispatch as engineer-planner jobs to create + fix them
  const bugRegex = /- Summary:\s*(.+?)\s*[—–-]\s*Severity:\s*(Critical|Major|Minor)\s*[—–-]\s*RootCause:\s*(.+?)\s*[—–-]\s*Priority:\s*(High|Medium|Low)$/gim;
  let bugMatch;
  while ((bugMatch = bugRegex.exec(summary)) !== null) {
    const bugSummary = bugMatch[1].trim();
    const severity = bugMatch[2].trim();
    const rootCause = bugMatch[3].trim();
    const priority = bugMatch[4].trim();
    const priorityMap = { High: "High", Medium: "Medium", Low: "Low" };
    const jiraPriority = priorityMap[priority] || "Medium";
    const severityLabel = `severity-${severity.toLowerCase()}`;

    const bugPrompt = [
      `A bug was identified during a team meeting that requires immediate attention.`,
      ``,
      `**Meeting topic:** ${meeting.topic}`,
      `**Bug summary:** ${bugSummary}`,
      `**Severity:** ${severity}`,
      `**Root cause / suspected area:** ${rootCause}`,
      `**Priority:** ${priority}`,
      ``,
      `Your task:`,
      `1. Create a Jira Bug in project ${resolveJiraProject(meeting.productId || meeting.workingDir)} with the summary above.`,
      `2. Set the priority to ${jiraPriority}.`,
      `3. Set labels to: ["${severityLabel}", "agent:engineer-planner", "agent-created-bug"]`,
      `4. Add a description that includes:`,
      `   - Root cause: ${rootCause}`,
      `   - Source: Identified during meeting "${meeting.topic}" (meeting ID: ${meeting.meetingId})`,
      `   - Meeting decisions context (paste the relevant decisions from the meeting summary)`,
      `5. After creating the bug, post an \`[AUTO-PLAN]\` comment on the new issue with an initial investigation plan based on the root cause.`,
      `6. Then begin investigating and implementing the fix. Use the bug-fix workflow (investigate, implement, test, PR).`,
      ``,
      `Meeting summary for context:`,
      summary,
    ].join("\n");

    const jobId = makeJobId();
    const logFile = path.join(LOG_DIR, `${jobId}.log`);
    const metaFile = path.join(LOG_DIR, `${jobId}.json`);
    const job = {
      jobId,
      status: "queued",
      mode: "agent",
      agent: "engineer-planner",
      prompt: bugPrompt,
      context: "",
      workingDir: meeting.workingDir || config.workingDir || DEFAULT_WORKING_DIR,
      issueKey: null,
      model: config.routing?.agentToModel?.["engineer-planner"] || "opus",
      selectedModel: null,
      requestedProvider: null,
      callbackUrl: config.callbackUrl || null,
      logFile,
      metaFile,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      pid: null,
      output: null,
      error: null,
      retryCount: 0,
      maxRetries: config.maxRetries || 3,
      source: `meeting:${meeting.meetingId}`,
      meetingAction: { task: `Create and fix bug: ${bugSummary}`, priority, meetingId: meeting.meetingId, type: "agent-created-bug" },
    };

    jobs.set(jobId, job);
    db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
    queue.push({ jobId });
  
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Dispatched agent-created bug "${bugSummary.substring(0, 60)}" -> engineer-planner (job ${jobId})`);

    if (config.sseEnabled) {
      jobEmitter.emit("job:queued", { jobId, agent: "engineer-planner", source: `meeting:${meeting.meetingId}`, type: "agent-created-bug" });
    }
  }

  // Parse action items — with optional Schedule and DependsOn fields
  // Groups: 1=task, 2=owner, 3=priority, 4=scheduleStr, 5=dependsOnStr
  const actionRegex = /- \[ \] (.+?)(?:\s*[—–-]\s*Owner:\s*\*{0,2}(\S+?)\*{0,2}\s*[—–-]\s*Priority:\s*\*{0,2}(High|Medium|Low)\*{0,2})(?:\s*[—–-]\s*Schedule:\s*([^—–\n\r]+?))?(?:\s*[—–-]\s*DependsOn:\s*\[([^\]]*)\])?$/gim;
  const actions = [];
  let match;
  while ((match = actionRegex.exec(summary)) !== null) {
    const task = match[1].trim();
    let owner = match[2].trim().replace(/\*+/g, "");
    const priority = match[3].trim();
    const scheduleStr = match[4]?.trim() || null;
    const dependsOnStr = match[5]?.trim() || null;
    const dependsOn = dependsOnStr
      ? dependsOnStr.split(",").map(s => parseInt(s.trim(), 10) - 1).filter(n => Number.isFinite(n) && n >= 0)
      : [];
    // Strip namespace prefixes like "certpilot:" that agents sometimes add
    if (owner.includes(":")) {
      owner = owner.split(":").pop();
    }
    if (!agentNameMap[owner]) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Skipping action item — unknown owner "${owner}" (original: ${match[2]})`);
      continue;
    }
    // Filter out items that are just restatements of the meeting topic (Bug B)
    if (isMeetingTopicEcho(task, meeting.topic)) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Skipping action item — looks like a meeting-topic echo: "${task.substring(0, 80)}"`);
      continue;
    }
    actions.push({ task, owner, priority, scheduleStr, dependsOn });
  }

  // Parse follow-up meetings
  const followUpMeetings = [];
  const meetingRegex = /- Topic:\s*(.+?)\s*[—–-]\s*Agents?:\s*(.+?)\s*[—–-]\s*Schedule:\s*(.+?)$/gim;
  while ((match = meetingRegex.exec(summary)) !== null) {
    const topic = match[1].trim();
    const agentsStr = match[2].trim();
    const scheduleStr = match[3].trim();
    const agents = agentsStr.split(/[,\s]+/).map(a => a.trim().replace(/\*+/g, "")).filter(Boolean);
    // Strip namespace prefixes from agents
    const cleanAgents = agents.map(a => a.includes(":") ? a.split(":").pop() : a);
    followUpMeetings.push({ topic, agents: cleanAgents, scheduleStr });
  }

  const totalItems = actions.length + followUpMeetings.length;
  if (totalItems === 0) {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: No dispatchable action items or follow-up meetings found in summary`);
    return;
  }

  console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Processing ${actions.length} action items + ${followUpMeetings.length} follow-up meetings (bugs already dispatched above)`);

  const actionJiraProject = resolveJiraProject(meeting.productId || meeting.workingDir);
  const actionProductName = (meeting.productId && products.get(meeting.productId)?.name) || meeting.productId || "";

  // ── Tier classification — prevent duplicate Jira stories per meeting.
  // Tier 1 (storyCreators: ba-agent, product-manager) own story creation.
  // Tier 2 (enrichers: ux-agent, engineer-planner, etc.) must comment on
  // tier-1 stories rather than create their own. Tier 2 jobs are gated on
  // tier 1 via blockedByJobIds so they only run after stories exist.
  const tierConfig = config.meetings?.actionItemTiers || {};
  const storyCreators = new Set(tierConfig.storyCreators || ["ba-agent", "product-manager"]);
  const enrichers = new Set(tierConfig.enrichers || ["ux-agent", "engineer-planner", "architect-jets", "security-agent", "qa-agent", "ui-engineer", "ask-tom-agent"]);
  const tierOf = (owner) => {
    if (storyCreators.has(owner)) return 1;
    if (enrichers.has(owner)) return 2;
    return 0;
  };
  const tier1Indices = [];
  const tier2Indices = [];
  for (let i = 0; i < actions.length; i++) {
    const t = tierOf(actions[i].owner);
    if (t === 1) tier1Indices.push(i);
    else if (t === 2) tier2Indices.push(i);
  }
  // Auto-wire tier-2 dependencies on tier-1 (only if the agent author didn't set explicit deps).
  if (tier1Indices.length > 0) {
    for (const t2idx of tier2Indices) {
      if (!actions[t2idx].dependsOn || actions[t2idx].dependsOn.length === 0) {
        actions[t2idx].dependsOn = [...tier1Indices];
        actions[t2idx].autoTieredDep = true;
      }
    }
    if (tier2Indices.length > 0) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Tier-gated dispatch — tier1=[${tier1Indices.join(",")}] tier2=[${tier2Indices.join(",")}]`);
    }
  }

  // Jira auth for creating meeting-action tasks
  const { domain: jiraDomain, email: jiraEmail, apiToken: jiraApiToken } = config.jira || {};
  const canCreateJiraTasks = !!(jiraDomain && jiraEmail && jiraApiToken);
  const jiraAuthHeader = canCreateJiraTasks ? "Basic " + Buffer.from(`${jiraEmail}:${jiraApiToken}`).toString("base64") : null;
  const jiraBaseUrl = jiraDomain ? jiraDomain.replace(/\/+$/, "") : "";
  const jiraHeaders = jiraAuthHeader ? { authorization: jiraAuthHeader } : {};

  // ── Pass 1: create all Jira tasks + build all immediate job objects.
  // Nothing is pushed to the queue yet so no job can start before deps are wired.
  const pendingJobs = []; // { job, actionIdx } — immediate-dispatch only
  const jobIdsByIdx = {}; // actionIdx → jobId
  const issueKeysByIdx = {}; // actionIdx → issueKey

  for (let actionIdx = 0; actionIdx < actions.length; actionIdx++) {
    const action = actions[actionIdx];
    const tier = tierOf(action.owner);
    const meetingStoryLabel = `meeting:${meeting.meetingId}`;

    let tierGuidance = "";
    if (tier === 1) {
      // Story creators: tag their stories so tier-2 enrichers can find them.
      tierGuidance = [
        ``,
        `**Tier 1 — story creator role:**`,
        `- If this action requires you to create a Jira Story, add the label \`${meetingStoryLabel}\` to it so other agents from this meeting can locate it.`,
        `- Create ONE story per distinct scope. Do not create multiple stories for the same outcome.`,
      ].join("\n");
    } else if (tier === 2) {
      // Enrichers: forbidden from creating new Stories. Must comment on tier-1 output.
      tierGuidance = [
        ``,
        `**Tier 2 — enrichment role (STRICT):**`,
        `- DO NOT create new Jira Stories. This work is enrichment of an existing Story produced by a Tier 1 agent (BA / PM) in the same meeting.`,
        `- Find the parent Story via JQL: \`project = ${actionJiraProject} AND labels = "${meetingStoryLabel}" AND issuetype = Story\``,
        `- Add your output (audit findings, tech assessment, UX spec, etc.) as a COMMENT on the most relevant parent Story.`,
        `- Use a prefixed header in your comment, e.g. \`[UX-AUDIT]\`, \`[TECH-ASSESSMENT]\`, \`[SECURITY-REVIEW]\`, so other agents can find your contribution.`,
        `- Your meeting Task (this ticket) IS your work container — close it when complete; the Story does the long-term tracking.`,
        `- If you cannot find a parent Story (Tier 1 produced none), add your output as a comment on THIS meeting Task and flag it in your report — do not silently create a new Story.`,
      ].join("\n");
    }

    const prompt = [
      `You were in a meeting and committed to the following action item:`,
      ``,
      `**Task:** ${action.task}`,
      `**Priority:** ${action.priority}`,
      `**Meeting topic:** ${meeting.topic}`,
      actionProductName ? `**Product:** ${actionProductName}` : "",
      `**Jira Project:** ${actionJiraProject} — ALL Jira issues MUST be created in project ${actionJiraProject}. Do NOT use any other project key.`,
      tierGuidance,
      ``,
      `Meeting decisions and context:`,
      summary,
      ``,
      `Execute this task now. Be thorough and report what you did.`,
    ].filter(Boolean).join("\n");

    // Create a Jira Task for this action item so the job is linked in the dashboard
    let actionIssueKey = null;
    if (canCreateJiraTasks) {
      try {
        const agentLabel = `agent:${action.owner}`;
        const taskSummary = `[Meeting] ${action.task}`.substring(0, 255);
        const priorityMap = { High: "High", Medium: "Medium", Low: "Low" };
        const taskPayload = {
          fields: {
            project: { key: actionJiraProject },
            summary: taskSummary,
            description: {
              type: "doc",
              version: 1,
              content: [{
                type: "paragraph",
                content: [{
                  type: "text",
                  text: `Action item from meeting "${meeting.topic}" (${meeting.meetingId}).\n\nTask: ${action.task}\nOwner: ${action.owner}\nPriority: ${action.priority}`
                }]
              }]
            },
            issuetype: { name: "Task" },
            labels: ["meeting-action", agentLabel],
            priority: { name: priorityMap[action.priority] || "Medium" },
          }
        };
        const createRes = await postJson(`${jiraBaseUrl}/rest/api/3/issue`, taskPayload, jiraHeaders);
        if (createRes.statusCode === 201) {
          try { actionIssueKey = JSON.parse(createRes.body)?.key; } catch (_) {}
          console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Created Jira task ${actionIssueKey} for action "${action.task.substring(0, 60)}..."`);
          if (actionIssueKey) {
            await transitionIssueToInProgress(actionIssueKey);
          }
        } else {
          console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Jira task creation failed (${createRes.statusCode}): ${(createRes.body || "").substring(0, 200)}`);
        }
      } catch (e) {
        console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: Jira task creation error: ${e.message}`);
      }
    }
    issueKeysByIdx[actionIdx] = actionIssueKey;

    const scheduledAt = action.scheduleStr ? parseScheduleTime(action.scheduleStr) : null;

    if (scheduledAt && scheduledAt > new Date()) {
      // Scheduled items fire via tickScheduler — dependencies not tracked for these
      const schedId = scheduleItem({
        type: "job",
        scheduledAt: scheduledAt.toISOString(),
        status: "pending",
        source: `meeting:${meeting.meetingId}`,
        data: {
          agent: action.owner,
          prompt,
          workingDir: meeting.workingDir || config.workingDir || DEFAULT_WORKING_DIR,
          task: action.task,
          priority: action.priority,
          issueKey: actionIssueKey,
        },
      });
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Scheduled action "${action.task.substring(0, 60)}..." -> ${action.owner} for ${scheduledAt.toISOString()} (${schedId})`);
    } else {
      // Build job object but do NOT queue yet
      const jobId = makeJobId();
      const logFile = path.join(LOG_DIR, `${jobId}.log`);
      const metaFile = path.join(LOG_DIR, `${jobId}.json`);
      const job = {
        jobId,
        status: "queued",
        mode: "agent",
        agent: action.owner,
        prompt,
        context: "",
        workingDir: meeting.workingDir || config.workingDir || DEFAULT_WORKING_DIR,
        issueKey: actionIssueKey,
        model: config.routing?.agentToModel?.[action.owner] || "sonnet",
        selectedModel: null,
        requestedProvider: null,
        callbackUrl: config.callbackUrl || null,
        logFile,
        metaFile,
        createdAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        pid: null,
        output: null,
        error: null,
        retryCount: 0,
        maxRetries: config.maxRetries || 3,
        source: `meeting:${meeting.meetingId}`,
        meetingAction: { task: action.task, priority: action.priority, meetingId: meeting.meetingId },
        blockedByJobIds: [], // populated in pass 2
      };
      jobs.set(jobId, job);
      jobIdsByIdx[actionIdx] = jobId;
      pendingJobs.push({ job, actionIdx });
    }
  }

  // ── Pass 2: wire dependencies, then enqueue everything atomically.
  // Set Jira blocks/is-blocked-by links and blockedByJobIds before anything can start.
  const linkPromises = [];
  for (const { job, actionIdx } of pendingJobs) {
    const action = actions[actionIdx];
    if (!action.dependsOn?.length) continue;

    const validDeps = action.dependsOn.filter(depIdx => depIdx >= 0 && depIdx < actions.length && depIdx !== actionIdx);
    if (!validDeps.length) continue;

    // Jira links (fire-and-forget, best effort)
    if (canCreateJiraTasks) {
      for (const depIdx of validDeps) {
        const depKey = issueKeysByIdx[depIdx];
        const thisKey = issueKeysByIdx[actionIdx];
        if (depKey && thisKey) {
          linkPromises.push(
            postJson(`${jiraBaseUrl}/rest/api/3/issueLink`, {
              type: { name: "Blocks" },
              inwardIssue: { key: depKey },
              outwardIssue: { key: thisKey },
            }, jiraHeaders).catch(e => {
              console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: Failed to set Jira link ${depKey} blocks ${thisKey}: ${e.message}`);
            })
          );
        }
      }
    }

    // In-memory dependency gate
    job.blockedByJobIds = validDeps
      .map(depIdx => jobIdsByIdx[depIdx])
      .filter(Boolean);
  }

  if (linkPromises.length) {
    await Promise.all(linkPromises);
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Set ${linkPromises.length} Jira dependency link(s)`);
  }

  // Enqueue all immediate jobs now that deps are fully wired
  for (const { job } of pendingJobs) {
    db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${job.jobId}: ${e.message}`));
    queue.push({ jobId: job.jobId });
    const blockedNote = job.blockedByJobIds?.length ? ` [blocked by: ${job.blockedByJobIds.join(", ")}]` : "";
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Queued action "${(job.meetingAction?.task || "").substring(0, 60)}..." -> ${job.agent} (job ${job.jobId}, issueKey: ${job.issueKey || "none"}${blockedNote})`);
    if (config.sseEnabled) {
      jobEmitter.emit("job:queued", { jobId: job.jobId, agent: job.agent, source: job.source });
    }
  }

  if (pendingJobs.length) tickWorker();

  // Schedule follow-up meetings (with dedup)
  for (const fm of followUpMeetings) {
    const scheduledAt = parseScheduleTime(fm.scheduleStr);
    if (!scheduledAt) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Could not parse follow-up meeting schedule "${fm.scheduleStr}", skipping`);
      continue;
    }

    // Dedup: skip if same topic is already active or scheduled
    const dup = checkMeetingDuplicate(fm.topic);
    if (dup.duplicate) {
      const msg = dup.reason === "active"
        ? `already active as ${dup.existingId}`
        : `already scheduled as ${dup.existingId} for ${dup.scheduledAt}`;
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Skipping follow-up "${fm.topic}" — ${msg}`);
      continue;
    }

    const schedId = scheduleItem({
      type: "meeting",
      scheduledAt: scheduledAt.toISOString(),
      status: "pending",
      source: `meeting:${meeting.meetingId}`,
      data: {
        topic: fm.topic,
        agents: fm.agents,
        facilitator: fm.agents[0],
        maxRounds: 3,
        workingDir: meeting.workingDir || DEFAULT_WORKING_DIR,
        telegram: meeting.telegram || null,
        callbackUrl: meeting.callbackUrl || N8N_CALLBACK_URL || null,
      },
    });
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Scheduled follow-up meeting "${fm.topic.substring(0, 60)}" with [${fm.agents.join(",")}] for ${scheduledAt.toISOString()} (${schedId})`);
  }

  // Kick the queue for immediate items
  tickWorker();
}

async function runMeetingAgentTurn(meeting, agent, triggerMessage, options = {}) {
  if (meeting.status !== "active") return null;
  meeting.currentSpeaker = agent;

  // Chair mode: use chair-specific or called-agent prompts
  let prompt;
  if (meeting.mode === "chair") {
    if (options.isChairTurn) {
      prompt = buildChairPrompt(meeting, {
        isOpening: !meeting.transcript.some(t => t.agent === meeting.chair),
        agentResponses: options.agentResponses || [],
        closedItems: options.closedItems || [],
        handRaisers: options.handRaisers || [],
      });
    } else if (options.calledByChair && triggerMessage) {
      prompt = buildCalledAgentPrompt(meeting, agent, triggerMessage);
    } else {
      prompt = buildMeetingPrompt(meeting, agent, triggerMessage, options);
    }
  } else {
    prompt = buildMeetingPrompt(meeting, agent, triggerMessage, options);
  }
  const model = config.routing?.agentToModel?.[agent] || "sonnet";
  const selectedModel = selectModel(model, agent, null);

  const jobId = makeJobId();
  const logFile = path.join(LOG_DIR, `${jobId}.log`);

  // Build Claude CLI args
  const args = [...config.claude.baseArgs];
  args.push("--model", selectedModel);
  args.push("-p");
  args.push("--output-format", "stream-json", "--verbose");
  if (agent) args.push("--agent", agent);

  // Enable MCP tools during meetings so agents can look up Jira issues,
  // check statuses, and take real actions (not just talk about them)
  const meetingAllowedTools = config.meetings?.allowedTools;
  if (meetingAllowedTools && meetingAllowedTools.length > 0) {
    args.push("--allowedTools", ...meetingAllowedTools);
  }

  // Per-product plugin directory for meetings — use productId first, fall back to workingDir
  const meetingProduct = meeting.productId
    ? products.get(meeting.productId)
    : resolveProduct(meeting.workingDir);
  applyProductPluginDir(args, meetingProduct);

  const cliCmd = config.claude?.command || "claude";

  return new Promise((resolve) => {
    const proc = spawn(cliCmd, args, {
      cwd: meeting.workingDir,
      env: { ...process.env, ...getOAuthEnvVars() },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    // Send prompt via stdin
    proc.stdin.write(prompt);
    proc.stdin.end();

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ agent, content: "(timed out)", error: true });
    }, 180_000); // 3 min timeout — longer to allow tool calls

    proc.on("close", (code) => {
      clearTimeout(timeout);
      meeting.currentSpeaker = null;

      // Extract assistant text from stream-json events
      let content = "";
      const textParts = [];
      const lines = stdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (event.type === "assistant" && event.message) {
            for (const block of (event.message.content || [])) {
              if (block.type === "text" && block.text) {
                textParts.push(block.text);
              }
            }
          } else if (event.type === "result" && event.result) {
            // Fallback: use result field if it has content
            if (!textParts.length) textParts.push(event.result);
          }
        } catch { /* skip non-JSON lines */ }
      }
      content = textParts.join("").trim() || stderr.trim() || "(no response)";

      // Truncate for Telegram (4096 limit minus overhead)
      if (content.length > 3500) {
        content = content.substring(0, 3490) + "\n...(truncated)";
      }

      // Add to transcript
      meeting.transcript.push({
        role: "agent",
        agent,
        name: agent,
        content,
        timestamp: nowIso(),
      });
    

      resolve({ agent, content, error: code !== 0 });
    });
  });
}

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

/**
 * Load pipeline definitions from config
 */
function loadPipelineDefinitions() {
  const configPath = path.join(__dirname, "config.json");
  try {
    const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return fileConfig.pipelines || {};
  } catch {
    return {};
  }
}

/**
 * Evaluate a phase condition string against runtime context.
 * The condition is a simple expression evaluated with the pipeline's labels array.
 * e.g. "labels.includes('needs-ui') || labels.includes('needs-ux-design')"
 */
function evaluatePhaseCondition(condition, labels) {
  if (!condition) return true;
  try {
    // Safe eval: only allow access to `labels`
    const fn = new Function("labels", `return !!(${condition});`);
    return fn(Array.isArray(labels) ? labels : []);
  } catch {
    return true; // If condition can't be evaluated, don't skip phase
  }
}

/**
 * Parse [PIPELINE-PHASES] block from planner output.
 * Expected format:
 *   [PIPELINE-PHASES]
 *   - requirements: local
 *   - implementation: sonnet
 *   - qa: local
 *   [/PIPELINE-PHASES]
 * Returns Map of phaseName → modelTier (or null if no model override).
 */
function parsePlannerPhases(output) {
  if (!output) return null;
  const match = output.match(/\[PIPELINE-PHASES\]([\s\S]*?)\[\/PIPELINE-PHASES\]/);
  if (!match) return null;

  const phases = new Map();
  const lines = match[1].trim().split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*-\s*(\S+)(?:\s*:\s*(\S+))?/);
    if (m) {
      phases.set(m[1].toLowerCase(), m[2]?.toLowerCase() || null);
    }
  }
  return phases.size > 0 ? phases : null;
}

/**
 * Apply dynamic phase gating after a planner/triage phase completes.
 * Reads the planner's output for [PIPELINE-PHASES] and skips phases not listed.
 * Always keeps 'triage', 'implementation', 'code-review', and 'verify' as mandatory (planner can't skip those).
 */
function applyDynamicPhaseGating(pipeline, phase, job) {
  const output = (typeof job.parsedOutput === "string" ? job.parsedOutput : job.parsedOutput?.result) || "";
  const selectedPhases = parsePlannerPhases(output);

  if (!selectedPhases) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} dynamic gating: no [PIPELINE-PHASES] block found — running all phases`);
    return;
  }

  // Mandatory phases that can never be skipped
  const mandatory = new Set(["triage", "implementation", "code-review", "verify"]);

  let skipped = 0;
  let retained = 0;
  for (const p of pipeline.phases) {
    if (p.status !== "pending") continue; // Already completed/skipped/running
    if (mandatory.has(p.name)) { retained++; continue; }

    if (selectedPhases.has(p.name)) {
      // Planner wants this phase — optionally override model tier
      const modelOverride = selectedPhases.get(p.name);
      if (modelOverride && ["opus", "sonnet", "haiku"].includes(modelOverride)) {
        p.model = modelOverride;
      }
      retained++;
    } else {
      // Planner didn't select this phase — skip it
      p.status = "skipped";
      p.completedAt = nowIso();
      skipped++;
    }
  }


  console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} dynamic gating applied: ${retained} phases retained, ${skipped} skipped. Selected: [${[...selectedPhases.keys()].join(", ")}]`);

  jobEmitter.emit("pipeline:dynamic-gating", {
    pipelineId: pipeline.pipelineId,
    issueKey: pipeline.issueKey,
    selectedPhases: [...selectedPhases.entries()],
    skipped,
    retained,
  });
}

/**
 * ============================================================
 * WORKTREE ISOLATION
 * Creates isolated git worktrees for pipeline jobs so concurrent
 * pipelines don't contaminate each other's branches.
 * ============================================================
 */

function resolveWorktreeBaseDir() {
  const dir = config.worktrees?.baseDir || "~/certpilot-worktrees";
  return dir.replace(/^~/, os.homedir());
}

/**
 * Create a git worktree for an issue. Reuses if already exists.
 * Returns the worktree directory path.
 */
function createWorktree(baseRepo, issueKey, branchName) {
  const { execSync } = require("child_process");
  const baseDir = resolveWorktreeBaseDir();
  const worktreeDir = path.join(baseDir, issueKey);

  // Reuse existing worktree
  if (fs.existsSync(worktreeDir)) {
    const existing = Array.from(worktrees.values()).find(w => w.issueKey === issueKey && w.status === "active");
    if (existing) {
      console.log(`[${nowIso()}] Reusing existing worktree for ${issueKey}: ${worktreeDir}`);
      return { id: existing.id, path: worktreeDir };
    }
  }

  // Ensure base dir exists
  fs.mkdirSync(baseDir, { recursive: true });

  // Ensure base repo is on default branch
  try {
    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: baseRepo, encoding: "utf8" }).trim();
    if (currentBranch !== "main") {
      execSync("git checkout main", { cwd: baseRepo, encoding: "utf8", timeout: 10000 });
    }
  } catch (e) {
    console.log(`[${nowIso()}] Worktree: could not reset base repo to main: ${e.message}`);
  }

  // Create worktree with new branch
  try {
    execSync(`git worktree add "${worktreeDir}" -b "${branchName}"`, { cwd: baseRepo, encoding: "utf8", timeout: 30000 });
  } catch (e) {
    // Branch may already exist — try adding worktree on existing branch
    if (e.message.includes("already exists")) {
      try {
        execSync(`git worktree add "${worktreeDir}" "${branchName}"`, { cwd: baseRepo, encoding: "utf8", timeout: 30000 });
      } catch (e2) {
        throw new Error(`Failed to create worktree: ${e2.message}`);
      }
    } else {
      throw new Error(`Failed to create worktree: ${e.message}`);
    }
  }

  // Symlink agent memory so all worktrees share memory files
  const memSrc = path.join(baseRepo, ".claude", "agent-memory");
  const memDst = path.join(worktreeDir, ".claude", "agent-memory");
  if (fs.existsSync(memSrc) && !fs.existsSync(memDst)) {
    fs.mkdirSync(path.join(worktreeDir, ".claude"), { recursive: true });
    try {
      fs.symlinkSync(memSrc, memDst);
    } catch (e) {
      console.log(`[${nowIso()}] Worktree: memory symlink warning: ${e.message}`);
    }
  }

  // Track worktree
  const id = `wt_${crypto.randomBytes(4).toString("hex")}`;
  const record = {
    id,
    issueKey,
    branch: branchName,
    path: worktreeDir,
    baseRepo,
    pipelineId: null,
    status: "active",
    createdAt: nowIso(),
    lastJobId: null,
    lastJobAgent: null,
    prUrl: null,
  };
  worktrees.set(id, record);
  db.worktrees.set(record).catch(e => console.error('[db] worktree persist failed: ' + e.message));


  jobEmitter.emit("worktree:created", { id, issueKey, branch: branchName, path: worktreeDir });
  console.log(`[${nowIso()}] Worktree created: ${id} issue=${issueKey} branch=${branchName} path=${worktreeDir}`);

  return { id, path: worktreeDir };
}

/**
 * Run product-specific post-create setup commands inside a fresh worktree.
 *
 * Drives off `product.worktreeSetup.commands` (array of strings); falls back to
 * detecting `package.json` (runs `<pm> install --frozen-lockfile`) and
 * `prisma/schema.prisma` (runs `<pm> exec prisma generate`).
 *
 * Failures are logged but do NOT throw — the implementer agent can still attempt
 * the work and surface a clearer error than a silent missing-types failure.
 */
function setupWorktree(worktreeDir, baseRepo) {
  const { execSync } = require("child_process");
  const product = resolveProduct(baseRepo);
  const pm = product?.techStack?.packageManager || "pnpm";

  let commands = product?.worktreeSetup?.commands;
  if (!Array.isArray(commands) || commands.length === 0) {
    commands = [];
    if (fs.existsSync(path.join(worktreeDir, "package.json"))) {
      const lockArg = pm === "pnpm" ? "--frozen-lockfile" : (pm === "yarn" ? "--frozen-lockfile" : "--ci");
      commands.push(`${pm} install ${lockArg}`);
    }
    // Detect Prisma anywhere in the worktree (monorepo packages/* common in EOS/CER)
    const hasPrisma = (() => {
      try {
        if (fs.existsSync(path.join(worktreeDir, "prisma", "schema.prisma"))) return true;
        const pkgs = path.join(worktreeDir, "packages");
        if (fs.existsSync(pkgs)) {
          for (const sub of fs.readdirSync(pkgs)) {
            if (fs.existsSync(path.join(pkgs, sub, "prisma", "schema.prisma"))) return true;
          }
        }
      } catch { /* ignore */ }
      return false;
    })();
    if (hasPrisma) commands.push(`${pm} exec prisma generate`);
  }

  if (commands.length === 0) {
    console.log(`[${nowIso()}] Worktree setup: nothing to do for ${worktreeDir}`);
    return { ok: true, ran: [] };
  }

  const ran = [];
  for (const cmd of commands) {
    console.log(`[${nowIso()}] Worktree setup: running '${cmd}' in ${worktreeDir}`);
    try {
      execSync(cmd, { cwd: worktreeDir, encoding: "utf8", timeout: 10 * 60 * 1000, stdio: "pipe" });
      ran.push({ cmd, ok: true });
    } catch (e) {
      console.error(`[${nowIso()}] Worktree setup: '${cmd}' failed: ${e.message?.slice(0, 500)}`);
      ran.push({ cmd, ok: false, error: e.message?.slice(0, 500) });
      // Continue — partial setup is still better than none.
    }
  }
  return { ok: ran.every(r => r.ok), ran };
}

/**
 * Remove a worktree by issue key.
 */
function removeWorktree(issueKey) {
  const { execSync } = require("child_process");
  const record = Array.from(worktrees.values()).find(w => w.issueKey === issueKey);
  if (!record) throw new Error(`No worktree found for ${issueKey}`);

  // Remove symlinks before removal
  const memLink = path.join(record.path, ".claude", "agent-memory");
  try {
    if (fs.lstatSync(memLink).isSymbolicLink()) fs.unlinkSync(memLink);
  } catch { /* ignore */ }

  // Remove worktree directory
  if (fs.existsSync(record.path)) {
    try {
      execSync(`git worktree remove "${record.path}" --force`, { cwd: record.baseRepo, encoding: "utf8", timeout: 15000, stdio: "pipe" });
    } catch (e) {
      console.log(`[${nowIso()}] Worktree remove warning: ${e.message}`);
      // Fallback: remove directory manually
      fs.rmSync(record.path, { recursive: true, force: true });
    }
  }
  // Prune stale worktree references from git
  try {
    execSync("git worktree prune", { cwd: record.baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" });
  } catch { /* ignore */ }
  // Clean up the branch
  if (record.branch) {
    try {
      execSync(`git branch -D ${record.branch}`, { cwd: record.baseRepo, encoding: "utf8", timeout: 5000, stdio: "pipe" });
    } catch { /* branch may already be deleted or merged */ }
  }

  worktrees.delete(record.id);
  db.worktrees.delete(record.id).catch(e => console.error('[db] worktree delete failed: ' + e.message));


  jobEmitter.emit("worktree:deleted", { id: record.id, issueKey });
  console.log(`[${nowIso()}] Worktree removed: ${record.id} issue=${issueKey}`);
}

/**
 * List worktrees with live git stats.
 */
function listWorktreesWithStats() {
  const { execSync } = require("child_process");
  const results = [];
  for (const [, wt] of worktrees) {
    let commits = 0, filesChanged = 0;
    try {
      execSync(`git rev-parse --verify ${wt.branch}`, { cwd: wt.baseRepo, encoding: "utf8", stdio: "pipe", timeout: 5000 });
      commits = parseInt(execSync(`git rev-list main..${wt.branch} --count`, { cwd: wt.baseRepo, encoding: "utf8", stdio: "pipe" }).trim()) || 0;
      const diffOutput = execSync(`git diff main..${wt.branch} --name-only`, { cwd: wt.baseRepo, encoding: "utf8", stdio: "pipe" }).trim();
      filesChanged = diffOutput ? diffOutput.split("\n").filter(Boolean).length : 0;
    } catch { /* worktree may be stale or branch deleted */ }
    results.push({ ...wt, commits, filesChanged });
  }
  return results;
}

/**
 * Prune stale git worktrees and reconcile tracking Map.
 */
function pruneWorktrees(baseRepo) {
  const { execSync } = require("child_process");
  try {
    execSync("git worktree prune", { cwd: baseRepo, encoding: "utf8", timeout: 10000 });
  } catch (e) {
    console.log(`[${nowIso()}] Worktree prune warning: ${e.message}`);
  }

  // Reconcile: remove tracked worktrees whose directories no longer exist
  const staleIds = [];
  for (const [id, wt] of worktrees) {
    if (!fs.existsSync(wt.path)) {
      staleIds.push(id);
    }
  }
  for (const id of staleIds) {
    const wt = worktrees.get(id);
    console.log(`[${nowIso()}] Worktree pruned (dir gone): ${id} (${wt.issueKey})`);
    // Clean up branch reference if it exists
    try {
      execSync(`git branch -D ${wt.branch}`, { cwd: wt.baseRepo, encoding: "utf8", timeout: 5000, stdio: "pipe" });
    } catch { /* branch may already be deleted or merged */ }
    worktrees.delete(id);
    db.worktrees.delete(id).catch(e => console.error('[db] worktree delete failed: ' + e.message));
  }
  // stale worktrees already removed from DB above
}

/**
 * Resolve the integration ("dev") branch for a base repo from product config.
 * Defaults to "dev". A product can override via `product.json -> mergeBranch`.
 */
function resolveMergeBranch(baseRepo) {
  const product = resolveProduct(baseRepo);
  return (product && typeof product.mergeBranch === "string" && product.mergeBranch.trim())
    ? product.mergeBranch.trim()
    : "dev";
}

/**
 * Resolve the git remote name for a base repo.
 * Order:
 *  1. `product.json -> remoteName` if set (e.g. estateos uses remote "estateos", not "origin")
 *  2. The repo's actual remotes — prefer "origin", else first listed
 *  3. Falls back to "origin" if detection fails
 * Cached per baseRepo for the process lifetime.
 */
const _remoteNameCache = new Map();
function resolveRemoteName(baseRepo) {
  if (!baseRepo) return "origin";
  if (_remoteNameCache.has(baseRepo)) return _remoteNameCache.get(baseRepo);

  const product = resolveProduct(baseRepo);
  if (product && typeof product.remoteName === "string" && product.remoteName.trim()) {
    const name = product.remoteName.trim();
    _remoteNameCache.set(baseRepo, name);
    return name;
  }

  const { execSync } = require("child_process");
  let name = "origin";
  try {
    const out = execSync("git remote", { cwd: baseRepo, encoding: "utf8", timeout: 5000, stdio: "pipe" }).trim();
    const remotes = out.split("\n").map(s => s.trim()).filter(Boolean);
    if (remotes.length > 0) {
      name = remotes.includes("origin") ? "origin" : remotes[0];
    }
  } catch (e) {
    console.warn(`[${nowIso()}] resolveRemoteName: detection failed for ${baseRepo}, falling back to "origin": ${e.message}`);
  }
  _remoteNameCache.set(baseRepo, name);
  return name;
}

/**
 * Ensure the integration branch exists locally and on origin.
 * If origin/<mergeBranch> is missing, create it from origin/main and push.
 * Idempotent: safe to call on every merge.
 */
function ensureIntegrationBranch(baseRepo, mergeBranch) {
  const { execSync } = require("child_process");
  const remote = resolveRemoteName(baseRepo);
  try {
    execSync(`git fetch ${remote} --prune`, { cwd: baseRepo, encoding: "utf8", timeout: 60000, stdio: "pipe" });
  } catch (e) {
    console.warn(`[${nowIso()}] ensureIntegrationBranch: fetch failed for ${baseRepo}: ${e.message}`);
  }

  let remoteHasIt = false;
  try {
    const out = execSync(`git ls-remote --heads ${remote} ${mergeBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 15000, stdio: "pipe" }).trim();
    remoteHasIt = !!out;
  } catch { /* assume not */ }

  if (!remoteHasIt) {
    console.log(`[${nowIso()}] Bootstrapping integration branch '${mergeBranch}' from ${remote}/main in ${baseRepo}`);
    try {
      // Create local branch from <remote>/main if missing
      try { execSync(`git rev-parse --verify ${mergeBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 5000, stdio: "pipe" }); }
      catch {
        execSync(`git branch ${mergeBranch} ${remote}/main`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" });
      }
      execSync(`git push -u ${remote} ${mergeBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 60000, stdio: "pipe" });
    } catch (e) {
      throw new Error(`ensureIntegrationBranch failed to bootstrap '${mergeBranch}': ${e.message}`);
    }
  } else {
    // Remote has it — ensure local tracking exists
    try {
      execSync(`git rev-parse --verify ${mergeBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 5000, stdio: "pipe" });
    } catch {
      try {
        execSync(`git branch --track ${mergeBranch} ${remote}/${mergeBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" });
      } catch (e) {
        console.warn(`[${nowIso()}] ensureIntegrationBranch: local track create warned: ${e.message}`);
      }
    }
  }
}

/**
 * Merge a feature branch into the integration ("dev") branch via a temp worktree
 * checked out to dev (refs are shared across worktrees, so feature branches are
 * visible). Fast-forward by default, falls back to --no-ff if dev has diverged.
 * On success: pushes dev, deletes the feature branch locally + on origin.
 *
 * Returns { branch, mergeBranch, devSha, mode } where mode is "ff" or "no-ff".
 * Throws on conflict (with .conflictContext) or other failure.
 */
function mergeBranchIntoDev(baseRepo, featureBranch, issueKey) {
  const { execSync } = require("child_process");
  if (!baseRepo || !featureBranch) throw new Error("mergeBranchIntoDev: baseRepo and featureBranch required");

  const mergeBranch = resolveMergeBranch(baseRepo);
  const remote = resolveRemoteName(baseRepo);
  ensureIntegrationBranch(baseRepo, mergeBranch);

  // Push the feature branch first so the merge result has a remote audit trail
  // and so failure-path safety is preserved even if the merge itself fails.
  try {
    execSync(`git push -u ${remote} ${featureBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 60000, stdio: "pipe" });
  } catch (e) {
    console.warn(`[${nowIso()}] mergeBranchIntoDev: feature-branch push failed (continuing to merge): ${e.message}`);
  }

  // Verify there is something to merge (branch ahead of mergeBranch)
  let ahead = 0;
  try {
    ahead = parseInt(execSync(`git rev-list ${mergeBranch}..${featureBranch} --count`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" }).trim()) || 0;
  } catch {
    try {
      ahead = parseInt(execSync(`git rev-list ${remote}/${mergeBranch}..${featureBranch} --count`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" }).trim()) || 0;
    } catch {}
  }
  if (ahead === 0) {
    console.log(`[${nowIso()}] mergeBranchIntoDev: ${featureBranch} has 0 commits ahead of ${mergeBranch}, skipping`);
    return null;
  }

  // git refuses to check out a branch that's already checked out in another
  // worktree. Detect that case and merge in-place there instead of trying to
  // add a fresh worktree (which would fail with "fatal: '<branch>' is already
  // checked out at ..."). The base repo itself counts as a worktree.
  let existingWorktree = null;
  try {
    const wt = execSync("git worktree list --porcelain", { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" });
    let cur = {};
    for (const line of wt.split("\n")) {
      if (line.startsWith("worktree ")) cur = { path: line.slice(9).trim() };
      else if (line.startsWith("branch ")) cur.branch = line.slice(7).trim();
      else if (line === "" && cur.path) {
        if (cur.branch === `refs/heads/${mergeBranch}`) { existingWorktree = cur.path; break; }
        cur = {};
      }
    }
  } catch (e) {
    console.warn(`[${nowIso()}] mergeBranchIntoDev: worktree list failed (continuing): ${e.message}`);
  }

  const os = require("os");
  const reuseWorktree = !!existingWorktree;
  const tmpWorktree = reuseWorktree ? existingWorktree : path.join(os.tmpdir(), `merge-${issueKey || featureBranch}-${Date.now()}`);
  console.log(`[${nowIso()}] mergeBranchIntoDev: ${reuseWorktree ? "reusing existing" : "temp"} worktree at ${tmpWorktree} for ${featureBranch} -> ${mergeBranch}`);

  try {
    if (!reuseWorktree) {
      execSync(`git worktree add "${tmpWorktree}" ${mergeBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 30000, stdio: "pipe" });
    } else {
      // Existing worktree must have no tracked changes; merging would fail mid-merge.
      // Untracked files (??) are fine — git merge refuses on its own only if they'd be
      // overwritten, and pipeline artifacts (CTX-*.md, REPORT-*.md) routinely sit here.
      const status = execSync("git status --porcelain", { cwd: tmpWorktree, encoding: "utf8", timeout: 10000, stdio: "pipe" });
      const trackedDirty = status.split("\n").filter(l => l && !l.startsWith("??")).join("\n").trim();
      if (trackedDirty) {
        throw new Error(`mergeBranchIntoDev: ${tmpWorktree} (on ${mergeBranch}) has uncommitted tracked changes — refusing to merge into dirty tree:\n${trackedDirty}`);
      }
    }
    try {
      execSync(`git pull --ff-only ${remote} ${mergeBranch}`, { cwd: tmpWorktree, encoding: "utf8", timeout: 60000, stdio: "pipe" });
    } catch (e) {
      console.warn(`[${nowIso()}] mergeBranchIntoDev: ff-only pull of ${mergeBranch} failed: ${e.message}`);
    }

    let mode = "ff";
    try {
      execSync(`git merge --ff-only ${featureBranch}`, { cwd: tmpWorktree, encoding: "utf8", timeout: 30000, stdio: "pipe" });
    } catch (ffErr) {
      // Fallback to --no-ff so a merge commit captures the integration point
      mode = "no-ff";
      try {
        execSync(
          `git merge ${featureBranch} --no-ff -m "Merge ${featureBranch} into ${mergeBranch}${issueKey ? ` (${issueKey})` : ""}"`,
          {
            cwd: tmpWorktree, encoding: "utf8", timeout: 30000, stdio: "pipe",
            env: { ...process.env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "CertPilot Runner", GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "runner@local.invalid", GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || process.env.GIT_AUTHOR_NAME || "CertPilot Runner", GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || process.env.GIT_AUTHOR_EMAIL || "runner@local.invalid" }
          }
        );
      } catch (mergeErr) {
        try { execSync("git merge --abort", { cwd: tmpWorktree, encoding: "utf8", timeout: 5000, stdio: "pipe" }); } catch {}

        let devLog = "", branchLog = "", diffStat = "";
        try {
          devLog = execSync(`git log ${featureBranch}..${mergeBranch} --oneline -20`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" }).trim();
          branchLog = execSync(`git log ${mergeBranch}..${featureBranch} --oneline -20`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" }).trim();
          diffStat = execSync(`git diff ${mergeBranch}...${featureBranch} --stat`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" }).trim();
        } catch {}

        const err = new Error(`MERGE_CONFLICT:${featureBranch}`);
        err.conflictContext = { branchName: featureBranch, mergeBranch, mainLog: devLog, branchLog, diffStat, issueKey };
        throw err;
      }
    }

    // Push the integration branch
    execSync(`git push ${remote} ${mergeBranch}`, { cwd: tmpWorktree, encoding: "utf8", timeout: 60000, stdio: "pipe" });
    const devSha = execSync(`git rev-parse HEAD`, { cwd: tmpWorktree, encoding: "utf8", timeout: 5000, stdio: "pipe" }).trim();
    console.log(`[${nowIso()}] mergeBranchIntoDev: pushed ${mergeBranch}@${devSha.slice(0,8)} (${mode})`);

    // Delete the feature branch on the remote (best-effort)
    try {
      execSync(`git push ${remote} --delete ${featureBranch}`, { cwd: baseRepo, encoding: "utf8", timeout: 30000, stdio: "pipe" });
    } catch (e) {
      console.warn(`[${nowIso()}] mergeBranchIntoDev: remote branch delete warning for ${featureBranch}: ${e.message}`);
    }

    jobEmitter.emit("pipeline:auto-merged", {
      pipelineId: null, issueKey, branch: featureBranch, mergeBranch, devSha, mode,
    });

    if (issueKey) {
      const comment = [
        `[AUTO-MERGED-TO-DEV] Branch \`${featureBranch}\` merged into \`${mergeBranch}\` (${mode}) at ${devSha.slice(0, 8)}.`,
        ``,
        `Open a PR \`${mergeBranch}\` -> \`main\` when ready to deploy. The feature branch has been deleted locally and on ${remote}.`,
      ].join("\n");
      Promise.resolve().then(() => issueTracker.addComment(issueKey, comment, "runner")).catch(e => {
        console.warn(`[${nowIso()}] mergeBranchIntoDev: Jira comment failed for ${issueKey}: ${e.message}`);
      });
    }
    return { branch: featureBranch, mergeBranch, devSha, mode };
  } finally {
    if (!reuseWorktree) {
      try {
        execSync(`git worktree remove "${tmpWorktree}" --force`, { cwd: baseRepo, encoding: "utf8", timeout: 15000, stdio: "pipe" });
      } catch (e) {
        console.warn(`[${nowIso()}] mergeBranchIntoDev: temp worktree cleanup warning: ${e.message}`);
        try { fs.rmSync(tmpWorktree, { recursive: true, force: true }); } catch {}
        try { execSync(`git worktree prune`, { cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: "pipe" }); } catch {}
      }
    }
  }
}

/**
 * Merge a worktree branch into the integration ("dev") branch and reap the worktree.
 * Synchronous: by the time this returns, dev has been pushed and the local feature
 * branch + worktree have been removed.
 * Returns { branch, mergeBranch, devSha, mode }.
 */
function mergeWorktree(issueKey) {
  const record = Array.from(worktrees.values()).find(w => w.issueKey === issueKey);
  if (!record) throw new Error(`No worktree found for ${issueKey}`);
  if (!record.baseRepo || !record.branch) throw new Error(`Worktree ${record.id} has no baseRepo/branch`);

  const result = mergeBranchIntoDev(record.baseRepo, record.branch, issueKey);
  if (!result) throw new Error(`No commits to merge for ${issueKey}`);

  record.status = "merged";
  record.mergedTo = result.mergeBranch;
  record.mergedSha = result.devSha;
  db.worktrees.set(record).catch(e => console.error('[db] worktree update failed: ' + e.message));

  jobEmitter.emit("worktree:merged", {
    id: record.id, issueKey, branch: record.branch, mergeBranch: result.mergeBranch, devSha: result.devSha,
  });

  // Reap the worktree synchronously now that the branch is on dev
  try {
    removeWorktree(issueKey);
  } catch (e) {
    console.warn(`[${nowIso()}] mergeWorktree: post-merge worktree removal warning for ${issueKey}: ${e.message}`);
  }

  return result;
}

/**
 * Preserve dirty workingDir state by stashing onto a safety branch and pushing.
 * Called at pipeline creation so the user's in-progress work is never overwritten.
 * Returns { stashedBranch, fileCount } when work was preserved, or null when clean.
 */
function stashDirtyWorkingDir(workingDir, issueKey) {
  const { execSync } = require("child_process");
  if (!workingDir) return null;
  let status = "";
  try {
    status = execSync("git status --porcelain", { cwd: workingDir, encoding: "utf8", timeout: 10000, stdio: "pipe" }).trim();
  } catch (e) {
    console.warn(`[${nowIso()}] stashDirtyWorkingDir: status check failed for ${workingDir}: ${e.message}`);
    return null;
  }
  if (!status) return null;

  const fileCount = status.split("\n").filter(Boolean).length;
  const ts = new Date().toISOString().replace(/[-:]/g, "").split(".")[0]; // 20260426T091500
  const stashedBranch = `safety/main-wip-${ts}`;
  console.log(`[${nowIso()}] Stashing ${fileCount} dirty file(s) in ${workingDir} to ${stashedBranch} before pipeline ${issueKey || ''}`);

  try {
    // Determine current branch (typically main); we'll come back to it
    const currentBranch = execSync("git branch --show-current", { cwd: workingDir, encoding: "utf8", timeout: 5000, stdio: "pipe" }).trim() || "main";
    execSync(`git checkout -b ${stashedBranch}`, { cwd: workingDir, encoding: "utf8", timeout: 10000, stdio: "pipe" });
    execSync("git add -A", { cwd: workingDir, encoding: "utf8", timeout: 30000, stdio: "pipe" });
    execSync(
      `git commit -m "safety: in-progress WIP stashed before pipeline${issueKey ? ` ${issueKey}` : ''}\n\nAuto-stashed by CertPilot Runner. Review and merge or discard."`,
      {
        cwd: workingDir, encoding: "utf8", timeout: 30000, stdio: "pipe",
        env: { ...process.env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "CertPilot Runner", GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "runner@local.invalid", GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || process.env.GIT_AUTHOR_NAME || "CertPilot Runner", GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || process.env.GIT_AUTHOR_EMAIL || "runner@local.invalid" }
      }
    );
    try {
      const remote = resolveRemoteName(workingDir);
      execSync(`git push -u ${remote} ${stashedBranch}`, { cwd: workingDir, encoding: "utf8", timeout: 60000, stdio: "pipe" });
      console.log(`[${nowIso()}] Pushed safety branch ${stashedBranch}`);
    } catch (pushErr) {
      console.warn(`[${nowIso()}] Safety branch push failed (kept locally): ${pushErr.message}`);
    }
    execSync(`git checkout ${currentBranch}`, { cwd: workingDir, encoding: "utf8", timeout: 10000, stdio: "pipe" });
    jobEmitter.emit("workingdir:safety-stashed", { workingDir, stashedBranch, fileCount, issueKey });
    return { stashedBranch, fileCount };
  } catch (e) {
    console.error(`[${nowIso()}] stashDirtyWorkingDir failed for ${workingDir}: ${e.message}`);
    return null;
  }
}

/**
 * Locate the pipeline's feature branch in the base repo and merge it into the
 * integration ("dev") branch via mergeBranchIntoDev. Used by the non-worktree path.
 * Returns { branch, mergeBranch, devSha, mode } or null when nothing to merge.
 */
function mergePipelineBranchIntoDev(pipeline) {
  const { execSync } = require("child_process");
  const baseRepo = pipeline.workingDir; // non-worktree: agents committed in workingDir
  if (!baseRepo) return null;
  const issueKey = pipeline.issueKey;
  if (!issueKey) return null;

  const candidateBranches = [
    pipeline.worktreeBranch,
    `${issueKey}-auto`,
    `${issueKey.toLowerCase()}-auto`,
    `feature/${issueKey}`,
    `fix/${issueKey}`,
    issueKey.toLowerCase(),
  ].filter(Boolean);

  let branchName = null;
  for (const candidate of candidateBranches) {
    try {
      execSync(`git rev-parse --verify ${candidate}`, { cwd: baseRepo, encoding: "utf8", timeout: 5000, stdio: "pipe" });
      branchName = candidate;
      break;
    } catch { /* try next */ }
  }
  if (!branchName) {
    console.log(`[${nowIso()}] mergePipelineBranchIntoDev: no matching branch found for ${issueKey} in ${baseRepo}`);
    return null;
  }

  return mergeBranchIntoDev(baseRepo, branchName, issueKey);
}

/**
 * On pipeline failure, preserve work by pushing the branch (no PR — just keep it on remote).
 * Posts an [AUTO-IMPLEMENT-FAILED] Jira comment with the branch name so a human can pick it up.
 */
/**
 * d3a: Detect "blocked on red base" — quality-gate failures whose failing
 * test files have zero overlap with the pipeline's diff. Heuristic:
 * if the implementer hasn't touched these files, they were red on dev
 * before the pipeline started. Halts fix-loop retry burn.
 *
 * Conservative: only consults `test` failures; needs ≥1 parsed failing
 * file path; needs a non-empty diff to compare against.
 */
function detectInheritedRedBase(pipeline, phase, job) {
  const { execSync } = require("child_process");
  const cwd = pipeline.worktreePath || pipeline.workingDir || job.workingDir;
  if (!cwd || !fs.existsSync(cwd)) return { inherited: false, reason: "no worktree" };

  const qgFailure = job.qualityGateFailure || {};
  if (qgFailure.failedCheck !== "test") return { inherited: false, reason: "not a test failure" };
  const output = qgFailure.failureOutput || job.error || "";
  if (!output) return { inherited: false, reason: "no output" };

  const failingFiles = new Set();
  const failRegex = /(?:^|\s)(?:FAIL|❯|×)\s+([\w./@-]+\.(?:test|spec)\.[tj]sx?)/g;
  let m;
  while ((m = failRegex.exec(output)) !== null) failingFiles.add(m[1]);
  if (failingFiles.size === 0) return { inherited: false, reason: "no failing files parsed" };

  let changedFiles = new Set();
  let basis = null;
  for (const ref of ["origin/dev", "origin/main"]) {
    try {
      const out = execSync(`git diff --name-only $(git merge-base HEAD ${ref})..HEAD`, {
        cwd, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"], shell: "/bin/bash"
      });
      out.split("\n").map(s => s.trim()).filter(Boolean).forEach(f => changedFiles.add(f));
      basis = ref;
      if (changedFiles.size > 0) break;
    } catch {}
  }
  if (changedFiles.size === 0) return { inherited: false, reason: "no diff resolvable" };

  for (const f of failingFiles) {
    if (changedFiles.has(f)) return { inherited: false, reason: `overlap: ${f}` };
  }
  return {
    inherited: true,
    failingFiles: Array.from(failingFiles),
    changedFiles: Array.from(changedFiles),
    basis,
  };
}

function preserveBranchOnFailure(pipeline, phase) {
  const { execSync } = require("child_process");
  const cwd = pipeline.worktreePath || pipeline.workingDir;
  if (!cwd || !pipeline.issueKey) return null;

  let branchName = pipeline.worktreeBranch || `${pipeline.issueKey}-auto`;
  try {
    execSync(`git rev-parse --verify ${branchName}`, { cwd, encoding: "utf8", timeout: 5000, stdio: "pipe" });
  } catch {
    // Fall back to current branch if the canonical one isn't there
    try {
      branchName = execSync("git branch --show-current", { cwd, encoding: "utf8", timeout: 5000, stdio: "pipe" }).trim();
    } catch { return null; }
    if (!branchName || branchName === "main") return null;
  }

  // Skip if no commits ahead of main
  let ahead = 0;
  try {
    ahead = parseInt(execSync(`git rev-list main..${branchName} --count`, { cwd, encoding: "utf8", timeout: 5000, stdio: "pipe" }).trim()) || 0;
  } catch {}
  if (ahead === 0) {
    console.log(`[${nowIso()}] No commits to preserve for failed pipeline ${pipeline.pipelineId}`);
    return null;
  }

  let pushedRemote = false;
  const remote = resolveRemoteName(cwd);
  try {
    execSync(`git push -u ${remote} ${branchName}`, { cwd, encoding: "utf8", timeout: 60000, stdio: "pipe" });
    pushedRemote = true;
    console.log(`[${nowIso()}] Preserved failed-pipeline branch ${branchName} to ${remote}`);
  } catch (e) {
    console.warn(`[${nowIso()}] Failed to push preservation branch ${branchName}: ${e.message}`);
  }

  // Best-effort Jira note (non-blocking)
  const jiraComment = [
    `[AUTO-IMPLEMENT-FAILED] Pipeline ${pipeline.pipelineId} failed at phase "${phase?.name || 'unknown'}".`,
    ``,
    `Branch ${pushedRemote ? `pushed to ${remote}` : 'kept locally'}: \`${branchName}\` (${ahead} commit${ahead === 1 ? '' : 's'} ahead of main).`,
    `Worktree retained for inspection: ${pipeline.worktreePath || '(no worktree)'}.`,
    `Error: ${pipeline.error || phase?.error || 'unknown'}`,
    ``,
    `No PR was opened. A human can review the branch and either complete it or discard it.`,
  ].join("\n");
  Promise.resolve().then(() => issueTracker.addComment(pipeline.issueKey, jiraComment, "runner")).catch(e => {
    console.warn(`[${nowIso()}] preserveBranchOnFailure: Jira comment failed: ${e.message}`);
  });

  jobEmitter.emit("pipeline:branch-preserved", {
    pipelineId: pipeline.pipelineId, issueKey: pipeline.issueKey, branch: branchName, pushedRemote, ahead,
  });
  return { branch: branchName, pushedRemote, ahead };
}

/**
 * Periodic reconciler: reap stale worktree records.
 * Two-condition reaping: (a) the local worktree directory is missing, OR
 * (b) the feature branch's LOCAL ref is gone (someone deleted the branch).
 *
 * NOTE: We deliberately do NOT check the remote ref here. Fresh pipelines run
 * for many minutes on a local-only branch before any push happens (EOS-621
 * never pushed at all). Treating remote-absence as "gone" reaped active
 * worktrees mid-pipeline, which then broke the final merge step with
 * "No worktree found" (see EOS-598/EOS-621 incident, 2026-04-26).
 */
function reconcileMergedWorktrees() {
  const { execSync } = require("child_process");
  for (const [, wt] of Array.from(worktrees.entries())) {
    if (!wt || !wt.path || !wt.branch || !wt.baseRepo) continue;
    if (wt.status === "merged" || wt.status === "deleted") {
      // Already-merged record: directory was reaped synchronously, drop the row
      try {
        worktrees.delete(wt.id);
        db.worktrees.delete(wt.id).catch(e => console.error('[db] worktree delete failed: ' + e.message));
      } catch {}
      continue;
    }

    const dirGone = !fs.existsSync(wt.path);
    let branchGone = false;
    try {
      execSync(`git show-ref --verify --quiet refs/heads/${wt.branch}`, { cwd: wt.baseRepo, timeout: 15000, stdio: "pipe" });
      // exit 0 → local branch ref exists → branch is alive
    } catch (e) {
      // Non-zero exit means the local branch ref is missing.
      // Distinguish "missing" (exit 1) from "I/O or timeout error" — only treat the former as gone.
      if (e && (e.status === 1 || e.code === 1)) branchGone = true;
    }

    if (!dirGone && !branchGone) continue;

    try {
      console.log(`[${nowIso()}] Reconciler: reaping worktree for ${wt.issueKey} (dirGone=${dirGone}, branchGone=${branchGone})`);
      removeWorktree(wt.issueKey);
    } catch (e) {
      console.warn(`[${nowIso()}] Reconciler: removeWorktree failed for ${wt.issueKey}: ${e.message}`);
      // Drop the record anyway so it doesn't pile up
      try {
        worktrees.delete(wt.id);
        db.worktrees.delete(wt.id).catch(err => console.error('[db] worktree delete failed: ' + err.message));
      } catch {}
    }
  }
}

/**
 * Create and start a pipeline for an issue.
 * Returns the pipeline record immediately; execution happens asynchronously.
 */
async function createPipeline(issueKey, pipelineType, options = {}) {
  const definitions = loadPipelineDefinitions();
  const def = definitions[pipelineType];
  if (!def) {
    throw new Error(`Unknown pipeline type: ${pipelineType}`);
  }

  // Reject duplicate: if an active pipeline already exists for this issue, don't create another
  for (const existing of pipelines.values()) {
    if (existing.issueKey === String(issueKey) && !["completed", "failed"].includes(existing.status)) {
      throw new Error(`Pipeline ${existing.pipelineId} already active for ${issueKey} (status: ${existing.status})`);
    }
  }

  // Pre-flight: if the workingDir has uncommitted changes, push them to a safety branch
  // so the user's in-progress work is preserved before the pipeline (or worktree creation)
  // potentially disturbs it. Skipping this check on subtask pipelines whose parent already
  // has a worktree, since they'll share that worktree and never touch the base repo.
  const targetWorkingDir = options.workingDir || DEFAULT_WORKING_DIR;
  const parentHasActiveWorktree = options.parentKey && Array.from(worktrees.values())
    .some(w => w.issueKey === options.parentKey && w.status === "active");
  if (!parentHasActiveWorktree) {
    try {
      const stashResult = stashDirtyWorkingDir(targetWorkingDir, issueKey);
      if (stashResult) {
        console.log(`[${nowIso()}] Pre-flight stash: ${stashResult.fileCount} file(s) preserved on ${stashResult.stashedBranch} for ${issueKey}`);
      }
    } catch (e) {
      console.warn(`[${nowIso()}] Pre-flight stash failed for ${issueKey}: ${e.message} — proceeding anyway`);
    }
  }

  const pipelineId = `pipe_${crypto.randomBytes(4).toString("hex")}`;
  const labels = options.labels || [];

  // Check for agent:* label to override the implementation phase agent
  const agentLabelMap = config.agentLabels || {};
  const agentOverrideLabel = labels.find(l => agentLabelMap[l]);
  const agentOverride = agentOverrideLabel ? agentLabelMap[agentOverrideLabel] : null;

  // Build phases, marking optional ones that fail their condition as skipped
  const phases = def.phases.map((phaseDef, index) => {
    // Override implementation phase agent if subtask has an agent:* label
    let phaseAgent = phaseDef.agent;
    if (agentOverride && phaseDef.name === "implementation") {
      phaseAgent = agentOverride;
      console.log(`[${nowIso()}] Pipeline ${pipelineId}: overriding implementation agent ${phaseDef.agent} → ${agentOverride} (label: ${agentOverrideLabel})`);
    }
    const skip = phaseDef.optional && !evaluatePhaseCondition(phaseDef.condition, labels);
    return {
      index,
      name: phaseDef.name,
      agent: phaseAgent,
      model: phaseDef.model || null,
      team: phaseDef.team || false,
      worktree: phaseDef.worktree || false,
      dynamicGating: phaseDef.dynamicGating || false,
      optional: phaseDef.optional || false,
      condition: phaseDef.condition || null,
      gate: phaseDef.gate || null,
      contextExtract: phaseDef.contextExtract || null,
      status: skip ? "skipped" : "pending",
      jobId: null,
      startedAt: null,
      completedAt: null,
      error: null,
      gateResult: null,
      retryCount: 0,
      fixLoopAttempts: 0,
      fixLoopContext: null,
    };
  });

  const parentKey = options.parentKey || null;

  const pipeline = {
    pipelineId,
    issueKey: String(issueKey),
    parentKey,
    pipelineType,
    description: def.description || "",
    workingDir: options.workingDir || DEFAULT_WORKING_DIR,
    labels,
    callbackUrl: options.callbackUrl || N8N_CALLBACK_URL || null,
    slack: options.slack || null,
    telegram: options.telegram || null,
    requestedProvider: options.provider || null, // Optional provider override for all phases
    status: "running",
    currentPhase: 0,
    phases,
    contextBridgeFile: null,
    worktreePath: null,
    worktreeBranch: null,
    worktreeId: null,
    createdAt: nowIso(),
    startedAt: nowIso(),
    completedAt: null,
    error: null,
  };

  pipelines.set(pipelineId, pipeline);
  db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline persist failed: ' + e.message));


  jobEmitter.emit("pipeline:created", {
    pipelineId,
    issueKey,
    pipelineType,
    phases: phases.length,
    createdAt: pipeline.createdAt,
  });

  console.log(`[${nowIso()}] Pipeline ${pipelineId} created: type=${pipelineType} issueKey=${issueKey} phases=${phases.length}`);

  // Defer context bridge seeding until the worktree exists — writing to
  // pipeline.workingDir (base repo on dev) leaks CTX-*.md as untracked files
  // on the dev branch's working tree.
  if (options.initialContext) {
    pipeline.pendingInitialContext = {
      text: options.initialContext.substring(0, 2000),
      agent: options.initialContextAgent || "unknown",
    };
  }

  // Start the first non-skipped phase
  const firstActiveIndex = phases.findIndex(p => p.status === "pending");
  if (firstActiveIndex >= 0) {
    setImmediate(() => executePipelinePhase(pipeline, firstActiveIndex));
  } else {
    // All phases skipped (shouldn't happen but handle gracefully)
    pipeline.status = "completed";
    pipeline.completedAt = nowIso();
    db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));
  
    jobEmitter.emit("pipeline:completed", { pipelineId, issueKey, reason: "all phases skipped" });
  }

  return pipeline;
}

/**
 * Build the full prompt for a pipeline phase, prepending any existing
 * context bridge content so each agent knows what prior phases did.
 */
function buildPipelinePrompt(pipeline, phase, basePrompt) {
  const parts = [];

  // Prepend context bridge if it exists
  // For local models (smaller context windows), compress to compact word limit
  const isLocalAgent = shouldRunLocal({ agent: phase.agent });
  if (pipeline.contextBridgeFile && fs.existsSync(pipeline.contextBridgeFile)) {
    try {
      let bridgeContent = fs.readFileSync(pipeline.contextBridgeFile, "utf8");
      if (bridgeContent.trim()) {
        if (isLocalAgent) {
          // Compress for local models: strip raw excerpts and <details> blocks, enforce word limit
          const compactMax = config.contextBridge?.compactMaxWords || 120;
          bridgeContent = bridgeContent
            .replace(/<details>[\s\S]*?<\/details>/g, "")  // strip collapsed raw blocks
            .replace(/- \*\*Job\*\*:.*$/gm, "")            // strip job IDs (noise for local)
            .replace(/\n{3,}/g, "\n\n");                     // collapse whitespace
          const words = bridgeContent.split(/\s+/).filter(Boolean);
          if (words.length > compactMax) {
            bridgeContent = words.slice(0, compactMax).join(" ") + "\n\n(context truncated for local model)";
          }
          parts.push("## Prior Phase Context (compact)");
        } else {
          parts.push("## Prior Phase Context");
        }
        parts.push(bridgeContent.trim());
        parts.push("");
      }
    } catch {
      // Ignore read errors; agent proceeds without prior context
    }
  }

  // For local models, inject the extraction instruction so the agent focuses on what matters
  if (isLocalAgent) {
    const extractorConfig = config.contextBridge?.phaseExtractors?.[phase.name];
    if (extractorConfig?.instruction) {
      parts.push(`**Context output requirement**: ${extractorConfig.instruction}`);
      parts.push("");
    }
  }

  // Phase-specific instruction header
  parts.push(`## Pipeline Phase: ${phase.name}`);
  parts.push(`You are the ${phase.agent} agent running as phase "${phase.name}" in a ${pipeline.pipelineType} pipeline.`);
  parts.push(`Issue: ${pipeline.issueKey}`);
  parts.push(`Working directory: ${pipeline.workingDir}`);

  // Branch context: tell agents which branch they're reviewing/working on
  // After implementation, the branch stays checked out — QA and reviewers run on it
  if (pipeline.mergedBranch) {
    parts.push(`Branch: ${pipeline.mergedBranch} (already merged to main)`);
  } else {
    // Detect current branch from the working directory
    try {
      const branch = execSync("git branch --show-current", { cwd: pipeline.worktreePath || pipeline.workingDir, encoding: "utf8" }).trim();
      if (branch && branch !== "main" && branch !== "master") {
        parts.push(`Branch: ${branch} (NOT yet merged to main — merge happens only after QA passes)`);
        if (phase.name === "verify") {
          parts.push("You are reviewing code ON THE IMPLEMENTATION BRANCH. If you find issues, they will be fixed on this same branch and you will re-verify.");
        }
      }
    } catch { /* ignore — agent proceeds without branch info */ }
  }
  parts.push("");

  if (phase.gate) {
    if (phase.gate.type === "comment-prefix") {
      parts.push(`When done, post a Jira comment starting with: ${phase.gate.prefix}`);
    } else if (phase.gate.type === "quality-gate") {
      parts.push("Your implementation must pass the quality gate (type-check, lint, test).");
    } else if (phase.gate.type === "file-exists") {
      parts.push(`When done, ensure file exists: ${phase.gate.file}`);
    }
    parts.push("");
  }

  // Fix-loop: inject error context from previous failed attempt
  if (phase.fixLoopContext) {
    const ctx = phase.fixLoopContext;
    parts.push("## ⚠️ Fix-Loop: Previous Attempt Failed");
    const source = ctx.sourcePhase === "verify"
      ? `QA verification found issues. This is verify-fix-loop attempt ${ctx.attempt}. Fix the QA findings on this branch — do NOT create a new branch.`
      : `This is fix-loop attempt ${ctx.attempt}. Your previous implementation failed the quality gate.`;
    parts.push(source);
    parts.push("");
    if (ctx.failedCheck) parts.push(`**Failed check:** ${ctx.failedCheck}`);
    if (ctx.failedCommand) parts.push(`**Command:** ${ctx.failedCommand}`);
    if (ctx.failureOutput) {
      parts.push("");
      parts.push("**Error output:**");
      parts.push("```");
      parts.push(ctx.failureOutput);
      parts.push("```");
    }
    parts.push("");
    parts.push("You MUST fix these errors before proceeding. Read the error output carefully, identify the root cause, and apply a targeted fix. Do not rewrite from scratch — fix the specific issues.");
    parts.push("");
  }

  parts.push("## Your Task");
  parts.push(basePrompt);

  return parts.join("\n");
}

/**
 * Execute a single pipeline phase by creating a standard job.
 * The job is tagged with pipelineId and pipelinePhase for tracking.
 */
async function executePipelinePhase(pipeline, phaseIndex) {
  const phase = pipeline.phases[phaseIndex];
  if (!phase) return;

  // Skip phases marked as skipped
  if (phase.status === "skipped") {
    return advancePipeline(pipeline);
  }

  pipeline.currentPhase = phaseIndex;
  phase.status = "running";
  phase.startedAt = nowIso();

  // Dependency gating: before creating a worktree, verify all blockers' branches are merged to main
  if (phase.worktree && config.dependencyGating?.enabled && !pipeline.worktreePath) {
    const blockers = await getUnmergedBlockers(pipeline.issueKey, pipeline.workingDir);
    if (blockers.length > 0) {
      const blockerStr = blockers.map(b => `${b.key} (${b.detail})`).join(", ");
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} BLOCKED: waiting on ${blockerStr}`);

      phase.status = "blocked";
      phase.blockedBy = blockers;
      phase.blockedAt = nowIso();
      pipeline.status = "blocked";
    

      jobEmitter.emit("pipeline:blocked", {
        pipelineId: pipeline.pipelineId,
        issueKey: pipeline.issueKey,
        phase: phase.name,
        blockedBy: blockers,
      });
      return; // tickDependencyChecker will resume when blockers resolve
    }
  }

  // Worktree isolation: create worktree when first code-modifying phase runs
  // Subtasks share a worktree with their parent story so all changes land on one branch
  if (phase.worktree && config.worktrees?.enabled && !pipeline.worktreePath) {
    try {
      const worktreeKey = pipeline.parentKey || pipeline.issueKey;
      const branchName = `${worktreeKey}-auto`;
      const wt = createWorktree(pipeline.workingDir, worktreeKey, branchName);
      pipeline.worktreePath = wt.path;
      pipeline.worktreeBranch = branchName;
      pipeline.worktreeId = wt.id;
      // Link worktree to pipeline
      const wtRecord = worktrees.get(wt.id);
      if (wtRecord) wtRecord.pipelineId = pipeline.pipelineId;
      // Run product-specific install/generate so the implementer doesn't fail
      // on missing node_modules or ungenerated Prisma client (was #1 cause of
      // EOS pipelines stuck in fix-loop-forever on type-check).
      try {
        const setup = setupWorktree(wt.path, pipeline.workingDir);
        pipeline.worktreeSetup = setup;
      } catch (e) {
        console.error(`[${nowIso()}] Worktree setup error (non-fatal): ${e.message}`);
      }

      // Flush any deferred initial-context seed into the worktree.
      if (pipeline.pendingInitialContext) {
        try {
          const seedDir = path.join(pipeline.worktreePath, "docs", "sdlc", "context");
          fs.mkdirSync(seedDir, { recursive: true });
          const seedFile = path.join(seedDir, `CTX-${pipeline.issueKey}.md`);
          const header = `# Context Bridge: ${pipeline.issueKey}\n> Pipeline: ${pipeline.pipelineType}\n> Created: ${nowIso()}\n\n`;
          const { text, agent } = pipeline.pendingInitialContext;
          const section = `## Phase: triage (pre-pipeline)\n- **Agent**: ${agent}\n- **Completed**: ${nowIso()}\n\n### Triage Output\n${text}\n\n`;
          fs.writeFileSync(seedFile, header + section, "utf8");
          pipeline.contextBridgeFile = seedFile;
          console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} context bridge seeded with ${agent} output (worktree)`);
        } catch (e) {
          console.error(`[${nowIso()}] Failed to seed context bridge for pipeline ${pipeline.pipelineId}: ${e.message}`);
        }
        delete pipeline.pendingInitialContext;
      }

    } catch (e) {
      console.error(`[${nowIso()}] Worktree creation failed for ${pipeline.issueKey}: ${e.message}`);
      // Fall through — pipeline will use base workingDir
    }
  }

  // If pipeline has a worktree, use it as workingDir for code-touching phases
  const phaseWorkingDir = pipeline.worktreePath || pipeline.workingDir;

  const basePrompt = `You are running as part of the ${pipeline.pipelineType} pipeline for Jira issue ${pipeline.issueKey}.\n` +
    `Phase: ${phase.name}\nAgent: ${phase.agent}\n\n` +
    `Fetch the full Jira issue ${pipeline.issueKey} via MCP tools for complete context. ` +
    `ALSO fetch every subtask of ${pipeline.issueKey} and read each one in full — subtasks are usually more prescriptive than the parent and define the actual work that needs doing.\n\n` +
    `If open subtasks exist that prescribe the work for this phase, do NOT do the work yourself. Instead, dispatch those subtasks to the appropriate agents (via [CREATE-SUBTASKS] routing labels if they need rerouting, or by ensuring the existing agent labels will pick them up) and let them execute. Your job in that case is to coordinate, not to implement.\n\n` +
    `Only do the work directly if there are no relevant subtasks, or the subtasks are already done/closed and the parent still requires action.`;

  const prompt = buildPipelinePrompt(pipeline, phase, basePrompt);

  const jobId = makeJobId();
  const logFile = path.join(LOG_DIR, `${jobId}.log`);
  const metaFile = path.join(LOG_DIR, `${jobId}.json`);

  const job = {
    jobId,
    mode: "delivery",
    issueKey: pipeline.issueKey,
    summary: `[Pipeline:${pipeline.pipelineType}] Phase: ${phase.name}`,
    description: prompt,
    workingDir: phaseWorkingDir,
    agent: phase.agent,
    model: phase.model || null,
    requestedProvider: phase.provider || pipeline.requestedProvider || null, // Provider override (claude/zai)
    selectedModel: null,

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
    callbackUrl: null, // Pipeline manages callbacks; phase jobs don't call back independently
    slack: null,
    telegram: null,
    batchId: null,
    source: { workflow: "pipeline", pipeline: pipeline.pipelineType, phase: phase.name },

    // Pipeline metadata
    pipelineId: pipeline.pipelineId,
    pipelinePhase: phase.name,
    pipelinePhaseIndex: phaseIndex,
    pipelineGateType: phase.gate?.type || null,
    worktreeId: pipeline.worktreeId || null,

    parentKey: null,
    subtaskFiles: [],
    subtaskDepth: 0,
    isSubtask: false,
    teamSessionId: null,
    teamRole: null,
    teammates: [],
  };

  // Set up Agent Teams if phase has team:true
  if (phase.team && config.teams?.enabled && config.teams.teamLeads?.[job.agent]) {
    job.teamSessionId = `team-${jobId}`;
    job.teamRole = "lead";
    job.teammates = config.teams.teamLeads[job.agent].teammates || [];
  }

  jobs.set(jobId, job);
  db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
  fs.writeFileSync(metaFile, JSON.stringify(job, null, 2), "utf8");

  phase.jobId = jobId;


  jobEmitter.emit("pipeline:phase-started", {
    pipelineId: pipeline.pipelineId,
    issueKey: pipeline.issueKey,
    phase: phase.name,
    phaseIndex,
    agent: phase.agent,
    jobId,
    startedAt: phase.startedAt,
  });

  console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} starting: jobId=${jobId} agent=${phase.agent}`);

  enqueue(jobId);
}

/**
 * Evaluate the gate condition for a completed phase.
 * Returns { passed: boolean, reason: string }
 */
function evaluateGate(pipeline, phase, job) {
  const gate = phase.gate;
  if (!gate) {
    return { passed: true, reason: "no gate defined" };
  }

  if (gate.type === "comment-prefix") {
    // Check job output for the required prefix
    const result = job.parsedOutput?.result || "";
    const stdout = job.stdout || "";
    const searchText = result + stdout;
    if (searchText.includes(gate.prefix)) {
      // Check verdict polarity — prefix found but with FAIL verdict means gate failed
      // Check prefix-specific patterns against full text
      const prefixFail = [
        `${gate.prefix} FAIL`, `${gate.prefix}] FAIL`, `${gate.prefix}-FAIL`
      ].some(p => searchText.includes(p));
      // Check generic verdict patterns only near the prefix (avoid false positives from narrative text)
      const prefixIdx = searchText.indexOf(gate.prefix);
      const vicinity = searchText.substring(prefixIdx, Math.min(prefixIdx + 500, searchText.length));
      const verdictFail = [
        "verdict: FAIL", "verdict FAIL", "Verdict: FAIL", "VERDICT: FAIL"
      ].some(p => vicinity.includes(p));
      const hasFail = prefixFail || verdictFail;
      if (hasFail) {
        return { passed: false, reason: `Found prefix "${gate.prefix}" but verdict is FAIL` };
      }
      return { passed: true, reason: `Found prefix "${gate.prefix}" in output` };
    }
    // Job succeeded but prefix not found in output - still passes
    // The agent may have posted it to Jira directly; we trust a succeeded job
    if (job.status === "succeeded") {
      return { passed: true, reason: `Job succeeded; assuming "${gate.prefix}" posted to Jira` };
    }
    return { passed: false, reason: `Required prefix "${gate.prefix}" not found in output` };
  }

  if (gate.type === "quality-gate") {
    if (job.qualityGate?.skipped) {
      return { passed: true, reason: "Quality gate skipped for this agent" };
    }
    if (job.qualityGate?.passed) {
      return { passed: true, reason: "Quality gate passed" };
    }
    if (job.status === "quality-gate-failed") {
      return { passed: false, reason: `Quality gate failed: ${job.error}` };
    }
    // Succeeded without gate data = pass
    if (job.status === "succeeded") {
      return { passed: true, reason: "Job succeeded (no quality gate configured for this agent)" };
    }
    return { passed: false, reason: "Quality gate did not pass" };
  }

  if (gate.type === "file-exists") {
    const filePath = path.join(pipeline.workingDir, gate.file);
    if (fs.existsSync(filePath)) {
      return { passed: true, reason: `File exists: ${gate.file}` };
    }
    return { passed: false, reason: `Required file not found: ${gate.file}` };
  }

  return { passed: true, reason: `Unknown gate type "${gate.type}" - defaulting to pass` };
}

/**
 * Extract a structured summary from phase output using phase-specific extractors.
 * Each phase type defines which sections to extract (decisions, artifacts, risks, etc).
 * Falls back to a truncated raw summary if no extractor matches.
 */
function extractStructuredSummary(phaseName, rawOutput, maxWords) {
  const extractorConfig = config.contextBridge?.phaseExtractors?.[phaseName];
  const words = rawOutput.split(/\s+/).filter(Boolean);

  if (!extractorConfig || !extractorConfig.sections) {
    // Fallback: truncated raw output
    const truncated = words.slice(0, maxWords).join(" ") + (words.length > maxWords ? "..." : "");
    return { type: "raw", sections: {}, raw: truncated };
  }

  const sections = {};
  const sectionDefs = extractorConfig.sections;

  // Extract file paths mentioned (common across phases)
  if (sectionDefs.includes("filesChanged")) {
    const filePaths = [];
    const filePatterns = [
      /(?:created?|modified?|updated?|wrote|changed)\s+[`"]?([a-zA-Z0-9_/.-]+\.[a-z]{1,5})[`"]?/gi,
      /###\s+([a-zA-Z0-9_/.-]+\.[a-z]{1,5})/g,
      /(?:^|\n)\s*[-*]\s+[`"]?([a-zA-Z0-9_/.-]+\.[a-z]{1,5})[`"]?/g,
    ];
    for (const pat of filePatterns) {
      let m;
      while ((m = pat.exec(rawOutput))) {
        const fp = m[1].trim();
        if (fp && !filePaths.includes(fp) && !fp.startsWith("http")) filePaths.push(fp);
      }
    }
    if (filePaths.length) sections.filesChanged = filePaths.slice(0, 30);
  }

  // Extract acceptance criteria (numbered lists)
  if (sectionDefs.includes("acceptanceCriteria")) {
    const acMatch = rawOutput.match(/(?:acceptance criteria|ACs?)[\s:]*\n((?:\s*\d+[.)]\s+.+\n?)+)/i);
    if (acMatch) sections.acceptanceCriteria = acMatch[1].trim();
  }

  // Extract verdict/decision blocks
  if (sectionDefs.includes("verdict")) {
    const verdictMatch = rawOutput.match(/(?:verdict|decision|recommendation|conclusion)[\s:]*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
    if (verdictMatch) sections.verdict = verdictMatch[1].trim().substring(0, 500);
  }

  // Extract decisions (look for decision markers, ADR format, or "decided" language)
  if (sectionDefs.includes("decisions")) {
    const decisionLines = [];
    const lines = rawOutput.split("\n");
    for (const line of lines) {
      if (/(?:decided|decision|chose|selected|approach|strategy)[:]/i.test(line) ||
          /^[-*]\s*\*?\*?(?:Decision|Approach|Strategy|Choice)/i.test(line)) {
        decisionLines.push(line.trim());
      }
    }
    if (decisionLines.length) sections.decisions = decisionLines.slice(0, 10).join("\n");
  }

  // Extract selected phases (from triage output)
  if (sectionDefs.includes("selectedPhases")) {
    const phaseMatch = rawOutput.match(/(?:selected phases|pipeline phases|phases to run|skipping)[\s:]*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
    if (phaseMatch) sections.selectedPhases = phaseMatch[1].trim().substring(0, 300);
  }

  // Extract risks/blockers
  if (sectionDefs.includes("risks")) {
    const riskLines = [];
    const lines = rawOutput.split("\n");
    let inRiskSection = false;
    for (const line of lines) {
      if (/(?:risks?|blockers?|concerns?|warnings?)[\s:]/i.test(line) && /^#+\s|^\*\*/.test(line)) {
        inRiskSection = true;
        continue;
      }
      if (inRiskSection) {
        if (/^#+\s/.test(line) || line.trim() === "") { inRiskSection = false; continue; }
        riskLines.push(line.trim());
      }
    }
    if (riskLines.length) sections.risks = riskLines.slice(0, 8).join("\n");
  }

  // Extract test results
  if (sectionDefs.includes("testResults")) {
    const testMatch = rawOutput.match(/(\d+)\s*(?:tests?\s+)?pass(?:ed|ing)?/i);
    const failMatch = rawOutput.match(/(\d+)\s*(?:tests?\s+)?fail(?:ed|ing)?/i);
    if (testMatch || failMatch) {
      sections.testResults = `Passed: ${testMatch?.[1] || "?"}, Failed: ${failMatch?.[1] || "0"}`;
    }
  }

  // Extract vulnerabilities
  if (sectionDefs.includes("vulnerabilities")) {
    const vulnLines = [];
    const lines = rawOutput.split("\n");
    for (const line of lines) {
      if (/(?:vulnerabilit|CVE-|CWE-|CVSS|injection|XSS|CSRF|exposure)/i.test(line)) {
        vulnLines.push(line.trim());
      }
    }
    if (vulnLines.length) sections.vulnerabilities = vulnLines.slice(0, 10).join("\n");
  }

  // Handoff notes: look for explicit handoff or "next phase" language
  if (sectionDefs.includes("handoff")) {
    const handoffMatch = rawOutput.match(/(?:handoff|hand-off|next phase|for (?:the )?(?:implementer|reviewer|architect|qa|uat)|notes? for)[\s:]*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
    if (handoffMatch) sections.handoff = handoffMatch[1].trim().substring(0, 400);
  }

  // Build a compact text representation
  const hasSections = Object.keys(sections).length > 0;
  // Also include a truncated raw as fallback context
  const rawFallback = words.slice(0, Math.floor(maxWords / 2)).join(" ") + (words.length > maxWords / 2 ? "..." : "");

  return { type: hasSections ? "structured" : "raw", sections, raw: hasSections ? rawFallback : words.slice(0, maxWords).join(" ") + (words.length > maxWords ? "..." : "") };
}

/**
 * Format a structured summary into markdown for the context bridge file.
 */
function formatContextSection(phaseName, agent, status, jobId, extracted) {
  const lines = [
    `\n## Phase: ${phaseName}`,
    `- **Agent**: ${agent}`,
    `- **Status**: ${status}`,
    `- **Completed**: ${nowIso()}`,
    `- **Job**: ${jobId}`,
    "",
  ];

  if (extracted.type === "structured") {
    const s = extracted.sections;

    if (s.decisions) {
      lines.push("### Decisions");
      lines.push(s.decisions);
      lines.push("");
    }
    if (s.selectedPhases) {
      lines.push("### Selected Phases");
      lines.push(s.selectedPhases);
      lines.push("");
    }
    if (s.acceptanceCriteria) {
      lines.push("### Acceptance Criteria");
      lines.push(s.acceptanceCriteria);
      lines.push("");
    }
    if (s.verdict) {
      lines.push("### Verdict");
      lines.push(s.verdict);
      lines.push("");
    }
    if (s.filesChanged && s.filesChanged.length) {
      lines.push("### Files Changed");
      for (const f of s.filesChanged) lines.push(`- \`${f}\``);
      lines.push("");
    }
    if (s.testResults) {
      lines.push("### Test Results");
      lines.push(s.testResults);
      lines.push("");
    }
    if (s.vulnerabilities) {
      lines.push("### Vulnerabilities");
      lines.push(s.vulnerabilities);
      lines.push("");
    }
    if (s.risks) {
      lines.push("### Risks / Blockers");
      lines.push(s.risks);
      lines.push("");
    }
    if (s.handoff) {
      lines.push("### Handoff → Next Phase");
      lines.push(s.handoff);
      lines.push("");
    }

    // Compact raw context for additional signal
    if (extracted.raw) {
      lines.push("<details><summary>Raw excerpt</summary>");
      lines.push("");
      lines.push(extracted.raw);
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  } else {
    lines.push("### Summary");
    lines.push(extracted.raw || "(no output summary available)");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Update the context bridge file with a structured summary of the completed phase.
 * Creates docs/sdlc/context/CTX-{issueKey}.md in the working directory.
 * Uses phase-specific extractors to pull out decisions, artifacts, risks, and
 * handoff notes — giving downstream agents (especially local models) a compressed,
 * relevant prompt instead of a raw output dump.
 */
function updateContextBridge(pipeline, phase, job) {
  try {
    // Write into the worktree so CTX-*.md doesn't leak as untracked file on
    // dev. Falls back to the base repo only when no worktree was created
    // (e.g. non-code phases before the first worktree-bearing phase).
    const ctxRoot = pipeline.worktreePath || pipeline.workingDir;
    const ctxDir = path.join(ctxRoot, "docs", "sdlc", "context");
    fs.mkdirSync(ctxDir, { recursive: true });

    const ctxFile = path.join(ctxDir, `CTX-${pipeline.issueKey}.md`);
    pipeline.contextBridgeFile = ctxFile;

    const maxWords = config.contextBridge?.maxSummaryWords || 300;
    const result = job.parsedOutput?.result || "";

    // Extract structured summary based on phase type
    const extracted = extractStructuredSummary(phase.name, result, maxWords);
    const section = formatContextSection(phase.name, phase.agent, job.status, job.jobId, extracted);

    // Create or append. If a deferred initial-context seed survived (worktree
    // creation failed or was disabled), include it as the first section so
    // the seed isn't lost.
    if (!fs.existsSync(ctxFile)) {
      const header = [
        `# Context Bridge: ${pipeline.issueKey}`,
        `> Pipeline: ${pipeline.pipelineType}`,
        `> Created: ${nowIso()}`,
        "",
      ].join("\n");
      let seedSection = "";
      if (pipeline.pendingInitialContext) {
        const { text, agent } = pipeline.pendingInitialContext;
        seedSection = `## Phase: triage (pre-pipeline)\n- **Agent**: ${agent}\n- **Completed**: ${nowIso()}\n\n### Triage Output\n${text}\n\n`;
        delete pipeline.pendingInitialContext;
      }
      fs.writeFileSync(ctxFile, header + seedSection + section, "utf8");
    } else {
      fs.appendFileSync(ctxFile, section, "utf8");
    }

    const sectionCount = Object.keys(extracted.sections).length;
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} context bridge updated: ${ctxFile} (${extracted.type}, ${sectionCount} sections)`);
  } catch (e) {
    console.error(`[${nowIso()}] Failed to update context bridge for pipeline ${pipeline.pipelineId}: ${e.message}`);
  }
}

// Per-repo merge lock to prevent concurrent checkout/merge conflicts
const repoMergeLocks = new Map();
async function withMergeLock(cwd, fn) {
  const key = cwd;
  while (repoMergeLocks.get(key)) {
    await new Promise(r => setTimeout(r, 500));
  }
  repoMergeLocks.set(key, true);
  try { return await fn(); } finally { repoMergeLocks.delete(key); }
}

/**
 * Merge a non-worktree pipeline's feature branch into the integration branch (dev).
 * Returns { branch, mergeBranch, devSha, mode } or null when no branch is found.
 * Throws on conflict (with .conflictContext) or push failure.
 */
function autoMergePipelineBranch(pipeline) {
  return mergePipelineBranchIntoDev(pipeline);
}

/**
 * Dispatch an agent job to resolve a merge conflict.
 * The agent checks out the integration branch (dev), merges the feature branch,
 * resolves conflicts with full context, commits the merge, and pushes dev.
 */
function dispatchMergeConflictAgent(pipeline, conflictContext) {
  const { branchName, mainLog, branchLog, diffStat, issueKey } = conflictContext;
  const mergeBranch = conflictContext.mergeBranch || resolveMergeBranch(pipeline.workingDir) || "dev";
  const remote = resolveRemoteName(pipeline.workingDir);

  const prompt = [
    `You are resolving a merge conflict for pipeline ${pipeline.pipelineId} (${issueKey}).`,
    ``,
    `Branch \`${branchName}\` needs to be merged into \`${mergeBranch}\` but has conflicts.`,
    ``,
    `## Recent commits on ${mergeBranch} (since branch diverged):`,
    mainLog || "(none)",
    ``,
    `## Commits on ${branchName}:`,
    branchLog || "(none)",
    ``,
    `## Files changed on the feature branch:`,
    diffStat || "(none)",
    ``,
    `## Your task:`,
    `1. Run \`git fetch ${remote} && git checkout ${mergeBranch} && git pull --ff-only ${remote} ${mergeBranch}\` to ensure ${mergeBranch} is up to date.`,
    `2. Run \`git merge ${branchName} --no-ff\` — this will produce conflicts.`,
    `3. For each conflicted file, read both versions carefully. Understand what ${mergeBranch} changed and what the feature branch changed. Preserve ALL meaningful work from both sides.`,
    `4. If both sides changed the same code, integrate both changes. If they're truly incompatible, prefer the feature branch change but preserve any ${mergeBranch}-side additions.`,
    `5. After resolving all conflicts, run the build/typecheck to verify nothing is broken.`,
    `6. Commit with message: \`Merge ${branchName} into ${mergeBranch} (agent-resolved conflicts)\``,
    `7. Push to remote: \`git push ${remote} ${mergeBranch}\``,
    `8. Delete the merged branch locally and on the remote: \`git branch -d ${branchName} && git push ${remote} --delete ${branchName}\``,
    ``,
    `IMPORTANT: Do NOT use \`-X theirs\` or \`-X ours\`. Resolve each conflict manually by reading the code and understanding both changes. Do NOT push to main — main is reserved for human-driven PRs from ${mergeBranch}.`,
  ].join("\n");

  const jobId = makeJobId();
  const logFile = path.join(LOG_DIR, `${jobId}.log`);
  const metaFile = path.join(LOG_DIR, `${jobId}.json`);
  const job = {
    jobId,
    status: "queued",
    mode: "agent",
    agent: "engineer-implementer",
    prompt,
    context: "",
    workingDir: pipeline.workingDir,
    issueKey: issueKey,
    model: config.routing?.agentToModel?.["engineer-implementer"] || "sonnet",
    selectedModel: null,
    requestedProvider: null,
    callbackUrl: config.callbackUrl || null,
    logFile,
    metaFile,
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    pid: null,
    output: null,
    error: null,
    retryCount: 0,
    maxRetries: config.maxRetries || 3,
    source: `pipeline:${pipeline.pipelineId}:merge-conflict`,
    pipelineId: pipeline.pipelineId,
    telegram: pipeline.telegram || null,
  };

  jobs.set(jobId, job);
  db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));

  // Stash the conflict branch + target so finalizeMergeConflictResolution can verify
  // the resolver actually pushed dev when its job completes. Without this metadata,
  // the post-resolution hook has no way to know which branch the resolver was assigned to.
  pipeline.conflictBranch = branchName;
  pipeline.conflictMergeBranch = mergeBranch;
  pipeline.conflictResolverJobId = jobId;
  db.pipelines.set(pipeline).catch(e => console.error(`[db] pipeline conflict stash failed: ${e.message}`));

  console.log(`[${nowIso()}] Dispatched merge-conflict agent job ${jobId} for ${branchName} → main (pipeline ${pipeline.pipelineId})`);

  // Notify via Telegram
  const telegramChatId = pipeline.telegram?.chatId || config.telegramChatEngineering;
  if (telegramChatId) {
    sendTelegramMessage(telegramChatId,
      `⚠️ *Merge Conflict* — ${issueKey}\n\nBranch \`${branchName}\` conflicts with \`${mergeBranch}\`.\nDispatched agent job \`${jobId}\` to resolve.\n\nConflicting files:\n\`\`\`\n${diffStat.substring(0, 500)}\n\`\`\``
    ).catch(() => {});
  }

  enqueue(jobId);
  return jobId;
}

/**
 * Called when a merge-conflict resolver job succeeds. Verifies the resolver
 * actually pushed dev (by checking the merge commit + branch deletion), then
 * flips pipeline.merged so the upstream pipeline's Jira issue auto-transitions
 * to Done. The dependency checker (tickDependencyChecker) re-checks blockers
 * against pipeline records, so this is what unblocks downstream pipelines.
 *
 * Returns true if the resolution was verified and the pipeline was finalised.
 */
async function finalizeMergeConflictResolution(pipeline, job) {
  const { execSync } = require("child_process");
  const branchName = pipeline.conflictBranch;
  const mergeBranch = pipeline.conflictMergeBranch || resolveMergeBranch(pipeline.workingDir) || "dev";
  const remote = resolveRemoteName(pipeline.workingDir);
  const issueKey = pipeline.issueKey;

  if (!branchName) {
    console.warn(`[${nowIso()}] finalizeMergeConflictResolution: no conflictBranch on pipeline ${pipeline.pipelineId}, skipping`);
    return false;
  }

  // Refresh local refs so we see what the resolver pushed
  try {
    execSync(`git fetch ${remote} --prune`, { cwd: pipeline.workingDir, encoding: "utf8", timeout: 30000, stdio: "pipe" });
  } catch (e) {
    console.warn(`[${nowIso()}] finalizeMergeConflictResolution: fetch failed for ${pipeline.workingDir}: ${e.message}`);
  }

  // 1. Branch should be gone from remote (resolver deletes it after merging)
  let branchGone = true;
  try {
    const out = execSync(`git ls-remote --heads ${remote} ${branchName}`, { cwd: pipeline.workingDir, encoding: "utf8", timeout: 15000, stdio: "pipe" }).trim();
    branchGone = !out;
  } catch (_) { /* assume gone */ }

  // 2. Dev should contain a commit referencing the issue key
  let devHasMerge = false;
  let devSha = null;
  try {
    const log = execSync(`git log --oneline -10 ${remote}/${mergeBranch}`, { cwd: pipeline.workingDir, encoding: "utf8", timeout: 15000, stdio: "pipe" });
    if (issueKey && log.includes(issueKey)) devHasMerge = true;
    if (!devHasMerge && log.toLowerCase().includes(branchName.toLowerCase())) devHasMerge = true;
    devSha = execSync(`git rev-parse ${remote}/${mergeBranch}`, { cwd: pipeline.workingDir, encoding: "utf8", timeout: 5000, stdio: "pipe" }).trim();
  } catch (e) {
    console.warn(`[${nowIso()}] finalizeMergeConflictResolution: dev log check failed for ${pipeline.workingDir}: ${e.message}`);
  }

  if (!devHasMerge && !branchGone) {
    console.warn(`[${nowIso()}] Pipeline ${pipeline.pipelineId} merge-conflict resolver job ${job.jobId} reported success but dev shows no merge AND branch ${branchName} still on remote — leaving mergeError in place`);
    return false;
  }

  if (!devHasMerge && branchGone) {
    // Branch deleted but no commit referencing the issue — likely a no-op merge.
    // Still treat as merged (the resolver may have rebased or fast-forwarded).
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} merge-conflict resolver: branch ${branchName} deleted, dev log doesn't reference ${issueKey} — accepting as merged anyway`);
  }

  pipeline.merged = true;
  pipeline.mergedBranch = branchName;
  pipeline.mergedTo = mergeBranch;
  pipeline.mergedSha = devSha;
  pipeline.mergeError = null;
  pipeline.conflictResolvedAt = nowIso();
  pipeline.conflictResolverJobId = job.jobId;
  db.pipelines.set(pipeline).catch(e => console.error(`[db] pipeline post-resolution update failed: ${e.message}`));

  console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} merge-conflict resolved (${branchName} → ${mergeBranch}@${(devSha||"").slice(0,8)}) by job ${job.jobId} — flipping to merged`);

  jobEmitter.emit("pipeline:merge-conflict-resolved", {
    pipelineId: pipeline.pipelineId,
    issueKey: pipeline.issueKey,
    branch: branchName,
    mergeBranch,
    devSha,
    resolverJobId: job.jobId,
  });

  // Telegram ping so Mark sees the unblock without checking the dashboard
  const telegramChatId = pipeline.telegram?.chatId || config.telegramChatEngineering;
  if (telegramChatId) {
    sendTelegramMessage(telegramChatId,
      `✅ *Merge resolved* — ${pipeline.issueKey}\n\nBranch \`${branchName}\` merged into \`${mergeBranch}\` by resolver job \`${job.jobId}\`.\nPipeline ${pipeline.pipelineId} now flagged merged — Jira auto-transition pending.`
    ).catch(() => {});
  }

  // Auto-transition Jira (same guards as advancePipeline: subtasks block, FAIL phases block)
  const anyPhaseFailed = pipeline.phases?.some(ph => ph.gateResult && ph.gateResult.passed === false);
  if (anyPhaseFailed) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} skipping post-resolution auto-transition: phase FAIL verdict present`);
  } else {
    autoTransitionIssueToDone(pipeline).catch(e => {
      console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} post-resolution auto-transition failed: ${e.message}`);
    });
    if (pipeline.parentKey) {
      setTimeout(() => {
        checkAndTransitionParent(pipeline.parentKey).catch(e => {
          console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} post-resolution parent transition failed: ${e.message}`);
        });
      }, 5000);
    }
  }

  return true;
}

/**
 * Advance the pipeline to the next non-skipped phase.
 * If no more phases, mark pipeline as completed.
 */
async function advancePipeline(pipeline) {
  // Defensive: if any phase is still running, do NOT advance or mark the
  // pipeline complete. The phase that's still running will call advancePipeline
  // again when it finishes. This prevents a stale callback from declaring the
  // pipeline done while real work is in flight.
  const stillRunning = pipeline.phases.find(p => p.status === "running");
  if (stillRunning) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} advancePipeline deferred: phase ${stillRunning.name} still running`);
    return;
  }

  const nextIndex = pipeline.phases.findIndex(
    (p, i) => i > pipeline.currentPhase && (p.status === "pending")
  );

  if (nextIndex >= 0) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} advancing to phase ${pipeline.phases[nextIndex].name} (index ${nextIndex})`);
    await executePipelinePhase(pipeline, nextIndex);
  } else {
    // No more pending phases
    pipeline.status = "completed";
    pipeline.completedAt = nowIso();
    db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));
  

    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} completed all phases for ${pipeline.issueKey}`);

    jobEmitter.emit("pipeline:completed", {
      pipelineId: pipeline.pipelineId,
      issueKey: pipeline.issueKey,
      pipelineType: pipeline.pipelineType,
      completedAt: pipeline.completedAt,
      phases: pipeline.phases.length,
    });

    // Auto-merge feature branch into the integration branch (dev) on successful
    // pipeline completion. The local main branch is never touched by the runner —
    // a human reviews `dev` and opens a PR `dev -> main` for deployment.
    // Synchronous: by the time this returns, dev has been pushed and the local
    // feature branch + worktree have been cleaned up.
    if (pipeline.merged) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} already merged (${pipeline.mergedBranch}) — skipping completion merge`);
    } else if (pipeline.worktreeId && config.worktrees?.enabled) {
      await withMergeLock(pipeline.workingDir, async () => {
        try {
          const mergeResult = mergeWorktree(pipeline.issueKey);
          console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} merged ${mergeResult.branch} -> ${mergeResult.mergeBranch}@${(mergeResult.devSha || "").slice(0,8)} (${mergeResult.mode})`);
          pipeline.merged = true;
          pipeline.mergedBranch = mergeResult.branch;
          pipeline.mergedTo = mergeResult.mergeBranch;
          pipeline.mergedSha = mergeResult.devSha;
        } catch (e) {
          if (e.conflictContext) {
            console.warn(`[${nowIso()}] Pipeline ${pipeline.pipelineId} merge conflict — dispatching agent`);
            dispatchMergeConflictAgent(pipeline, e.conflictContext);
            pipeline.mergeError = `Conflict on ${e.conflictContext.branchName} — agent dispatched`;
          } else {
            console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} worktree merge failed: ${e.message}`);
            pipeline.mergeError = e.message;
          }
        }
      });
    } else if (!pipeline.merged) {
      // Non-worktree: detect agent-created branch in workingDir and merge it
      await withMergeLock(pipeline.workingDir, async () => {
        try {
          const result = autoMergePipelineBranch(pipeline);
          if (result) {
            console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} merged ${result.branch} -> ${result.mergeBranch}@${(result.devSha || "").slice(0,8)} (${result.mode})`);
            pipeline.merged = true;
            pipeline.mergedBranch = result.branch;
            pipeline.mergedTo = result.mergeBranch;
            pipeline.mergedSha = result.devSha;
          } else {
            console.warn(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-merge skipped: no mergeable branch found for ${pipeline.issueKey}`);
          }
        } catch (e) {
          if (e.conflictContext) {
            console.warn(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-merge conflict — dispatching agent`);
            dispatchMergeConflictAgent(pipeline, e.conflictContext);
            pipeline.mergeError = `Conflict on ${e.conflictContext.branchName} — agent dispatched`;
          } else {
            console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-merge failed: ${e.message}`);
            pipeline.mergeError = e.message;
          }
        }
      });
    }

    // Auto-transition Jira issue to Done only after the merge into dev has succeeded.
    // Guard 1: any phase with a FAIL verdict blocks the transition.
    // Guard 2: if the merge didn't succeed, leave Jira un-Done — preserves the
    // CER-530-style fix (no silent Done when the code never reaches the integration
    // branch). A human still needs to act on `pipeline.mergeError`.
    const anyPhaseFailed = pipeline.phases.some(ph =>
      ph.gateResult && ph.gateResult.passed === false
    );
    if (anyPhaseFailed) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} skipping auto-transition: one or more phases had FAIL verdict`);
    } else if (!pipeline.merged) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} skipping auto-transition: merge did not succeed (${pipeline.mergeError || 'no branch found'})`);
    } else {
      autoTransitionIssueToDone(pipeline).catch(e => {
        console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition failed: ${e.message}`);
      });

      // If this pipeline's issue is a subtask, check if all siblings are done → transition parent
      if (pipeline.parentKey) {
        // Small delay to let the subtask transition complete first
        setTimeout(() => {
          checkAndTransitionParent(pipeline.parentKey).catch(e => {
            console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} parent transition check failed: ${e.message}`);
          });
        }, 5000);
      }
    }

    // Send pipeline completion callback if configured
    if (pipeline.callbackUrl) {
      const payload = {
        event: "pipeline:completed",
        pipelineId: pipeline.pipelineId,
        issueKey: pipeline.issueKey,
        pipelineType: pipeline.pipelineType,
        completedAt: pipeline.completedAt,
        merged: pipeline.merged || false,
        mergedBranch: pipeline.mergedBranch || null,
        mergeError: pipeline.mergeError || null,
        slack: pipeline.slack || null,
      };
      const mockJob = { jobId: pipeline.pipelineId, logFile: path.join(LOG_DIR, `${pipeline.pipelineId}.log`) };
      // Ensure log file exists for callback helper
      if (!fs.existsSync(mockJob.logFile)) {
        fs.writeFileSync(mockJob.logFile, `[${nowIso()}] Pipeline completed\n`, "utf8");
      }
      sendCallbackWithRetry(pipeline.callbackUrl, payload, mockJob).catch(e => {
        console.error(`[${nowIso()}] Pipeline completion callback failed: ${e.message}`);
      });
    }
  }
}

/**
 * Auto-transition a Jira issue to Done after a pipeline completes successfully.
 * Uses direct Jira REST API calls — no Claude CLI overhead.
 * This is a safety net — the PM agent should also transition, but sometimes doesn't.
 */
async function autoTransitionIssueToDone(pipeline) {
  const issueKey = pipeline.issueKey;
  if (!issueKey) return;

  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition skipped: JIRA_DOMAIN/JIRA_EMAIL/JIRA_API_TOKEN not configured`);
    return;
  }

  const authHeader = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: authHeader };

  try {
    // 1. Check current status AND subtasks
    const issueRes = await getJson(`${baseUrl}/rest/api/3/issue/${issueKey}?fields=status,subtasks`, headers);
    if (issueRes.statusCode !== 200) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: failed to fetch issue (${issueRes.statusCode})`);
      return;
    }
    const currentStatus = issueRes.json?.fields?.status?.name || "";
    if (currentStatus.toLowerCase() === "done") {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: Already Done`);
      return;
    }

    // Guard: if issue has subtasks, do NOT auto-transition — let checkAndTransitionParent handle it
    const subtasks = issueRes.json?.fields?.subtasks || [];
    if (subtasks.length > 0) {
      const doneCount = subtasks.filter(st => (st.fields?.status?.name || "").toLowerCase() === "done").length;
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: BLOCKED — has ${subtasks.length} subtasks (${doneCount} done). Parent transitions are handled by checkAndTransitionParent only.`);
      return;
    }

    // 2. Get available transitions
    const transRes = await getJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, headers);
    if (transRes.statusCode !== 200) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: failed to get transitions (${transRes.statusCode})`);
      return;
    }
    const transitions = transRes.json?.transitions || [];
    const doneTrans = transitions.find(t => t.name?.toLowerCase() === "done");
    if (!doneTrans) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: no "Done" transition available from "${currentStatus}" (available: ${transitions.map(t => t.name).join(", ")})`);
      return;
    }

    // 3. Transition to Done
    const result = await postJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: doneTrans.id } }, headers);
    if (result.statusCode === 204 || result.statusCode === 200) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: Transitioned to Done (from "${currentStatus}")`);
    } else {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: transition failed (${result.statusCode}) ${result.body?.substring(0, 200)}`);
    }
  } catch (e) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} auto-transition for ${issueKey}: error - ${e.message}`);
  }
}

/**
 * Check if all subtasks of a parent are done (via Jira API, not in-memory tracking).
 * If all subtasks are Done, transition the parent story to Done.
 */
async function checkAndTransitionParent(parentKey) {
  if (!parentKey) return;

  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return;

  const authHeader = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: authHeader };

  // 1. Fetch parent with subtasks and their statuses
  const parentRes = await getJson(`${baseUrl}/rest/api/3/issue/${parentKey}?fields=subtasks,status`, headers);
  if (parentRes.statusCode !== 200) {
    console.log(`[parent-transition] ${parentKey}: failed to fetch (${parentRes.statusCode})`);
    return;
  }

  const subtasks = parentRes.json?.fields?.subtasks || [];
  if (subtasks.length === 0) {
    console.log(`[parent-transition] ${parentKey}: no subtasks, skipping`);
    return;
  }

  // 2. Check each subtask's status — need to fetch individually since subtasks field only has key/summary/status
  let allDone = true;
  for (const st of subtasks) {
    const stStatus = st.fields?.status?.name?.toLowerCase() || "";
    if (stStatus !== "done") {
      allDone = false;
      break;
    }
  }

  if (!allDone) {
    const doneCount = subtasks.filter(st => (st.fields?.status?.name || "").toLowerCase() === "done").length;
    console.log(`[parent-transition] ${parentKey}: ${doneCount}/${subtasks.length} subtasks done, waiting`);
    return;
  }

  // 3. Check parent isn't already done
  const parentStatus = parentRes.json?.fields?.status?.name || "";
  if (parentStatus.toLowerCase() === "done") {
    console.log(`[parent-transition] ${parentKey}: already Done`);
    return;
  }

  // 4. Get transitions and transition to Done
  const transRes = await getJson(`${baseUrl}/rest/api/3/issue/${parentKey}/transitions`, headers);
  if (transRes.statusCode !== 200) {
    console.log(`[parent-transition] ${parentKey}: failed to get transitions (${transRes.statusCode})`);
    return;
  }
  const transitions = transRes.json?.transitions || [];
  const doneTrans = transitions.find(t => t.name?.toLowerCase() === "done");
  if (!doneTrans) {
    console.log(`[parent-transition] ${parentKey}: no "Done" transition from "${parentStatus}" (available: ${transitions.map(t => t.name).join(", ")})`);
    return;
  }

  const result = await postJson(`${baseUrl}/rest/api/3/issue/${parentKey}/transitions`, { transition: { id: doneTrans.id } }, headers);
  if (result.statusCode === 204 || result.statusCode === 200) {
    console.log(`[parent-transition] ${parentKey}: ALL ${subtasks.length} subtasks done → transitioned parent to Done`);
  } else {
    console.log(`[parent-transition] ${parentKey}: transition failed (${result.statusCode})`);
  }
}

/**
 * Move parent story to "In Progress" when first subtask starts working.
 * Skips if parent is already In Progress or Done (idempotent).
 */
async function moveParentToInProgress(parentKey) {
  if (!parentKey) return;
  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return;

  const authHeader = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: authHeader };

  // Check current status — only transition if still in a pre-progress state (e.g. "To Do", "Backlog")
  const parentRes = await getJson(`${baseUrl}/rest/api/3/issue/${parentKey}?fields=status`, headers);
  if (parentRes.statusCode !== 200) {
    console.log(`[parent-in-progress] ${parentKey}: failed to fetch (${parentRes.statusCode})`);
    return;
  }

  const currentStatus = parentRes.json?.fields?.status?.name || "";
  const statusLower = currentStatus.toLowerCase();
  if (statusLower === "in progress" || statusLower === "done" || statusLower === "in review") {
    console.log(`[parent-in-progress] ${parentKey}: already "${currentStatus}", skipping`);
    return;
  }

  // Get transitions and move to In Progress
  const transRes = await getJson(`${baseUrl}/rest/api/3/issue/${parentKey}/transitions`, headers);
  if (transRes.statusCode !== 200) return;

  const transitions = transRes.json?.transitions || [];
  const ipTrans = transitions.find(t => t.name?.toLowerCase() === "in progress");
  if (!ipTrans) {
    console.log(`[parent-in-progress] ${parentKey}: no "In Progress" transition from "${currentStatus}" (available: ${transitions.map(t => t.name).join(", ")})`);
    return;
  }

  const result = await postJson(`${baseUrl}/rest/api/3/issue/${parentKey}/transitions`, { transition: { id: ipTrans.id } }, headers);
  if (result.statusCode === 204 || result.statusCode === 200) {
    console.log(`[parent-in-progress] ${parentKey}: transitioned from "${currentStatus}" → In Progress (subtask started)`);
  } else {
    console.log(`[parent-in-progress] ${parentKey}: transition failed (${result.statusCode})`);
  }
}

/**
 * Create a Jira subtask under the parent issue when a pipeline phase fails.
 * The subtask is auto-transitioned to In Progress so it enters the sprint and gets worked on.
 */
async function createPipelineFailureSubtask(pipeline, phase) {
  if (!pipeline.issueKey) return;

  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} failure subtask skipped: JIRA_DOMAIN/JIRA_EMAIL/JIRA_API_TOKEN not configured`);
    return;
  }

  const authHeader = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: authHeader };

  try {
    // Get parent issue project key
    const issueRes = await getJson(`${baseUrl}/rest/api/3/issue/${pipeline.issueKey}?fields=project`, headers);
    if (issueRes.statusCode !== 200) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} failure subtask: failed to fetch parent issue (${issueRes.statusCode})`);
      return;
    }
    const projectKey = issueRes.json?.fields?.project?.key;
    const projectId = issueRes.json?.fields?.project?.id;
    if (!projectKey || !projectId) return;

    // Truncate error for summary (max 255 chars)
    const errorSummary = (phase.error || "Phase failed").substring(0, 140);
    const summary = `[RCA] ${pipeline.issueKey} — ${phase.name} exhausted: ${errorSummary}`.substring(0, 255);

    // Route exhausted-pipeline failures to ask-tom for root-cause analysis instead of
    // re-spawning the same agent. Ask-tom investigates, attaches findings, and only then
    // delegates to an implementer (or recommends scope reduction / deferral) with a
    // narrow, evidenced plan.
    const agentLabel = "agent:ask-tom-agent";
    const failedAgent = phase.agent || "unknown";
    const fixLoopAttempts = phase.fixLoopAttempts || 0;
    const verifyLoopAttempts = pipeline.verifyFixLoopAttempts || 0;

    const rcaBrief = [
      `Pipeline ${pipeline.pipelineId} (${pipeline.pipelineType}) exhausted all retries at phase "${phase.name}".`,
      ``,
      `Failed agent: ${failedAgent}`,
      `Fix-loop attempts: ${fixLoopAttempts}`,
      `Verify-fix-loop attempts: ${verifyLoopAttempts}`,
      `Last error: ${phase.error || "Unknown"}`,
      ``,
      `## Your job (ask-tom-agent)`,
      `Do NOT just re-run the failed agent. Treat this as a root-cause problem.`,
      `1. Read the parent issue ${pipeline.issueKey} and the prior pipeline jobs/comments to understand what was attempted and why each attempt failed.`,
      `2. Identify the actual root cause — distinguish between (a) a narrow bug in the change, (b) scope creep that broke unrelated code, (c) a pre-existing flaky/broken test, (d) the spec being unimplementable as stated.`,
      `3. Post your findings as a Jira comment on this subtask before doing any code work.`,
      `4. Decide the path: narrow the scope and delegate to engineer-implementer with a constrained plan; recommend a meeting (planner + qa + product-manager) for scope/defer decisions; or escalate to a human if the spec needs revision.`,
      `5. Only dispatch an implementer once you have an evidenced, scoped plan that addresses the root cause.`,
    ].join("\n");

    const subtaskPayload = {
      fields: {
        project: { key: projectKey },
        parent: { key: pipeline.issueKey },
        summary,
        description: {
          type: "doc",
          version: 1,
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: rcaBrief }]
          }]
        },
        issuetype: { name: "Subtask" },
        labels: ["pipeline-fix", "needs-rca", agentLabel],
        priority: { name: "High" },
      }
    };

    const createRes = await postJson(`${baseUrl}/rest/api/3/issue`, subtaskPayload, headers);
    let createdKey = null;
    if (createRes.statusCode === 201) {
      try { createdKey = JSON.parse(createRes.body)?.key; } catch (_) {}
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} failure subtask created: ${createdKey || "unknown"} under ${pipeline.issueKey}`);
    } else {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} failure subtask creation failed (${createRes.statusCode}): ${(createRes.body || "").substring(0, 300)}`);
      return;
    }

    // Move subtask to parent's sprint + transition to In Progress
    if (createdKey) {
      await moveSubtaskToParentSprint(createdKey, pipeline.issueKey);
      await transitionIssueToInProgress(createdKey);
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} failure subtask ${createdKey} moved to sprint + transitioned to In Progress`);
    }
  } catch (e) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} failure subtask error: ${e.message}`);
  }
}

/**
 * Close the matching [Meeting] Jira task when a meeting-dispatched job succeeds.
 * Searches Jira for the task by summary/label match and transitions to Done.
 * Uses direct Jira REST API — no Claude CLI overhead.
 */
async function closeMeetingJiraTask(job) {
  if (!job.meetingAction?.task || job.status !== "succeeded") return;

  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) {
    console.log(`[${nowIso()}] Meeting task closure skipped: JIRA_DOMAIN/JIRA_EMAIL/JIRA_API_TOKEN not configured`);
    return;
  }

  const authHeader = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: authHeader };

  try {
    // Use job.issueKey directly if available (created by dispatchMeetingActions)
    let issueKey = job.issueKey;

    // Fallback: search Jira by text match for legacy jobs without issueKey
    if (!issueKey) {
      const taskSnippet = (job.meetingAction.task || "").substring(0, 80).replace(/[^\w\s]/g, " ").trim();
      if (!taskSnippet) return;
      const projectKey = resolveJiraProject(job.workingDir);
      const jql = encodeURIComponent(`project = ${projectKey} AND labels = meeting-action AND summary ~ "[Meeting]" AND text ~ "${taskSnippet.substring(0, 40)}" AND status != Done`);
      const searchRes = await getJson(`${baseUrl}/rest/api/3/search?jql=${jql}&fields=key,summary,status&maxResults=5`, headers);

      if (searchRes.statusCode !== 200 || !searchRes.json?.issues?.length) {
        console.log(`[${nowIso()}] Meeting task closure for job ${job.jobId}: No matching task found (no issueKey, text search failed)`);
        return;
      }
      issueKey = searchRes.json.issues[0].key;
    }

    // Get transitions and transition to Done
    const transRes = await getJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, headers);
    const transitions = transRes.json?.transitions || [];
    const doneTrans = transitions.find(t => t.name?.toLowerCase() === "done");
    if (!doneTrans) {
      console.log(`[${nowIso()}] Meeting task closure for job ${job.jobId}: ${issueKey} has no Done transition`);
      return;
    }

    const result = await postJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: doneTrans.id } }, headers);
    if (result.statusCode === 204 || result.statusCode === 200) {
      console.log(`[${nowIso()}] Meeting task closure for job ${job.jobId}: Closed ${issueKey}`);
    } else {
      console.log(`[${nowIso()}] Meeting task closure for job ${job.jobId}: transition failed for ${issueKey} (${result.statusCode})`);
    }
  } catch (e) {
    console.error(`[${nowIso()}] Meeting task closure error: ${e.message}`);
  }
}

/**
 * Called when a pipeline phase job finishes (success or failure).
 * Evaluates the gate, updates context bridge, and advances or fails the pipeline.
 */
async function onPipelinePhaseComplete(pipeline, phaseIndex, job) {
  const phase = pipeline.phases[phaseIndex];
  if (!phase) return;

  // Guard: ignore stale callbacks for phases that have already terminated.
  // This happens when a duplicate job for the same phase finishes late — e.g.
  // job 1 of phase X is interrupted by a runner restart and re-queued via
  // `retry-pending` (loadStateFromDB), while the pipeline's own resume logic
  // ALSO restarts phase X with a fresh job 2. When job 1 eventually finishes,
  // it would re-fire phase completion and (incorrectly) advance the pipeline
  // past phases that are already running. Concrete repro: EOS-653 on 2026-04-26
  // leapt from completed code-review straight to verify, leaving code-review
  // running and the pipeline marked completed before verify finished.
  if (phase.status === "completed" || phase.status === "failed" || phase.status === "skipped") {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} ignoring stale completion for phase ${phase.name} (status=${phase.status}, jobId=${job.jobId})`);
    return;
  }
  // Defensive: if the phase's tracked jobId no longer matches this job, the
  // phase has already moved on (e.g. fix-loop reset). Drop the stale callback.
  if (phase.jobId && phase.jobId !== job.jobId) {
    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} ignoring duplicate job completion for phase ${phase.name} (current jobId=${phase.jobId}, completing jobId=${job.jobId})`);
    return;
  }

  phase.completedAt = nowIso();

  if (job.status === "failed" || job.status === "quality-gate-failed" || job.status === "cancelled") {
    // Fix-loop: for quality-gate failures on eligible phases, re-dispatch with error context
    const fixLoopCfg = config.fixLoop || {};
    const isFixLoopEligible = fixLoopCfg.enabled &&
      job.status === "quality-gate-failed" &&
      phase.gate && (fixLoopCfg.gateTypes || ["quality-gate"]).includes(phase.gate.type);

    if (isFixLoopEligible && phase.fixLoopAttempts < (fixLoopCfg.maxAttempts || 3)) {
      // d3a: short-circuit fix-loop when the failing tests live entirely
      // outside the pipeline's diff (i.e. base branch was already red).
      // Only check after at least one fix-loop attempt to avoid false
      // positives on a fresh implementer-introduced issue.
      if (phase.fixLoopAttempts >= 1) {
        try {
          const baseRed = detectInheritedRedBase(pipeline, phase, job);
          if (baseRed.inherited) {
            phase.baseRedDetection = baseRed;
            console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} BLOCKED_ON_BASE_RED (basis=${baseRed.basis}, failing=${baseRed.failingFiles.length} file(s)) — halting fix-loop`);
            // Fall through to terminal-fail block below.
          }
        } catch (e) {
          console.warn(`[${nowIso()}] detectInheritedRedBase error: ${e.message}`);
        }
      }

      if (!phase.baseRedDetection) {
      phase.fixLoopAttempts++;
      phase.status = "pending";
      phase.jobId = null;
      phase.startedAt = null;
      phase.completedAt = null;

      // Capture error context from the failed job for the next attempt
      const qgFailure = job.qualityGateFailure || {};
      phase.fixLoopContext = {
        attempt: phase.fixLoopAttempts,
        failedCheck: qgFailure.failedCheck || job.error || "unknown",
        failedCommand: qgFailure.failedCommand || "",
        failureOutput: qgFailure.failureOutput || job.error || "",
        previousJobId: job.jobId,
      };
    

      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} quality-gate failed — fix-loop attempt ${phase.fixLoopAttempts}/${fixLoopCfg.maxAttempts || 3}`);

      jobEmitter.emit("pipeline:fix-loop", {
        pipelineId: pipeline.pipelineId,
        phase: phase.name,
        phaseIndex,
        jobId: job.jobId,
        attempt: phase.fixLoopAttempts,
        maxAttempts: fixLoopCfg.maxAttempts || 3,
        failedCheck: phase.fixLoopContext.failedCheck,
      });

      setTimeout(() => executePipelinePhase(pipeline, phaseIndex), 5000);
      return;
      }
      // baseRedDetection set: fall through to terminal-fail block.
    }

    // Standard retry (non-quality-gate failures)
    const maxPhaseRetries = 1;
    if (phase.retryCount < maxPhaseRetries && job.status !== "cancelled" && !isFixLoopEligible) {
      phase.retryCount++;
      phase.status = "pending";
      phase.jobId = null;
      phase.startedAt = null;
    

      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} failed, retrying (${phase.retryCount}/${maxPhaseRetries})`);

      jobEmitter.emit("pipeline:phase-complete", {
        pipelineId: pipeline.pipelineId,
        phase: phase.name,
        phaseIndex,
        jobId: job.jobId,
        status: "retrying",
      });

      setTimeout(() => executePipelinePhase(pipeline, phaseIndex), 5000);
      return;
    }

    // All retries/fix-loops exhausted, cancelled, or base-red detected
    phase.status = "failed";
    const baseRed = phase.baseRedDetection;
    if (baseRed && baseRed.inherited) {
      const head = baseRed.failingFiles.slice(0, 3).join(", ");
      const more = baseRed.failingFiles.length > 3 ? ` (+${baseRed.failingFiles.length - 3} more)` : "";
      phase.error = `BLOCKED_ON_BASE_RED: ${baseRed.failingFiles.length} failing test file(s) live outside pipeline diff (basis=${baseRed.basis}). Failing: ${head}${more}.`;
    } else {
      phase.error = job.error || "Phase job failed";
      if (phase.fixLoopAttempts > 0) {
        phase.error += ` (after ${phase.fixLoopAttempts} fix-loop attempts)`;
      }
    }

    pipeline.status = "failed";
    pipeline.completedAt = nowIso();
    pipeline.blockedOnBaseRed = !!(baseRed && baseRed.inherited);
    pipeline.error = `Phase "${phase.name}" failed: ${phase.error}`;
    const baseRedActive = baseRed && baseRed.inherited;
    db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));
  

    console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} FAILED at phase ${phase.name}: ${pipeline.error}`);

    // Preserve any partial work on the worktree branch by pushing it to the remote.
    // This guarantees we never lose progress even when the pipeline didn't reach a green state.
    try {
      const preserved = preserveBranchOnFailure(pipeline, phase);
      if (preserved) {
        pipeline.preservedBranch = preserved.branch;
        pipeline.preservedRemote = preserved.pushedRemote;
      }
    } catch (e) {
      console.warn(`[${nowIso()}] preserveBranchOnFailure (job-fail) error: ${e.message}`);
    }

    // Create a Jira subtask for the failure so it gets resolved
    createPipelineFailureSubtask(pipeline, phase).catch(e => {
      console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} failure subtask error: ${e.message}`);
    });

    jobEmitter.emit("pipeline:phase-complete", {
      pipelineId: pipeline.pipelineId,
      phase: phase.name,
      phaseIndex,
      jobId: job.jobId,
      status: "failed",
      error: phase.error,
    });

    jobEmitter.emit("pipeline:failed", {
      pipelineId: pipeline.pipelineId,
      issueKey: pipeline.issueKey,
      pipelineType: pipeline.pipelineType,
      failedPhase: phase.name,
      error: pipeline.error,
      completedAt: pipeline.completedAt,
    });

    // Send pipeline failure callback so N8N/Slack is notified
    if (pipeline.callbackUrl) {
      const failPayload = {
        event: "pipeline:failed",
        pipelineId: pipeline.pipelineId,
        issueKey: pipeline.issueKey,
        pipelineType: pipeline.pipelineType,
        failedPhase: phase.name,
        error: pipeline.error,
        completedAt: pipeline.completedAt,
        slack: pipeline.slack || null,
        telegram: pipeline.telegram || null,
        blockedOnBaseRed: !!baseRedActive,
        failingTestFiles: baseRedActive ? baseRed.failingFiles : undefined,
        baseRef: baseRedActive ? baseRed.basis : undefined,
        message: baseRedActive
          ? `Pipeline ${pipeline.issueKey} BLOCKED_ON_BASE_RED — ${baseRed.failingFiles.length} test file(s) failing on ${baseRed.basis} that this pipeline never touched. Fix the base before retrying.`
          : `Pipeline FAILED for ${pipeline.issueKey} at phase "${phase.name}": ${phase.error}`,
      };
      const mockJob = { jobId: pipeline.pipelineId, logFile: path.join(LOG_DIR, `${pipeline.pipelineId}.log`) };
      if (!fs.existsSync(mockJob.logFile)) {
        fs.writeFileSync(mockJob.logFile, `[${nowIso()}] Pipeline failed\n`, "utf8");
      }
      sendCallbackWithRetry(pipeline.callbackUrl, failPayload, mockJob).catch(e => {
        console.error(`[${nowIso()}] Pipeline failure callback failed: ${e.message}`);
      });
    }

    return;
  }

  // Job succeeded — evaluate gate
  const gateResult = evaluateGate(pipeline, phase, job);
  phase.gateResult = gateResult;

  if (!gateResult.passed) {
    // Gate failed — retry the phase if retries remain.
    // Exception: when QA returns an explicit FAIL verdict, retrying the same
    // code is pointless — go straight to the verify-fix-loop so the
    // implementer can address the findings.
    const isDefinitiveVerifyFail = phase.name === "verify" &&
      /verdict is FAIL/i.test(gateResult.reason || "");
    const maxPhaseRetries = 1;
    if (!isDefinitiveVerifyFail && phase.retryCount < maxPhaseRetries) {
      phase.retryCount++;
      phase.status = "pending";
      phase.jobId = null;
      phase.startedAt = null;
    

      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} gate failed (${gateResult.reason}), retrying`);

      jobEmitter.emit("pipeline:gate-failed", {
        pipelineId: pipeline.pipelineId,
        phase: phase.name,
        phaseIndex,
        reason: gateResult.reason,
        retrying: true,
      });

      setTimeout(() => executePipelinePhase(pipeline, phaseIndex), 5000);
      return;
    }

    // Verify fix-loop: when QA (verify) gate fails, loop back to the implementer
    // to fix issues on the same branch, then re-run QA.  The branch stays checked
    // out — merge only happens when verify finally passes.
    const verifyFixCfg = config.fixLoop || {};
    const maxVerifyLoops = verifyFixCfg.maxVerifyAttempts || 3;
    if (phase.name === "verify" && verifyFixCfg.enabled) {
      pipeline.verifyFixLoopAttempts = (pipeline.verifyFixLoopAttempts || 0) + 1;
      if (pipeline.verifyFixLoopAttempts <= maxVerifyLoops) {
        const implIndex = pipeline.phases.findIndex(p => p.name === "implementation");
        if (implIndex >= 0) {
          const implPhase = pipeline.phases[implIndex];

          // Reset implementation phase with QA findings as fix context
          implPhase.status = "pending";
          implPhase.jobId = null;
          implPhase.startedAt = null;
          implPhase.fixLoopContext = {
            attempt: pipeline.verifyFixLoopAttempts,
            failedCheck: `QA verification failed: ${gateResult.reason}`,
            failedCommand: "",
            failureOutput: ((job.parsedOutput?.result || "") + "\n" + (job.stdout || "")).substring(0, 4000),
            sourcePhase: "verify",
          };

          // Reset verify phase so it re-runs after implementation
          phase.status = "pending";
          phase.jobId = null;
          phase.startedAt = null;
          phase.retryCount = 0;
          phase.gateResult = null;

          // Also reset code-review if present so reviewer sees the fixes
          const crIndex = pipeline.phases.findIndex(p => p.name === "code-review");
          if (crIndex >= 0 && crIndex > implIndex) {
            const crPhase = pipeline.phases[crIndex];
            crPhase.status = "pending";
            crPhase.jobId = null;
            crPhase.startedAt = null;
            crPhase.retryCount = 0;
            crPhase.gateResult = null;
          }

          pipeline.status = "running";
          db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));

          console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} verify-fix-loop ${pipeline.verifyFixLoopAttempts}/${maxVerifyLoops}: QA failed → re-dispatching implementer on same branch`);

          jobEmitter.emit("pipeline:verify-fix-loop", {
            pipelineId: pipeline.pipelineId,
            issueKey: pipeline.issueKey,
            phase: phase.name,
            attempt: pipeline.verifyFixLoopAttempts,
            maxAttempts: maxVerifyLoops,
            reason: gateResult.reason,
          });

          setTimeout(() => executePipelinePhase(pipeline, implIndex), 5000);
          return;
        }
      }
    }

    // Gate failed and no more retries (or verify-fix-loop exhausted)
    phase.status = "failed";
    phase.error = `Gate failed: ${gateResult.reason}`;
    if (pipeline.verifyFixLoopAttempts > 0) {
      phase.error += ` (after ${pipeline.verifyFixLoopAttempts} verify-fix-loop attempts)`;
    }

    pipeline.status = "failed";
    pipeline.completedAt = nowIso();
    pipeline.error = `Phase "${phase.name}" gate failed: ${gateResult.reason}`;
    db.pipelines.set(pipeline).catch(e => console.error('[db] pipeline update failed: ' + e.message));

    // Preserve any partial work on the worktree branch by pushing it to the remote.
    try {
      const preserved = preserveBranchOnFailure(pipeline, phase);
      if (preserved) {
        pipeline.preservedBranch = preserved.branch;
        pipeline.preservedRemote = preserved.pushedRemote;
      }
    } catch (e) {
      console.warn(`[${nowIso()}] preserveBranchOnFailure (gate-fail) error: ${e.message}`);
    }

    // Create a Jira subtask for the gate failure so it gets resolved
    createPipelineFailureSubtask(pipeline, phase).catch(e => {
      console.error(`[${nowIso()}] Pipeline ${pipeline.pipelineId} gate failure subtask error: ${e.message}`);
    });

    jobEmitter.emit("pipeline:gate-failed", {
      pipelineId: pipeline.pipelineId,
      phase: phase.name,
      phaseIndex,
      reason: gateResult.reason,
      retrying: false,
    });

    jobEmitter.emit("pipeline:failed", {
      pipelineId: pipeline.pipelineId,
      issueKey: pipeline.issueKey,
      pipelineType: pipeline.pipelineType,
      failedPhase: phase.name,
      error: pipeline.error,
      completedAt: pipeline.completedAt,
    });

    // Send pipeline failure callback so N8N/Slack is notified
    if (pipeline.callbackUrl) {
      const failPayload = {
        event: "pipeline:failed",
        pipelineId: pipeline.pipelineId,
        issueKey: pipeline.issueKey,
        pipelineType: pipeline.pipelineType,
        failedPhase: phase.name,
        error: pipeline.error,
        completedAt: pipeline.completedAt,
        slack: pipeline.slack || null,
        telegram: pipeline.telegram || null,
        message: `Pipeline FAILED for ${pipeline.issueKey} at phase "${phase.name}": ${phase.error}`,
      };
      const mockJob = { jobId: pipeline.pipelineId, logFile: path.join(LOG_DIR, `${pipeline.pipelineId}.log`) };
      if (!fs.existsSync(mockJob.logFile)) {
        fs.writeFileSync(mockJob.logFile, `[${nowIso()}] Pipeline failed\n`, "utf8");
      }
      sendCallbackWithRetry(pipeline.callbackUrl, failPayload, mockJob).catch(e => {
        console.error(`[${nowIso()}] Pipeline failure callback failed: ${e.message}`);
      });
    }

    return;
  }

  // Gate passed — auto-commit any uncommitted changes in the worktree
  if (pipeline.worktreePath && phase.worktree) {
    try {
      const { execSync } = require("child_process");
      const phaseDir = pipeline.worktreePath;
      const statusOut = execSync("git status --porcelain", { cwd: phaseDir, encoding: "utf8", timeout: 10000 }).trim();
      if (statusOut) {
        execSync("git add -A", { cwd: phaseDir, encoding: "utf8", timeout: 15000 });
        execSync(`git commit -m "feat: ${phase.name} phase complete (${pipeline.issueKey})\n\nPipeline: ${pipeline.pipelineId}\nAgent: ${phase.agent}"`, {
          cwd: phaseDir, encoding: "utf8", timeout: 30000,
          env: { ...process.env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "CertPilot Runner", GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "runner@local.invalid", GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || process.env.GIT_AUTHOR_NAME || "CertPilot Runner", GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || process.env.GIT_AUTHOR_EMAIL || "runner@local.invalid" }
        });
        console.log(`[${nowIso()}] Auto-committed uncommitted changes in worktree for ${pipeline.issueKey} phase ${phase.name}`);
      }
    } catch (e) {
      console.warn(`[${nowIso()}] Auto-commit warning for ${pipeline.issueKey} phase ${phase.name}: ${e.message}`);
    }
  }

  // Gate passed
  phase.status = "completed";


  jobEmitter.emit("pipeline:gate-passed", {
    pipelineId: pipeline.pipelineId,
    phase: phase.name,
    phaseIndex,
    reason: gateResult.reason,
  });

  jobEmitter.emit("pipeline:phase-complete", {
    pipelineId: pipeline.pipelineId,
    phase: phase.name,
    phaseIndex,
    jobId: job.jobId,
    status: "completed",
  });

  console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} phase ${phase.name} completed and gate passed`);

  // Dynamic gating: planner phase selects which subsequent phases to run
  if (phase.dynamicGating) {
    applyDynamicPhaseGating(pipeline, phase, job);
  }

  // Merge is deferred to pipeline completion (advancePipeline) so that
  // code-review and QA (verify) phases run on the implementation branch.
  // If QA fails, the verify-fix-loop sends the implementer back to fix on
  // the same branch before QA re-runs.  Only when QA passes does the branch
  // get merged into main.

  // Send pipeline phase progress callback for Slack notifications
  if (pipeline.callbackUrl) {
    const completedCount = pipeline.phases.filter(p => p.status === "completed" || p.status === "skipped").length;
    const totalPhases = pipeline.phases.length;
    const nextPhase = pipeline.phases.find(p => p.status === "pending") || null;
    const nextPhaseName = nextPhase ? nextPhase.name : null;
    const progress = totalPhases > 0 ? Math.round((completedCount / totalPhases) * 100) : 0;

    const phaseProgressPayload = {
      event: "pipeline:phase-complete",
      pipelineId: pipeline.pipelineId,
      issueKey: pipeline.issueKey,
      pipelineType: pipeline.pipelineType,
      completedPhase: phase.name,
      completedPhaseIndex: phaseIndex,
      totalPhases,
      completedCount,
      nextPhase: nextPhaseName,
      progress,
      slack: pipeline.slack || null,
      telegram: pipeline.telegram || null,
      message: `${pipeline.issueKey}: Phase ${completedCount}/${totalPhases} complete (${phase.name}). Next: ${nextPhaseName || "done"}.`,
    };
    const mockPhaseJob = { jobId: pipeline.pipelineId, logFile: path.join(LOG_DIR, `${pipeline.pipelineId}.log`) };
    if (!fs.existsSync(mockPhaseJob.logFile)) {
      fs.writeFileSync(mockPhaseJob.logFile, `[${nowIso()}] Pipeline phase complete\n`, "utf8");
    }
    sendCallbackWithRetry(pipeline.callbackUrl, phaseProgressPayload, mockPhaseJob).catch(e => {
      console.error(`[${nowIso()}] Pipeline phase progress callback failed: ${e.message}`);
    });
  }

  // Update context bridge with phase summary
  updateContextBridge(pipeline, phase, job);

  // Advance to next phase
  await advancePipeline(pipeline);
}

/**
 * Parse [TEAMMATE-LOG]...[/TEAMMATE-LOG] blocks from Claude output.
 * Returns array of { agent, started, completed, summary }
 */
function extractTeammateLog(output) {
  if (!output) return [];
  const results = [];
  const blockPattern = /\[TEAMMATE-LOG\]([\s\S]*?)\[\/TEAMMATE-LOG\]/g;
  let match;
  while ((match = blockPattern.exec(output)) !== null) {
    const block = match[1].trim();
    const entry = { agent: null, started: null, completed: null, summary: "" };

    const agentMatch = block.match(/agent:\s*(.+)/i);
    if (agentMatch) entry.agent = agentMatch[1].trim();

    const startedMatch = block.match(/started:\s*(.+)/i);
    if (startedMatch) entry.started = startedMatch[1].trim();

    const completedMatch = block.match(/completed:\s*(.+)/i);
    if (completedMatch) entry.completed = completedMatch[1].trim();

    // Summary is everything after the key-value lines
    const summaryMatch = block.match(/summary:\s*([\s\S]+)/i);
    if (summaryMatch) entry.summary = summaryMatch[1].trim();

    results.push(entry);
  }
  return results;
}

/**
 * Build a chronological timeline for a Jira issue by scanning all jobs.
 * Includes pipeline phase metadata and teammate activity.
 */
async function buildTimelineForIssue(issueKey) {
  const timeline = [];

  // Scan in-memory jobs
  for (const job of jobs.values()) {
    if (job.issueKey !== issueKey) continue;

    const entry = {
      jobId: job.jobId,
      agent: job.agent || null,
      mode: job.mode,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      pipelineId: job.pipelineId || null,
      pipelinePhase: job.pipelinePhase || null,
      model: job.selectedModel || job.model || null,
      estimatedCostUsd: job.usage?.estimatedCostUsd || null,
      error: job.error || null,
      teammateActivity: [],
    };

    // Extract teammate logs from output if available
    if (job.stdout || job.parsedOutput?.result) {
      const rawText = (job.parsedOutput?.result || "") + (job.stdout || "");
      entry.teammateActivity = extractTeammateLog(rawText);
    }

    timeline.push(entry);
  }

  // Also scan DB for historical jobs not in memory
  try {
    const dbJobs = await db.jobs.findByIssueKey(issueKey);
    for (const entry of dbJobs) {
      if (jobs.has(entry.jobId)) continue; // Already included above
      timeline.push({
        jobId: entry.jobId,
        agent: entry.agent || null,
        mode: entry.mode,
        status: entry.status,
        createdAt: entry.createdAt,
        startedAt: entry.startedAt || null,
        finishedAt: entry.finishedAt || null,
        pipelineId: null,
        pipelinePhase: null,
        model: entry.selectedModel || entry.model || null,
        estimatedCostUsd: entry.estimatedCostUsd || null,
        error: entry.error || null,
        teammateActivity: [],
      });
    }
  } catch {}

  // Sort chronologically
  timeline.sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return aTime - bTime;
  });

  return timeline;
}

/**
 * Metrics store for tracking usage and costs (Phase 4.3)
 */
const metrics = {
  jobs: { total: 0, succeeded: 0, failed: 0, cancelled: 0, retried: 0 },
  byAgent: {}, // agent -> { total, succeeded, failed, tokens, cost }
  byProduct: {}, // productId -> { total, succeeded, failed, tokens, cost }
  tokens: { input: 0, output: 0 },
  costs: { total: 0 },
  latency: { sum: 0, count: 0 },
  chrome: { sessionsEnabled: 0, sessionsUsed: 0, toolCalls: 0, byTool: {} },
  updatedAt: null
};

const METRICS_FILE = path.join(LOG_DIR, "metrics.json");

/**
 * Skill usage telemetry store.
 * Tracks when agents read skill files or run skill scripts.
 * Persisted in runner-state.json.
 *
 * Shape: { [skillName]: { reads, scriptRuns, lastUsed, byAgent: { [agentName]: count } } }
 */
const skillUsage = {};

/**
 * Detect a skill event from a tool_use input.
 * Returns { skillName, eventType } or null if not skill-related.
 * @param {string} toolName - e.g. "Read", "Bash"
 * @param {object|string} toolInput - raw tool input from Claude stream
 */
function detectSkillEvent(toolName, toolInput) {
  // Normalise: if input is a string, attempt to extract relevant field via regex
  let filePath = null;
  let command = null;

  if (typeof toolInput === "object" && toolInput !== null) {
    filePath = toolInput.file_path || null;
    command = toolInput.command || null;
  } else if (typeof toolInput === "string") {
    // Fallback: treat the whole string as a potential path or command
    filePath = toolInput;
    command = toolInput;
  }

  if (toolName === "Read" && filePath) {
    // Match /skills/<skillName>/ anywhere in the path (handles absolute paths in containers)
    const m = filePath.match(/(?:^|\/)skills\/([^/]+)\//);
    if (m) return { skillName: m[1], eventType: "read" };
    // Standalone MASTER.md or OVERRIDES.md directly under a skill directory
    const m2 = filePath.match(/(?:^|\/)skills\/([^/]+)\/(MASTER\.md|OVERRIDES\.md)$/);
    if (m2) return { skillName: m2[1], eventType: "read" };
  }

  if (toolName === "Bash" && command) {
    // Match skills/<name>/scripts/ after start-of-string, whitespace, or slash
    const m = command.match(/(?:^|[\s/])skills\/([^/\s]+)\/scripts\//);
    if (m) return { skillName: m[1], eventType: "scriptRun" };
  }

  return null;
}

/**
 * Record a skill usage event.
 * @param {string} skillName - e.g. "ux-design", "sales"
 * @param {"read"|"scriptRun"} eventType
 * @param {string} agentName - agent that triggered the event
 */
function trackSkillUsage(skillName, eventType, agentName) {
  if (!skillUsage[skillName]) {
    skillUsage[skillName] = { reads: 0, scriptRuns: 0, lastUsed: null, byAgent: {} };
  }
  const entry = skillUsage[skillName];
  if (eventType === "read") entry.reads++;
  if (eventType === "scriptRun") entry.scriptRuns++;
  entry.lastUsed = nowIso();
  const agent = agentName || "unknown";
  entry.byAgent[agent] = (entry.byAgent[agent] || 0) + 1;
  db.skillUsage.increment(skillName, eventType, agentName).catch(e => console.error('[db] skillUsage increment failed: ' + e.message));

}

function loadMetrics() {
  try {
    if (fs.existsSync(METRICS_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(METRICS_FILE, "utf8"));
      Object.assign(metrics, loaded);
    }
  } catch {}
}

function saveMetrics() {
  metrics.updatedAt = nowIso();
  fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2), "utf8");
  db.metrics.set(metrics).catch(e => console.error('[db] metrics persist failed: ' + e.message));
}

function updateMetrics(job, status, usage = null) {
  metrics.jobs.total++;
  metrics.jobs[status] = (metrics.jobs[status] || 0) + 1;

  const agent = job.agent || "default";
  if (!metrics.byAgent[agent]) {
    metrics.byAgent[agent] = { total: 0, succeeded: 0, failed: 0, tokens: 0, cost: 0 };
  }
  metrics.byAgent[agent].total++;
  metrics.byAgent[agent][status] = (metrics.byAgent[agent][status] || 0) + 1;

  // Per-product metrics
  const product = resolveProduct(job.workingDir);
  const productId = product?.id || "unknown";
  if (!metrics.byProduct[productId]) {
    metrics.byProduct[productId] = { total: 0, succeeded: 0, failed: 0, tokens: 0, cost: 0 };
  }
  metrics.byProduct[productId].total++;
  metrics.byProduct[productId][status] = (metrics.byProduct[productId][status] || 0) + 1;

  if (usage) {
    metrics.tokens.input += usage.inputTokens || 0;
    metrics.tokens.output += usage.outputTokens || 0;
    metrics.costs.total += usage.estimatedCostUsd || 0;
    metrics.byAgent[agent].tokens += (usage.inputTokens || 0) + (usage.outputTokens || 0);
    metrics.byAgent[agent].cost += usage.estimatedCostUsd || 0;
    metrics.byProduct[productId].tokens += (usage.inputTokens || 0) + (usage.outputTokens || 0);
    metrics.byProduct[productId].cost += usage.estimatedCostUsd || 0;
  }

  if (job.startedAt && job.finishedAt) {
    const latencyMs = new Date(job.finishedAt) - new Date(job.startedAt);
    metrics.latency.sum += latencyMs;
    metrics.latency.count++;
  }

  saveMetrics();
}

// Load metrics on startup
loadMetrics();

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

function pruneCompletedJobs() {
  db.jobs.pruneTerminal(JOB_STATE_RETENTION_DAYS).then(pruned => {
    if (pruned > 0) console.log(`[${nowIso()}] Pruned ${pruned} terminal jobs from DB`);
  }).catch(e => console.error(`[db] pruneTerminal failed: ${e.message}`));

  db.pipelines.pruneTerminal(JOB_STATE_RETENTION_DAYS).catch(e => console.error(`[db] pipeline pruneTerminal failed: ${e.message}`));
  db.meetings.pruneOld(JOB_STATE_RETENTION_DAYS).catch(e => console.error(`[db] meeting pruneOld failed: ${e.message}`));
  db.scheduled.pruneOld(JOB_STATE_RETENTION_DAYS).catch(e => console.error(`[db] scheduled pruneOld failed: ${e.message}`));
  db.idempotency.prune(config.idempotencyTtlHours || 72).catch(e => console.error(`[db] idempotency prune failed: ${e.message}`));
}

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
      // pipeline-resume path own re-execution. EOS-653 (2026-04-26) hit this.
      if (job.status === "running" || job.status === "queued" || job.status === "retry-pending" || job.status === "quality-gate-retry") {
        job.status = "failed";
        job.error = "Process interrupted (runner restart)";
        job.finishedAt = job.finishedAt || new Date().toISOString();
        const maxRetries = job.maxRetries ?? MAX_RETRIES;
        if ((job.retryCount || 0) < maxRetries && !job.pipelineId) {
          job.status = "retry-pending";
          job.retryCount = (job.retryCount || 0) + 1;
          job.retryAt = new Date(Date.now() + 5000).toISOString();
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
 * ============================================================
 * SCHEDULER — Deferred jobs and scheduled meetings
 * Persisted in state, checked every 60 seconds.
 * ============================================================
 */
const scheduledItems = new Map(); // id -> { type: "job"|"meeting", scheduledAt, data, source, createdAt }

/**
 * Parse relative time strings into absolute Date.
 * Supports: "tomorrow 09:00", "in 2 hours", "next Monday 10:00", ISO dates, etc.
 */
function parseScheduleTime(timeStr) {
  if (!timeStr) return null;
  const s = timeStr.trim();

  // Already ISO? e.g. "2026-03-10T09:00:00Z" or "2026-03-10 09:00"
  const isoDate = new Date(s.replace(" ", "T"));
  if (!isNaN(isoDate.getTime()) && s.match(/^\d{4}-/)) return isoDate;

  const now = new Date();

  // "in X hours/minutes/days"
  const inMatch = s.match(/^in\s+(\d+)\s+(hour|minute|min|day|week)s?$/i);
  if (inMatch) {
    const n = parseInt(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    const ms = unit.startsWith("hour") ? n * 3600000
      : unit.startsWith("min") ? n * 60000
      : unit.startsWith("day") ? n * 86400000
      : unit.startsWith("week") ? n * 604800000 : 0;
    return new Date(now.getTime() + ms);
  }

  // "tomorrow HH:MM" or just "tomorrow"
  const tomorrowMatch = s.match(/^tomorrow\s*(\d{1,2}:\d{2})?$/i);
  if (tomorrowMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    if (tomorrowMatch[1]) {
      const [h, m] = tomorrowMatch[1].split(":").map(Number);
      d.setHours(h, m, 0, 0);
    } else {
      d.setHours(9, 0, 0, 0); // default 9am
    }
    return d;
  }

  // "next Monday/Tuesday/... HH:MM"
  const dayNames = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const nextDayMatch = s.match(/^next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*(\d{1,2}:\d{2})?$/i);
  if (nextDayMatch) {
    const targetDay = dayNames.indexOf(nextDayMatch[1].toLowerCase());
    const d = new Date(now);
    let daysAhead = targetDay - d.getDay();
    if (daysAhead <= 0) daysAhead += 7;
    d.setDate(d.getDate() + daysAhead);
    if (nextDayMatch[2]) {
      const [h, m] = nextDayMatch[2].split(":").map(Number);
      d.setHours(h, m, 0, 0);
    } else {
      d.setHours(9, 0, 0, 0);
    }
    return d;
  }

  // "today HH:MM"
  const todayMatch = s.match(/^today\s+(\d{1,2}:\d{2})$/i);
  if (todayMatch) {
    const d = new Date(now);
    const [h, m] = todayMatch[1].split(":").map(Number);
    d.setHours(h, m, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1); // if past, push to tomorrow
    return d;
  }

  return null; // Couldn't parse — will execute immediately
}

function scheduleItem(item) {
  const id = `sched_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const scheduledEntry = { ...item, id, createdAt: nowIso() };
  scheduledItems.set(id, scheduledEntry);
  db.scheduled.set(scheduledEntry).catch(e => console.error('[db] scheduled persist failed: ' + e.message));

  console.log(`[${nowIso()}] Scheduled ${item.type}: "${(item.data?.topic || item.data?.task || "").substring(0, 60)}" for ${item.scheduledAt}`);
  return id;
}

/**
 * Schedule Acceleration: When a scheduled job completes successfully,
 * check if downstream scheduled items from the same meeting can fire early.
 * Items are brought forward to now + accelerationDelayMs.
 */
function accelerateScheduledItems(completedJob) {
  if (!config.scheduler?.accelerateOnCompletion) return;

  // Only accelerate if this job came from a scheduled item
  const sourceMatch = completedJob.source?.match(/^meeting:(.+)$/);
  if (!sourceMatch) return;
  const meetingSource = completedJob.source;

  // Find pending items from the same meeting source, sorted by scheduledAt
  const pendingFromSameMeeting = [];
  for (const [id, item] of scheduledItems.entries()) {
    if (item.status !== "pending") continue;
    if (item.source !== meetingSource) continue;
    pendingFromSameMeeting.push({ id, item });
  }

  if (pendingFromSameMeeting.length === 0) return;

  // Sort by scheduledAt (earliest first)
  pendingFromSameMeeting.sort((a, b) =>
    new Date(a.item.scheduledAt).getTime() - new Date(b.item.scheduledAt).getTime()
  );

  // Only accelerate the NEXT item in sequence (not all at once)
  const next = pendingFromSameMeeting[0];
  const originalTime = next.item.scheduledAt;
  const delayMs = config.scheduler?.accelerationDelayMs || 300000; // 5 min default
  const newTime = new Date(Date.now() + delayMs).toISOString();

  // Don't accelerate if it's already due soon (within 2x the delay)
  const timeUntilOriginal = new Date(originalTime).getTime() - Date.now();
  if (timeUntilOriginal < delayMs * 2) {
    console.log(`[${nowIso()}] Schedule acceleration: "${(next.item.data?.task || next.item.data?.topic || "").substring(0, 60)}" already due in ${Math.round(timeUntilOriginal / 60000)}min, skipping`);
    return;
  }

  // Optionally run GLM readiness check
  if (config.scheduler?.glmReadinessCheck && process.env.ZAI_API_KEY) {
    // Fire async — don't block the completion flow
    checkGlmReadiness(completedJob, next).then(ready => {
      if (ready) {
        doAccelerate(next, originalTime, newTime, completedJob);
      } else {
        console.log(`[${nowIso()}] Schedule acceleration: GLM says "${(next.item.data?.task || "").substring(0, 60)}" not ready yet, keeping original schedule`);
      }
    }).catch(err => {
      console.log(`[${nowIso()}] Schedule acceleration: GLM check failed (${err.message}), accelerating anyway`);
      doAccelerate(next, originalTime, newTime, completedJob);
    });
    return;
  }

  doAccelerate(next, originalTime, newTime, completedJob);
}

function doAccelerate(next, originalTime, newTime, completedJob) {
  next.item.scheduledAt = newTime;
  next.item.acceleratedFrom = originalTime;
  next.item.acceleratedBy = completedJob.jobId;


  const savedHours = Math.round((new Date(originalTime).getTime() - new Date(newTime).getTime()) / 3600000 * 10) / 10;
  const taskDesc = (next.item.data?.task || next.item.data?.topic || "unknown").substring(0, 80);
  console.log(`[${nowIso()}] Schedule acceleration: "${taskDesc}" brought forward ${savedHours}h (was ${originalTime}, now ${newTime})`);

  // Emit SSE event
  if (config.sseEnabled) {
    jobEmitter.emit("schedule:accelerated", {
      scheduledItemId: next.id,
      type: next.item.type,
      originalTime,
      newTime,
      savedHours,
      acceleratedBy: completedJob.jobId,
      agent: completedJob.agent,
      task: taskDesc,
    });
  }
}

async function checkGlmReadiness(completedJob, nextItem) {
  const https = require("https");
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) return true; // No key = skip check, just accelerate

  const completedTask = completedJob.meetingAction?.task || completedJob.prompt?.substring(0, 500) || "unknown";
  const completedOutput = extractAssistantText(completedJob.parsedOutput)?.substring(0, 1000) || "completed successfully";
  const nextTask = nextItem.item.data?.task || nextItem.item.data?.topic || "unknown";

  const prompt = `A team of AI agents is working through a sequence of tasks from a meeting. The previous task just completed. Determine if the next task can start now.

COMPLETED TASK: ${completedTask}
RESULT SUMMARY: ${completedOutput}

NEXT TASK: ${nextTask}

Can the next task start now based on the completed result? Answer only YES or NO, then one sentence explaining why.`;

  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model: config.scheduler?.glmModel || "GLM-5",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0,
    });

    const url = new URL("https://api.z.ai/api/anthropic/v1/messages");
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(postData),
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const result = JSON.parse(body);
          const answer = result.content?.[0]?.text || "";
          const isReady = answer.trim().toUpperCase().startsWith("YES");
          console.log(`[${nowIso()}] GLM readiness check: ${isReady ? "READY" : "NOT READY"} — ${answer.substring(0, 100)}`);
          resolve(isReady);
        } catch (e) {
          resolve(true); // Parse error = assume ready
        }
      });
    });

    req.on("error", () => resolve(true));
    req.on("timeout", () => { req.destroy(); resolve(true); });
    req.write(postData);
    req.end();
  });
}

function tickScheduler() {
  const now = Date.now();
  for (const [id, item] of scheduledItems.entries()) {
    if (item.status === "done" || item.status === "cancelled") continue;
    const schedTime = new Date(item.scheduledAt).getTime();
    if (isNaN(schedTime) || schedTime > now) continue;

    // Time to execute
    console.log(`[${nowIso()}] Scheduler: firing ${item.type} "${(item.data?.topic || item.data?.task || "").substring(0, 60)}" (was scheduled for ${item.scheduledAt})`);

    if (item.type === "meeting") {
      // Dedup: skip if a meeting with same topic is already active
      const dup = checkMeetingDuplicate(item.data?.topic);
      if (dup.duplicate && dup.reason === "active") {
        console.log(`[${nowIso()}] Scheduler dedup: skipping "${item.data?.topic}" — already active as ${dup.existingId}`);
        item.status = "cancelled";
        item.cancelReason = `Duplicate of active meeting ${dup.existingId}`;
      
        continue;
      }

      // Create and start the meeting
      const d = item.data;
      // Resolve workingDir: explicit > product lookup > default
      let meetingWorkingDir = d.workingDir;
      if (!meetingWorkingDir && d.product) {
        const prod = products.get(d.product);
        if (prod && prod.workingDir) meetingWorkingDir = prod.workingDir;
      }
      // Normalize mode from stored data; default to "directed" (chair-based).
      const scheduledMode = normalizeMode(d.mode || "directed");
      const meeting = createMeeting({
        topic: d.topic,
        agents: d.agents || ["product-manager"],
        facilitator: d.facilitator || d.agents?.[0] || "product-manager",
        // Explicit chair only — selectChair() inside createMeeting applies smart default.
        chair: d.chair || null,
        mode: scheduledMode,
        roundRobin: true,
        autoDiscuss: true,
        maxRounds: d.maxRounds || 3,
        maxTurns: d.maxTurns || (scheduledMode === "roundRobin" ? 0 : 20),
        workingDir: meetingWorkingDir || DEFAULT_WORKING_DIR,
        telegram: d.telegram || null,
        callbackUrl: d.callbackUrl || N8N_CALLBACK_URL || null,
      });
      console.log(`[${nowIso()}] Scheduler: created meeting ${meeting.meetingId} topic="${meeting.topic}"`);
      const discussFn = meeting.mode === "chair" ? runChairDiscussion : runAutoDiscussion;
      discussFn(meeting).catch(err => {
        console.error(`[${nowIso()}] Scheduler: ${meeting.mode}-discussion error for ${meeting.meetingId}: ${err.message}`);
        meeting.status = "ended";
        meeting.endedAt = nowIso();
        meeting.summary = `Meeting ended due to error: ${err.message}`;
        db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));
      
      });
      item.status = "done";
      item.firedAt = nowIso();
      item.meetingId = meeting.meetingId;

    } else if (item.type === "job") {
      // Create and queue the job
      const d = item.data;
      // Resolve workingDir: explicit > product lookup > default
      let scheduledWorkingDir = d.workingDir;
      if (!scheduledWorkingDir && d.product) {
        const prod = products.get(d.product);
        if (prod && prod.workingDir) scheduledWorkingDir = prod.workingDir;
      }
      // Propagate meeting action context so closeMeetingJiraTask can transition
      // the [Meeting] subtask to Done after the scheduled job succeeds.
      let meetingAction = null;
      if (typeof item.source === "string" && item.source.startsWith("meeting:") && d.task) {
        meetingAction = {
          task: d.task,
          priority: d.priority || null,
          meetingId: item.source.slice("meeting:".length),
        };
      }
      const jobId = makeJobId();
      const logFile = path.join(LOG_DIR, `${jobId}.log`);
      const metaFile = path.join(LOG_DIR, `${jobId}.json`);
      const job = {
        jobId,
        status: "queued",
        mode: "agent",
        agent: d.agent,
        prompt: d.prompt,
        context: d.context || "",
        workingDir: scheduledWorkingDir || DEFAULT_WORKING_DIR,
        issueKey: d.issueKey || null,
        model: config.routing?.agentToModel?.[d.agent] || "sonnet",
        selectedModel: null,
        requestedProvider: null,
        callbackUrl: config.callbackUrl || null,
        logFile,
        metaFile,
        createdAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        pid: null,
        output: null,
        error: null,
        retryCount: 0,
        maxRetries: config.maxRetries || 3,
        source: item.source || "scheduler",
        scheduledItemId: id,
        meetingAction,
      };
      jobs.set(jobId, job);
      db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
      queue.push({ jobId });
      tickWorker();
      item.status = "done";
      item.firedAt = nowIso();
      item.jobId = jobId;
      console.log(`[${nowIso()}] Scheduler: queued job ${jobId} agent=${d.agent}`);

      if (config.sseEnabled) {
        jobEmitter.emit("job:queued", { jobId, agent: d.agent, source: item.source || "scheduler" });
      }
    }

  
  }
}

// ─── Sprint Runner ──────────────────────────────────────────────────────────
// Periodically scans active sprints across all products and dispatches
// "To Do" issues as pipelines or direct agent jobs.
// ─────────────────────────────────────────────────────────────────────────────

const SPRINT_RUNNER_PRIORITY_ORDER = ["Highest", "High", "Medium", "Low", "Lowest"];

async function jiraAgileGet(apiPath) {
  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return null;
  const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const url = `${baseUrl}/rest/agile/1.0${apiPath}`;
  try {
    return await getJson(url, { authorization: auth });
  } catch (e) {
    console.error(`[sprint-runner] Agile API error ${apiPath}: ${e.message}`);
    return null;
  }
}

async function jiraAgilePost(apiPath, body) {
  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return null;
  const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const url = `${baseUrl}/rest/agile/1.0${apiPath}`;
  try {
    return await postJson(url, body, { authorization: auth });
  } catch (e) {
    console.error(`[sprint-runner] Agile POST error ${apiPath}: ${e.message}`);
    return null;
  }
}

/**
 * Move a subtask into the same sprint as its parent issue.
 * Looks up the parent's sprint via Agile API and moves the subtask into it.
 * This ensures subtasks are dispatchable by the sprint-runner.
 */
async function moveSubtaskToParentSprint(subtaskKey, parentKey) {
  if (!subtaskKey || !parentKey) return;
  try {
    // Get the parent issue's sprint via Agile API
    const parentRes = await jiraAgileGet(`/issue/${parentKey}?fields=sprint`);
    if (!parentRes || parentRes.statusCode !== 200) {
      console.log(`[sprint-inherit] ${subtaskKey}: failed to get parent ${parentKey} sprint info (${parentRes?.statusCode || "no response"})`);
      return;
    }
    const sprint = parentRes.json?.fields?.sprint;
    if (!sprint || !sprint.id) {
      console.log(`[sprint-inherit] ${subtaskKey}: parent ${parentKey} is not in any sprint, skipping`);
      return;
    }
    if (sprint.state === "closed") {
      console.log(`[sprint-inherit] ${subtaskKey}: parent ${parentKey} sprint ${sprint.id} (${sprint.name}) is closed, skipping`);
      return;
    }

    // Move subtask into parent's sprint
    const moveRes = await jiraAgilePost(`/sprint/${sprint.id}/issue`, { issues: [subtaskKey] });
    if (moveRes && (moveRes.statusCode === 204 || moveRes.statusCode === 200)) {
      console.log(`[sprint-inherit] ${subtaskKey}: moved to sprint ${sprint.id} (${sprint.name}) — inherited from parent ${parentKey}`);
    } else {
      console.log(`[sprint-inherit] ${subtaskKey}: failed to move to sprint ${sprint.id} (${moveRes?.statusCode || "no response"}) ${(moveRes?.body || "").substring(0, 200)}`);
    }
  } catch (e) {
    console.error(`[sprint-inherit] ${subtaskKey}: error inheriting sprint from ${parentKey}: ${e.message}`);
  }
}

async function jiraRestGet(apiPath) {
  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return null;
  const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const url = `${baseUrl}/rest/api/3${apiPath}`;
  try {
    return await getJson(url, { authorization: auth });
  } catch (e) {
    console.error(`[sprint-runner] REST API error ${apiPath}: ${e.message}`);
    return null;
  }
}

async function jiraRestPut(apiPath, payload) {
  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return null;
  const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const url = `${baseUrl}/rest/api/3${apiPath}`;
  try {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    return await new Promise((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.request({
        method: "PUT",
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + (u.search || ""),
        headers: { "content-type": "application/json", "content-length": body.length, authorization: auth },
      }, (res) => {
        let data = "";
        res.on("data", (d) => (data += d.toString()));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  } catch (e) {
    console.error(`[sprint-runner] REST PUT error ${apiPath}: ${e.message}`);
    return null;
  }
}

/**
 * After a standalone implementer's branch is merged into dev, the issue's
 * downstream agent labels (engineer-reviewer/qa-agent/product-manager) are
 * obsolete — there's nothing to review on the dead feature branch. Strip them
 * so the reconciler doesn't keep firing read-only agents that have nothing to do.
 * Leaves any non-engineering agent labels (security-agent etc.) intact.
 */
async function stripDownstreamLabelsAfterMerge(issueKey) {
  if (!issueKey) return;
  const stripLabels = new Set([
    "agent:engineer-reviewer",
    "agent:reviewer",
    "agent:engineer-implementer",
    "agent:implementer",
  ]);
  const issueRes = await jiraRestGet(`/issue/${issueKey}?fields=labels`);
  if (!issueRes || issueRes.statusCode !== 200) return;
  const currentLabels = issueRes.json?.fields?.labels || [];
  const updatedLabels = currentLabels.filter(l => !stripLabels.has(l));
  if (updatedLabels.length === currentLabels.length) return;
  const removed = currentLabels.filter(l => !updatedLabels.includes(l));
  await jiraRestPut(`/issue/${issueKey}`, { fields: { labels: updatedLabels } });
  console.log(`[${nowIso()}] standalone-merge: stripped labels [${removed.join(", ")}] from ${issueKey}`);
}

async function transitionIssueToInProgress(issueKey) {
  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return;
  const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: auth };
  try {
    const transRes = await getJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, headers);
    if (transRes.statusCode !== 200) return;
    const transitions = transRes.json?.transitions || [];
    const ipTrans = transitions.find(t => t.name?.toLowerCase() === "in progress");
    if (!ipTrans) return;
    await postJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: ipTrans.id } }, headers);
    console.log(`[sprint-runner] Transitioned ${issueKey} to In Progress`);
  } catch (e) {
    console.log(`[sprint-runner] Failed to transition ${issueKey}: ${e.message}`);
  }
}

/**
 * Transition a Jira issue to Done. Looks up transitions first (transition ID
 * differs per project workflow) and prefers a transition named "Done", falling
 * back to any transition whose target status is in the "done" category.
 * Returns true on success.
 */
async function transitionIssueToDone(issueKey, reason = "") {
  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return false;
  const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: auth };
  try {
    const transRes = await getJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, headers);
    if (transRes.statusCode !== 200) return false;
    const transitions = transRes.json?.transitions || [];
    let target = transitions.find(t => (t.name || "").toLowerCase() === "done");
    if (!target) target = transitions.find(t => (t.to?.statusCategory?.key || "").toLowerCase() === "done");
    if (!target) {
      console.log(`[verified-close] ${issueKey}: no Done transition available`);
      return false;
    }
    await postJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: target.id } }, headers);
    console.log(`[verified-close] Transitioned ${issueKey} to ${target.name}${reason ? ` (${reason})` : ""}`);
    return true;
  } catch (e) {
    console.log(`[verified-close] Failed to transition ${issueKey}: ${e.message}`);
    return false;
  }
}

/**
 * After a job succeeds, strip every agent:* label that aliases to the just-
 * completed agent. Without this, the periodic agent-label reconciler re-fires
 * the same agent every tick, producing the "no-op verdict" loops that spam
 * Telegram. Pipelines drive their phases via state, not labels, so stripping
 * here is safe mid-pipeline.
 *
 * If the agent's output contains a [VERIFIED-CLOSE] marker, also transition
 * the issue to Done — this lets agents close issues they've verified in a
 * single hop instead of looping forever on "Recommend close as Done".
 */
async function stripOwnAgentLabelsOnSuccess(job) {
  if (!job?.issueKey || !job?.agent) return;
  const agentLabelMap = config.agentLabels || {};
  const ownLabels = new Set();
  for (const [label, agent] of Object.entries(agentLabelMap)) {
    if (agent === job.agent) ownLabels.add(label);
  }
  if (ownLabels.size === 0) return;

  try {
    const issueRes = await jiraRestGet(`/issue/${job.issueKey}?fields=labels,status`);
    if (!issueRes || issueRes.statusCode !== 200) return;
    const statusName = (issueRes.json?.fields?.status?.name || "").toLowerCase();
    if (statusName === "done" || statusName === "closed") return; // already terminal
    const currentLabels = issueRes.json?.fields?.labels || [];
    const updatedLabels = currentLabels.filter(l => !ownLabels.has(l));

    if (updatedLabels.length !== currentLabels.length) {
      const removed = currentLabels.filter(l => !updatedLabels.includes(l));
      await jiraRestPut(`/issue/${job.issueKey}`, { fields: { labels: updatedLabels } });
      console.log(`[strip-own-label] ${job.issueKey}: stripped [${removed.join(", ")}] (agent=${job.agent}, jobId=${job.jobId})`);
    }

    // Scan for [VERIFIED-CLOSE] marker and transition to Done.
    const output = (job.parsedOutput?.result || "") + "\n" + (typeof job.stdout === "string" ? job.stdout : "");
    if (/\[VERIFIED-CLOSE\]/i.test(output)) {
      await transitionIssueToDone(job.issueKey, `agent=${job.agent} jobId=${job.jobId}`);
    }
  } catch (e) {
    console.error(`[strip-own-label] ${job.issueKey} failed: ${e.message}`);
  }
}

/**
 * Meeting gate quarantine.
 *
 * Meeting agents can create Jira issues with `agent:*` labels mid-conversation
 * (via the Jira MCP). When the meeting then gates on approval, the periodic
 * agent-label reconciler (every 15 min) can pick those issues up and dispatch
 * them BEFORE the user approves — bypassing the gate entirely.
 *
 * Fix: on gate fire, find every issue created in the meeting's product project
 * during the meeting window that carries any `agent:*` label, strip those
 * labels, replace with `meeting-pending-approval`, and save the originals on
 * the meeting record so /approve can restore them.
 */
const MEETING_QUARANTINE_LABEL = "meeting-pending-approval";

async function quarantineMeetingCreatedIssues(meeting) {
  if (!meeting?.productId || !meeting?.createdAt) return;
  const product = products.get(meeting.productId);
  const projectKey = product?.jira?.projectKey;
  if (!projectKey) return;

  const agentLabelMap = config.agentLabels || {};
  const agentLabelKeys = Object.keys(agentLabelMap);
  if (!agentLabelKeys.length) return;

  // Jira JQL datetime: "yyyy-MM-dd HH:mm" (no seconds, no T separator).
  const startStr = meeting.createdAt.replace("T", " ").substring(0, 16);
  const labelClause = agentLabelKeys.map(l => `"${l}"`).join(", ");
  const jql = encodeURIComponent(
    `project = ${projectKey} AND created >= "${startStr}" AND labels in (${labelClause})`
  );

  try {
    const res = await jiraRestGet(`/search/jql?jql=${jql}&fields=labels&maxResults=50`);
    if (!res || res.statusCode !== 200) {
      console.log(`[meeting-quarantine] ${meeting.meetingId}: JQL search failed (${res?.statusCode || "no response"})`);
      return;
    }
    const issues = res.json?.issues || [];
    if (!issues.length) {
      console.log(`[meeting-quarantine] ${meeting.meetingId}: no agent-labelled issues created during meeting`);
      return;
    }

    meeting.gatedIssueLabels = meeting.gatedIssueLabels || {};

    for (const issue of issues) {
      const issueKey = issue.key;
      const labels = issue.fields?.labels || [];
      const agentLabels = labels.filter(l => agentLabelMap[l]);
      if (!agentLabels.length) continue;
      // If we've already quarantined this one (e.g., from a prior refine cycle), preserve original map.
      if (!meeting.gatedIssueLabels[issueKey]) {
        meeting.gatedIssueLabels[issueKey] = agentLabels;
      }
      const newLabels = labels.filter(l => !agentLabelMap[l]);
      if (!newLabels.includes(MEETING_QUARANTINE_LABEL)) newLabels.push(MEETING_QUARANTINE_LABEL);
      try {
        await jiraRestPut(`/issue/${issueKey}`, { fields: { labels: newLabels } });
        console.log(`[meeting-quarantine] ${meeting.meetingId}/${issueKey}: stripped [${agentLabels.join(", ")}], added ${MEETING_QUARANTINE_LABEL}`);
      } catch (e) {
        console.error(`[meeting-quarantine] ${meeting.meetingId}/${issueKey}: PUT failed: ${e.message}`);
      }
    }
    db.meetings.set(meeting).catch(e => console.error(`[db] meeting quarantine save failed: ${e.message}`));
  } catch (e) {
    console.error(`[meeting-quarantine] ${meeting.meetingId}: error: ${e.message}`);
  }
}

async function unquarantineMeetingCreatedIssues(meeting) {
  const savedMap = meeting?.gatedIssueLabels || {};
  const keys = Object.keys(savedMap);
  if (!keys.length) return;
  for (const issueKey of keys) {
    const saved = savedMap[issueKey] || [];
    try {
      const res = await jiraRestGet(`/issue/${issueKey}?fields=labels`);
      if (!res || res.statusCode !== 200) continue;
      const labels = res.json?.fields?.labels || [];
      const restored = labels.filter(l => l !== MEETING_QUARANTINE_LABEL);
      for (const l of saved) if (!restored.includes(l)) restored.push(l);
      await jiraRestPut(`/issue/${issueKey}`, { fields: { labels: restored } });
      console.log(`[meeting-unquarantine] ${meeting.meetingId}/${issueKey}: restored [${saved.join(", ")}], removed ${MEETING_QUARANTINE_LABEL}`);
    } catch (e) {
      console.error(`[meeting-unquarantine] ${meeting.meetingId}/${issueKey}: failed: ${e.message}`);
    }
  }
}

async function clearMeetingQuarantineOnly(meeting) {
  const savedMap = meeting?.gatedIssueLabels || {};
  const keys = Object.keys(savedMap);
  if (!keys.length) return;
  for (const issueKey of keys) {
    try {
      const res = await jiraRestGet(`/issue/${issueKey}?fields=labels`);
      if (!res || res.statusCode !== 200) continue;
      const labels = res.json?.fields?.labels || [];
      const filtered = labels.filter(l => l !== MEETING_QUARANTINE_LABEL);
      if (filtered.length === labels.length) continue;
      await jiraRestPut(`/issue/${issueKey}`, { fields: { labels: filtered } });
      console.log(`[meeting-quarantine-clear] ${meeting.meetingId}/${issueKey}: removed ${MEETING_QUARANTINE_LABEL} (work rejected)`);
    } catch (e) {
      console.error(`[meeting-quarantine-clear] ${meeting.meetingId}/${issueKey}: failed: ${e.message}`);
    }
  }
}

function getBlockingDependencies(issue) {
  const blockers = [];
  const links = issue.fields?.issuelinks || [];
  for (const link of links) {
    // inwardIssue with "Blocks" type means "this issue is blocked by inwardIssue"
    // (inwardIssue is the prerequisite that must finish first)
    if (link.type?.name === "Blocks" && link.inwardIssue) {
      const depStatus = link.inwardIssue.fields?.status?.name || "";
      if (depStatus.toLowerCase() !== "done") {
        blockers.push({ key: link.inwardIssue.key, status: depStatus, type: "blocked-by" });
      }
    }
    // outwardIssue with "Blocks" type means "this issue blocks outwardIssue"
    // — that is NOT a blocker of this issue, so we skip it
  }
  return blockers;
}

/**
 * Check if a branch for a given issue key has been merged into a trunk branch (dev or main).
 * Platform pattern is dev-only auto-merges (runner → dev, human-owned dev → main),
 * so a branch landed on dev is "shipped" from the dependency-gate's perspective.
 * Looks for branch patterns: {issueKey}-auto, {issueKey}
 * Also checks pipeline records for completed+merged state.
 * Fails open (returns true) if git check errors — avoids blocking everything.
 */
function isBranchMergedToTrunk(baseRepo, issueKey) {
  const { execSync } = require("child_process");
  const branchPatterns = [`${issueKey}-auto`, issueKey.toLowerCase()];
  const trunks = config.dependencyGating?.trunkBranches || ["dev", "main"];

  try {
    for (const trunk of trunks) {
      let mergedBranches;
      try {
        const merged = execSync(`git branch --merged ${trunk}`, {
          cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"]
        });
        mergedBranches = merged.split("\n").map(b => b.trim().replace(/^\*\s*/, ""));
      } catch (_) {
        // Trunk doesn't exist locally (e.g. only `main` in some repos) — skip it
        continue;
      }

      for (const pattern of branchPatterns) {
        if (mergedBranches.some(b => b === pattern)) return true;
      }

      // Issue key in merge commits on this trunk (branch may have been deleted after merge)
      try {
        const mergeLog = execSync(`git log --oneline --grep="${issueKey}" ${trunk} -5`, {
          cwd: baseRepo, encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"]
        });
        if (mergeLog.trim().length > 0) return true;
      } catch (_) { /* ignore */ }
    }

    // Pipeline records — if a pipeline completed + merged, treat as merged
    for (const p of pipelines.values()) {
      if (p.issueKey === issueKey && p.status === "completed" && p.merged) return true;
    }

    return false;
  } catch (e) {
    console.log(`[${nowIso()}] Dependency check: trunk merge probe failed for ${baseRepo}: ${e.message}`);
    return true; // Fail open
  }
}


/**
 * Get unmerged blocking dependencies for an issue.
 * Fetches Jira issue links and checks both Jira status AND git merge status.
 * Returns array of { key, status, reason, detail } for each unresolved blocker.
 */
async function getUnmergedBlockers(issueKey, baseRepo) {
  if (!config.dependencyGating?.enabled) return [];

  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) return [];

  const authHeader = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: authHeader };

  try {
    const issueRes = await getJson(
      `${baseUrl}/rest/api/3/issue/${issueKey}?fields=issuelinks`,
      headers
    );
    if (issueRes.statusCode !== 200) return [];

    const links = issueRes.json?.fields?.issuelinks || [];
    const blockers = [];

    for (const link of links) {
      // "is blocked by" = inwardIssue with "Blocks" type
      if (link.type?.name === "Blocks" && link.inwardIssue) {
        const blockerKey = link.inwardIssue.key;
        const blockerStatus = link.inwardIssue.fields?.status?.name || "";

        if (blockerStatus.toLowerCase() === "done") {
          // Blocker is Done in Jira — verify branch is actually merged to a trunk (dev or main)
          if (config.dependencyGating?.checkGitMerge !== false) {
            const merged = isBranchMergedToTrunk(baseRepo, blockerKey);
            if (!merged) {
              blockers.push({
                key: blockerKey,
                status: blockerStatus,
                reason: "done-but-not-merged",
                detail: `${blockerKey} is Done but branch not merged to dev or main`
              });
            }
          }
          // If merged, blocker is cleared
        } else {
          blockers.push({
            key: blockerKey,
            status: blockerStatus,
            reason: "not-done",
            detail: `${blockerKey} status: ${blockerStatus}`
          });
        }
      }
    }

    return blockers;
  } catch (e) {
    console.log(`[${nowIso()}] Dependency check failed for ${issueKey}: ${e.message}`);
    return []; // Fail open
  }
}

/**
 * Periodic checker: unblock pipelines whose dependencies have resolved.
 * Runs every N seconds when dependency gating is enabled.
 */
async function tickDependencyChecker() {
  if (!config.dependencyGating?.enabled) return;

  const maxBlockedMs = (config.dependencyGating.maxBlockedMinutes || 120) * 60 * 1000;

  for (const pipeline of pipelines.values()) {
    if (pipeline.status !== "blocked") continue;

    const blockedPhase = pipeline.phases.find(p => p.status === "blocked");
    if (!blockedPhase) {
      // Stale blocked status — fix it
      pipeline.status = "running";
    
      continue;
    }

    // Check if blocked too long — fail the pipeline
    const blockedSince = blockedPhase.blockedAt ? new Date(blockedPhase.blockedAt).getTime() : 0;
    if (blockedSince && (Date.now() - blockedSince) > maxBlockedMs) {
      const blockerStr = (blockedPhase.blockedBy || []).map(b => `${b.key} (${b.detail})`).join(", ");
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} TIMED OUT waiting on: ${blockerStr}`);
      blockedPhase.status = "failed";
      blockedPhase.error = `Dependency timeout: waited ${config.dependencyGating.maxBlockedMinutes}m for ${blockerStr}`;
      pipeline.status = "failed";
      pipeline.error = blockedPhase.error;
      pipeline.completedAt = nowIso();
    

      jobEmitter.emit("pipeline:failed", {
        pipelineId: pipeline.pipelineId,
        issueKey: pipeline.issueKey,
        reason: "dependency-timeout",
        blockedBy: blockedPhase.blockedBy,
      });
      continue;
    }

    // Re-check blockers
    const blockers = await getUnmergedBlockers(pipeline.issueKey, pipeline.workingDir);
    if (blockers.length === 0) {
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} UNBLOCKED: all dependencies merged for ${pipeline.issueKey}`);

      blockedPhase.status = "pending";
      blockedPhase.blockedBy = null;
      blockedPhase.blockedAt = null;
      pipeline.status = "running";
    

      jobEmitter.emit("pipeline:unblocked", {
        pipelineId: pipeline.pipelineId,
        issueKey: pipeline.issueKey,
        phase: blockedPhase.name,
      });

      // Resume pipeline from the unblocked phase
      executePipelinePhase(pipeline, blockedPhase.index);
    } else {
      const blockerStr = blockers.map(b => b.key).join(", ");
      console.log(`[${nowIso()}] Pipeline ${pipeline.pipelineId} still blocked: waiting on ${blockerStr}`);
    }
  }
}

function resolveProductWorkingDir(product) {
  const mappings = config.pathMappings || {};
  const hostDir = product.workingDir;
  if (!hostDir) return null;
  // If a mapping exists (host → container), use the container path
  if (mappings[hostDir]) return mappings[hostDir];
  return hostDir;
}

async function tickSprintRunner() {
  const srConfig = config.sprintRunner || {};
  if (!srConfig.enabled) return;

  const { email, apiToken } = config.jira || {};
  if (!email || !apiToken) {
    console.log(`[sprint-runner] Skipped: JIRA credentials not configured`);
    return;
  }

  const dispatchStatuses = (srConfig.dispatchStatuses || ["To Do"]).map(s => s.toLowerCase());
  const skipLabels = srConfig.skipLabels || ["on-hold", "blocked"];
  const maxPerCycle = srConfig.maxDispatchPerCycle || 5;
  const dryRun = srConfig.dryRun || false;
  const agentLabels = config.agentLabels || {};

  for (const [productId, product] of products) {
    const sprintCfg = product.sprint;
    if (!sprintCfg?.enabled) continue;

    const boardId = sprintCfg.boardId || product.jira?.boardId;
    if (!boardId) {
      console.log(`[sprint-runner] Product ${productId}: no boardId configured, skipping`);
      continue;
    }

    try {
      // 1. Get active sprint
      const sprintRes = await jiraAgileGet(`/board/${boardId}/sprint?state=active`);
      if (!sprintRes || sprintRes.statusCode !== 200) {
        console.log(`[sprint-runner] Product ${productId}: failed to get active sprint (${sprintRes?.statusCode || "no response"})`);
        continue;
      }
      const activeSprints = sprintRes.json?.values || [];
      if (activeSprints.length === 0) {
        console.log(`[sprint-runner] Product ${productId}: no active sprint`);
        continue;
      }
      const sprint = activeSprints[0];

      // 2. Get sprint issues (Agile API returns top-level only, so we also fetch subtasks)
      const issueRes = await jiraAgileGet(`/sprint/${sprint.id}/issue?fields=summary,status,issuetype,labels,priority,issuelinks,parent&maxResults=50`);
      if (!issueRes || issueRes.statusCode !== 200) {
        console.log(`[sprint-runner] Product ${productId}: failed to get sprint issues (${issueRes?.statusCode || "no response"})`);
        continue;
      }
      const topLevelIssues = issueRes.json?.issues || [];
      // Fetch subtasks for each parent to include them (Agile API omits sub-tasks)
      const allIssues = [...topLevelIssues];
      const seenKeys = new Set(topLevelIssues.map(i => i.key));
      for (const issue of topLevelIssues) {
        try {
          const detail = await jiraRestGet(`/issue/${issue.key}?fields=subtasks`);
          if (detail?.statusCode === 200 && detail.json?.fields?.subtasks?.length) {
            for (const st of detail.json.fields.subtasks) {
              if (!seenKeys.has(st.key)) {
                // Fetch full subtask details for dispatch
                const stDetail = await jiraRestGet(`/issue/${st.key}?fields=summary,status,issuetype,labels,priority,issuelinks,parent`);
                if (stDetail?.statusCode === 200 && stDetail.json) {
                  allIssues.push(stDetail.json);
                  seenKeys.add(st.key);
                }
              }
            }
          }
        } catch (e) { /* skip on error, orphan detection below will catch it */ }
      }

      // 3. Filter to dispatchable issues
      // Build set of parent keys that have subtasks in the sprint — skip these parents
      const parentKeysWithSubtasks = new Set();
      const subtaskKeysInSprint = new Set();
      for (const issue of allIssues) {
        const parentKey = issue.fields?.parent?.key;
        if (parentKey) {
          parentKeysWithSubtasks.add(parentKey);
          subtaskKeysInSprint.add(issue.key);
        }
      }

      // Pull orphan subtasks into parent's sprint.
      // For each parent story IN the sprint, check if it has subtasks NOT in the sprint and move them in.
      let movedSubtasks = false;
      for (const issue of allIssues) {
        const issueType = (issue.fields?.issuetype?.name || "").toLowerCase();
        if (issueType === "sub-task" || issueType === "subtask") continue; // skip subtasks themselves
        // Check if this parent story has subtasks at all (via REST API subtasks field)
        try {
          const parentDetail = await jiraRestGet(`/issue/${issue.key}?fields=subtasks`);
          if (parentDetail?.statusCode === 200 && parentDetail.json?.fields?.subtasks?.length) {
            const allSubtasks = parentDetail.json.fields.subtasks;
            const orphans = allSubtasks.filter(st => !subtaskKeysInSprint.has(st.key));
            if (orphans.length > 0) {
              const orphanKeys = orphans.map(st => st.key);
              console.log(`[sprint-runner] Parent ${issue.key} has ${orphans.length} subtask(s) not in sprint: ${orphanKeys.join(", ")}`);
              // Move orphan subtasks into this sprint
              const moveRes = await jiraAgilePost(`/sprint/${sprint.id}/issue`, { issues: orphanKeys });
              if (moveRes && (moveRes.statusCode === 204 || moveRes.statusCode === 200)) {
                console.log(`[sprint-runner] Moved ${orphanKeys.join(", ")} into sprint ${sprint.id} (${sprint.name})`);
                movedSubtasks = true;
                for (const key of orphanKeys) {
                  parentKeysWithSubtasks.add(issue.key);
                  subtaskKeysInSprint.add(key);
                }
              } else {
                console.log(`[sprint-runner] Failed to move subtasks for ${issue.key}: ${moveRes?.statusCode || "no response"}`);
              }
            }
          }
        } catch (e) {
          console.log(`[sprint-runner] Error checking subtasks for ${issue.key}: ${e.message}`);
        }
      }

      // After moving orphans, fetch their details and add to the issue list
      let sprintIssues = allIssues;
      if (movedSubtasks) {
        // Re-scan all parents for newly moved subtasks
        for (const issue of topLevelIssues) {
          try {
            const detail = await jiraRestGet(`/issue/${issue.key}?fields=subtasks`);
            if (detail?.statusCode === 200 && detail.json?.fields?.subtasks?.length) {
              for (const st of detail.json.fields.subtasks) {
                if (!seenKeys.has(st.key)) {
                  const stDetail = await jiraRestGet(`/issue/${st.key}?fields=summary,status,issuetype,labels,priority,issuelinks,parent`);
                  if (stDetail?.statusCode === 200 && stDetail.json) {
                    sprintIssues.push(stDetail.json);
                    seenKeys.add(st.key);
                  }
                }
              }
            }
          } catch (e) { /* skip */ }
        }
      }

      const candidates = sprintIssues.filter(issue => {
        const statusName = (issue.fields?.status?.name || "").toLowerCase();
        if (!dispatchStatuses.includes(statusName)) return false;

        const labels = (issue.fields?.labels || []).map(l => l.toLowerCase());
        if (skipLabels.some(sl => labels.includes(sl.toLowerCase()))) return false;

        // Skip parent stories that have subtasks — only dispatch the subtasks
        const issueType = (issue.fields?.issuetype?.name || "").toLowerCase();
        if (issueType !== "sub-task" && issueType !== "subtask" && parentKeysWithSubtasks.has(issue.key)) {
          console.log(`[sprint-runner] Skipping parent ${issue.key}: has subtasks in sprint — dispatch subtasks instead`);
          return false;
        }

        return true;
      });

      // 4. Check dependencies and sort by priority
      const workingDir = resolveProductWorkingDir(product);
      const dispatchable = [];
      const blocked = [];
      for (const issue of candidates) {
        const blockers = getBlockingDependencies(issue);
        if (blockers.length > 0) {
          blocked.push({ key: issue.key, blockers });
        } else if (config.dependencyGating?.enabled && config.dependencyGating?.checkGitMerge !== false && workingDir) {
          // Additional check: verify "Done" blockers' branches are actually merged to a trunk (dev or main)
          const links = issue.fields?.issuelinks || [];
          const unmergedDone = [];
          for (const link of links) {
            if (link.type?.name === "Blocks" && link.inwardIssue) {
              const depStatus = (link.inwardIssue.fields?.status?.name || "").toLowerCase();
              if (depStatus === "done") {
                const depKey = link.inwardIssue.key;
                if (!isBranchMergedToTrunk(workingDir, depKey)) {
                  unmergedDone.push({ key: depKey, status: "Done (not merged)", type: "done-but-not-merged" });
                }
              }
            }
          }
          if (unmergedDone.length > 0) {
            blocked.push({ key: issue.key, blockers: unmergedDone });
          } else {
            dispatchable.push(issue);
          }
        } else {
          dispatchable.push(issue);
        }
      }

      // Log blocked issues
      for (const b of blocked) {
        const blockerStr = b.blockers.map(bl => `${bl.key} (${bl.status})`).join(", ");
        console.log(`[sprint-runner] Skipping ${b.key}: blocked by ${blockerStr}`);
      }

      // Sort by priority (Highest first)
      dispatchable.sort((a, b) => {
        const pa = SPRINT_RUNNER_PRIORITY_ORDER.indexOf(a.fields?.priority?.name || "Medium");
        const pb = SPRINT_RUNNER_PRIORITY_ORDER.indexOf(b.fields?.priority?.name || "Medium");
        return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
      });

      // 5. Dispatch (up to maxPerCycle)
      if (!workingDir) {
        console.log(`[sprint-runner] Product ${productId}: no workingDir configured, skipping dispatch`);
        continue;
      }

      let dispatched = 0;
      for (const issue of dispatchable) {
        if (dispatched >= maxPerCycle) break;

        const issueKey = issue.key;
        const idempotencyKey = `sprint-run:${issueKey}`;

        // Check idempotency
        pruneIdempotency(idempotencyStore);
        db.idempotency.prune(IDEMPOTENCY_TTL_HOURS).catch(e => console.error('[db] idempotency prune failed: ' + e.message));
        if (idempotencyStore[idempotencyKey]) {
          console.log(`[sprint-runner] SKIP ${issueKey}: idempotency hit (key: ${idempotencyKey})`);
          continue; // Already dispatched recently
        }

        // Check if job already queued/running for this issue
        let alreadyActive = false;
        let activeReason = "";
        for (const j of jobs.values()) {
          if (j.issueKey === issueKey && (j.status === "queued" || j.status === "running")) {
            alreadyActive = true;
            activeReason = `job ${j.id} status=${j.status} agent=${j.agent}`;
            break;
          }
        }
        // Check active pipelines too
        if (!alreadyActive) {
          for (const p of pipelines.values()) {
            if (p.issueKey === issueKey && !["completed", "failed"].includes(p.status)) {
              alreadyActive = true;
              activeReason = `pipeline ${p.pipelineId} status=${p.status}`;
              break;
            }
          }
        }
        if (alreadyActive) {
          console.log(`[sprint-runner] SKIP ${issueKey}: already active — ${activeReason}`);
          continue;
        }

        const issueType = (issue.fields?.issuetype?.name || "").toLowerCase();
        const labels = issue.fields?.labels || [];
        const telegram = product.telegram?.chatId ? { chatId: String(product.telegram.chatId) } : null;

        // --- Gate label enforcement ---
        // Gate labels (needs-requirements, needs-architecture, needs-ux-design) are applied
        // per-subtask at creation time by the planner/PM agent. No propagation from parent.
        // Route to the appropriate gate agent for the specific issue that needs it.
        const GATE_LABEL_TO_AGENT = {
          "needs-requirements": "ba-agent",
          "needs-ux-design": "ux-agent",
          "needs-architecture": "architect-jets",
        };
        const isSubtask = issueType === "sub-task" || issueType === "subtask";
        const gateLabels = labels.filter(l => GATE_LABEL_TO_AGENT[l]);

        if (gateLabels.length > 0) {
          // Route to the first gate agent (priority: requirements > architecture > ux)
          const gateOrder = ["needs-requirements", "needs-architecture", "needs-ux-design"];
          const firstGate = gateOrder.find(g => gateLabels.includes(g)) || gateLabels[0];
          const gateAgent = GATE_LABEL_TO_AGENT[firstGate];

          if (dryRun) {
            console.log(`[sprint-runner] DRY RUN: Would dispatch ${issueKey} → gate agent:${gateAgent} (label: ${firstGate}, product: ${productId})`);
          } else {
            // Dispatch gate agent against this specific issue (subtask or story)
            const jobId = makeJobId();
            const logFile = path.join(LOG_DIR, `${jobId}.log`);
            const metaFile = path.join(LOG_DIR, `${jobId}.json`);
            const job = {
              jobId,
              mode: "delivery",
              issueKey: String(issueKey),
              summary: issue.fields?.summary || "",
              description: "",
              workingDir,
              agent: gateAgent,
              model: config.routing?.agentToModel?.[gateAgent] || null,
              requestedProvider: null,
              selectedModel: null,
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
              callbackUrl: N8N_CALLBACK_URL || null,
              slack: null,
              telegram,
              batchId: null,
              parentKey: isSubtask ? (issue.fields?.parent?.key || null) : null,
              subtaskFiles: null,
              subtaskDepth: 0,
              isSubtask,
              source: "sprint-runner",
              gateLabel: firstGate,
              allGateLabels: gateLabels,
              teamSessionId: null,
              teamRole: null,
              teammates: [],
            };
            jobs.set(jobId, job);
            db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
            fs.writeFileSync(metaFile, JSON.stringify(job, null, 2), "utf8");
            enqueue(jobId);
            console.log(`[sprint-runner] Dispatched ${issueKey} → gate agent:${gateAgent} (label: ${firstGate}, job: ${jobId}, product: ${productId})`);
          }

          idempotencyStore[idempotencyKey] = { jobId: `sprint-${issueKey}`, createdAt: Date.now() };
          db.idempotency.set(idempotencyKey, `sprint-${issueKey}`).catch(e => console.error('[db] idempotency persist failed: ' + e.message));
          saveIdempotency(idempotencyStore);
          dispatched++;
          continue; // Skip normal dispatch — gate agent handles this issue first
        }

        // Check for direct agent label (agent:*)
        const agentLabel = labels.find(l => agentLabels[l]);
        const agentName = agentLabel ? agentLabels[agentLabel] : null;

        // Implementation agents route through pipeline (implement → code-review → verify)
        // Non-implementation agents (architect, PM, etc.) stay as direct dispatch
        const pipelineAgents = new Set(["engineer-implementer", "ui-engineer", "e2e-builder", "qa-agent", "security-agent"]);
        const routeToPipeline = agentName && pipelineAgents.has(agentName);

        try {
          // Safety net: before creating a pipeline for a non-subtask issue,
          // check if it already has subtasks. If so, skip pipeline and pull subtasks into sprint.
          if (!dryRun && issueType !== "sub-task" && issueType !== "subtask" && !agentName) {
            try {
              const parentCheck = await jiraRestGet(`/issue/${issueKey}?fields=subtasks`);
              const existingSubs = parentCheck?.statusCode === 200 ? (parentCheck.json?.fields?.subtasks || []) : [];
              if (existingSubs.length > 0) {
                console.log(`[sprint-runner] ${issueKey} has ${existingSubs.length} existing subtask(s) — skipping pipeline, ensuring subtasks are in sprint`);
                const toMove = existingSubs.map(st => st.key).filter(k => !subtaskKeysInSprint.has(k));
                if (toMove.length > 0) {
                  const moveRes = await jiraAgilePost(`/sprint/${sprint.id}/issue`, { issues: toMove });
                  if (moveRes && (moveRes.statusCode === 204 || moveRes.statusCode === 200)) {
                    console.log(`[sprint-runner] Moved ${toMove.join(", ")} into sprint ${sprint.id} (${sprint.name})`);
                  } else {
                    console.log(`[sprint-runner] Warning: failed to move subtasks for ${issueKey}: ${moveRes?.statusCode}`);
                  }
                }
                // Transition parent to In Progress so it's not re-picked up
                await transitionIssueToInProgress(issueKey);
                idempotencyStore[idempotencyKey] = { jobId: `sprint-${issueKey}`, createdAt: Date.now() };
                db.idempotency.set(idempotencyKey, `sprint-${issueKey}`).catch(e => console.error('[db] idempotency persist failed: ' + e.message));
                saveIdempotency(idempotencyStore);
                dispatched++;
                continue; // Skip pipeline — subtasks will dispatch on next tick
              }
            } catch (e) {
              console.log(`[sprint-runner] Warning: subtask check failed for ${issueKey}: ${e.message} — falling through to normal dispatch`);
            }
          }

          if (dryRun) {
            const dispatchType = routeToPipeline ? `pipeline (agent:${agentName})` : agentName ? `agent:${agentName}` : issueType === "bug" ? "bug-fix pipeline" : "new-feature pipeline";
            console.log(`[sprint-runner] DRY RUN: Would dispatch ${issueKey} as ${dispatchType} (product: ${productId})`);
          } else if (agentName && !routeToPipeline) {
            // Direct agent dispatch (non-implementation agents only)
            const jobId = makeJobId();
            const logFile = path.join(LOG_DIR, `${jobId}.log`);
            const metaFile = path.join(LOG_DIR, `${jobId}.json`);
            const job = {
              jobId,
              mode: "delivery",
              issueKey: String(issueKey),
              summary: issue.fields?.summary || "",
              description: "",
              workingDir,
              agent: agentName,
              model: config.routing?.agentToModel?.[agentName] || null,
              requestedProvider: null,
              selectedModel: null,
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
              callbackUrl: N8N_CALLBACK_URL || null,
              slack: null,
              telegram,
              batchId: null,
              parentKey: issue.fields?.parent?.key || null,
              subtaskFiles: null,
              subtaskDepth: 0,
              isSubtask: issueType === "sub-task" || issueType === "subtask",
              source: "sprint-runner",
              teamSessionId: null,
              teamRole: null,
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
            enqueue(jobId);
            console.log(`[sprint-runner] Dispatched ${issueKey} → agent:${agentName} (job: ${jobId}, product: ${productId})`);
          } else if (routeToPipeline) {
            // Implementation agents route through lean pipeline with agent override
            const pipelineType = issueType === "bug" ? "bug-fix" : "new-feature";
            const parentKey = issue.fields?.parent?.key || null;
            const pipeline = await createPipeline(issueKey, pipelineType, {
              workingDir,
              labels,
              telegram,
              parentKey,
            });
            console.log(`[sprint-runner] Dispatched ${issueKey} → ${pipelineType} pipeline ${pipeline.pipelineId} with agent override ${agentName}${parentKey ? ` (parent: ${parentKey})` : ""} (product: ${productId})`);
          } else if (issueType === "bug" && isSubtask) {
            const parentKey = issue.fields?.parent?.key || null;
            const pipeline = await createPipeline(issueKey, "bug-fix", {
              workingDir,
              labels,
              telegram,
              parentKey,
            });
            console.log(`[sprint-runner] Dispatched ${issueKey} → bug-fix pipeline ${pipeline.pipelineId}${parentKey ? ` (parent: ${parentKey})` : ""} (product: ${productId})`);
          } else if (issueType === "bug" && !isSubtask) {
            // Parent bug → send to bug-triage agent for analysis first
            const jobId = makeJobId();
            const logFile = path.join(LOG_DIR, `${jobId}.log`);
            const metaFile = path.join(LOG_DIR, `${jobId}.json`);
            const job = {
              jobId,
              mode: "delivery",
              issueKey: String(issueKey),
              summary: issue.fields?.summary || "",
              description: "",
              workingDir,
              agent: "bug-triage",
              model: config.routing?.agentToModel?.["bug-triage"] || null,
              requestedProvider: null,
              selectedModel: null,
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
              callbackUrl: N8N_CALLBACK_URL || null,
              slack: null,
              telegram,
              batchId: null,
              parentKey: null,
              subtaskFiles: null,
              subtaskDepth: 0,
              isSubtask: false,
              source: "sprint-runner",
              teamSessionId: null,
              teamRole: null,
              teammates: [],
            };
            jobs.set(jobId, job);
            db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
            fs.writeFileSync(metaFile, JSON.stringify(job, null, 2), "utf8");
            enqueue(jobId);
            console.log(`[sprint-runner] Dispatched ${issueKey} → bug-triage for analysis (job: ${jobId}, product: ${productId})`);
          } else if (labels.includes("needs-design-system")) {
            // Design system bootstrap pipeline
            const pipeline = await createPipeline(issueKey, "design-bootstrap", {
              workingDir,
              labels,
              telegram,
            });
            console.log(`[sprint-runner] Dispatched ${issueKey} → design-bootstrap pipeline ${pipeline.pipelineId} (product: ${productId})`);
          } else if (isSubtask) {
            // Subtask without agent label → new-feature pipeline
            const parentKey = issue.fields?.parent?.key || null;
            const pipeline = await createPipeline(issueKey, "new-feature", {
              workingDir,
              labels,
              telegram,
              parentKey,
            });
            console.log(`[sprint-runner] Dispatched ${issueKey} → new-feature pipeline ${pipeline.pipelineId}${parentKey ? ` (parent: ${parentKey})` : ""} (product: ${productId})`);
          } else {
            // Parent Story/Task with no subtasks → send to engineer-planner for decomposition
            const jobId = makeJobId();
            const logFile = path.join(LOG_DIR, `${jobId}.log`);
            const metaFile = path.join(LOG_DIR, `${jobId}.json`);
            const job = {
              jobId,
              mode: "delivery",
              issueKey: String(issueKey),
              summary: issue.fields?.summary || "",
              description: "",
              workingDir,
              agent: "engineer-planner",
              model: config.routing?.agentToModel?.["engineer-planner"] || null,
              requestedProvider: null,
              selectedModel: null,
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
              callbackUrl: N8N_CALLBACK_URL || null,
              slack: null,
              telegram,
              batchId: null,
              parentKey: null,
              subtaskFiles: null,
              subtaskDepth: 0,
              isSubtask: false,
              source: "sprint-runner",
              teamSessionId: null,
              teamRole: null,
              teammates: [],
            };
            // Planner is a team lead — activate team session
            if (config.teams?.enabled && config.teams.teamLeads?.["engineer-planner"]) {
              job.teamSessionId = `team-${jobId}`;
              job.teamRole = "lead";
              job.teammates = config.teams.teamLeads["engineer-planner"].teammates || [];
            }
            jobs.set(jobId, job);
            db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
            fs.writeFileSync(metaFile, JSON.stringify(job, null, 2), "utf8");
            enqueue(jobId);
            console.log(`[sprint-runner] Dispatched ${issueKey} → engineer-planner for decomposition (job: ${jobId}, product: ${productId})`);
          }

          // Set idempotency key
          idempotencyStore[idempotencyKey] = { jobId: `sprint-${issueKey}`, createdAt: Date.now() };
          db.idempotency.set(idempotencyKey, `sprint-${issueKey}`).catch(e => console.error('[db] idempotency persist failed: ' + e.message));
          saveIdempotency(idempotencyStore);

          // Transition to In Progress to prevent re-dispatch
          await transitionIssueToInProgress(issueKey);

          // Emit SSE event
          jobEmitter.emit("sprint-runner:dispatched", {
            issueKey,
            productId,
            issueType,
            agent: agentName || null,
            pipelineType: agentName ? null : (labels.includes("needs-design-system") ? "design-bootstrap" : (issueType === "bug" ? "bug-fix" : "new-feature")),
            dryRun,
          });

          dispatched++;
        } catch (e) {
          console.error(`[sprint-runner] Error dispatching ${issueKey}: ${e.message}`);
        }
      }

      console.log(`[sprint-runner] Product ${productId}: ${dispatched} dispatched, ${blocked.length} blocked by dependencies, ${candidates.length - dispatched - blocked.length} skipped (idempotency/active)`);
    } catch (e) {
      console.error(`[sprint-runner] Product ${productId} error: ${e.message}`);
    }
  }
}

/**
 * Find which product owns a given Jira issue key (by project key prefix).
 */
function resolveProductForIssueKey(issueKey) {
  if (!issueKey) return null;
  const projectKey = String(issueKey).split("-")[0]?.toUpperCase();
  if (!projectKey) return null;
  for (const [productId, product] of products) {
    if ((product.jira?.projectKey || "").toUpperCase() === projectKey) {
      return { productId, product };
    }
  }
  return null;
}

/**
 * Dispatch any agent:* labels currently on a Jira issue that aren't already
 * being worked. This is the core of the agent-label reconciler — used both
 * by the periodic sweep (B) and the post-job-completion hot path (A).
 *
 * @param {string} issueKey - Jira issue key (e.g., "EOS-664")
 * @param {object} opts
 * @param {string} [opts.excludeAgent] - Skip this agent (avoid self-redispatch when called from job completion)
 * @param {string} [opts.reason] - Logged with dispatch (e.g., "post-job-completion", "reconciler-sweep")
 * @param {object} [opts.preloadedIssue] - Issue JSON if already fetched, avoids extra REST call
 * @returns {Promise<{dispatched: string[], skipped: string[]}>}
 */
async function dispatchAgentLabelsForIssue(issueKey, opts = {}) {
  const { excludeAgent, reason = "agent-label-reconciler", preloadedIssue } = opts;
  const result = { dispatched: [], skipped: [] };

  const resolved = resolveProductForIssueKey(issueKey);
  if (!resolved) {
    result.skipped.push(`${issueKey}: no product matches project key`);
    return result;
  }
  const { productId, product } = resolved;
  const workingDir = resolveProductWorkingDir(product);
  if (!workingDir) {
    result.skipped.push(`${issueKey}: product ${productId} has no workingDir`);
    return result;
  }

  let issue = preloadedIssue;
  if (!issue) {
    const res = await jiraRestGet(`/issue/${issueKey}?fields=summary,status,issuetype,labels,priority,parent`);
    if (!res || res.statusCode !== 200) {
      result.skipped.push(`${issueKey}: failed to fetch (${res?.statusCode || "no response"})`);
      return result;
    }
    issue = res.json;
  }

  const statusName = (issue.fields?.status?.name || "").toLowerCase();
  const statusCategory = (issue.fields?.status?.statusCategory?.key || "").toLowerCase();
  if (statusName === "done" || statusName === "closed" || statusCategory === "done") {
    result.skipped.push(`${issueKey}: status is ${statusName}`);
    return result;
  }

  const issueLabels = issue.fields?.labels || [];
  const skipLabels = config.agentLabelReconciler?.skipLabels || [];
  const lowerIssueLabels = issueLabels.map(l => l.toLowerCase());
  const matchedSkipLabel = skipLabels.find(sl => {
    const pattern = sl.toLowerCase();
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return lowerIssueLabels.some(l => l.startsWith(prefix));
    }
    return lowerIssueLabels.includes(pattern);
  });
  if (matchedSkipLabel) {
    result.skipped.push(`${issueKey}: has skip-label (${matchedSkipLabel})`);
    return result;
  }

  const agentLabelMap = config.agentLabels || {};
  const matchedLabels = issueLabels.filter(l => agentLabelMap[l]);
  if (matchedLabels.length === 0) {
    result.skipped.push(`${issueKey}: no agent:* labels`);
    return result;
  }

  for (const label of matchedLabels) {
    const agentName = agentLabelMap[label];
    if (excludeAgent && agentName === excludeAgent) {
      result.skipped.push(`${issueKey}/${agentName}: excludeAgent`);
      continue;
    }

    // Check for an active (non-terminal) job on this issue+agent
    let activeJob = null;
    for (const j of jobs.values()) {
      if (j.issueKey === issueKey && j.agent === agentName &&
          ["queued", "running", "retry-pending"].includes(j.status)) {
        activeJob = j;
        break;
      }
    }
    if (activeJob) {
      result.skipped.push(`${issueKey}/${agentName}: active job ${activeJob.jobId} (${activeJob.status})`);
      continue;
    }

    // Check for an active pipeline phase running this agent for this issue
    let activePipelinePhase = null;
    for (const p of pipelines.values()) {
      if (p.issueKey === issueKey && ["running", "blocked"].includes(p.status)) {
        const ph = p.phases?.find(ph => ph.agent === agentName && ["running", "pending"].includes(ph.status));
        if (ph) { activePipelinePhase = { pipelineId: p.pipelineId, phase: ph.name }; break; }
      }
    }
    if (activePipelinePhase) {
      result.skipped.push(`${issueKey}/${agentName}: active pipeline ${activePipelinePhase.pipelineId} phase ${activePipelinePhase.phase}`);
      continue;
    }

    // Idempotency — separate namespace from sprint-runner
    const idempotencyKey = `agent-label:${issueKey}:${agentName}`;
    const ttlMs = (config.agentLabelReconciler?.idempotencyMinutes || 30) * 60 * 1000;
    const existing = idempotencyStore[idempotencyKey];
    if (existing && (Date.now() - new Date(existing.createdAt).getTime()) < ttlMs) {
      result.skipped.push(`${issueKey}/${agentName}: idempotency hit (${idempotencyKey})`);
      continue;
    }

    const issueType = (issue.fields?.issuetype?.name || "").toLowerCase();
    const isSubtask = issueType === "sub-task" || issueType === "subtask";
    const telegram = product.telegram?.chatId ? { chatId: String(product.telegram.chatId) } : null;

    const jobId = makeJobId();
    const logFile = path.join(LOG_DIR, `${jobId}.log`);
    const metaFile = path.join(LOG_DIR, `${jobId}.json`);
    const job = {
      jobId,
      mode: "delivery",
      issueKey: String(issueKey),
      summary: issue.fields?.summary || "",
      description: "",
      workingDir,
      agent: agentName,
      model: config.routing?.agentToModel?.[agentName] || null,
      requestedProvider: null,
      selectedModel: null,
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
      callbackUrl: N8N_CALLBACK_URL || null,
      slack: null,
      telegram,
      batchId: null,
      parentKey: isSubtask ? (issue.fields?.parent?.key || null) : null,
      subtaskFiles: null,
      subtaskDepth: 0,
      isSubtask,
      source: `agent-label-reconciler:${reason}`,
      teamSessionId: null,
      teamRole: null,
      teammates: [],
    };
    jobs.set(jobId, job);
    db.jobs.set(job).catch(e => console.error(`[db] Failed to persist reconciler job ${jobId}: ${e.message}`));
    fs.writeFileSync(metaFile, JSON.stringify(job, null, 2), "utf8");

    idempotencyStore[idempotencyKey] = { jobId, createdAt: nowIso() };
    db.idempotency.set(idempotencyKey, jobId).catch(e => console.error('[db] idempotency persist failed: ' + e.message));
    saveIdempotency(idempotencyStore);

    enqueue(jobId);
    console.log(`[agent-label-reconciler] Dispatched ${issueKey} → ${agentName} (job: ${jobId}, label: ${label}, reason: ${reason}, product: ${productId})`);
    result.dispatched.push(`${issueKey}/${agentName}`);
  }
  return result;
}

/**
 * Periodic sweep: scan every product's Jira project for issues with agent:*
 * labels that are not Done. Dispatches anything the sprint-runner missed
 * (in-flight issues, webhook drops, manual labels).
 */
async function tickAgentLabelReconciler() {
  const cfg = config.agentLabelReconciler || {};
  if (!cfg.enabled) return;

  const { email, apiToken } = config.jira || {};
  if (!email || !apiToken) {
    console.log(`[agent-label-reconciler] Skipped: JIRA credentials not configured`);
    return;
  }

  const agentLabelMap = config.agentLabels || {};
  const labelKeys = Object.keys(agentLabelMap);
  if (labelKeys.length === 0) return;

  const lookbackDays = cfg.lookbackDays || 14;
  const maxPerProduct = cfg.maxPerProductCycle || 10;

  for (const [productId, product] of products) {
    const projectKey = product.jira?.projectKey;
    if (!projectKey) continue;
    try {
      const labelClause = labelKeys.map(l => `"${l}"`).join(", ");
      const jql = encodeURIComponent(
        `project = ${projectKey} AND statusCategory != Done AND labels in (${labelClause}) AND updated > -${lookbackDays}d ORDER BY updated DESC`
      );
      const res = await jiraRestGet(`/search/jql?jql=${jql}&fields=summary,status,issuetype,labels,priority,parent&maxResults=${maxPerProduct}`);
      if (!res || res.statusCode !== 200) {
        console.log(`[agent-label-reconciler] Product ${productId}: search failed (${res?.statusCode || "no response"})`);
        continue;
      }
      const issues = res.json?.issues || [];
      let dispatchedCount = 0, skippedCount = 0;
      for (const issue of issues) {
        const r = await dispatchAgentLabelsForIssue(issue.key, {
          reason: "reconciler-sweep",
          preloadedIssue: issue,
        });
        dispatchedCount += r.dispatched.length;
        skippedCount += r.skipped.length;
      }
      if (dispatchedCount > 0 || issues.length > 0) {
        console.log(`[agent-label-reconciler] Product ${productId}: scanned ${issues.length} issue(s), dispatched ${dispatchedCount}, skipped ${skippedCount}`);
      }
    } catch (e) {
      console.error(`[agent-label-reconciler] Product ${productId} error: ${e.message}`);
    }
  }
}

// Initialize PostgreSQL and load state from DB
(async () => {
  try {
    await db.init(config);
    issueTracker.init(config, db);
    console.log(`[${new Date().toISOString()}] PostgreSQL connected`);
    await loadStateFromDB();
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

// jobIndex (disk-based historical index) replaced by DB — no startup scan needed

/**
 * ============================================================
 * GRACEFUL SHUTDOWN (Phase 1.2)
 * Stop accepting requests, SIGTERM running processes, save state.
 * ============================================================
 */
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
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

// Callback serialization queue
const callbackQueue = [];
let callbackProcessing = false;
const CALLBACK_DELAY_MS = 500; // 500ms between callbacks to avoid N8N SQLite WAL corruption

async function enqueueCallback(payload, callbackUrl, secret, job, maxAttempts) {
  return new Promise((resolve, reject) => {
    callbackQueue.push({ payload, callbackUrl, secret, job, maxAttempts, resolve, reject });
    console.log(`[callback-queue] Enqueued callback, queue depth: ${callbackQueue.length}`);
    processCallbackQueue();
  });
}

async function processCallbackQueue() {
  if (callbackProcessing || callbackQueue.length === 0) return;
  callbackProcessing = true;

  while (callbackQueue.length > 0) {
    const { payload, callbackUrl, secret, job, maxAttempts, resolve, reject } = callbackQueue.shift();
    try {
      const result = await sendCallbackDirect(callbackUrl, payload, job, maxAttempts);
      console.log(`[callback-queue] Sent callback, ${callbackQueue.length} remaining`);
      resolve(result);
    } catch (err) {
      console.log(`[callback-queue] Callback failed: ${err.message}, ${callbackQueue.length} remaining`);
      reject(err);
    }
    if (callbackQueue.length > 0) {
      await new Promise(r => setTimeout(r, CALLBACK_DELAY_MS));
    }
  }

  callbackProcessing = false;
}

async function sendCallbackDirect(url, payload, job, maxAttempts = 3) {
  const headers = {};
  if (SECRET) headers["X-Runner-Secret"] = SECRET;

  // Track per-attempt details for debugging
  const attemptDetails = [];
  let lastResponseStatus = null;

  // Try internal URL first if configured (faster, no ngrok dependency)
  const internalUrl = config.internalCallbackUrl;
  const urls = internalUrl ? [internalUrl, url] : [url];

  for (const targetUrl of urls) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await postJson(targetUrl, payload, headers);
        lastResponseStatus = resp.statusCode;
        attemptDetails.push({ at: new Date().toISOString(), url: targetUrl, attempt, status: resp.statusCode, error: null });
        appendLog(job.logFile, `[${new Date().toISOString()}] Callback response ${resp.statusCode} via ${targetUrl} (attempt ${attempt})\n`);
        if (resp.statusCode >= 200 && resp.statusCode < 500) {
          return { ok: true, statusCode: resp.statusCode, attempt, url: targetUrl };
        }
        // 5xx = retryable
        throw new Error(`Server error ${resp.statusCode}`);
      } catch (e) {
        attemptDetails.push({ at: new Date().toISOString(), url: targetUrl, attempt, status: lastResponseStatus, error: e.message });
        appendLog(job.logFile, `[${new Date().toISOString()}] Callback attempt ${attempt}/${maxAttempts} via ${targetUrl} failed: ${e.message}\n`);
        if (attempt < maxAttempts) {
          const delay = Math.pow(2, attempt) * 2000; // 4s, 8s
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    // If internal URL failed all attempts, fall back to external
    if (targetUrl === internalUrl) {
      appendLog(job.logFile, `[${new Date().toISOString()}] Internal callback failed, falling back to external: ${url}\n`);
    }
  }

  // Permanent failure — write to failed-callbacks for replay
  const failedId = `cb_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const failedFile = path.join(FAILED_CALLBACKS_DIR, `${failedId}.json`);

  // Truncate payload preview to 10KB for storage
  const payloadStr = JSON.stringify(payload);
  const payloadPreview = payloadStr.length > 10240 ? payloadStr.slice(0, 10240) + "...[truncated]" : payloadStr;

  const failedRecord = {
    id: failedId,
    url,
    payload,
    payloadPreview,
    jobId: job.jobId,
    agent: job.agent || null,
    issueKey: job.issueKey || null,
    failedAt: new Date().toISOString(),
    attempts: attemptDetails.length,
    attemptDetails,
    responseStatus: lastResponseStatus,
    error: attemptDetails.length > 0 ? attemptDetails[attemptDetails.length - 1].error : "unknown",
  };
  try {
    fs.writeFileSync(failedFile, JSON.stringify(failedRecord, null, 2), "utf8");
    appendLog(job.logFile, `[${new Date().toISOString()}] Callback permanently failed, saved to ${failedFile}\n`);
  } catch (writeErr) {
    appendLog(job.logFile, `[${new Date().toISOString()}] Failed to save failed callback: ${writeErr.message}\n`);
  }
  return { ok: false, failedId };
}

// Public wrapper — serializes through the queue to prevent concurrent N8N writes
async function sendCallbackWithRetry(url, payload, job, maxAttempts = 3) {
  return enqueueCallback(payload, url, SECRET, job, maxAttempts);
}

/**
 * ============================================================
 * PIPELINE FAILURE ALERTING (Phase 1.5)
 * On job:failed (after all retries), POST to Slack webhook.
 * ============================================================
 */
const ALERT_SLACK_WEBHOOK = config.alerting?.slackWebhookUrl || null;

function sendFailureAlert(eventData) {
  if (!ALERT_SLACK_WEBHOOK) return;
  const text = `:rotating_light: *Job Failed*\n` +
    `*Job ID*: ${eventData.jobId}\n` +
    `*Agent*: ${eventData.agent || "none"}\n` +
    `*Issue*: ${eventData.issueKey || "none"}\n` +
    `*Error*: ${eventData.error || "unknown"}\n` +
    `*Log*: ${RUNNER_PUBLIC_URL}/jobs/${eventData.jobId}/log`;

  postJson(ALERT_SLACK_WEBHOOK, { text }).catch(e => {
    console.error(`[${new Date().toISOString()}] Alert webhook failed: ${e.message}`);
  });
}

jobEmitter.on("job:failed", (eventData) => {
  sendFailureAlert(eventData);
});

// jobIndex listeners removed — DB is the source of truth for terminal jobs

/**
 * ============================================================
 * LOG ROTATION (Phase 1.6)
 * Delete .log and .json meta files older than logRetentionDays.
 * Runs on the existing daily cleanup interval.
 * ============================================================
 */
const LOG_RETENTION_DAYS = config.logRetentionDays || 30;

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
 * ============================================================
 * COST BUDGET / CIRCUIT BREAKER (Phase 1.7)
 * Block new jobs if daily/hourly cost limits exceeded.
 * ============================================================
 */
function checkBudget() {
  const budget = config.budget;
  if (!budget || !budget.enabled) return { ok: true };

  const now = Date.now();
  let costLastHour = 0;
  let costToday = 0;
  const oneHourAgo = now - (60 * 60 * 1000);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  for (const job of jobs.values()) {
    if (!job.usage?.estimatedCostUsd || !job.finishedAt) continue;
    const finished = new Date(job.finishedAt).getTime();
    if (finished > todayMs) costToday += job.usage.estimatedCostUsd;
    if (finished > oneHourAgo) costLastHour += job.usage.estimatedCostUsd;
  }

  if (budget.dailyLimitUsd && costToday >= budget.dailyLimitUsd) {
    return { ok: false, reason: `Daily budget exceeded: $${costToday.toFixed(2)} >= $${budget.dailyLimitUsd}` };
  }
  if (budget.hourlyLimitUsd && costLastHour >= budget.hourlyLimitUsd) {
    return { ok: false, reason: `Hourly budget exceeded: $${costLastHour.toFixed(2)} >= $${budget.hourlyLimitUsd}` };
  }

  return { ok: true, costToday: Math.round(costToday * 100) / 100, costLastHour: Math.round(costLastHour * 100) / 100 };
}

function nowIso() {
  return new Date().toISOString();
}

function makeJobId() {
  return `job_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

function appendLog(logFile, line) {
  fs.appendFileSync(logFile, line, { encoding: "utf8" });
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
      mapped = to + mapped.slice(from.length);
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
 * Conversation memory helpers
 */
function safeKeyToFilename(key) {
  // stable, filesystem-safe
  const h = crypto.createHash("sha1").update(String(key)).digest("hex");
  return `${h}.json`;
}

function convPath(conversationId) {
  return path.join(CONV_DIR, safeKeyToFilename(conversationId));
}

/**
 * Load conversation messages from PostgreSQL.
 * On a DB miss, checks for a legacy file at CONV_DIR and migrates it into the DB
 * (one-time per channel), then deletes the file.
 *
 * @param {string} conversationId
 * @returns {Promise<{conversationId: string, messages: Array}>}
 */
async function loadConversation(conversationId) {
  try {
    const turns = await db.conversations.load(conversationId);
    if (turns !== null) {
      return { conversationId, messages: turns };
    }

    // DB miss — check for a legacy file and migrate if found
    const legacyPath = convPath(conversationId);
    if (fs.existsSync(legacyPath)) {
      try {
        const obj = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
        const messages = Array.isArray(obj?.messages) ? obj.messages : [];
        await db.conversations.save(conversationId, messages, null);
        try { fs.unlinkSync(legacyPath); } catch (_) { /* best-effort delete */ }
        return { conversationId, messages };
      } catch (migErr) {
        console.warn(`[conv] Migration failed for ${conversationId}: ${migErr.message}`);
      }
    }

    return { conversationId, messages: [] };
  } catch (err) {
    console.warn(`[conv] loadConversation error for ${conversationId}: ${err.message}`);
    return { conversationId, messages: [] };
  }
}

/**
 * Save conversation messages to PostgreSQL only.
 * File-based writes no longer occur; CONV_DIR is only used for legacy migration.
 *
 * @param {string} conversationId
 * @param {Array} messages
 * @param {string|null} [productId]
 */
async function saveConversation(conversationId, messages, productId) {
  try {
    await db.conversations.save(conversationId, messages, productId || null);
  } catch (err) {
    console.error(`[conv] saveConversation error for ${conversationId}: ${err.message}`);
  }
}

function trimConversationMessages(messages) {
  // keep last N messages (turns) and cap total chars
  let trimmed = messages.slice(-Math.max(1, CONV_TURNS));
  let totalChars = trimmed.reduce((acc, m) => acc + (m?.content ? String(m.content).length : 0), 0);

  while (totalChars > CONV_MAX_CHARS && trimmed.length > 1) {
    const removed = trimmed.shift();
    totalChars -= removed?.content ? String(removed.content).length : 0;
  }

  return trimmed;
}

function formatConversationForPrompt(messages) {
  // simple readable transcript
  return messages
    .map((m) => {
      const role = m.role === "assistant" ? "Assistant" : "User";
      return `${role}: ${m.content}`;
    })
    .join("\n\n");
}

/**
 * Pre-read codebase via local model (LM Studio) for token-efficient context compression
 *
 * Scans the working directory for key files, sends contents to a local model,
 * and returns a structured summary that gets injected into the Claude prompt
 * instead of Claude reading dozens of files itself.
 */
async function preReadCodebase(job) {
  const pr = config.preRead;
  if (!pr?.enabled) return null;

  // Only run for configured agents
  const agentName = job.agent || "";
  if (!pr.agents.includes(agentName)) return null;

  const workDir = job.workingDir;
  if (!workDir || !fs.existsSync(workDir)) return null;

  const endpoint = process.env.PREREAD_ENDPOINT
    || (process.env.RUNNING_IN_DOCKER ? pr.dockerEndpoint : pr.endpoint);

  appendLog(job.logFile, `[${nowIso()}] Pre-read: scanning ${workDir} for ${agentName}\n`);

  jobEmitter.emit("job:pre-read-start", {
    jobId: job.jobId, agent: agentName, workingDir: workDir
  });

  try {
    // 1. Collect files matching scan patterns
    const files = collectFiles(workDir, pr.scanPatterns, pr.excludePatterns, pr.maxFiles);
    if (files.length === 0) {
      appendLog(job.logFile, `[${nowIso()}] Pre-read: no files matched scan patterns, skipping\n`);
      return null;
    }
    appendLog(job.logFile, `[${nowIso()}] Pre-read: found ${files.length} files\n`);

    // 2. Read file contents (with line caps)
    let totalChars = 0;
    const fileContents = [];
    for (const filePath of files) {
      if (totalChars >= (pr.maxTotalChars || 80000)) break;
      try {
        const rel = path.relative(workDir, filePath);
        const raw = fs.readFileSync(filePath, "utf8");
        const lines = raw.split("\n").slice(0, pr.maxFileLines || 200);
        const content = lines.join("\n");
        totalChars += content.length;
        fileContents.push({ path: rel, content });
      } catch { /* skip unreadable files */ }
    }

    appendLog(job.logFile, `[${nowIso()}] Pre-read: read ${fileContents.length} files (${totalChars} chars)\n`);

    // 3. Build the summarisation prompt
    const taskContext = [
      job.summary || "",
      job.description || "",
      job.prompt || job.message || ""
    ].filter(Boolean).join("\n").slice(0, 2000);

    const systemPrompt = `You are a codebase analyst. Given project files and a task description, produce a concise structured analysis. Focus on what is relevant to the task. Be factual and precise.`;

    const userPrompt = [
      `## Task`,
      taskContext || "(general analysis)",
      ``,
      `## Project Files (${fileContents.length} files)`,
      ...fileContents.map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``),
      ``,
      `## Instructions`,
      `Produce a structured analysis with these sections:`,
      `1. **Project Structure**: Architecture, framework, key directories`,
      `2. **Relevant Files**: Files most relevant to the task, with brief descriptions`,
      `3. **Key Patterns**: Conventions, abstractions, naming patterns used`,
      `4. **Dependencies**: Relevant packages and their purpose`,
      `5. **Suggested Approach**: How to approach the task given the codebase`,
      ``,
      `Keep total output under 3000 words. Be concise.`
    ].join("\n");

    // 4. Call LM Studio (OpenAI-compatible API)
    const payload = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 4096,
      stream: false
    };
    // Only include model if configured (LM Studio uses whatever is loaded when empty)
    if (pr.model) payload.model = pr.model;

    const timeoutMs = pr.timeoutMs || 120000;
    const result = await Promise.race([
      postJson(endpoint, payload),
      new Promise((_, reject) => setTimeout(() => reject(new Error("pre-read timeout")), timeoutMs))
    ]);

    if (result.statusCode !== 200) {
      appendLog(job.logFile, `[${nowIso()}] Pre-read: LM Studio returned ${result.statusCode}, skipping\n`);
      jobEmitter.emit("job:pre-read-done", {
        jobId: job.jobId, status: "error", error: `HTTP ${result.statusCode}`
      });
      return null;
    }

    const parsed = JSON.parse(result.body);
    const summary = parsed.choices?.[0]?.message?.content || "";

    if (!summary) {
      appendLog(job.logFile, `[${nowIso()}] Pre-read: empty response from local model, skipping\n`);
      return null;
    }

    const modelUsed = parsed.model || pr.model || "local";
    appendLog(job.logFile, `[${nowIso()}] Pre-read: got ${summary.length} char summary from ${modelUsed}\n`);

    // Track metrics
    if (!metrics.preRead) metrics.preRead = { total: 0, succeeded: 0, failed: 0, skipped: 0, totalCharsRead: 0, totalCharsSummary: 0 };
    metrics.preRead.total++;
    metrics.preRead.succeeded++;
    metrics.preRead.totalCharsRead += totalChars;
    metrics.preRead.totalCharsSummary += summary.length;
    saveMetrics();

    jobEmitter.emit("job:pre-read-done", {
      jobId: job.jobId, status: "success", filesRead: fileContents.length,
      charsRead: totalChars, summaryChars: summary.length, model: modelUsed
    });

    return summary;

  } catch (err) {
    appendLog(job.logFile, `[${nowIso()}] Pre-read: failed — ${err.message}. Continuing without pre-read.\n`);

    if (!metrics.preRead) metrics.preRead = { total: 0, succeeded: 0, failed: 0, skipped: 0, totalCharsRead: 0, totalCharsSummary: 0 };
    metrics.preRead.total++;
    metrics.preRead.failed++;
    saveMetrics();

    jobEmitter.emit("job:pre-read-done", {
      jobId: job.jobId, status: "error", error: err.message
    });
    return null;
  }
}

// ─── Hybrid Team: Local Model for Team Members ──────────────────────────────

/**
 * Detect if a team lead job should run as a hybrid team (some teammates local).
 * Returns { localTeammates, cloudTeammates } or null if not hybrid.
 */
function detectHybridTeam(job) {
  if (!config.teams?.enabled || !config.localTeamMembers?.enabled) return null;
  const leadConfig = config.teams.teamLeads?.[job.agent];
  if (!leadConfig) return null;

  const localAgents = config.localTeamMembers.agents || [];
  const localTeammates = (leadConfig.teammates || []).filter(t => localAgents.includes(t));
  const cloudTeammates = (leadConfig.teammates || []).filter(t => !localAgents.includes(t));

  if (localTeammates.length === 0) return null;
  return { localTeammates, cloudTeammates, leadConfig };
}

/**
 * Parse markdown output from local model into file blocks.
 * Expects format: ### path/to/file.ext \n ```lang \n content \n ```
 */
function parseFileBlocks(markdown) {
  const blocks = [];
  const regex = /###\s+([^\n]+)\n\s*```[^\n]*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(markdown))) {
    const filePath = match[1].trim().replace(/^`|`$/g, "").replace(/^\*\*|\*\*$/g, "");
    const content = match[2];
    if (!filePath || filePath.includes("..") || path.isAbsolute(filePath)) continue;
    blocks.push({ filePath, content });
  }
  return blocks;
}

/**
 * Call local model (LM Studio) to implement code from a plan.
 * Writes output files to disk. Returns { content, fileChanges, filesWritten }.
 */
async function runLocalTeamMember(job, planText, teammate) {
  const ltm = config.localTeamMembers;
  const teammateModel = resolveLocalModel(teammate);

  // Use qwen-code CLI mode if enabled
  if (ltm.mode === "qwen-code") {
    return runLocalTeamMemberQwen(job, planText, teammate, teammateModel);
  }

  return runLocalTeamMemberRaw(job, planText, teammate, teammateModel);
}

/**
 * Run a local teammate via Qwen-Code CLI (agentic, with file tools).
 * Spawns qwen CLI with the plan as prompt — model reads codebase and writes files directly.
 */
async function runLocalTeamMemberQwen(job, planText, teammate, teammateModel) {
  const ltm = config.localTeamMembers;
  const qwenConfig = ltm.qwenCode || {};
  const qwenCmd = qwenConfig.command || "qwen";
  const baseArgs = process.env.RUNNING_IN_DOCKER
    ? (qwenConfig.dockerBaseArgs || qwenConfig.baseArgs || [])
    : (qwenConfig.baseArgs || []);

  appendLog(job.logFile, `[${nowIso()}] Hybrid team (qwen-code): ${teammate} model=${teammateModel.model} tier=${teammateModel.tier}\n`);

  jobEmitter.emit("job:local-teammate-start", {
    jobId: job.jobId, teammate, agent: job.agent
  });

  const prompt = [
    `You are ${teammate} working as part of a team on ${job.issueKey || "a task"}.`,
    `Working directory: ${job.workingDir}`,
    ``,
    `## Implementation Plan (from team lead)`,
    planText.slice(0, 30000),
    ``,
    `## Your Task`,
    `Read the existing codebase, then implement ALL changes described in the plan above.`,
    `Create and modify files as specified. Run any necessary commands (npm install, etc).`,
    `Verify your changes compile/build if possible.`,
  ].join("\n");

  const args = [...baseArgs, "-m", teammateModel.model, "-p", prompt, "-o", "stream-json", "--include-partial-messages"];

  const spawnCwd = job.workingDir || process.cwd();
  appendLog(job.logFile, `[${nowIso()}] Qwen-Code team: ${teammate} -m ${teammateModel.model} -p <${prompt.length} chars> -o stream-json --yolo\n`);

  const timeoutMs = ltm.timeoutMs || 300000;

  return new Promise((resolve, reject) => {
    const child = spawn(qwenCmd, args, {
      cwd: spawnCwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });

    child.stdin.end();

    appendLog(job.logFile, `[${nowIso()}] Qwen-Code team PID=${child.pid} for ${teammate}\n`);

    let stdout = "";
    let stderr = "";
    let lastStreamEvent = null;
    let lineBuffer = "";
    let toolCount = 0;

    const timer = setTimeout(() => {
      appendLog(job.logFile, `[${nowIso()}] Qwen-Code team timeout for ${teammate}\n`);
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      lineBuffer += chunk;

      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          lastStreamEvent = event;

          if (event.type === "assistant" && event.message) {
            const toolUses = (event.message.content || []).filter(c => c.type === "tool_use");
            toolCount += toolUses.length;
            for (const tu of toolUses) {
              appendLog(job.logFile, `[${nowIso()}] Qwen-Code team (${teammate}): tool_use ${tu.name}\n`);
            }
          } else if (event.type === "result") {
            appendLog(job.logFile, `[${nowIso()}] Qwen-Code team (${teammate}): result turns=${event.num_turns} tools=${toolCount}\n`);
          }
        } catch { /* non-JSON */ }
      }
    });

    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      appendLog(job.logFile, `[${nowIso()}] Qwen-Code team (${teammate}) exited code=${code}\n`);

      const resultText = lastStreamEvent?.type === "result" ? (lastStreamEvent.result || "") : "";

      if (code !== 0 && !resultText) {
        reject(new Error(`Qwen-Code team member ${teammate} exited with code ${code}`));
        return;
      }

      jobEmitter.emit("job:local-teammate-done", {
        jobId: job.jobId, teammate, filesWritten: toolCount, totalChars: resultText.length, model: teammateModel.model
      });

      // Return shape expected by hybrid team handler
      // With qwen-code, files are written directly by the agent (not parsed from markdown)
      resolve({
        content: resultText,
        fileChanges: [],
        filesWritten: toolCount, // Approximate — count tool_use calls as proxy
        model: teammateModel.model,
        qwenCode: true,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Legacy raw API mode for local team members (direct LM Studio API call).
 */
async function runLocalTeamMemberRaw(job, planText, teammate, teammateModel) {
  const ltm = config.localTeamMembers;
  const endpoint = process.env.LTM_ENDPOINT
    || (process.env.RUNNING_IN_DOCKER ? ltm.dockerEndpoint : ltm.endpoint);

  appendLog(job.logFile, `[${nowIso()}] Hybrid team (raw): sending plan to local model for ${teammate} model=${teammateModel.model} tier=${teammateModel.tier}\n`);

  jobEmitter.emit("job:local-teammate-start", {
    jobId: job.jobId, teammate, agent: job.agent
  });

  const systemPrompt = `You are an expert software engineer implementing code changes from a detailed plan.

Output your changes as markdown code blocks with file paths. Use this exact format for each file:

### path/to/file.ext
\`\`\`language
complete file content here
\`\`\`

For NEW files: output the complete file content.
For MODIFIED files: output the COMPLETE file with all changes applied (not just the diff).

Rules:
- Follow the plan exactly. Do not skip files or leave placeholders.
- Use the exact file paths specified in the plan.
- Include ALL imports, exports, and boilerplate — output must be copy-paste ready.
- Match the existing code style and conventions described in the plan.`;

  const userPrompt = [
    `## Implementation Plan`,
    ``,
    planText,
    ``,
    `## Working Directory: ${job.workingDir}`,
    ``,
    `Implement ALL changes described above. Output every file that needs to be created or modified.`
  ].join("\n");

  const payload = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.2,
    max_tokens: teammateModel.maxOutputTokens,
    stream: false
  };
  if (teammateModel.model) payload.model = teammateModel.model;

  const timeoutMs = ltm.timeoutMs || 300000;
  const result = await Promise.race([
    postJson(endpoint, payload),
    new Promise((_, reject) => setTimeout(() => reject(new Error("local team member timeout")), timeoutMs))
  ]);

  if (result.statusCode !== 200) {
    throw new Error(`Local model returned HTTP ${result.statusCode}`);
  }

  const body = JSON.parse(result.body);
  const content = body.choices?.[0]?.message?.content || "";

  if (!content.trim()) {
    throw new Error("Local model returned empty response");
  }

  const modelUsed = body.model || ltm.model || "local";
  appendLog(job.logFile, `[${nowIso()}] Local model raw (${modelUsed}) response: ${content.length} chars\n`);

  // Parse file blocks and write to disk
  const fileChanges = parseFileBlocks(content);
  appendLog(job.logFile, `[${nowIso()}] Parsed ${fileChanges.length} file blocks from local model output\n`);

  let filesWritten = 0;
  for (const change of fileChanges) {
    const fullPath = path.resolve(job.workingDir, change.filePath);
    if (!fullPath.startsWith(path.resolve(job.workingDir))) {
      appendLog(job.logFile, `[${nowIso()}] SKIPPED: ${change.filePath} (outside working directory)\n`);
      continue;
    }
    try {
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, change.content, "utf8");
      filesWritten++;
      appendLog(job.logFile, `[${nowIso()}] Wrote: ${change.filePath} (${change.content.length} chars)\n`);
    } catch (e) {
      appendLog(job.logFile, `[${nowIso()}] ERROR writing ${change.filePath}: ${e.message}\n`);
    }
  }

  jobEmitter.emit("job:local-teammate-done", {
    jobId: job.jobId, teammate, filesWritten, totalChars: content.length, model: modelUsed
  });

  return { content, fileChanges, filesWritten, model: modelUsed };
}

/**
 * Resolve local model config for a given agent. Uses per-agent mapping from
 * agentModels if available, otherwise falls back to the global model/maxOutputTokens.
 * Returns { model, maxOutputTokens, tier } or the global defaults.
 */
function resolveLocalModel(agentName) {
  const ltm = config.localTeamMembers;
  const agentConfig = ltm.agentModels?.[agentName];
  if (agentConfig) {
    return {
      model: agentConfig.model || ltm.model,
      maxOutputTokens: agentConfig.maxOutputTokens || ltm.maxOutputTokens || 16384,
      tier: agentConfig.tier || "default",
    };
  }
  return {
    model: ltm.model,
    maxOutputTokens: ltm.maxOutputTokens || 16384,
    tier: "default",
  };
}

/**
 * Check if a job's agent should run on local LLM (LM Studio) directly.
 * Used for pipeline phases that dispatch agents solo (not via team routing).
 */
function shouldRunLocal(job) {
  if (!config.localTeamMembers?.enabled) return false;
  const localAgents = config.localTeamMembers.agents || [];
  return localAgents.includes(job.agent);
}

/**
 * Run an agent via Qwen-Code CLI (agentic local model with tools).
 * Spawns `qwen` CLI pointing at LM Studio, giving the local model proper
 * file read/write/edit/grep/glob tools instead of raw markdown output.
 * Stream-json output is parsed identically to runClaude.
 * Falls back to raw API mode (runLocalDirectRaw) or Claude if configured.
 * Returns { stdout, stderr, lastStreamEvent } shaped like runClaude output.
 */
async function runLocalDirect(job) {
  const ltm = config.localTeamMembers;
  const agentModel = resolveLocalModel(job.agent);

  // If mode is not qwen-code (or qwen binary missing), use legacy raw API mode
  if (ltm.mode !== "qwen-code") {
    return runLocalDirectRaw(job);
  }

  const qwenConfig = ltm.qwenCode || {};
  const qwenCmd = qwenConfig.command || "qwen";
  const baseArgs = process.env.RUNNING_IN_DOCKER
    ? (qwenConfig.dockerBaseArgs || qwenConfig.baseArgs || [])
    : (qwenConfig.baseArgs || []);

  appendLog(job.logFile, `[${nowIso()}] Qwen-Code: routing ${job.agent} via ${qwenCmd} model=${agentModel.model} tier=${agentModel.tier}\n`);

  jobEmitter.emit("job:local-direct-start", {
    jobId: job.jobId, agent: job.agent, pipelinePhase: job.pipelinePhase || null, model: agentModel.model, tier: agentModel.tier
  });

  const timeoutMs = ltm.timeoutMs || 300000;

  return new Promise((resolve, reject) => {
    // Build prompt (same as runClaude delivery/agent prompt)
    let prompt;
    if (job.mode === "chat") {
      prompt = buildChatPrompt(job);
    } else if (job.mode === "agent") {
      prompt = buildAgentPrompt(job);
    } else {
      prompt = buildDeliveryPrompt(job);
    }

    // Build CLI args
    // Note: qwen-code's -p takes a string value (unlike Claude CLI where -p is boolean).
    // Pass the full prompt as -p value; spawn() handles long args via execve.
    const args = [...baseArgs];
    args.push("-m", agentModel.model);
    args.push("-p", prompt);
    args.push("-o", "stream-json", "--include-partial-messages");

    // Product plugin: qwen-code supports extensions via --include-directories
    const jobProduct = resolveProduct(job.workingDir);
    if (jobProduct) {
      const pluginDir = resolvePluginDir(jobProduct);
      if (pluginDir && fs.existsSync(pluginDir)) {
        args.push("--include-directories", pluginDir);
      }
    }

    const spawnCwd = job.workingDir || process.cwd();
    appendLog(job.logFile, `[${nowIso()}] Qwen-Code CLI: ${qwenCmd} -m ${agentModel.model} -p <${prompt.length} chars> -o stream-json --yolo\n`);
    appendLog(job.logFile, `[${nowIso()}] CWD=${spawnCwd}\n`);

    const child = spawn(qwenCmd, args, {
      cwd: spawnCwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });

    child.stdin.end();

    job.processPid = child.pid;
    appendLog(job.logFile, `[${nowIso()}] Qwen-Code spawned PID=${child.pid}\n`);

    let stdout = "";
    let stderr = "";
    let lastStreamEvent = null;
    job.streamEvents = job.streamEvents || [];
    let lineBuffer = "";
    let resultExitTimer = null;

    const timer = setTimeout(() => {
      appendLog(job.logFile, `\n[${nowIso()}] Qwen-Code timeout after ${timeoutMs}ms, killing\n`);
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);

    // Parse stream-json (same format as Claude CLI)
    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      lineBuffer += chunk;

      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          lastStreamEvent = event;

          if (event.type === "system" && event.subtype === "init") {
            jobEmitter.emit("job:progress", {
              jobId: job.jobId, agent: job.agent, streamType: "init",
              model: event.model, tools: event.tools, sessionId: event.session_id,
            });
            job.sessionId = event.session_id;
            appendLog(job.logFile, `[${nowIso()}] Qwen-Code stream: init model=${event.model} tools=${(event.tools || []).length}\n`);
          } else if (event.type === "stream_event") {
            // Partial message events from --include-partial-messages
            const inner = event.event || {};
            if (inner.type === "content_block_start" && inner.content_block?.type === "tool_use") {
              const toolName = inner.content_block.name || "unknown";
              job.streamEvents.push({ type: "tool_use", tool: toolName, ts: nowIso() });
              appendLog(job.logFile, `[${nowIso()}] Qwen-Code: tool_use ${toolName}\n`);
              jobEmitter.emit("job:progress", {
                jobId: job.jobId, agent: job.agent, streamType: "tool_use", tool: toolName,
              });
            }
          } else if (event.type === "assistant" && event.message) {
            const textParts = (event.message.content || [])
              .filter(c => c.type === "text").map(c => c.text).join("");
            if (textParts) {
              jobEmitter.emit("job:progress", {
                jobId: job.jobId, agent: job.agent, streamType: "assistant",
                text: textParts.slice(0, 500),
                tokens: event.message.usage?.output_tokens || 0,
              });
            }
            const toolUses = (event.message.content || []).filter(c => c.type === "tool_use");
            for (const tu of toolUses) {
              jobEmitter.emit("job:progress", {
                jobId: job.jobId, agent: job.agent, streamType: "tool_use",
                tool: tu.name, toolId: tu.id,
                input: typeof tu.input === "string" ? tu.input.slice(0, 200) : JSON.stringify(tu.input || {}).slice(0, 200),
              });
              job.streamEvents.push({ type: "tool_use", tool: tu.name, ts: nowIso() });
              appendLog(job.logFile, `[${nowIso()}] Qwen-Code: tool_use ${tu.name}\n`);
            }
          } else if (event.type === "result") {
            appendLog(job.logFile, `[${nowIso()}] Qwen-Code: result status=${event.subtype} turns=${event.num_turns}\n`);
            jobEmitter.emit("job:progress", {
              jobId: job.jobId, agent: job.agent, streamType: "result",
              durationMs: event.duration_ms,
            });
            // Kill shortly after result (qwen-code may linger)
            if (!resultExitTimer) {
              resultExitTimer = setTimeout(() => {
                try { child.kill("SIGTERM"); } catch {}
              }, 5000);
            }
          }
        } catch { /* non-JSON line, ignore */ }
      }
    });

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (resultExitTimer) clearTimeout(resultExitTimer);

      appendLog(job.logFile, `[${nowIso()}] Qwen-Code exited code=${code}\n`);

      // Track metrics
      if (!metrics.localDirect) metrics.localDirect = { runs: 0, filesWritten: 0, fallbacks: 0, qwenCodeRuns: 0 };
      metrics.localDirect.runs++;
      metrics.localDirect.qwenCodeRuns = (metrics.localDirect.qwenCodeRuns || 0) + 1;
      saveMetrics();

      // Extract result text from last stream event
      const resultText = lastStreamEvent?.type === "result" ? (lastStreamEvent.result || "") : "";

      if (code !== 0 && !resultText) {
        appendLog(job.logFile, `[${nowIso()}] Qwen-Code FAILED (exit ${code})\n`);
        if (stderr) appendLog(job.logFile, `[${nowIso()}] stderr: ${stderr.slice(0, 500)}\n`);

        if (ltm.fallbackToClaude) {
          appendLog(job.logFile, `[${nowIso()}] Falling back to Claude CLI for ${job.agent}\n`);
          metrics.localDirect.fallbacks++;
          saveMetrics();
          resolve(runClaude(job));
          return;
        }
        reject(new Error(`Qwen-Code exited with code ${code}`));
        return;
      }

      jobEmitter.emit("job:local-direct-done", {
        jobId: job.jobId, agent: job.agent, model: agentModel.model,
        totalChars: resultText.length, provider: "qwen-code",
      });

      resolve({
        stdout,
        stderr,
        lastStreamEvent: lastStreamEvent || {
          type: "result", result: resultText, provider: "qwen-code", model: agentModel.model,
        },
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      appendLog(job.logFile, `[${nowIso()}] Qwen-Code spawn error: ${err.message}\n`);

      if (ltm.fallbackToClaude) {
        appendLog(job.logFile, `[${nowIso()}] Falling back to Claude CLI for ${job.agent}\n`);
        if (!metrics.localDirect) metrics.localDirect = { runs: 0, filesWritten: 0, fallbacks: 0 };
        metrics.localDirect.fallbacks++;
        saveMetrics();
        resolve(runClaude(job));
        return;
      }
      reject(err);
    });
  });
}

/**
 * Legacy raw API mode for local models (direct LM Studio API call without tools).
 * Used when localTeamMembers.mode !== "qwen-code".
 */
async function runLocalDirectRaw(job) {
  const ltm = config.localTeamMembers;
  const agentModel = resolveLocalModel(job.agent);
  const endpoint = process.env.LTM_ENDPOINT
    || (process.env.RUNNING_IN_DOCKER ? ltm.dockerEndpoint : ltm.endpoint);

  appendLog(job.logFile, `[${nowIso()}] Local direct (raw): routing ${job.agent} to LM Studio (${endpoint}) model=${agentModel.model} tier=${agentModel.tier}\n`);

  jobEmitter.emit("job:local-direct-start", {
    jobId: job.jobId, agent: job.agent, pipelinePhase: job.pipelinePhase || null, model: agentModel.model, tier: agentModel.tier
  });

  const systemPrompt = `You are ${job.agent}, an expert software engineer.
Working directory: ${job.workingDir}
${job.issueKey ? `Jira issue: ${job.issueKey}` : ""}

Output your changes as markdown code blocks with file paths. Use this exact format for each file:

### path/to/file.ext
\`\`\`language
complete file content here
\`\`\`

For NEW files: output the complete file content.
For MODIFIED files: output the COMPLETE file with all changes applied (not just the diff).

Rules:
- Follow the task description exactly. Do not skip files or leave placeholders.
- Use the exact file paths relative to the working directory.
- Include ALL imports, exports, and boilerplate — output must be copy-paste ready.
- Match the existing code style and conventions.`;

  const userPrompt = job.description || job.summary || "Complete your assigned task.";

  const payload = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.2,
    max_tokens: agentModel.maxOutputTokens,
    stream: false
  };
  if (agentModel.model) payload.model = agentModel.model;

  const timeoutMs = ltm.timeoutMs || 300000;

  try {
    const result = await Promise.race([
      postJson(endpoint, payload),
      new Promise((_, reject) => setTimeout(() => reject(new Error("local direct timeout")), timeoutMs))
    ]);

    if (result.statusCode !== 200) {
      throw new Error(`Local model returned HTTP ${result.statusCode}`);
    }

    const body = JSON.parse(result.body);
    const content = body.choices?.[0]?.message?.content || "";

    if (!content.trim()) {
      throw new Error("Local model returned empty response");
    }

    const modelUsed = body.model || ltm.model || "local";
    appendLog(job.logFile, `[${nowIso()}] Local direct raw (${modelUsed}) response: ${content.length} chars\n`);

    // Parse file blocks and write to disk
    const fileChanges = parseFileBlocks(content);
    appendLog(job.logFile, `[${nowIso()}] Parsed ${fileChanges.length} file blocks from local model output\n`);

    let filesWritten = 0;
    for (const change of fileChanges) {
      const fullPath = path.resolve(job.workingDir, change.filePath);
      if (!fullPath.startsWith(path.resolve(job.workingDir))) {
        appendLog(job.logFile, `[${nowIso()}] SKIPPED: ${change.filePath} (outside working directory)\n`);
        continue;
      }
      try {
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, change.content, "utf8");
        filesWritten++;
        appendLog(job.logFile, `[${nowIso()}] Wrote: ${change.filePath} (${change.content.length} chars)\n`);
      } catch (e) {
        appendLog(job.logFile, `[${nowIso()}] ERROR writing ${change.filePath}: ${e.message}\n`);
      }
    }

    // Track metrics
    if (!metrics.localDirect) metrics.localDirect = { runs: 0, filesWritten: 0, fallbacks: 0 };
    metrics.localDirect.runs++;
    metrics.localDirect.filesWritten += filesWritten;
    saveMetrics();

    jobEmitter.emit("job:local-direct-done", {
      jobId: job.jobId, agent: job.agent, filesWritten, totalChars: content.length, model: modelUsed
    });

    return {
      stdout: content,
      stderr: "",
      lastStreamEvent: {
        type: "result",
        result: content,
        provider: "local",
        model: modelUsed,
      }
    };
  } catch (err) {
    appendLog(job.logFile, `[${nowIso()}] Local direct raw FAILED for ${job.agent}: ${err.message}\n`);

    if (ltm.fallbackToClaude) {
      appendLog(job.logFile, `[${nowIso()}] Falling back to Claude CLI for ${job.agent}\n`);
      if (!metrics.localDirect) metrics.localDirect = { runs: 0, filesWritten: 0, fallbacks: 0 };
      metrics.localDirect.fallbacks++;
      saveMetrics();
      return runClaude(job);
    }

    throw err;
  }
}

/**
 * Run a cloud teammate (e.g., reviewer) via Claude CLI as an inline subprocess.
 * Returns the assistant's text output.
 */
async function runClaudeForTeammate(job, teammate, planText, implementationResults) {
  const parts = [
    `You are ${teammate} working as part of a team on ${job.issueKey || "a task"}.`,
    `Working directory: ${job.workingDir}`,
    "",
    "## Implementation Plan (from team lead)",
    planText.slice(0, 12000),
    "",
  ];

  if (implementationResults?.length) {
    parts.push(
      "## Implementation Summary",
      "Code has been written to disk by the implementation phase. Review the actual files in the repository.",
      ...implementationResults.map(r =>
        `- ${r.teammate}: ${r.success !== false ? `${r.filesWritten || 0} files written${r.fallback ? " (Claude fallback)" : " (local model)"}` : `FAILED: ${r.error}`}`
      ),
      "",
      "## Your Task",
      "Review ALL changed files in the working directory. Check for:",
      "- Correctness against the plan and acceptance criteria",
      "- Code style and convention consistency",
      "- Security issues (injection, XSS, etc.)",
      "- Missing error handling or edge cases",
      "- Test coverage gaps",
      "",
      "Output your review with specific file:line references."
    );
  } else {
    parts.push(
      "## Your Task",
      `Complete your work as ${teammate}.`
    );
  }

  const prompt = parts.join("\n");
  const modelTier = config.routing?.agentToModel?.[teammate] || "sonnet";
  const modelId = config.claude.models[modelTier] || modelTier;
  const product = resolveProduct(job.workingDir);

  const args = [...(config.claude.baseArgs || []), "--model", modelId];
  applyProductPluginDir(args, product);

  // Apply agent-specific tool restrictions (e.g., reviewer is read-only)
  const toolRestrictions = config.routing?.agentToolRestrictions?.[teammate];
  if (toolRestrictions?.disallowedTools?.length) {
    args.push("--disallowedTools", ...toolRestrictions.disallowedTools);
  }

  if (teammate) args.push("--agent", teammate);
  args.push("-p", "--output-format", "stream-json", "--verbose");

  appendLog(job.logFile, `[${nowIso()}] Spawning cloud teammate: ${teammate} (${modelTier}/${modelId})\n`);

  return new Promise((resolve, reject) => {
    const child = spawn(config.claude.command || "claude", args, {
      cwd: job.workingDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = "", stderr = "";
    let lastStreamEvent = null;

    child.stdout.on("data", d => {
      const chunk = d.toString();
      stdout += chunk;
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed);
          if (ev.type === "result") lastStreamEvent = ev;
        } catch {}
      }
    });
    child.stderr.on("data", d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`Cloud teammate ${teammate} timeout`));
    }, (config.jobTimeoutMinutes || 60) * 60000);

    child.on("close", (code) => {
      clearTimeout(timer);
      appendLog(job.logFile, `[${nowIso()}] Cloud teammate ${teammate} exited code=${code}\n`);
      if (lastStreamEvent?.result) {
        resolve(lastStreamEvent.result);
      } else if (code === 0) {
        resolve(extractResultText({ stdout, stderr, lastStreamEvent }));
      } else {
        reject(new Error(`Cloud teammate ${teammate} exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

/**
 * Orchestrate a hybrid team: lead (Claude) → local members (LM Studio) → cloud members (Claude).
 * Returns result in the same format as runClaude().
 */
async function runHybridTeam(job) {
  const hybrid = detectHybridTeam(job);
  if (!hybrid) return null;

  const { localTeammates, cloudTeammates } = hybrid;

  appendLog(job.logFile, `\n[${nowIso()}] ═══ HYBRID TEAM START ═══\n`);
  appendLog(job.logFile, `[${nowIso()}] Lead: ${job.agent} | Local: [${localTeammates}] | Cloud: [${cloudTeammates}]\n`);

  jobEmitter.emit("job:hybrid-team-start", {
    jobId: job.jobId, agent: job.agent, localTeammates, cloudTeammates
  });

  // Step 1: Run team lead as solo planner (no --teammate-mode)
  job._hybridTeam = true;
  appendLog(job.logFile, `[${nowIso()}] Step 1/3: Running ${job.agent} as solo planner (no teammate mode)\n`);

  const planResult = await runClaude(job);
  const planText = extractResultText(planResult);

  if (!planText || planText.length < 50) {
    appendLog(job.logFile, `[${nowIso()}] WARNING: Plan too short (${planText?.length || 0} chars), returning as-is\n`);
    job._hybridTeam = false;
    return planResult;
  }

  appendLog(job.logFile, `[${nowIso()}] Plan extracted: ${planText.length} chars\n`);

  // Step 2: Run local team members (write code via LM Studio)
  appendLog(job.logFile, `[${nowIso()}] Step 2/3: Local implementation\n`);
  const localResults = [];

  for (const teammate of localTeammates) {
    try {
      const result = await runLocalTeamMember(job, planText, teammate);
      localResults.push({ teammate, success: true, ...result });

      if (!metrics.hybridTeam) metrics.hybridTeam = { runs: 0, localRuns: 0, cloudRuns: 0, filesWritten: 0, fallbacks: 0 };
      metrics.hybridTeam.localRuns++;
      metrics.hybridTeam.filesWritten += result.filesWritten;
    } catch (e) {
      appendLog(job.logFile, `[${nowIso()}] Local ${teammate} FAILED: ${e.message}\n`);

      if (config.localTeamMembers.fallbackToClaude) {
        appendLog(job.logFile, `[${nowIso()}] Falling back to Claude for ${teammate}\n`);
        if (!metrics.hybridTeam) metrics.hybridTeam = { runs: 0, localRuns: 0, cloudRuns: 0, filesWritten: 0, fallbacks: 0 };
        metrics.hybridTeam.fallbacks++;

        try {
          const fbText = await runClaudeForTeammate(job, teammate, planText);
          localResults.push({ teammate, success: true, fallback: true, content: fbText, filesWritten: 0 });
        } catch (fbErr) {
          appendLog(job.logFile, `[${nowIso()}] Fallback also failed for ${teammate}: ${fbErr.message}\n`);
          localResults.push({ teammate, success: false, error: fbErr.message });
        }
      } else {
        localResults.push({ teammate, success: false, error: e.message });
      }
    }
  }

  // Step 3: Run cloud team members (reviewer) with context about what changed
  appendLog(job.logFile, `[${nowIso()}] Step 3/3: Cloud teammates\n`);
  const cloudResults = [];

  for (const teammate of cloudTeammates) {
    try {
      const reviewText = await runClaudeForTeammate(job, teammate, planText, localResults);
      cloudResults.push({ teammate, success: true, content: reviewText });

      if (!metrics.hybridTeam) metrics.hybridTeam = { runs: 0, localRuns: 0, cloudRuns: 0, filesWritten: 0, fallbacks: 0 };
      metrics.hybridTeam.cloudRuns++;
    } catch (e) {
      appendLog(job.logFile, `[${nowIso()}] Cloud ${teammate} FAILED: ${e.message}\n`);
      cloudResults.push({ teammate, success: false, error: e.message });
    }
  }

  if (!metrics.hybridTeam) metrics.hybridTeam = { runs: 0, localRuns: 0, cloudRuns: 0, filesWritten: 0, fallbacks: 0 };
  metrics.hybridTeam.runs++;
  saveMetrics();

  // Build combined output
  const combinedLines = [
    `## Team Lead (${job.agent}) — Plan\n`,
    planText.slice(0, 15000),
    "",
  ];

  for (const r of localResults) {
    const label = r.fallback ? "(Claude fallback)" : "(local model)";
    combinedLines.push(`## ${r.teammate} — Implementation ${label}`);
    if (r.success !== false) {
      combinedLines.push(`Files written: ${r.filesWritten || 0}`);
      if (r.content) combinedLines.push(r.content.slice(0, 5000));
    } else {
      combinedLines.push(`FAILED: ${r.error}`);
    }
    combinedLines.push("");
  }

  for (const r of cloudResults) {
    combinedLines.push(`## ${r.teammate} — Review`);
    combinedLines.push(r.success !== false ? (r.content?.slice(0, 8000) || "(no output)") : `FAILED: ${r.error}`);
    combinedLines.push("");
  }

  const combined = combinedLines.join("\n");
  const totalFilesWritten = localResults.reduce((s, r) => s + (r.filesWritten || 0), 0);

  appendLog(job.logFile, `[${nowIso()}] ═══ HYBRID TEAM DONE ═══ ${localResults.length} local, ${cloudResults.length} cloud, ${totalFilesWritten} files written\n\n`);

  jobEmitter.emit("job:hybrid-team-done", {
    jobId: job.jobId, localCount: localResults.length, cloudCount: cloudResults.length,
    filesWritten: totalFilesWritten
  });

  job._hybridTeam = false;

  return {
    stdout: planResult.stdout + "\n" + JSON.stringify({ type: "result", result: combined }),
    stderr: planResult.stderr || "",
    lastStreamEvent: { type: "result", result: combined },
  };
}

// ─── End Hybrid Team ─────────────────────────────────────────────────────────

/**
 * Collect files matching glob-like patterns from a directory.
 * Simple pattern matching without external dependencies.
 */
function collectFiles(dir, patterns, excludes, maxFiles) {
  const results = [];
  const excludeSet = new Set(excludes || []);

  function matchPattern(relPath, pattern) {
    // Exact match
    if (relPath === pattern) return true;
    // Simple glob: "*.ext" matches files ending with .ext
    if (pattern.startsWith("*.")) {
      return relPath.endsWith(pattern.slice(1));
    }
    // Directory glob: "dir/**/*.ext"
    if (pattern.includes("**")) {
      const parts = pattern.split("**");
      const prefix = parts[0].replace(/\/$/, "");
      const suffix = (parts[1] || "").replace(/^\//, "");
      const matchesPrefix = !prefix || relPath.startsWith(prefix + "/") || relPath.startsWith(prefix);
      if (!matchesPrefix) return false;
      if (!suffix) return true;
      // suffix like "/*.ts" → check extension
      if (suffix.startsWith("/*.") || suffix.startsWith("*.")) {
        const ext = suffix.replace(/^\/?\*/, "");
        return relPath.endsWith(ext);
      }
      return true;
    }
    return false;
  }

  function walk(currentDir, depth) {
    if (depth > 6 || results.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (excludeSet.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(dir, fullPath);

      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        for (const pat of patterns) {
          if (matchPattern(relPath, pat)) {
            results.push(fullPath);
            break;
          }
        }
      }
    }
  }

  walk(dir, 0);
  return results;
}

/**
 * Prompt builders
 */
function buildDeliveryPrompt(job) {
  const issueKey = job.issueKey || "(missing issueKey)";
  const summary = job.summary || "";
  const description = job.description || "";
  const product = resolveProduct(job.workingDir);

  const parts = [
    "You are running inside the local repository on this machine.",
    `Your working directory is: ${job.workingDir}`,
    "",
    "Jira Context (may be partial; you should fetch full issue via n8n Jira MCP tools):",
    `Issue Key: ${issueKey}`,
    summary ? `Summary: ${summary}` : "",
    "",
    description ? "Description / Acceptance Criteria:" : "",
    description || "",
    "",
    "Execution Rules:",
    "- Use ONLY the n8n Jira MCP tools for Jira operations.",
    "- Never assume transitions: call get transitions first, then transition by ID.",
    "- Use the agreed comment chain prefixes for automation.",
    "- Keep changes minimal and aligned with repo conventions.",
  ];

  // Inject pre-read brief from local model (saves Claude from reading dozens of files)
  if (job.preReadBrief) {
    parts.push(
      "",
      "<codebase-brief>",
      "The following codebase analysis was produced by a pre-read of the repository.",
      "Use this as your primary context — only read individual files when you need exact code.",
      "",
      job.preReadBrief,
      "</codebase-brief>"
    );
  }

  if (product) {
    parts.push(
      "",
      `<product-context>`,
      JSON.stringify(product, null, 2),
      `</product-context>`
    );
    const routing = buildFileRoutingRules(product);
    if (routing) parts.push("", routing);
  }

  return parts.filter(Boolean).join("\n");
}

function buildChatPrompt(job) {
  const conversationId = job.conversationId || "default";
  const message = job.message || "";
  const historyText = job.historyText ? job.historyText : "";
  const product = resolveProduct(job.workingDir);
  const routing = buildFileRoutingRules(product);
  const productBlock = product
    ? ["", `<product-context>`, JSON.stringify(product, null, 2), `</product-context>`, ...(routing ? ["", routing] : [])]
    : [];

  // When an agent is specified, don't inject a generic identity — let the --agent flag's
  // persona definition take precedence. Only provide conversation context and the message.
  if (job.agent && job.agent !== "default") {
    const agentDisplayName = job.agent.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    return [
      `You are the ${agentDisplayName} agent. CHAT MODE (conversational, no Jira issue required).`,
      `IMPORTANT: You are ONLY the ${agentDisplayName}. You are NOT a general assistant. Respond strictly from your agent persona as defined in your agent definition file. If asked who you are or what department you work in, answer based on your agent persona ONLY.`,
      "",
      `Conversation ID: ${conversationId}`,
      "",
      historyText ? "Conversation so far:" : "",
      historyText || "",
      "",
      "Latest user message:",
      message,
      "",
      "Rules:",
      `- You are the ${agentDisplayName} agent. Never identify as any other role.`,
      "- Keep replies concise and actionable.",
      "- If the user asks you to create or update Jira items, do so via the n8n Jira MCP tools.",
      "- Ask clarifying questions when needed.",
      ...(buildConsultSectionForChatAgent(job) || []),
      ...productBlock,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "You are an assistant running on a developer machine.",
    "You are in CHAT MODE (no Jira issue required).",
    "",
    `Conversation ID: ${conversationId}`,
    "",
    historyText ? "Conversation so far:" : "",
    historyText || "",
    "",
    "Latest user message:",
    message,
    "",
    "Rules:",
    "- Keep replies concise and actionable.",
    "- If the user asks you to create or update Jira items, do so via the n8n Jira MCP tools.",
    "- Ask clarifying questions when needed.",
    "- When helpful, propose next steps as bullet points.",
    ...productBlock,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAgentPrompt(job) {
  const prompt = job.prompt || job.message || "";
  const context = job.context || "";
  const agentName = job.agent || "";
  const product = resolveProduct(job.workingDir);

  const parts = [
    "You are running inside the local repository on this machine.",
    `Your working directory is: ${job.workingDir}`,
    "",
    "You are in DIRECT AGENT MODE - executing a task without a Jira ticket.",
    "",
    context ? "Context:" : "",
    context || "",
    "",
    "Task:",
    prompt,
    "",
    "Rules:",
    "- Execute the task autonomously and report results.",
    "- Use n8n Jira MCP tools if you need to create/update Jira issues.",
    "- Follow your agent-specific guidelines and skill references.",
    "- Keep output focused and actionable.",
  ];

  // Inject pre-read brief from local model
  if (job.preReadBrief) {
    parts.push(
      "",
      "<codebase-brief>",
      "The following codebase analysis was produced by a pre-read of the repository.",
      "Use this as your primary context — only read individual files when you need exact code.",
      "",
      job.preReadBrief,
      "</codebase-brief>"
    );
  }

  // Consultation section: agent-to-agent consultation via /internal/consult
  const consultLines = buildConsultSectionForAgentPrompt(job, agentName);
  if (consultLines.length) parts.push(...consultLines);

  if (product) {
    parts.push(
      "",
      `<product-context>`,
      JSON.stringify(product, null, 2),
      `</product-context>`
    );
    const routing = buildFileRoutingRules(product);
    if (routing) parts.push("", routing);
  }

  return parts.filter(Boolean).join("\n");
}

/**
 * Parse Claude JSON output
 */
function tryParseClaudeJson(stdout) {
  const s = String(stdout || "").trim();
  if (!s) return null;

  // stream-json: look for the last "result" event in the multi-line output
  const lines = s.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "result") return parsed;
    } catch { /* skip non-JSON lines */ }
  }

  // Fallback: try to find any valid JSON object (backwards compat with json format)
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === "{") {
      const candidate = s.slice(i);
      try {
        return JSON.parse(candidate);
      } catch {}
    }
  }

  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractAssistantText(parsed) {
  // Claude Code JSON has "result" (string) on success
  if (parsed && typeof parsed.result === "string" && parsed.result.trim()) return parsed.result.trim();
  return "";
}


/**
 * Extract all assistant text from stream-json stdout output.
 * Aggregates text from assistant events and the final result event.
 */
function extractResultText(runResult) {
  if (runResult.lastStreamEvent?.result) return runResult.lastStreamEvent.result;
  const parts = [];
  for (const line of (runResult.stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed);
      if (ev.type === "assistant" && ev.message?.content) {
        for (const c of ev.message.content) {
          if (c.type === "text") parts.push(c.text);
        }
      }
      if (ev.type === "result" && ev.result) parts.push(ev.result);
    } catch { /* not JSON */ }
  }
  return parts.join("\n");
}


/**
 * Build consult section as array of lines for the chat prompt (agent-specific variant).
 */
function buildConsultSectionForChatAgent(job) {
  return [
    "", "## Consulting Other Agents",
    "You can consult other CertPilot agents for their expertise. Use this when a question falls outside your domain.",
    "",
    "Available agents you can consult:",
    "- engineer-planner: Technical planning, architecture decisions, implementation strategy",
    "- engineer-implementer: Code implementation details, PR specifics",
    "- engineer-reviewer: Code quality, review standards",
    "- product-manager: Prioritisation, requirements, acceptance criteria",
    "- security-agent: Security concerns, vulnerability assessment",
    "- marketing: Content strategy, brand voice, messaging",
    "- sales-development: Sales strategy, pipeline, ICP",
    "- sales-researcher: Prospect research, market intelligence",
    "- ba-agent: Requirements analysis, story enrichment",
    "- architect-jets: System architecture, design patterns",
    "- sprint-reporter: Sprint metrics, velocity data",
    "- qa-agent: Testing strategy, quality gates",
    "- ask-tom-agent: Complex troubleshooting, root cause analysis",
    "",
    "To consult an agent, use the Bash tool:",
    `curl -s -X POST http://localhost:${config.port || 3210}/internal/consult \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "x-runner-secret: $RUNNER_SECRET" \\`,
    `  -d '{"agent": "<agent-name>", "question": "<your question>", "context": "<relevant context>", "requestingAgent": "${job.agent}"}'`,
    "",
    "Only consult when genuinely needed.",
  ];
}

/**
 * Build consult section as array of lines for the agent prompt (direct agent mode).
 */
function buildConsultSectionForAgentPrompt(job, agentName) {
  return [
    "", "## Consulting Other Agents",
    "You can consult other CertPilot agents for their expertise. Use this when a question falls outside your domain.",
    "",
    "Available agents you can consult:",
    "- engineer-planner: Technical planning, architecture decisions, implementation strategy",
    "- engineer-implementer: Code implementation details, PR specifics",
    "- engineer-reviewer: Code quality, review standards",
    "- product-manager: Prioritisation, requirements, acceptance criteria",
    "- security-agent: Security concerns, vulnerability assessment",
    "- marketing: Content strategy, brand voice, messaging",
    "- sales-development: Sales strategy, pipeline, ICP",
    "- sales-researcher: Prospect research, market intelligence",
    "- ba-agent: Requirements analysis, story enrichment",
    "- architect-jets: System architecture, design patterns",
    "- sprint-reporter: Sprint metrics, velocity data",
    "- qa-agent: Testing strategy, quality gates",
    "- ask-tom-agent: Complex troubleshooting, root cause analysis",
    "",
    "To consult an agent, use the Bash tool:",
    `curl -s -X POST http://localhost:${config.port || 3210}/internal/consult \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "x-runner-secret: $RUNNER_SECRET" \\`,
    `  -d '{"agent": "<agent-name>", "question": "<your question>", "context": "<relevant context>", "requestingAgent": "${agentName}"}'`,
    "",
    "Only consult when genuinely needed.",
  ];
}

/**
 * POST JSON helper (callback)
 */
function postJson(urlStr, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === "https:" ? https : http;

      const body = Buffer.from(JSON.stringify(payload), "utf8");

      const req = lib.request(
        {
          method: "POST",
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + (u.search || ""),
          headers: {
            "content-type": "application/json",
            "content-length": body.length,
            ...headers,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (d) => (data += d.toString()));
          res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
        }
      );

      req.on("error", reject);
      req.write(body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function getJson(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === "https:" ? https : http;

      const req = lib.request(
        {
          method: "GET",
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + (u.search || ""),
          headers: { accept: "application/json", ...headers },
        },
        (res) => {
          let data = "";
          res.on("data", (d) => (data += d.toString()));
          res.on("end", () => {
            let parsed = null;
            try { parsed = JSON.parse(data); } catch {}
            resolve({ statusCode: res.statusCode, body: data, json: parsed });
          });
        }
      );
      req.on("error", reject);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * OAuth credential cache — read from .credentials.json (bind-mounted from host).
 * On macOS, Claude CLI stores OAuth in Keychain; Docker containers can't access Keychain,
 * so we read from a synced file and inject tokens as env vars into spawned processes.
 * The host-side sync-auth.sh script writes Keychain → .credentials.json periodically.
 */
let _oauthCache = { accessToken: null, refreshToken: null, expiresAt: 0, lastRead: 0 };
const OAUTH_CACHE_TTL_MS = 30_000; // Re-read file every 30s at most

function getOAuthEnvVars() {
  const now = Date.now();

  // Return cached values if fresh
  if (_oauthCache.accessToken && now - _oauthCache.lastRead < OAUTH_CACHE_TTL_MS && _oauthCache.expiresAt > now + 60_000) {
    return {
      CLAUDE_CODE_OAUTH_TOKEN: _oauthCache.accessToken,
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: _oauthCache.refreshToken || "",
    };
  }

  // Read from .credentials.json
  const homeDir = process.env.HOME || "/home/node";
  const credFile = path.join(homeDir, ".claude", ".credentials.json");
  try {
    if (!fs.existsSync(credFile)) return {};
    const creds = JSON.parse(fs.readFileSync(credFile, "utf8"));
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) return {};

    _oauthCache = {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken || null,
      expiresAt: oauth.expiresAt || 0,
      lastRead: now,
    };

    // If token expires within 5 min, attempt refresh
    if (oauth.expiresAt && oauth.expiresAt - now < 5 * 60 * 1000 && oauth.refreshToken) {
      console.log(`[${nowIso()}] OAuth token near expiry (${Math.round((oauth.expiresAt - now) / 60000)}min left) — refreshing`);
      refreshOAuthToken(oauth.refreshToken).then((result) => {
        if (result) {
          _oauthCache.accessToken = result.access_token;
          _oauthCache.expiresAt = now + result.expires_in * 1000;
          if (result.refresh_token) _oauthCache.refreshToken = result.refresh_token;
          // Write back to file so other processes and future restarts get the fresh token
          try {
            const updated = { claudeAiOauth: { ...oauth, accessToken: result.access_token, expiresAt: _oauthCache.expiresAt } };
            if (result.refresh_token) updated.claudeAiOauth.refreshToken = result.refresh_token;
            fs.writeFileSync(credFile, JSON.stringify(updated, null, 2), "utf8");
            console.log(`[${nowIso()}] OAuth token refreshed and written to ${credFile}`);
          } catch (e) {
            console.error(`[${nowIso()}] Failed to write refreshed token: ${e.message}`);
          }
        }
      }).catch(() => {});
    }

    return {
      CLAUDE_CODE_OAUTH_TOKEN: _oauthCache.accessToken,
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: _oauthCache.refreshToken || "",
    };
  } catch (e) {
    console.error(`[${nowIso()}] Failed to read OAuth credentials: ${e.message}`);
    return {};
  }
}

/**
 * Get spawn environment based on provider routing
 * Z.ai agents get ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN set
 * per https://docs.z.ai/devpack/tool/claude
 */
function getSpawnEnv(job) {
  const routing = config.routing || {};
  const providers = config.providers || {};
  const agentToProvider = routing.agentToProvider || {};

  // Provider priority: explicit job request > agent routing > default (claude)
  const provider = job.requestedProvider || agentToProvider[job.agent] || "claude";
  const providerConfig = providers[provider] || providers.claude;

  const env = { ...process.env, ...getOAuthEnvVars() };

  if (provider === "zai" && providerConfig) {
    // Set Z.ai-specific environment variables per Z.ai docs
    // Uses ANTHROPIC_AUTH_TOKEN (not ANTHROPIC_API_KEY)
    env.ANTHROPIC_BASE_URL = providerConfig.baseUrl;
    const apiKey = process.env[providerConfig.authTokenEnvVar];
    if (apiKey) {
      env.ANTHROPIC_AUTH_TOKEN = apiKey;
    }
    if (providerConfig.timeoutMs) {
      env.API_TIMEOUT_MS = String(providerConfig.timeoutMs);
    }
    console.log(`[getSpawnEnv] Z.ai routing: agent=${job.agent}, baseUrl=${providerConfig.baseUrl}`);
  }

  return { env, provider, providerConfig };
}

/**
 * Pre-flight auth check using `claude auth status`.
 * Detects expired/missing auth before wasting a job attempt.
 * Also attempts token refresh via Anthropic's OAuth endpoint if token is near expiry.
 */
async function ensureOAuthValid(job) {
  // 1. Fast check: inspect credentials file for token expiry
  const homeDir = process.env.HOME || "/home/node";
  const credFile = path.join(homeDir, ".claude", ".credentials.json");

  try {
    if (fs.existsSync(credFile)) {
      const creds = JSON.parse(fs.readFileSync(credFile, "utf8"));
      const oauth = creds.claudeAiOauth;
      if (oauth?.expiresAt) {
        const remainingMs = oauth.expiresAt - Date.now();
        const remainingMin = Math.round(remainingMs / 60000);

        if (remainingMs > 5 * 60 * 1000) {
          return true; // Token valid for >5 minutes
        }

        appendLog(job.logFile, `[${nowIso()}] OAuth token expires in ${remainingMin}min — attempting refresh\n`);

        // Attempt refresh using the refresh token
        if (oauth.refreshToken) {
          const refreshResult = await refreshOAuthToken(oauth.refreshToken);
          if (refreshResult) {
            creds.claudeAiOauth.accessToken = refreshResult.access_token;
            creds.claudeAiOauth.expiresAt = Date.now() + (refreshResult.expires_in * 1000);
            if (refreshResult.refresh_token) {
              creds.claudeAiOauth.refreshToken = refreshResult.refresh_token;
            }
            fs.writeFileSync(credFile, JSON.stringify(creds, null, 2), "utf8");
            appendLog(job.logFile, `[${nowIso()}] OAuth token refreshed — new expiry in ${Math.round(refreshResult.expires_in / 60)}min\n`);
            console.log(`[${nowIso()}] OAuth token refreshed for job ${job.jobId}`);
            return true;
          }
        }
      }
    }

    // 2. Fallback: run `claude auth status` to check if CLI thinks it's logged in
    return new Promise((resolve) => {
      const child = spawn(config.claude.command || "claude", ["auth", "status"], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...getOAuthEnvVars() },
        timeout: 10000,
      });

      let stdout = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.on("close", (code) => {
        try {
          const status = JSON.parse(stdout);
          if (status.loggedIn) {
            return resolve(true);
          }
          appendLog(job.logFile, `[${nowIso()}] WARNING: claude auth status reports not logged in\n`);
          console.error(`[${nowIso()}] Auth check failed: not logged in. Run 'claude' then '/login' from the project.`);
          resolve(false);
        } catch {
          // Non-JSON output or parse error
          resolve(code === 0);
        }
      });
      child.on("error", () => resolve(false));
    });
  } catch (e) {
    console.error(`[${nowIso()}] OAuth check error:`, e.message);
    return false;
  }
}

/**
 * Refresh an OAuth token using Anthropic's token endpoint.
 * Returns { access_token, expires_in, refresh_token } or null on failure.
 */
function refreshOAuthToken(refreshToken) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    });

    const req = https.request({
      hostname: "platform.claude.com",
      path: "/v1/oauth/token",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
      timeout: 10000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        } else {
          console.error(`[${nowIso()}] OAuth refresh failed: ${res.statusCode} ${data.substring(0, 200)}`);
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

/**
 * Run a short, stateless Claude subprocess for inter-agent consultation.
 * Runs outside the job queue (no MAX_CONCURRENCY slot consumed).
 * Returns { output: string, model: string }.
 */
async function runConsultation({ agent, prompt, timeout = 120000, parentJobId }) {
  const modelId = resolveModelForAgent(agent);

  const args = [...(config.claude.baseArgs || ["--dangerously-skip-permissions"])];
  args.push("--model", modelId);
  args.push("--no-session-persistence");
  args.push("--max-turns", "3"); // Keep consultations short
  if (agent) args.push("--agent", agent);
  args.push("-p", "--output-format", "json");

  const workingDir = config.workingDir || DEFAULT_WORKING_DIR || process.cwd();

  // Per-product plugin directory: resolve from parent job's workingDir if available
  const parentJob = parentJobId ? jobs.get(parentJobId) : null;
  const consultProduct = resolveProduct(parentJob?.workingDir || workingDir);
  applyProductPluginDir(args, consultProduct);

  // Log to parent job's log file if available, otherwise console only
  const logLine = (msg) => {
    const line = `[${nowIso()}] [consult:${agent}] ${msg}\n`;
    if (parentJobId) {
      const parentJob = jobs.get(parentJobId);
      if (parentJob?.logFile) {
        try { appendLog(parentJob.logFile, line); } catch {}
      }
    }
    console.log(line.trimEnd());
  };

  logLine(`Starting consultation: agent=${agent} model=${modelId} parentJob=${parentJobId || "none"}`);

  return new Promise((resolve, reject) => {
    const child = spawn(config.claude.command || "claude", args, {
      cwd: workingDir,
      env: { ...process.env, ...getOAuthEnvVars() },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.stdin.write(prompt);
    child.stdin.end();

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      reject(new Error("Consultation timed out after " + timeout + "ms"));
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      logLine(`Consultation exited code=${code} stdoutLen=${stdout.length}`);
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve({ output: parsed.result || stdout.trim(), model: modelId });
        } catch {
          resolve({ output: stdout.trim(), model: modelId });
        }
      } else {
        reject(new Error(`Consultation exited with code ${code}: ${stderr.slice(0, 300)}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Consultation spawn error: ${err.message}`));
    });
  });
}

/**
 * Run Claude with selected model
 */
async function runClaude(job) {
  const timeoutMs = JOB_TIMEOUT_MINUTES * 60 * 1000;

  // Get provider-specific environment
  const { env: providerEnv, provider, providerConfig } = getSpawnEnv(job);

  // Pre-flight: ensure OAuth token is valid (skip for local/zai — they use their own auth)
  if (provider === "claude") {
    await ensureOAuthValid(job).catch(() => {}); // Best-effort — don't block if check fails
  }

  // Get selected model and resolve to full model ID
  // Providers with modelMapping (e.g. zai) use their own IDs
  const model = job.selectedModel || "sonnet";
  let modelId;
  if (providerConfig?.modelMapping) {
    modelId = providerConfig.modelMapping[model] || providerConfig.modelMapping.default || providerConfig.modelMapping.sonnet;
  } else {
    modelId = config.claude.models[model] || config.claude.models.sonnet;
  }

  return new Promise((resolve, reject) => {
    let prompt;
    if (job.mode === "chat") {
      prompt = buildChatPrompt(job);
    } else if (job.mode === "agent") {
      prompt = buildAgentPrompt(job);
    } else {
      prompt = buildDeliveryPrompt(job);
    }

    // Build args from config with model selection
    const args = [...(config.claude.baseArgs || ["--dangerously-skip-permissions"])];
    args.push("--model", modelId);

    // Fallback model: auto-fallback to sonnet when opus is overloaded (Claude provider only)
    if (provider === "claude" && (model === "opus" || modelId.includes("opus"))) {
      const fallbackId = config.claude.models.sonnet || "claude-sonnet-4-6";
      args.push("--fallback-model", fallbackId);
    }

    // No session persistence: runner jobs are one-shot, don't save sessions to disk
    args.push("--no-session-persistence");

    // Effort level: low for haiku, xhigh for agents in routing.agentEffort map
    const agentEffort = config.routing?.agentEffort?.[job.agent];
    if (agentEffort) {
      args.push("--effort", agentEffort);
    } else if (model === "haiku") {
      args.push("--effort", "low");
    }

    // Per-job budget cap from CLI (defence-in-depth alongside runner budget)
    const perJobBudget = config.budget?.perJobLimitUsd;
    if (perJobBudget) {
      args.push("--max-budget-usd", String(perJobBudget));
    }

    // Check if Chrome should be enabled for visual testing
    const chromeCheck = shouldEnableChrome(job);
    job.chromeEnabled = chromeCheck.enabled;
    job.chromeReason = chromeCheck.reason;
    if (chromeCheck.enabled) {
      args.push("--chrome");
    }

    // Agent Teams: set display mode and tool restrictions for team lead agents
    // Skip for hybrid teams — lead runs solo as planner, teammates are managed by the runner
    if (config.teams?.enabled && config.teams.teamLeads?.[job.agent] && !job._hybridTeam) {
      const leadConfig = config.teams.teamLeads[job.agent];
      args.push("--teammate-mode", leadConfig.teammateMode || "in-process");
      // Hard-block implementation tools so team leads MUST delegate to teammates
      if (leadConfig.disallowedTools?.length) {
        args.push("--disallowedTools", ...leadConfig.disallowedTools);
      }
    }

    // Agent-specific tool restrictions from config
    const agentToolRestrictions = config.routing?.agentToolRestrictions?.[job.agent];
    if (agentToolRestrictions) {
      if (agentToolRestrictions.allowedTools?.length) {
        args.push("--allowedTools", ...agentToolRestrictions.allowedTools);
      }
      if (agentToolRestrictions.disallowedTools?.length) {
        args.push("--disallowedTools", ...agentToolRestrictions.disallowedTools);
      }
    }

    if (job.agent) args.push("--agent", job.agent);
    args.push("-p", "--output-format", "stream-json", "--verbose");

    // Per-product plugin directory: use optimized dir with only declared skills, or fall back to full dirs
    const jobProduct = resolveProduct(job.workingDir);
    const optimizedDir = buildOptimizedPluginDir(job.agent, jobProduct, job.jobId, provider);
    if (optimizedDir) {
      // Single temp dir with only the skills this agent declared in frontmatter
      let idx;
      while ((idx = args.indexOf('--plugin-dir')) >= 0) {
        args.splice(idx, idx + 1 < args.length ? 2 : 1);
      }
      args.push('--plugin-dir', optimizedDir);
      job._tmpPluginDir = optimizedDir;
      appendLog(job.logFile, `[${nowIso()}] Using optimized plugin dir (${optimizedDir})\n`);
    } else {
      // No skill declarations in frontmatter — load everything (backward-compatible)
      applyProductPluginDir(args, jobProduct);
    }

    // Per-agent MCP allowlist: build a filtered .mcp.json and pass via --mcp-config + --strict-mcp-config
    // This suppresses fan-out of MCP servers the agent doesn't need (memory pressure mitigation).
    if (provider === 'claude') {
      const filteredMcp = buildFilteredMcpConfig(job.agent, jobProduct, job.jobId, job.workingDir, optimizedDir);
      if (filteredMcp) {
        args.push('--mcp-config', filteredMcp, '--strict-mcp-config');
        appendLog(job.logFile, `[${nowIso()}] MCP allowlist active: ${filteredMcp}\n`);
      }
    }

    // Pass prompt via stdin to avoid very long CLI args that may cause issues
    let promptViaStdin = prompt;

    // Z.ai/GLM providers don't auto-load CLAUDE.md from the working directory.
    // Read it explicitly and prepend to the prompt so GLM gets project context.
    if (provider !== "claude" && job.workingDir) {
      const claudeMdPath = path.join(job.workingDir, "CLAUDE.md");
      try {
        if (fs.existsSync(claudeMdPath)) {
          const claudeMdContent = fs.readFileSync(claudeMdPath, "utf8");
          if (claudeMdContent.trim()) {
            promptViaStdin = `<project-instructions>\nThe following is the CLAUDE.md project instructions file from the working directory. Follow these instructions carefully.\n\n${claudeMdContent}\n</project-instructions>\n\n${promptViaStdin}`;
            appendLog(job.logFile, `[${nowIso()}] Injected CLAUDE.md (${claudeMdContent.length} chars) into prompt for ${provider} provider\n`);
          }
        }
      } catch (err) {
        appendLog(job.logFile, `[${nowIso()}] WARNING: Failed to read CLAUDE.md: ${err.message}\n`);
      }
    }

    appendLog(job.logFile, `[${nowIso()}] Starting claude (${model}/${modelId}) jobId=${job.jobId} mode=${job.mode} agent=${job.agent || "default"} provider=${provider}\n`);
    appendLog(job.logFile, `[${nowIso()}] CLI args: claude ${args.join(" ")}\n`);
    if (provider !== "claude") {
      appendLog(job.logFile, `[${nowIso()}] Using provider: ${provider} (${providerConfig?.baseUrl || "default"})\n`);
    }
    if (chromeCheck.enabled) {
      appendLog(job.logFile, `[${nowIso()}] Chrome enabled: ${chromeCheck.reason}\n`);
    }
    if (job.workingDir) appendLog(job.logFile, `[${nowIso()}] CWD=${job.workingDir}\n`);

    const spawnCwd = job.workingDir || process.cwd();

    // Build env from provider-specific environment with shared task list for cross-phase coordination
    const spawnEnv = { ...providerEnv };
    if (job.issueKey) {
      // All phases of the same Jira issue share one task list
      // so planner's tasks are visible to implementer, reviewer, etc.
      spawnEnv.CLAUDE_CODE_TASK_LIST_ID = job.issueKey;
      appendLog(job.logFile, `[${nowIso()}] Task list: ${job.issueKey} (shared across phases)\n`);
    }
    if (job.agent) spawnEnv.CERTPILOT_AGENT = job.agent;
    if (job.issueKey) spawnEnv.CERTPILOT_ISSUE = job.issueKey;
    const _jobProductId = resolveProduct(job.workingDir);
    if (_jobProductId) spawnEnv.CERTPILOT_PRODUCT = _jobProductId;
    if (Array.isArray(job.labels) && job.labels.length) spawnEnv.CERTPILOT_LABELS = job.labels.join(",");
    spawnEnv.CERTPILOT_RUNNER_URL = process.env.RUNNER_INTERNAL_URL || `http://runner:${config.port || 3210}`;
    if (process.env.RUNNER_SECRET) spawnEnv.CERTPILOT_RUNNER_SECRET = process.env.RUNNER_SECRET;

    // Agent Teams: enable for team lead agents (skip for hybrid — runner manages teammates)
    if (config.teams?.enabled && config.teams.teamLeads?.[job.agent] && !job._hybridTeam) {
      spawnEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
      appendLog(job.logFile, `[${nowIso()}] Agent Teams enabled: ${job.agent} is team lead (teammates: ${config.teams.teamLeads[job.agent].teammates?.join(", ") || "none"})\n`);
    } else if (job._hybridTeam) {
      appendLog(job.logFile, `[${nowIso()}] Hybrid team mode: ${job.agent} running as solo planner\n`);
    }

    // Track provider usage on job
    job.provider = provider;

    const child = spawn(config.claude.command || "claude", args, {
      cwd: spawnCwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
    });
    // Write prompt to stdin then close - Claude CLI reads from stdin when -p has no trailing argument
    child.stdin.write(promptViaStdin);
    child.stdin.end();

    job.processPid = child.pid;
    appendLog(job.logFile, `[${nowIso()}] Spawned PID=${child.pid}\n`);

    let stdout = "";
    let stderr = "";
    let lastStreamEvent = null;
    job.streamEvents = job.streamEvents || []; // Store on job for real-time access
    let lineBuffer = ""; // Buffer for incomplete lines
    let resultExitTimer = null; // Safety: kill if process lingers after result

    const timer = setTimeout(() => {
      appendLog(job.logFile, `\n[${nowIso()}] Timeout after ${timeoutMs}ms, killing process\n`);
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);

    // Process stream-json events line by line
    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      lineBuffer += chunk;

      // Process complete lines
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || ""; // Keep incomplete last line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const event = JSON.parse(trimmed);
          lastStreamEvent = event;

          // Emit real-time SSE events based on stream-json event type
          if (event.type === "system" && event.subtype === "init") {
            // Session initialized — emit with tools and model info
            const initData = {
              jobId: job.jobId,
              agent: job.agent,
              model: event.model,
              tools: event.tools,
              sessionId: event.session_id,
            };
            jobEmitter.emit("job:progress", { ...initData, streamType: "init" });
            job.sessionId = event.session_id;
            const toolList = event.tools || [];
            appendLog(job.logFile, `[${nowIso()}] Stream: session init model=${event.model} tools=${toolList.length}\n`);

            // MCP eager-load check: warn if n8n-jira-mcp tools aren't in the eager list.
            // Not fatal — MCP tools may still be available via tool-search/deferral, and
            // the agent can fall back to direct REST. Killing the process here was
            // causing SIGTERM cascades for jobs that would otherwise have succeeded.
            const jobProductForMcp = resolveProduct(job.workingDir);
            if (jobProductForMcp) {
              const mcpJsonPath = path.join(resolvePluginDir(jobProductForMcp), ".mcp.json");
              try {
                const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8"));
                const expectedServers = Object.keys(mcpConfig.mcpServers || {});
                const hasJiraMcp = toolList.some(t => typeof t === "string" ? t.includes("jira-mcp") : (t.name || "").includes("jira-mcp"));
                if (expectedServers.includes("n8n-jira-mcp") && !hasJiraMcp) {
                  const msg = `MCP eager-load: n8n-jira-mcp not in ${toolList.length} eager tools (deferral assumed; agent may need ToolSearch).`;
                  appendLog(job.logFile, `[${nowIso()}] ${msg}\n`);
                }
              } catch { /* no .mcp.json or unreadable — skip check */ }
            }
          } else if (event.type === "assistant" && event.message) {
            // Assistant message chunk — extract text content
            const textParts = (event.message.content || [])
              .filter(c => c.type === "text")
              .map(c => c.text)
              .join("");
            if (textParts) {
              jobEmitter.emit("job:progress", {
                jobId: job.jobId,
                agent: job.agent,
                streamType: "assistant",
                text: textParts.slice(0, 500), // Truncate for SSE
                tokens: event.message.usage?.output_tokens || 0,
              });
            }
            // Check for tool_use content blocks
            const toolUses = (event.message.content || []).filter(c => c.type === "tool_use");
            for (const tu of toolUses) {
              const toolData = {
                jobId: job.jobId,
                agent: job.agent,
                streamType: "tool_use",
                tool: tu.name,
                toolId: tu.id,
                input: typeof tu.input === "string" ? tu.input.slice(0, 200) : JSON.stringify(tu.input || {}).slice(0, 200),
              };
              jobEmitter.emit("job:progress", toolData);
              job.streamEvents.push({ type: "tool_use", tool: tu.name, ts: nowIso() });
              appendLog(job.logFile, `[${nowIso()}] Stream: tool_use ${tu.name}\n`);
              // Skill usage telemetry: detect reads/script runs against shared-skills
              const skillEvent = detectSkillEvent(tu.name, tu.input);
              if (skillEvent) {
                trackSkillUsage(skillEvent.skillName, skillEvent.eventType, job.agent || "unknown");
                appendLog(job.logFile, `[${nowIso()}] Stream: skill_usage skill=${skillEvent.skillName} type=${skillEvent.eventType} agent=${job.agent || "unknown"}\n`);
              }
            }
          } else if (event.type === "tool_result") {
            jobEmitter.emit("job:progress", {
              jobId: job.jobId,
              agent: job.agent,
              streamType: "tool_result",
              toolId: event.tool_use_id,
              // Don't send full output — could be huge
            });
          } else if (event.type === "result") {
            // Final result — this is the one we parse for the job output
            appendLog(job.logFile, `[${nowIso()}] Stream: result status=${event.subtype} cost=$${event.total_cost_usd?.toFixed(4) || "?"}\n`);
            // Emit live cost update
            jobEmitter.emit("job:progress", {
              jobId: job.jobId,
              agent: job.agent,
              streamType: "result",
              costUsd: event.total_cost_usd,
              durationMs: event.duration_ms,
              numTurns: event.num_turns,
            });
            // Safety: if process doesn't exit after result, kill it
            // Team leads get 5 min (sub-agents need time), others get 60s
            // With --agent mode there can be multiple result events, so reset each time
            const lingerMs = job.teamRole === "lead" ? 300000 : 60000;
            if (resultExitTimer) clearTimeout(resultExitTimer);
            resultExitTimer = setTimeout(() => {
              appendLog(job.logFile, `\n[${nowIso()}] Process lingering ${lingerMs / 1000}s after result event, sending SIGTERM\n`);
              try { child.kill("SIGTERM"); } catch {}
              // Force kill after 10s if still alive
              setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 10000);
            }, lingerMs);
          } else if (event.type === "rate_limit_event") {
            appendLog(job.logFile, `[${nowIso()}] Stream: rate_limit status=${event.rate_limit_info?.status}\n`);
          }
        } catch {
          // Not JSON — append as raw log output
          appendLog(job.logFile, trimmed + "\n");
        }
      }
    });

    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      fs.appendFileSync(job.logFile, s, { encoding: "utf8" });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      appendLog(job.logFile, `\n[${nowIso()}] Spawn error: ${err.message}\n`);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (resultExitTimer) clearTimeout(resultExitTimer);

      // Process any remaining buffered line
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer.trim());
          if (event.type === "result") lastStreamEvent = event;
        } catch { /* ignore */ }
      }

      appendLog(job.logFile, `\n[${nowIso()}] Process exited with code ${code}\n`);

      if (code !== 0) {
        return reject(new Error(`claude exited with code ${code}. stderr: ${stderr.slice(0, 2000)}`));
      }

      resolve({ stdout, stderr, lastStreamEvent });
    });
  });
}

/**
 * Extract usage info from Claude output
 */
function extractUsageFromOutput(parsedOutput) {
  if (!parsedOutput) return null;

  // stream-json result events have both `usage` (totals) and `modelUsage` (per-model breakdown)
  // Use modelUsage if available (more detailed), otherwise fall back to usage
  const usage = parsedOutput.usage || {};
  const modelUsage = parsedOutput.modelUsage || {};

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  if (Object.keys(modelUsage).length > 0) {
    // Prefer modelUsage (stream-json): aggregate across all models used
    for (const model of Object.values(modelUsage)) {
      inputTokens += model.inputTokens || 0;
      outputTokens += model.outputTokens || 0;
      cacheReadTokens += model.cacheReadInputTokens || 0;
      cacheCreationTokens += model.cacheCreationInputTokens || 0;
    }
  } else {
    // Fallback to usage object (legacy json format)
    inputTokens = usage.input_tokens || usage.inputTokens || 0;
    outputTokens = usage.output_tokens || usage.outputTokens || 0;
    cacheReadTokens = usage.cache_read_input_tokens || usage.cacheReadInputTokens || 0;
    cacheCreationTokens = usage.cache_creation_input_tokens || usage.cacheCreationInputTokens || 0;
  }

  // Prefer the CLI's own cost calculation (total_cost_usd) over our estimate
  const cliCost = parsedOutput.total_cost_usd;
  const estimatedCostUsd = cliCost != null
    ? Math.round(cliCost * 10000) / 10000
    : Math.round(((inputTokens / 1000000) * TOKEN_PRICE_INPUT + (outputTokens / 1000000) * TOKEN_PRICE_OUTPUT) * 10000) / 10000;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    estimatedCostUsd,
    durationMs: parsedOutput.duration_ms || null,
    numTurns: parsedOutput.num_turns || null,
    sessionId: parsedOutput.session_id || null,
  };
}

/**
 * Run a single quality gate check
 */
function runQualityCheck(check, workingDir) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const child = spawn("sh", ["-c", check.cmd], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    // Timeout after 5 minutes per check
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({
        name: check.name,
        passed: false,
        output: "Timeout after 5 minutes",
        durationMs: Date.now() - startTime
      });
    }, 5 * 60 * 1000);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        name: check.name,
        passed: code === 0,
        output: stdout + stderr,
        exitCode: code,
        durationMs: Date.now() - startTime
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        name: check.name,
        passed: false,
        output: `Error: ${err.message}`,
        durationMs: Date.now() - startTime
      });
    });
  });
}

/**
 * Run quality gate checks after implementation
 * Returns { passed, results, failedCheck, retryContext }
 */
async function runQualityGate(job) {
  const qg = config.qualityGate;
  if (!qg.enabled) {
    return { passed: true, skipped: true, results: [] };
  }

  // Only run for configured agents
  if (!qg.runAfterAgents.includes(job.agent)) {
    return { passed: true, skipped: true, reason: `agent ${job.agent} not in runAfterAgents`, results: [] };
  }

  // Skip code quality gate for phases whose gate type is not 'quality-gate'
  // (e.g. comment-prefix phases like triage/requirements/security-review don't produce testable code)
  if (job.pipelineGateType && job.pipelineGateType !== "quality-gate") {
    return { passed: true, skipped: true, reason: `phase gate type is '${job.pipelineGateType}', not 'quality-gate'`, results: [] };
  }

  // Product-level quality gate override: check product.json for custom checks
  let productChecks = null;
  for (const [, product] of products) {
    const mappedDir = config.pathMappings?.[product.workingDir] || product.workingDir;
    if (job.workingDir === product.workingDir || job.workingDir === mappedDir) {
      productChecks = product.qualityGate?.checks || null;
      if (productChecks) {
        appendLog(job.logFile, `\n[${nowIso()}] Using product-level quality gate checks for ${product.name}\n`);
      }
      break;
    }
  }

  appendLog(job.logFile, `\n[${nowIso()}] Running quality gate checks...\n`);

  const gateChecks = productChecks || qg.checks;
  const results = [];
  let allPassed = true;
  let failedCheck = null;

  // Detect Turborepo monorepo once for all checks
  const isTurboRepo = (() => {
    try { return fs.existsSync(path.join(job.workingDir, "turbo.json")); } catch { return false; }
  })();

  // Auto-detect package manager (pnpm > yarn > npm)
  const detectedPkgMgr = (() => {
    try {
      if (fs.existsSync(path.join(job.workingDir, "pnpm-lock.yaml"))) return "pnpm";
      if (fs.existsSync(path.join(job.workingDir, "yarn.lock"))) return "yarn";
      // Also check packageManager field in package.json
      const pkgPath = path.join(job.workingDir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.packageManager) {
          if (pkg.packageManager.startsWith("pnpm")) return "pnpm";
          if (pkg.packageManager.startsWith("yarn")) return "yarn";
        }
      }
    } catch {}
    return "npm";
  })();

  for (const check of gateChecks) {
    // For Turborepo monorepos, replace the typecheck command with `npx turbo type-check`
    // to avoid phantom errors from the root tsconfig (which has no jsx setting)
    let resolvedCheck = (check.name === "typecheck" && isTurboRepo)
      ? { ...check, cmd: "npx turbo type-check" }
      : check;

    // Replace npm with detected package manager (pnpm/yarn) in check commands
    if (detectedPkgMgr !== "npm" && resolvedCheck.cmd.startsWith("npm ")) {
      resolvedCheck = { ...resolvedCheck, cmd: resolvedCheck.cmd.replace(/^npm /, `${detectedPkgMgr} `) };
    }

    const pkgNote = detectedPkgMgr !== "npm" ? ` [${detectedPkgMgr} detected]` : "";
    appendLog(job.logFile, `[${nowIso()}] Running check: ${resolvedCheck.name} (${resolvedCheck.cmd}${isTurboRepo && check.name === "typecheck" ? " [turbo detected]" : ""}${pkgNote})\n`);

    const result = await runQualityCheck(resolvedCheck, job.workingDir);
    results.push(result);

    appendLog(job.logFile, `[${nowIso()}] Check ${check.name}: ${result.passed ? "PASSED" : "FAILED"} (${result.durationMs}ms)\n`);

    if (!result.passed) {
      allPassed = false;
      if (resolvedCheck.required) {
        failedCheck = { ...resolvedCheck, result };
        // Log failure output for context
        appendLog(job.logFile, `[${nowIso()}] Failure output:\n${result.output.slice(0, 5000)}\n`);
        break; // Stop on first required failure
      }
    }
  }

  const gateResult = {
    passed: allPassed,
    results,
    failedCheck,
    retryContext: null
  };

  // Build retry context if failed and retryWithContext is enabled
  if (!allPassed && failedCheck && qg.retryWithContext) {
    gateResult.retryContext = buildQualityGateRetryContext(job, failedCheck);
  }

  appendLog(job.logFile, `[${nowIso()}] Quality gate ${allPassed ? "PASSED" : "FAILED"}\n`);

  return gateResult;
}

/**
 * Build context for retry attempt after quality gate failure
 */
function buildQualityGateRetryContext(job, failedCheck) {
  const output = failedCheck.result?.output || "";
  // Truncate output to avoid overwhelming the prompt
  const truncatedOutput = output.length > 4000 ? output.slice(0, 4000) + "\n...[truncated]" : output;

  return {
    failedCheck: failedCheck.name,
    failedCommand: failedCheck.cmd,
    failureOutput: truncatedOutput,
    retryPrompt: `Previous implementation attempt failed quality gate check "${failedCheck.name}" (${failedCheck.cmd}).\n\nFailure output:\n${truncatedOutput}\n\nPlease fix the issues and complete the implementation.`
  };
}

/**
 * Targeted quality gate repair: spawn a lightweight Claude session to fix errors
 * instead of re-running the entire agent from scratch.
 *
 * Returns { repaired: boolean, checkResult: object }
 */
async function repairQualityGateFailure(job, failedCheck, attempt) {
  const output = failedCheck.result?.output || "";
  const truncatedOutput = output.length > 6000 ? output.slice(0, 6000) + "\n...[truncated]" : output;

  appendLog(job.logFile, `\n[${nowIso()}] Quality gate repair attempt ${attempt}: fixing "${failedCheck.name}" errors\n`);

  const prompt = [
    `You are a code repair agent. A quality gate check failed and you must fix the errors.`,
    ``,
    `Working directory: ${job.workingDir}`,
    job.issueKey ? `Jira issue: ${job.issueKey}` : "",
    ``,
    `The following quality gate check failed:`,
    `  Check: ${failedCheck.name}`,
    `  Command: ${failedCheck.cmd}`,
    ``,
    `Error output:`,
    "```",
    truncatedOutput,
    "```",
    ``,
    `Instructions:`,
    `- Read the error output carefully and identify every file and line with errors.`,
    `- Open each affected file, understand the surrounding code, and fix the errors.`,
    `- For type-check errors: fix type mismatches, missing imports, incorrect generics, missing properties.`,
    `- For lint errors: fix the specific lint violations shown.`,
    `- For test failures: fix the failing test or the code it tests.`,
    `- Make minimal, targeted fixes. Do NOT refactor or restructure unrelated code.`,
    `- After fixing, run \`${failedCheck.cmd}\` to verify your fixes resolved the errors.`,
    `- If new errors appear from your fixes, fix those too until the check passes.`,
  ].filter(Boolean).join("\n");

  const repairModel = config.claude.models.sonnet || "claude-sonnet-4-6";
  const args = [...(config.claude.baseArgs || ["--dangerously-skip-permissions"])];
  args.push("--model", repairModel);
  args.push("-p");
  args.push("--output-format", "json");
  args.push("--no-session-persistence");

  // Apply product plugin directory
  const product = resolveProduct(job.workingDir);
  applyProductPluginDir(args, product);

  const cliCmd = config.claude?.command || "claude";

  // Run repair session
  const repairResult = await new Promise((resolve) => {
    const proc = spawn(cliCmd, args, {
      cwd: job.workingDir,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.stdin.write(prompt);
    proc.stdin.end();

    const timeout = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      resolve({ success: false, output: "Repair timed out after 5 minutes" });
    }, 5 * 60 * 1000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      let content = "";
      try {
        const parsed = JSON.parse(stdout);
        content = parsed.result || parsed.output || stdout;
      } catch {
        content = stdout.trim() || stderr.trim() || "(no output)";
      }
      appendLog(job.logFile, `[${nowIso()}] Repair session finished (exit ${code})\n`);
      resolve({ success: code === 0, output: content });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ success: false, output: `Repair spawn error: ${err.message}` });
    });
  });

  appendLog(job.logFile, `[${nowIso()}] Repair session ${repairResult.success ? "completed" : "failed"}, re-running check "${failedCheck.name}"...\n`);

  // Re-run only the failed check to see if repair worked
  const recheckResult = await runQualityCheck(failedCheck, job.workingDir);

  appendLog(job.logFile, `[${nowIso()}] Re-check "${failedCheck.name}": ${recheckResult.passed ? "PASSED" : "FAILED"} (${recheckResult.durationMs}ms)\n`);

  if (!recheckResult.passed) {
    appendLog(job.logFile, `[${nowIso()}] Repair attempt ${attempt} did not resolve errors:\n${(recheckResult.output || "").slice(0, 2000)}\n`);
  }

  return { repaired: recheckResult.passed, checkResult: recheckResult };
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
        db.jobs.set(job).then(() => {
          jobs.delete(job.jobId);
        }).catch(e => console.error(`[db] Failed to persist terminal job ${job.jobId}: ${e.message}`));

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
    db.jobs.set(job).then(() => {
      jobs.delete(job.jobId);
    }).catch(e => console.error(`[db] Failed to persist terminal job ${job.jobId}: ${e.message}`));
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

/**
 * AUTH middleware
 * Accepts either:
 *   - X-Runner-Secret: <token>
 *   - Authorization: Bearer <token>
 */
function requireSecret(req, res, next) {
  const headerSecret = req.header("x-runner-secret");
  const authHeader = req.header("authorization");

  // Check X-Runner-Secret header
  if (headerSecret === SECRET) {
    return next();
  }

  // Check Authorization: Bearer <token>
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const bearerToken = authHeader.slice(7); // Remove "Bearer " prefix
    if (bearerToken === SECRET) {
      return next();
    }
  }

  // Check query param (for EventSource which can't set headers)
  if (req.query.secret === SECRET) {
    return next();
  }

  return res.status(401).json({ ok: false, error: "unauthorized" });
}

/**
 * N8N HEALTH CHECK
 * Periodically checks if N8N is reachable. Tries internal Docker URL first, then external.
 */
const n8nHealth = { reachable: false, lastCheck: null, latencyMs: 0, url: null, internalReachable: false, externalReachable: false };
const N8N_INTERNAL_URL = config.internalCallbackUrl ? new URL(config.internalCallbackUrl).origin : "http://n8n:5678";
const N8N_EXTERNAL_URL = N8N_CALLBACK_URL ? (() => { try { return new URL(N8N_CALLBACK_URL).origin; } catch { return null; } })() : null;

async function checkN8NHealth() {
  const tryUrl = async (url) => {
    const start = Date.now();
    return new Promise((resolve) => {
      const mod = url.startsWith("https") ? https : http;
      const req = mod.get(url, { timeout: 5000 }, (resp) => {
        resp.resume();
        resolve({ ok: resp.statusCode < 500, latencyMs: Date.now() - start, url });
      });
      req.on("error", () => resolve({ ok: false, latencyMs: Date.now() - start, url }));
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, latencyMs: Date.now() - start, url }); });
    });
  };

  const internalResult = await tryUrl(N8N_INTERNAL_URL);
  n8nHealth.internalReachable = internalResult.ok;

  if (N8N_EXTERNAL_URL && N8N_EXTERNAL_URL !== N8N_INTERNAL_URL) {
    const externalResult = await tryUrl(N8N_EXTERNAL_URL);
    n8nHealth.externalReachable = externalResult.ok;
  }

  // Use internal if reachable, otherwise external
  const best = internalResult.ok ? internalResult : (n8nHealth.externalReachable ? { ok: true, latencyMs: 0, url: N8N_EXTERNAL_URL } : internalResult);
  n8nHealth.reachable = best.ok;
  n8nHealth.latencyMs = best.latencyMs;
  n8nHealth.url = best.url;
  n8nHealth.lastCheck = nowIso();
}

// Check N8N health on startup and every 60 seconds
checkN8NHealth();
setInterval(checkN8NHealth, 60000);

/**
 * ROUTES
 */
app.get("/health", async (req, res) => {
  // If protection is enabled, require secret for detailed info
  if (config.protectHealthEndpoint) {
    if (req.header("x-runner-secret") !== SECRET) {
      // Return minimal info without auth
      return res.json({ ok: true, time: nowIso() });
    }
  }

  const uptimeSeconds = process.uptime();
  const totalJobCount = await db.jobs.count().catch(() => jobs.size);

  res.json({
    ok: true,
    time: nowIso(),
    running: getTotalRunningCount(),
    runningByProduct: Object.fromEntries(runningByProduct),
    queued: queue.length,
    jobs: totalJobCount,
    maxConcurrencyPerProduct: MAX_CONCURRENCY_PER_PRODUCT,
    uptime: Math.floor(uptimeSeconds),
    n8n: n8nHealth,
  });
});

/**
 * DELIVERY ENTRYPOINT: POST /run (requires issueKey + workingDir)
 */
app.post("/run", requireSecret, (req, res) => {
  if (shuttingDown) return res.status(503).json({ ok: false, error: "Server shutting down" });

  // Budget check
  const budgetCheck = checkBudget();
  if (!budgetCheck.ok) return res.status(429).json({ ok: false, error: budgetCheck.reason, status: "budget-exceeded" });

  const body = req.body || {};
  const jobIn = body.job || body;

  const issueKey = jobIn.issueKey || jobIn.key || jobIn?.issue?.key;
  if (!issueKey) return res.status(400).json({ ok: false, error: "issueKey is required" });

  let workingDir = jobIn.workingDir;
  // Resolve workingDir from Jira project key if not provided
  if (!workingDir && jobIn.projectKey) {
    for (const [, product] of products) {
      if (product.jira?.projectKey === jobIn.projectKey) {
        workingDir = product.workingDir;
        break;
      }
    }
  }
  const wd = validateWorkingDir(workingDir);
  if (!wd.ok) return res.status(400).json({ ok: false, error: wd.error });

  const summary = jobIn.summary || jobIn?.issue?.fields?.summary || "";
  const description = jobIn.description || jobIn?.issue?.fields?.description || "";
  const agent = jobIn.agent || "";
  const model = jobIn.model || null; // Optional model override (opus/sonnet/haiku)
  const requestedProvider = jobIn.provider || null; // Optional provider override (claude/zai)
  const idempotencyKey = req.header("x-idempotency-key") || jobIn.idempotencyKey || null;

  const callbackUrl = jobIn.callbackUrl || N8N_CALLBACK_URL || null;
  const slack = jobIn.slack || null;
  const telegram = jobIn.telegram || null;
  const batchId = jobIn.batchId || null;
  const source = jobIn.source || null; // { workflow, triggeredBy }

  // Subtask-related fields
  const parentKey = jobIn.parentKey || null;
  const subtaskFiles = jobIn.subtaskFiles || [];
  const subtaskDepth = jobIn.subtaskDepth || 0;

  // Track subtask if this job is for a subtask (parentKey is set)
  if (parentKey && issueKey) {
    trackSubtask(parentKey, issueKey, {
      agent: agent,
      files: subtaskFiles,
    });
    // Inherit sprint from parent — fire-and-forget (don't block job enqueue)
    moveSubtaskToParentSprint(issueKey, parentKey).catch(() => {});
  }

  // Check subtask concurrency limits
  if (parentKey) {
    const stConfig = getSubtaskConfig();
    if (!canRunSubtaskParallel(parentKey, issueKey, subtaskFiles)) {
      // Queue but don't start immediately - wait for slot
      console.log(`[${nowIso()}] Subtask ${issueKey} queued (maxPerParent=${stConfig.maxPerParent} reached or file conflict)`);
    }
  }

  if (idempotencyKey) {
    pruneIdempotency(idempotencyStore);
    db.idempotency.prune(IDEMPOTENCY_TTL_HOURS).catch(e => console.error('[db] idempotency prune failed: ' + e.message));
    const existing = idempotencyStore[idempotencyKey];
    if (existing?.jobId) {
      return res.status(200).json({
        ok: true,
        deduped: true,
        jobId: existing.jobId,
        statusUrl: `/jobs/${existing.jobId}`,
      });
    }
  }

  const jobId = makeJobId();
  const logFile = path.join(LOG_DIR, `${jobId}.log`);
  const metaFile = path.join(LOG_DIR, `${jobId}.json`);

  const job = {
    jobId,
    mode: "delivery",
    issueKey: String(issueKey),
    summary: summary ? String(summary) : "",
    description: description ? String(description) : "",
    workingDir: wd.resolved,
    agent: agent ? String(agent) : "",

    // Model routing (Phase: Multi-Model)
    model: model || null, // Optional override (opus/sonnet/haiku)
    requestedProvider: requestedProvider, // Optional provider override (claude/zai)
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
    slack,
    telegram,
    batchId,

    // Subtask-related fields
    parentKey,
    subtaskFiles,
    subtaskDepth,
    isSubtask: !!parentKey,

    // Source tracking
    source,

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

  if (idempotencyKey) {
    idempotencyStore[idempotencyKey] = { jobId, createdAt: Date.now() };
    db.idempotency.set(idempotencyKey, jobId).catch(e => console.error('[db] idempotency persist failed: ' + e.message));
    saveIdempotency(idempotencyStore);
  }

  enqueue(jobId);

  return res.status(202).json({
    ok: true,
    jobId,
    statusUrl: `/jobs/${jobId}`,
    logUrl: `/jobs/${jobId}/log`,
    outputUrl: `/jobs/${jobId}/output`,
  });
});

/**
 * CHAT ENTRYPOINT: POST /chat (NO issueKey required)
 * Body:
 *  { agent, message, conversationId, workingDir(optional), slack(optional), callbackUrl(required for replies) }
 */
app.post("/chat", requireSecret, async (req, res) => {
  if (shuttingDown) return res.status(503).json({ ok: false, error: "Server shutting down" });
  const budgetCheck = checkBudget();
  if (!budgetCheck.ok) return res.status(429).json({ ok: false, error: budgetCheck.reason, status: "budget-exceeded" });

  const body = req.body || {};
  const jobIn = body.job || body;

  const agent = jobIn.agent || "product-manager";
  const message = jobIn.message || jobIn.text || "";
  const model = jobIn.model || null; // Optional model override (opus/sonnet/haiku)
  const requestedProvider = jobIn.provider || null; // Optional provider override (claude/zai)
  if (!String(message).trim()) return res.status(400).json({ ok: false, error: "message is required" });

  const callbackUrl = jobIn.callbackUrl || null;
  const slack = jobIn.slack || null;
  const telegram = jobIn.telegram || null;
  const batchId = jobIn.batchId || null;
  const source = jobIn.source || null;
  const conversationId = jobIn.conversationId || (telegram?.chatId ? `telegram:${telegram.chatId}` : slack?.channel ? `slack:${slack.channel}` : "default");

  // workingDir optional in chat; default to process cwd
  let resolvedWorkingDir = null;
  if (jobIn.workingDir) {
    const wd = validateWorkingDir(jobIn.workingDir);
    if (!wd.ok) return res.status(400).json({ ok: false, error: wd.error });
    resolvedWorkingDir = wd.resolved;
  }

  // Load and prepare history text
  const conv = await loadConversation(conversationId);
  const trimmed = trimConversationMessages(conv.messages || []);
  const historyText = formatConversationForPrompt(trimmed);

  const jobId = makeJobId();
  const logFile = path.join(LOG_DIR, `${jobId}.log`);
  const metaFile = path.join(LOG_DIR, `${jobId}.json`);

  const job = {
    jobId,
    mode: "chat",
    agent: String(agent),
    message: String(message),
    conversationId: String(conversationId),
    historyText,
    workingDir: resolvedWorkingDir || DEFAULT_WORKING_DIR, // Use default if not specified
    issueKey: null,

    // Model routing (Phase: Multi-Model)
    model: model || null, // Optional override (opus/sonnet/haiku)
    requestedProvider: requestedProvider, // Optional provider override (claude/zai)
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
    slack,
    telegram,
    batchId,
    source,

    // Agent Teams metadata (Phase: Agent Teams Visibility)
    teamSessionId: null,
    teamRole: null,
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

  enqueue(jobId);

  return res.status(202).json({
    ok: true,
    jobId,
    statusUrl: `/jobs/${jobId}`,
    logUrl: `/jobs/${jobId}/log`,
    outputUrl: `/jobs/${jobId}/output`,
  });
});

/**
 * AGENT ENTRYPOINT: POST /agent (direct agent interaction, no Jira required)
 * Body:
 *  { agent (required), prompt (required), workingDir (optional), context (optional), model (optional) }
 */
app.post("/agent", requireSecret, (req, res) => {
  if (shuttingDown) return res.status(503).json({ ok: false, error: "Server shutting down" });
  const budgetCheck = checkBudget();
  if (!budgetCheck.ok) return res.status(429).json({ ok: false, error: budgetCheck.reason, status: "budget-exceeded" });

  const body = req.body || {};
  const jobIn = body.job || body;

  const agent = jobIn.agent;
  if (!agent) return res.status(400).json({ ok: false, error: "agent is required" });

  const prompt = jobIn.prompt || jobIn.message || jobIn.task || "";
  if (!String(prompt).trim()) return res.status(400).json({ ok: false, error: "prompt is required" });

  const context = jobIn.context || "";
  const model = jobIn.model || null; // Optional model override (opus/sonnet/haiku)
  const requestedProvider = jobIn.provider || null; // Optional provider override (claude/zai)
  const callbackUrl = jobIn.callbackUrl || N8N_CALLBACK_URL || null;
  const batchId = jobIn.batchId || null;
  const source = jobIn.source || null;
  const telegram = jobIn.telegram || null;

  // workingDir optional; resolve from product/productId if provided, else default
  let resolvedWorkingDir = null;
  const productKey = jobIn.product || jobIn.productId;
  if (jobIn.workingDir) {
    const wd = validateWorkingDir(jobIn.workingDir);
    if (!wd.ok) return res.status(400).json({ ok: false, error: wd.error });
    resolvedWorkingDir = wd.resolved;
  } else if (productKey && findProduct(productKey)) {
    const prod = findProduct(productKey);
    if (prod.workingDir) {
      const wd = validateWorkingDir(prod.workingDir);
      if (wd.ok) resolvedWorkingDir = wd.resolved;
    }
  }

  const jobId = makeJobId();
  const logFile = path.join(LOG_DIR, `${jobId}.log`);
  const metaFile = path.join(LOG_DIR, `${jobId}.json`);

  const job = {
    jobId,
    mode: "agent",
    agent: String(agent),
    prompt: String(prompt),
    context: context ? String(context) : "",
    workingDir: resolvedWorkingDir || DEFAULT_WORKING_DIR,
    issueKey: null,

    // Model routing
    model: model || null,
    selectedModel: null,
    requestedProvider: requestedProvider, // Optional provider override (claude/zai)

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

    // Retry fields
    retryCount: 0,
    maxRetries: jobIn.maxRetries ?? MAX_RETRIES,
    retryAt: null,

    // Quality gate retry tracking
    qualityGateRetryCount: 0,
    qualityGateFailure: null,
    qualityGate: null,

    // Usage tracking
    usage: null,

    callbackUrl,
    batchId,
    source,
    telegram,

    // Agent Teams metadata (Phase: Agent Teams Visibility)
    teamSessionId: null,
    teamRole: null,
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

  enqueue(jobId);

  return res.status(202).json({
    ok: true,
    jobId,
    agent: job.agent,
    statusUrl: `/jobs/${jobId}`,
    logUrl: `/jobs/${jobId}/log`,
    outputUrl: `/jobs/${jobId}/output`,
  });
});

/**
 * INTER-AGENT CONSULTATION: POST /internal/consult
 * Allows any agent to ask another agent for input during a job.
 * Runs inline (outside the job queue) with a 2-minute timeout.
 * Body: { agent (required), question (required), context?, requestingAgent?, jobId? }
 */
app.post("/internal/consult", requireSecret, async (req, res) => {
  const { agent, question, context, requestingAgent, jobId } = req.body || {};

  if (!agent || !String(agent).trim()) {
    return res.status(400).json({ error: "agent is required" });
  }
  if (!question || !String(question).trim()) {
    return res.status(400).json({ error: "question is required" });
  }

  // Validate target agent exists in routing config
  const agentToModel = config.routing?.agentToModel || {};
  if (!agentToModel[agent]) {
    return res.status(400).json({ error: `Unknown agent: ${agent}` });
  }

  const consultPrompt = [
    `You are being consulted by the ${requestingAgent || "unknown"} agent who needs your expertise.`,
    "",
    `Their question: ${question}`,
    context ? `\nContext: ${context}` : "",
    "",
    "Provide a focused, expert answer from your domain perspective. Keep it concise and actionable.",
  ]
    .filter((l) => l !== undefined)
    .join("\n")
    .trim();

  try {
    const result = await runConsultation({
      agent: String(agent),
      prompt: consultPrompt,
      timeout: 120000,
      parentJobId: jobId || null,
    });

    return res.json({
      agent,
      response: result.output,
      model: result.model,
    });
  } catch (err) {
    console.error(`[${nowIso()}] Consultation failed: agent=${agent} error=${err.message}`);
    return res.status(500).json({ error: `Consultation failed: ${err.message}` });
  }
});

/**
 * ============================================================
 * MEETING ENDPOINTS
 * ============================================================
 */

/**
 * POST /meeting - Create a new team meeting
 * Body: {
 *   topic, agents[],
 *   mode?       — "directed" (default, chair-based) | "serial" (round-robin) | legacy aliases "chair"/"roundRobin"
 *   chair?      — explicit chair agent name (defaults to product-manager if in agents list, else first agent)
 *   facilitator?, roundRobin?, maxRounds?, maxTurns?,
 *   workingDir?, telegram?, callbackUrl?, autoDiscuss?
 * }
 */
app.post("/meeting", requireSecret, (req, res) => {
  if (shuttingDown) return res.status(503).json({ ok: false, error: "Server shutting down" });

  const body = req.body || {};
  const agents = body.agents || ["product-manager", "engineer-planner"];

  // Validate agents exist
  const availableAgents = Object.values(config.agentLabels || {});
  const agentModelMap = config.routing?.agentToModel || {};
  const allKnown = [...new Set([...availableAgents, ...Object.keys(agentModelMap)])];
  const invalid = agents.filter(a => !allKnown.includes(a));
  if (invalid.length > 0) {
    return res.status(400).json({ ok: false, error: `Unknown agents: ${invalid.join(", ")}`, available: allKnown });
  }

  // Dedup: reject if a meeting with the same topic is already active or scheduled
  if (!body.allowDuplicate) {
    const dup = checkMeetingDuplicate(body.topic || "Team Meeting");
    if (dup.duplicate) {
      const msg = dup.reason === "active"
        ? `Meeting "${dup.existingTopic}" is already active (${dup.existingId})`
        : `Meeting "${dup.existingTopic}" is already scheduled for ${dup.scheduledAt} (${dup.existingId})`;
      console.log(`[${nowIso()}] Meeting dedup: rejected "${body.topic}" — ${msg}`);
      return res.status(409).json({ ok: false, error: msg, existingId: dup.existingId, reason: dup.reason });
    }
  }

  let resolvedWorkingDir = DEFAULT_WORKING_DIR;
  if (body.workingDir) {
    const wd = validateWorkingDir(body.workingDir);
    if (!wd.ok) return res.status(400).json({ ok: false, error: wd.error });
    resolvedWorkingDir = wd.resolved;
  } else {
    const pid = body.product || body.productId;
    const prod = pid ? findProduct(pid) : null;
    if (prod) {
      if (prod.workingDir) {
        const wd = validateWorkingDir(prod.workingDir);
        if (wd.ok) resolvedWorkingDir = wd.resolved;
      }
    }
  }

  const autoDiscuss = body.autoDiscuss !== false; // default to auto-discuss
  // Accept "directed"/"serial" (new API) and "chair"/"roundRobin" (legacy). Default: "directed".
  const rawMode = body.mode || "directed";
  const mode = normalizeMode(rawMode);
  const maxRounds = body.maxRounds || (autoDiscuss ? 3 : 2);

  const meeting = createMeeting({
    topic: body.topic || "Team Meeting",
    agents,
    facilitator: body.facilitator || agents[0],
    // Explicit chair wins; otherwise selectChair() applies smart default inside createMeeting.
    chair: body.chair || null,
    mode,
    roundRobin: body.roundRobin !== false,
    autoDiscuss,
    maxRounds,
    maxTurns: body.maxTurns || (mode === "chair" ? 20 : 0),
    workingDir: resolvedWorkingDir,
    telegram: body.telegram || (config.meetings?.defaultTelegramChatId ? { chatId: config.meetings.defaultTelegramChatId } : null),
    callbackUrl: body.callbackUrl || N8N_CALLBACK_URL || null,
    gateBeforeDispatch: body.gateBeforeDispatch === true,
  });

  console.log(`[${nowIso()}] Meeting created: ${meeting.meetingId} topic="${meeting.topic}" mode=${meeting.mode} chair=${meeting.chair} agents=[${meeting.agents.join(",")}] autoDiscuss=${autoDiscuss} rounds=${maxRounds} maxTurns=${meeting.maxTurns} workingDir=${meeting.workingDir} productId=${meeting.productId || "NONE"} callbackUrl=${meeting.callbackUrl || "NONE"} telegram=${JSON.stringify(meeting.telegram)}`);

  // Respond immediately
  res.status(201).json({
    ok: true,
    meetingId: meeting.meetingId,
    topic: meeting.topic,
    agents: meeting.agents,
    status: meeting.status,
    mode: meeting.mode,
    chair: meeting.chair,
    autoDiscuss,
    maxRounds,
    maxTurns: meeting.maxTurns,
  });

  // If autoDiscuss, kick off the autonomous discussion in the background
  if (autoDiscuss) {
    const discussFn = meeting.mode === "chair" ? runChairDiscussion : runAutoDiscussion;
    discussFn(meeting).catch(err => {
      console.error(`[${nowIso()}] ${meeting.mode}-discussion error for ${meeting.meetingId}: ${err.message}`);
      meeting.status = "ended";
      meeting.endedAt = nowIso();
      meeting.summary = `Meeting ended due to error: ${err.message}`;
      db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));
    
    });
  }

  return;
});

/**
 * POST /meeting/:id/message - Send a message to the meeting (from user or trigger agent response)
 * Body: { message, from?, triggerAgents? (array of agents to respond), agent? (single agent to respond) }
 */
app.post("/meeting/:id/message", requireSecret, async (req, res) => {
  const meeting = await getMeeting(req.params.id);
  if (!meeting) return res.status(404).json({ ok: false, error: "Meeting not found" });
  if (meeting.status !== "active") return res.status(400).json({ ok: false, error: `Meeting is ${meeting.status}` });

  const body = req.body || {};
  const message = body.message || "";
  const fromName = body.from || "Facilitator";

  // Add user message to transcript
  if (message.trim()) {
    meeting.transcript.push({
      role: "user",
      agent: null,
      name: fromName,
      content: message.trim(),
      timestamp: nowIso(),
    });
  
  }

  // Determine which agents should respond
  let respondingAgents = [];
  if (body.agent) {
    // Single agent requested
    respondingAgents = [body.agent];
  } else if (body.triggerAgents && Array.isArray(body.triggerAgents)) {
    respondingAgents = body.triggerAgents;
  } else if (meeting.roundRobin) {
    // All agents respond in order
    respondingAgents = meeting.agents;
  } else {
    // Default: facilitator agent responds
    respondingAgents = [meeting.facilitator];
  }

  // Filter to valid meeting agents
  respondingAgents = respondingAgents.filter(a => meeting.agents.includes(a));

  if (respondingAgents.length === 0) {
    return res.json({ ok: true, meetingId: meeting.meetingId, responses: [], message: "No agents to respond" });
  }

  // Respond immediately with 202, then process agent turns
  res.status(202).json({
    ok: true,
    meetingId: meeting.meetingId,
    responding: respondingAgents,
    message: `${respondingAgents.length} agent(s) will respond`,
  });

  // Run agent turns sequentially (they build on each other)
  const responses = [];
  for (const agent of respondingAgents) {
    const budgetCheck = checkBudget();
    if (!budgetCheck.ok) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Budget exceeded, stopping agent turns`);
      break;
    }

    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: ${agent} speaking...`);
    const result = await runMeetingAgentTurn(meeting, agent, message);
    if (result) {
      responses.push(result);

      // Send to Telegram callback if configured
      if (meeting.callbackUrl || meeting.telegram) {
        const callbackPayload = {
          event: "meeting:agent-response",
          meetingId: meeting.meetingId,
          agent: result.agent,
          content: result.content,
          telegram: meeting.telegram,
          topic: meeting.topic,
          transcriptLength: meeting.transcript.length,
        };
        if (meeting.callbackUrl) {
          sendMeetingCallback(meeting.callbackUrl, callbackPayload);
        }
      }
    }
  }

  // Emit SSE
  if (config.sseEnabled) {
    jobEmitter.emit("meeting:responses", {
      meetingId: meeting.meetingId,
      responses: responses.map(r => ({ agent: r.agent, contentLength: r.content.length })),
    });
  }
});

/**
 * POST /meeting/:id/end - End a meeting and generate summary
 */
app.post("/meeting/:id/end", requireSecret, async (req, res) => {
  const meeting = await getMeeting(req.params.id);
  if (!meeting) return res.status(404).json({ ok: false, error: "Meeting not found" });
  if (meeting.status === "ended") return res.status(400).json({ ok: false, error: "Meeting already ended" });

  meeting.status = "ended";
  meeting.endedAt = nowIso();

  // Generate summary using facilitator agent
  const summaryTrigger = "The meeting has ended. Generate a concise summary with: 1) Key decisions made, 2) Action items (who does what), 3) Open questions, 4) Next steps. Format as Markdown.";

  // Temporarily set status back to active for the summary turn
  meeting.status = "active";
  const summaryResult = await runMeetingAgentTurn(meeting, meeting.facilitator, summaryTrigger);
  meeting.summary = summaryResult?.content || "No summary generated";
  meeting.status = "ended"; // Ensure still ended after agent turn
  db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));


  // Send summary callback
  if (meeting.callbackUrl && meeting.telegram) {
    const callbackPayload = {
      event: "meeting:ended",
      meetingId: meeting.meetingId,
      topic: meeting.topic,
      summary: meeting.summary,
      telegram: meeting.telegram,
      messageCount: meeting.transcript.length,
      agents: meeting.agents,
      duration: meeting.endedAt && meeting.createdAt
        ? Math.round((new Date(meeting.endedAt) - new Date(meeting.createdAt)) / 1000)
        : null,
    };
    sendMeetingCallback(meeting.callbackUrl, callbackPayload);
  }

  console.log(`[${nowIso()}] Meeting ended: ${meeting.meetingId} (${meeting.transcript.length} messages)`);

  return res.json({
    ok: true,
    meetingId: meeting.meetingId,
    status: meeting.status,
    summary: meeting.summary,
  });
});

/**
 * POST /meeting/:id/decision — resolve a gated meeting that's awaiting human approval.
 * Body: { decision: "approve" | "reject" | "refine", refinement?: string, decidedBy?: string }
 * approve → run dispatchMeetingActions + postMeetingOutcomes (Confluence + Jira), mark ended
 * reject  → mark ended without dispatch, no Confluence/Jira side-effects
 * refine  → append guidance to transcript, restart chair discussion (cap = 3 cycles)
 */
app.post("/meeting/:id/decision", requireSecret, async (req, res) => {
  const meeting = await getMeeting(req.params.id);
  if (!meeting) return res.status(404).json({ ok: false, error: "Meeting not found" });
  if (meeting.status !== "awaiting-approval" || !meeting.awaitingApproval) {
    return res.status(400).json({ ok: false, error: `Meeting is ${meeting.status}, not awaiting-approval` });
  }

  const body = req.body || {};
  const decision = String(body.decision || "").toLowerCase();
  const decidedBy = body.decidedBy || "Mark";
  if (!["approve", "reject", "refine"].includes(decision)) {
    return res.status(400).json({ ok: false, error: "decision must be approve|reject|refine" });
  }

  meeting.decision = { decision, refinement: body.refinement || null, decidedBy, decidedAt: nowIso() };

  if (decision === "approve") {
    meeting.awaitingApproval = false;
    meeting.status = "ended";
    meeting.endedAt = nowIso();
    db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));

    // Notify Telegram that dispatch is starting.
    if (meeting.callbackUrl && meeting.telegram) {
      sendMeetingCallback(meeting.callbackUrl, {
        event: "meeting:agent-response",
        meetingId: meeting.meetingId,
        agent: "Meeting — Approved",
        content: `_Approved by ${decidedBy}. Dispatching action items + writing minutes…_`,
        telegram: meeting.telegram,
        topic: meeting.topic,
      });
    }

    // Restore the agent:* labels we stripped at gate time so the reconciler (and
    // the dispatch path) can pick up any meeting-created issues. Awaited so the
    // labels are back in place before dispatchMeetingActions fires.
    await unquarantineMeetingCreatedIssues(meeting).catch(e =>
      console.error(`[meeting-unquarantine] ${meeting.meetingId}: ${e.message}`)
    );

    // Fire dispatch + outcomes (these are async, fire-and-forget — same as the ungated path).
    postMeetingOutcomes(meeting).catch(e => {
      console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: postMeetingOutcomes error: ${e.message}`);
    });
    dispatchMeetingActions(meeting).catch(e => {
      console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: dispatchMeetingActions error: ${e.message}`);
    });

    if (config.sseEnabled) {
      jobEmitter.emit("meeting:approved", { meetingId: meeting.meetingId });
    }
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: APPROVED by ${decidedBy} — dispatching`);
    return res.json({ ok: true, meetingId: meeting.meetingId, status: meeting.status, action: "dispatched" });
  }

  if (decision === "reject") {
    meeting.awaitingApproval = false;
    meeting.status = "rejected";
    meeting.endedAt = nowIso();
    db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));

    // Remove meeting-pending-approval label; agent:* labels stay off so the
    // rejected work doesn't get picked up by the reconciler.
    await clearMeetingQuarantineOnly(meeting).catch(e =>
      console.error(`[meeting-quarantine-clear] ${meeting.meetingId}: ${e.message}`)
    );

    if (meeting.callbackUrl && meeting.telegram) {
      sendMeetingCallback(meeting.callbackUrl, {
        event: "meeting:agent-response",
        meetingId: meeting.meetingId,
        agent: "Meeting — Rejected",
        content: `_Rejected by ${decidedBy}. Nothing dispatched. Transcript retained in runner._`,
        telegram: meeting.telegram,
        topic: meeting.topic,
      });
    }

    if (config.sseEnabled) {
      jobEmitter.emit("meeting:rejected", { meetingId: meeting.meetingId });
    }
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: REJECTED by ${decidedBy}`);
    return res.json({ ok: true, meetingId: meeting.meetingId, status: meeting.status, action: "rejected" });
  }

  // refine
  if ((meeting.refinementsUsed || 0) >= 3) {
    return res.status(400).json({
      ok: false,
      error: "Refinement cap reached (3). Approve, reject, or end the meeting via the dashboard.",
    });
  }
  const refinement = String(body.refinement || "").trim();
  if (!refinement) {
    return res.status(400).json({ ok: false, error: "refinement text required for decision=refine" });
  }
  meeting.refinementsUsed = (meeting.refinementsUsed || 0) + 1;
  meeting.awaitingApproval = false;
  meeting.status = "active";
  meeting.summary = null; // re-generated after refined discussion
  meeting.transcript.push({
    role: "user",
    agent: null,
    name: decidedBy,
    content: `[Refinement #${meeting.refinementsUsed}] ${refinement}`,
    timestamp: nowIso(),
  });
  // Top up turn budget so the chair can actually resume.
  meeting.maxTurns = (meeting.maxTurns || 0) + 6;
  db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));

  // Respond immediately, then resume discussion in the background.
  res.json({
    ok: true,
    meetingId: meeting.meetingId,
    status: meeting.status,
    action: "refining",
    refinementsUsed: meeting.refinementsUsed,
  });

  if (meeting.callbackUrl && meeting.telegram) {
    sendMeetingCallback(meeting.callbackUrl, {
      event: "meeting:agent-response",
      meetingId: meeting.meetingId,
      agent: "Meeting — Refining",
      content: `_${decidedBy} added guidance (refinement ${meeting.refinementsUsed}/3). Resuming discussion…_\n\n> ${refinement.substring(0, 800)}`,
      telegram: meeting.telegram,
      topic: meeting.topic,
    });
  }

  const discussFn = meeting.mode === "chair" ? runChairDiscussion : runAutoDiscussion;
  discussFn(meeting).catch(err => {
    console.error(`[${nowIso()}] refine-discussion error for ${meeting.meetingId}: ${err.message}`);
    meeting.status = "ended";
    meeting.endedAt = nowIso();
    meeting.summary = (meeting.summary || "") + `\n\n_Refinement failed: ${err.message}_`;
    db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));
  });
  console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: REFINING (#${meeting.refinementsUsed}) by ${decidedBy}`);
});

/**
 * GET /meeting/:id - Get meeting status and transcript
 */
app.get("/meeting/:id", requireSecret, async (req, res) => {
  const meeting = await getMeeting(req.params.id);
  if (!meeting) return res.status(404).json({ ok: false, error: "Meeting not found" });

  return res.json({
    ok: true,
    meetingId: meeting.meetingId,
    topic: meeting.topic,
    agents: meeting.agents,
    facilitator: meeting.facilitator,
    chair: meeting.chair,
    mode: meeting.mode,
    status: meeting.status,
    currentSpeaker: meeting.currentSpeaker,
    turnCount: meeting.turnCount || 0,
    maxTurns: meeting.maxTurns || 0,
    messageCount: (meeting.transcript || []).length,
    transcript: meeting.transcript,
    summary: meeting.summary,
    createdAt: meeting.createdAt,
    endedAt: meeting.endedAt,
  });
});

/**
 * GET /api/meetings - List all meetings
 */
app.get("/api/meetings", requireSecret, async (_req, res) => {
  let allMeetings;
  try {
    allMeetings = await db.meetings.listAll();
    // Merge with any in-memory active meetings not yet in DB
    for (const [id, m] of meetings) {
      if (!allMeetings.find(x => x.meetingId === id)) allMeetings.push(m);
    }
  } catch {
    allMeetings = Array.from(meetings.values());
  }
  const list = allMeetings.map(m => ({
    meetingId: m.meetingId,
    topic: m.topic,
    agents: m.agents,
    status: m.status,
    messageCount: (m.transcript || []).length,
    createdAt: m.createdAt,
    endedAt: m.endedAt,
  }));
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ ok: true, meetings: list });
});

/**
 * POST /schedule - Schedule a future job or meeting
 * Body: { type: "job"|"meeting", scheduledAt: "ISO date or relative time", data: { ... } }
 * For jobs: data = { agent, prompt, context?, workingDir? }
 * For meetings: data = { topic, agents[], facilitator?, maxRounds?, telegram? }
 */
app.post("/schedule", requireSecret, (req, res) => {
  const body = req.body || {};
  const type = body.type;
  if (!type || !["job", "meeting"].includes(type)) {
    return res.status(400).json({ ok: false, error: 'type must be "job" or "meeting"' });
  }

  const scheduledAt = parseScheduleTime(body.scheduledAt || body.schedule);
  if (!scheduledAt) {
    return res.status(400).json({ ok: false, error: "Could not parse scheduledAt. Use ISO datetime or relative time (e.g. 'tomorrow 09:00', 'in 2 hours', 'next Monday 10:00')" });
  }

  const data = body.data || {};

  if (type === "job") {
    if (!data.agent) return res.status(400).json({ ok: false, error: "data.agent is required for job scheduling" });
    if (!data.prompt) return res.status(400).json({ ok: false, error: "data.prompt is required for job scheduling" });
  } else if (type === "meeting") {
    if (!data.topic) return res.status(400).json({ ok: false, error: "data.topic is required for meeting scheduling" });
    if (!data.agents || !data.agents.length) return res.status(400).json({ ok: false, error: "data.agents is required for meeting scheduling" });
  }

  // Set defaults for meetings
  if (type === "meeting") {
    data.facilitator = data.facilitator || data.agents[0];
    data.maxRounds = data.maxRounds || 3;
    data.workingDir = data.workingDir || DEFAULT_WORKING_DIR;
    data.telegram = data.telegram || null;
    data.callbackUrl = data.callbackUrl || N8N_CALLBACK_URL || null;

    // Dedup: reject if same topic is active or already scheduled
    if (!body.allowDuplicate) {
      const dup = checkMeetingDuplicate(data.topic);
      if (dup.duplicate) {
        const msg = dup.reason === "active"
          ? `Meeting "${dup.existingTopic}" is already active (${dup.existingId})`
          : `Meeting "${dup.existingTopic}" is already scheduled for ${dup.scheduledAt} (${dup.existingId})`;
        console.log(`[${nowIso()}] Schedule dedup: rejected "${data.topic}" — ${msg}`);
        return res.status(409).json({ ok: false, error: msg, existingId: dup.existingId, reason: dup.reason });
      }
    }
  }

  const id = scheduleItem({
    type,
    scheduledAt: scheduledAt.toISOString(),
    status: "pending",
    source: body.source || "api",
    data,
  });

  return res.status(201).json({
    ok: true,
    scheduleId: id,
    type,
    scheduledAt: scheduledAt.toISOString(),
    scheduledAtHuman: scheduledAt.toLocaleString(),
    data: { topic: data.topic, agent: data.agent, agents: data.agents },
  });
});

/**
 * GET /api/scheduled - List scheduled items (pending and recent)
 */
app.get("/api/scheduled", requireSecret, async (_req, res) => {
  let allItems;
  try {
    allItems = await db.scheduled.listAll();
    // Merge with any in-memory scheduled items not yet in DB
    for (const [id, s] of scheduledItems) {
      if (!allItems.find(x => x.id === id)) allItems.push(s);
    }
  } catch {
    allItems = Array.from(scheduledItems.values());
  }
  const items = allItems.map(s => ({
    id: s.id,
    type: s.type,
    status: s.status || "pending",
    scheduledAt: s.scheduledAt,
    createdAt: s.createdAt,
    firedAt: s.firedAt,
    source: s.source,
    topic: s.data?.topic,
    agent: s.data?.agent,
    agents: s.data?.agents,
    task: s.data?.task?.substring(0, 120),
    jobId: s.jobId,
    meetingId: s.meetingId,
    acceleratedFrom: s.acceleratedFrom || null,
    acceleratedBy: s.acceleratedBy || null,
  }));
  items.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  const pending = items.filter(i => i.status === "pending");
  const done = items.filter(i => i.status !== "pending");
  return res.json({ ok: true, pending, done: done.slice(-20) });
});

/**
 * DELETE /api/scheduled/:id - Cancel a scheduled item
 */
app.delete("/api/scheduled/:id", requireSecret, async (req, res) => {
  let item = scheduledItems.get(req.params.id);
  if (!item) {
    try { item = await db.scheduled.get(req.params.id); } catch { item = null; }
  }
  if (!item) return res.status(404).json({ ok: false, error: "Scheduled item not found" });
  if (item.status === "done") return res.status(400).json({ ok: false, error: "Item already executed" });
  item.status = "cancelled";
  item.cancelledAt = nowIso();
  db.scheduled.set(item).catch(e => console.error('[db] scheduled update failed: ' + e.message));

  return res.json({ ok: true, id: item.id, status: "cancelled" });
});

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
 * Auth via query param for EventSource/fetch compatibility.
 */
app.get("/jobs/:jobId/log/stream", async (req, res) => {
  // Auth via query param or header
  const secret = req.query.secret || req.header("x-runner-secret");
  if (secret !== SECRET) return res.status(401).json({ ok: false, error: "unauthorized" });

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
      pluginDir: p.pluginDir || null
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

registerBigBrotherRoutes(app, { requireSecret, secret: SECRET });

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
 * BATCH ENDPOINTS
 */

// POST /batches - Create a new batch
app.post("/batches", requireSecret, (req, res) => {
  const { total, slack, telegram } = req.body || {};

  if (!total || typeof total !== "number" || total < 1) {
    return res.status(400).json({ ok: false, error: "total must be a positive number" });
  }

  const batchId = `batch_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const batchRecord = {
    batchId,
    total,
    completed: 0,
    failed: 0,
    results: [],
    slack: slack || null,
    telegram: telegram || null,
    createdAt: nowIso(),
  };
  batches.set(batchId, batchRecord);
  db.batches.set(batchRecord).catch(e => console.error('[db] batch persist failed: ' + e.message));

  console.log(`[${nowIso()}] Created batch ${batchId} with total=${total}`);

  return res.status(201).json({ ok: true, batchId });
});

// GET /batches/:batchId - Get batch status
app.get("/batches/:batchId", requireSecret, async (req, res) => {
  let batch = batches.get(req.params.batchId);
  if (!batch) {
    try { batch = await db.batches.get(req.params.batchId); } catch { batch = null; }
  }
  if (!batch) return res.status(404).json({ ok: false, error: "batch not found" });

  const isComplete = (batch.completed + batch.failed) >= batch.total;
  return res.json({ ok: true, batch, isComplete });
});

// POST /batches/:batchId/complete - Called by callback when a job finishes
app.post("/batches/:batchId/complete", requireSecret, async (req, res) => {
  const { jobId, status, result, issueKey, error } = req.body || {};
  let batch = batches.get(req.params.batchId);
  if (!batch) {
    try { batch = await db.batches.get(req.params.batchId); } catch { batch = null; }
  }

  if (!batch) return res.status(404).json({ ok: false, error: "batch not found" });

  batch.results.push({
    jobId: jobId || null,
    issueKey: issueKey || null,
    status: status || "unknown",
    result: result || null,
    error: error || null,
    completedAt: nowIso(),
  });

  if (status === "succeeded" || status === "completed") {
    batch.completed++;
  } else {
    batch.failed++;
  }

  const isComplete = (batch.completed + batch.failed) >= batch.total;
  db.batches.set(batch).catch(e => console.error('[db] batch update failed: ' + e.message));

  console.log(`[${nowIso()}] Batch ${req.params.batchId}: ${batch.completed + batch.failed}/${batch.total} (complete=${isComplete})`);

  return res.json({ ok: true, isComplete, batch });
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

// GET /api/batches - List all batches
app.get("/api/batches", requireSecret, async (req, res) => {
  let allBatches;
  try {
    allBatches = await db.batches.listAll();
    // Merge with any in-memory batches not yet in DB
    for (const [id, b] of batches) {
      if (!allBatches.find(x => x.batchId === id)) allBatches.push(b);
    }
  } catch {
    allBatches = Array.from(batches.values());
  }
  const batchList = allBatches.map(b => ({
    batchId: b.batchId,
    total: b.total,
    completed: b.completed,
    failed: b.failed,
    slack: b.slack,
    telegram: b.telegram,
    createdAt: b.createdAt,
    resultsCount: b.results?.length || 0,
  }));

  // Sort by createdAt descending
  batchList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return res.json({ ok: true, batches: batchList });
});

// GET /api/conversations - List all conversations
app.get("/api/conversations", requireSecret, async (req, res) => {
  try {
    const rows = await db.conversations.listAll();
    const conversations = rows.map(r => ({
      conversationId: r.channelId,
      updatedAt: r.lastActive,
      messageCount: r.messageCount,
      productId: r.productId,
    }));
    return res.json({ ok: true, conversations });
  } catch (e) {
    return res.json({ ok: true, conversations: [] });
  }
});

// GET /api/conversations/:id - Get conversation messages
app.get("/api/conversations/:id", requireSecret, async (req, res) => {
  const conv = await loadConversation(req.params.id);
  return res.json({ ok: true, conversation: conv });
});

// ============================================================
// ISSUE TRACKER API ROUTES
// ============================================================

// POST /api/issues - Create issue
app.post("/api/issues", requireSecret, async (req, res) => {
  try {
    const { project, type, summary, description, labels, priority, assignee, parentKey, storyPoints } = req.body || {};
    if (!project || !summary) return res.status(400).json({ ok: false, error: "project and summary are required" });
    const issue = await issueTracker.createIssue(project, { type, summary, description, labels, priority, assignee, parentKey, storyPoints });
    // Emit notification
    try {
      await db.notifications.create({ type: "issue_created", title: `Issue ${issue.key} created`, body: summary, severity: "info", link: `/issues?key=${issue.key}` });
      emitNotificationWebhook("issue.created", "info", `Issue ${issue.key} created`, summary, `/issues?key=${issue.key}`);
    } catch (_) { /* non-critical */ }
    return res.json({ ok: true, issue });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/issues - List/filter issues
app.get("/api/issues", requireSecret, async (req, res) => {
  try {
    const { status, type, project, label, assignee, search, parentKey, limit, offset } = req.query;
    const result = await issueTracker.searchIssues({ status, type, project, label, assignee, search, parentKey, limit: limit || 50, offset: offset || 0 });
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/issues/:key - Get issue with comments + links
app.get("/api/issues/:key", requireSecret, async (req, res) => {
  try {
    const issue = await issueTracker.getIssue(req.params.key);
    if (!issue) return res.status(404).json({ ok: false, error: "Issue not found" });
    const [comments, links, subtasks] = await Promise.all([
      issueTracker.getComments(req.params.key),
      issueTracker.getLinks(req.params.key),
      issueTracker.getSubtasks(req.params.key),
    ]);
    return res.json({ ok: true, issue, comments, links, subtasks });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// PUT /api/issues/:key - Update issue fields
app.put("/api/issues/:key", requireSecret, async (req, res) => {
  try {
    const issue = await issueTracker.updateIssue(req.params.key, req.body || {});
    if (!issue) return res.status(404).json({ ok: false, error: "Issue not found" });
    return res.json({ ok: true, issue });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/issues/:key - Delete issue
app.delete("/api/issues/:key", requireSecret, async (req, res) => {
  try {
    const deleted = await issueTracker.deleteIssue(req.params.key);
    return res.json({ ok: true, deleted });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/issues/:key/transition - Change issue status
app.post("/api/issues/:key/transition", requireSecret, async (req, res) => {
  try {
    const { status, actor } = req.body || {};
    if (!status) return res.status(400).json({ ok: false, error: "status is required" });
    const issue = await issueTracker.transitionIssue(req.params.key, status, actor);
    return res.json({ ok: true, issue });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

// GET /api/issues/:key/transitions - List available transitions
app.get("/api/issues/:key/transitions", requireSecret, async (req, res) => {
  try {
    const transitions = await issueTracker.getTransitions(req.params.key);
    return res.json({ ok: true, transitions });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/issues/:key/comments - Add comment
app.post("/api/issues/:key/comments", requireSecret, async (req, res) => {
  try {
    const { body, author } = req.body || {};
    if (!body) return res.status(400).json({ ok: false, error: "body is required" });
    const comment = await issueTracker.addComment(req.params.key, body, author || "user");
    return res.json({ ok: true, comment });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/issues/:key/link - Create dependency link
app.post("/api/issues/:key/link", requireSecret, async (req, res) => {
  try {
    const { targetKey, linkType } = req.body || {};
    if (!targetKey || !linkType) return res.status(400).json({ ok: false, error: "targetKey and linkType are required" });
    const link = await issueTracker.createLink(req.params.key, targetKey, linkType);
    return res.json({ ok: true, link });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// NOTIFICATION API ROUTES
// ============================================================

// GET /api/notifications - List notifications
app.get("/api/notifications", requireSecret, async (_req, res) => {
  try {
    const notifications = await db.notifications.list({ limit: 50 });
    return res.json({ ok: true, notifications });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/notifications/count - Unread count
app.get("/api/notifications/count", requireSecret, async (_req, res) => {
  try {
    const count = await db.notifications.unreadCount();
    return res.json({ ok: true, count });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/notifications/:id/read - Mark as read
app.post("/api/notifications/:id/read", requireSecret, async (req, res) => {
  try {
    await db.notifications.markRead(parseInt(req.params.id, 10));
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/notifications/read-all - Mark all as read
app.post("/api/notifications/read-all", requireSecret, async (_req, res) => {
  try {
    await db.notifications.markAllRead();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Emit notification to outgoing webhook (Slack/Discord/Teams/custom)
 */
function emitNotificationWebhook(event, severity, title, body, link) {
  const webhookUrl = config.notifications?.webhookUrl;
  if (!webhookUrl) return;
  const payload = JSON.stringify({
    event, severity, title, body, link,
    timestamp: new Date().toISOString(),
  });
  try {
    const u = new URL(webhookUrl);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({
      method: "POST",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    });
    req.on("error", (e) => console.error(`[notifications] Webhook error: ${e.message}`));
    req.write(payload);
    req.end();
  } catch (e) {
    console.error(`[notifications] Webhook send failed: ${e.message}`);
  }
}

// ============================================================
// CHAT API ENHANCEMENTS
// ============================================================

// POST /api/chat/send - Send chat message, returns job ID for streaming
app.post("/api/chat/send", requireSecret, async (req, res) => {
  try {
    const { message, agent, channelId, workingDir } = req.body || {};
    if (!message) return res.status(400).json({ ok: false, error: "message is required" });

    // Reuse existing /chat logic by constructing a chat request
    const chatBody = {
      channelId: channelId || "dashboard-general",
      message,
      workingDir: workingDir || config.workingDir,
    };
    if (agent) chatBody.agent = agent;

    // Forward to the existing chat handler internally
    const chatReq = { body: chatBody, headers: req.headers };
    const jobId = crypto.randomUUID();

    // We enqueue this the same way /chat does but return the jobId immediately
    // The caller can then subscribe to /jobs/:id/stream-events for real-time output
    chatBody._dashboardJobId = jobId;

    // Use a lightweight redirect: POST to /chat internally
    const fakeRes = {
      statusCode: 200,
      json(data) { fakeRes._data = data; fakeRes.statusCode = 200; },
      status(code) { fakeRes.statusCode = code; return fakeRes; },
      _data: null,
    };

    // Trigger the existing chat handler
    try {
      const chatHandler = app._router.stack.find(
        (layer) => layer.route?.path === "/chat" && layer.route?.methods?.post
      );
      if (chatHandler) {
        await new Promise((resolve) => {
          chatHandler.route.stack[chatHandler.route.stack.length - 1].handle(
            { ...chatReq, body: chatBody },
            fakeRes,
            resolve
          );
        });
        if (fakeRes._data) return res.json({ ok: true, ...fakeRes._data });
      }
    } catch (_) { /* fallback below */ }

    return res.json({ ok: true, message: "Chat message queued", channelId: chatBody.channelId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/chat/conversations - List all conversations (alias for existing endpoint)
app.get("/api/chat/conversations", requireSecret, async (_req, res) => {
  try {
    const rows = await db.conversations.listAll();
    const conversations = rows.map(r => ({
      id: r.channelId,
      channelId: r.channelId,
      messageCount: r.messageCount,
      lastUpdated: r.lastActive,
    }));
    return res.json({ ok: true, conversations });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/chat/conversations/:id - Get conversation history
app.get("/api/chat/conversations/:id", requireSecret, async (req, res) => {
  const conv = await loadConversation(req.params.id);
  return res.json({ ok: true, conversation: conv });
});

// DELETE /api/chat/conversations/:id - Delete conversation
app.delete("/api/chat/conversations/:id", requireSecret, async (req, res) => {
  try {
    // Delete from DB
    await db.conversations.delete(req.params.id);
    // Also remove any residual legacy file
    const filePath = convPath(req.params.id);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) { /* best-effort */ }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
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

/**
 * ============================================================
 * PIPELINE API ROUTES
 * ============================================================
 */

// POST /pipeline - Create and start a pipeline
app.post("/pipeline", requireSecret, async (req, res) => {
  if (shuttingDown) return res.status(503).json({ ok: false, error: "Server shutting down" });

  const budgetCheck = checkBudget();
  if (!budgetCheck.ok) return res.status(429).json({ ok: false, error: budgetCheck.reason, status: "budget-exceeded" });

  const body = req.body || {};
  const issueKey = body.issueKey;
  if (!issueKey) return res.status(400).json({ ok: false, error: "issueKey is required" });

  const pipelineType = body.pipelineType || body.pipeline;
  if (!pipelineType) return res.status(400).json({ ok: false, error: "pipelineType is required" });

  // Validate pipeline type exists
  const definitions = loadPipelineDefinitions();
  if (!definitions[pipelineType]) {
    return res.status(400).json({
      ok: false,
      error: `Unknown pipeline type: ${pipelineType}`,
      available: Object.keys(definitions),
    });
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
    provider: body.provider || null, // Optional provider override (claude/zai)
  };

  try {
    const pipeline = await createPipeline(issueKey, pipelineType, options);
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
  if (shuttingDown) return res.status(503).json({ ok: false, error: "Server shutting down" });

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


// ============================================================
// WORKTREE API ENDPOINTS
// ============================================================

// GET /api/worktrees - List all tracked worktrees with git stats
app.get("/api/worktrees", requireSecret, (req, res) => {
  const results = listWorktreesWithStats();
  res.json({ ok: true, worktrees: results, total: results.length });
});

// POST /api/worktrees/:id/merge - Merge worktree branch into the integration branch (dev)
app.post("/api/worktrees/:id/merge", requireSecret, async (req, res) => {
  const wt = await getWorktree(req.params.id);
  if (!wt) return res.status(404).json({ ok: false, error: "worktree not found" });
  try {
    const result = mergeWorktree(wt.issueKey);
    res.json({ ok: true, merged: true, ...result });
  } catch (e) {
    res.status(409).json({ ok: false, error: e.message });
  }
});

// DELETE /api/worktrees/:id - Delete worktree (optionally delete branch)
app.delete("/api/worktrees/:id", requireSecret, async (req, res) => {
  const wt = await getWorktree(req.params.id);
  if (!wt) return res.status(404).json({ ok: false, error: "worktree not found" });
  try {
    removeWorktree(wt.issueKey);
    res.json({ ok: true, deleted: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/worktrees/:id/pr - Legacy alias for /merge (kept for dashboard back-compat).
// The runner no longer opens GitHub PRs; it merges the branch into the integration
// branch (dev) directly. Humans open PRs from dev -> main manually for deployment.
app.post("/api/worktrees/:id/pr", requireSecret, async (req, res) => {
  const wt = await getWorktree(req.params.id);
  if (!wt) return res.status(404).json({ ok: false, error: "worktree not found" });
  try {
    const result = mergeWorktree(wt.issueKey);
    res.json({ ok: true, merged: true, ...result, note: "PR endpoint is deprecated; merged into integration branch instead" });
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