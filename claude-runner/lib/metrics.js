// metrics.js — job metrics, skill-usage tracking, budget circuit breaker
// Extracted from runner.js.

const fs = require("fs");
const path = require("path");
const db = require("../db");
const { LOG_DIR, config } = require("./config");
const { resolveProduct } = require("./products");
const { jobs } = require("./state");
const { nowIso } = require("./util");


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

module.exports = {
  metrics,
  METRICS_FILE,
  skillUsage,
  detectSkillEvent,
  trackSkillUsage,
  loadMetrics,
  saveMetrics,
  updateMetrics,
  checkBudget,
};
