// models.js — model selection and routing (Claude tiers, chrome enablement, local-model routing)
// Extracted from runner.js.

const { config } = require("./config");


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

/** Config-driven fallback tier: opus→sonnet→haiku per config.claude.fallbacks. */
function fallbackModelFor(model) {
  if (!model) return null;
  const m = String(model);
  let tier = null;
  if (m === "opus" || m.startsWith("claude-opus")) tier = "opus";
  else if (m === "sonnet" || m.startsWith("claude-sonnet")) tier = "sonnet";
  else if (m === "haiku" || m.startsWith("claude-haiku")) tier = "haiku";
  if (!tier) return null;
  const fallbacks = config.claude.fallbacks || { opus: "sonnet", sonnet: "haiku" };
  const fbTier = fallbacks[tier];
  if (!fbTier || fbTier === tier) return null;
  return config.claude.models[fbTier] || fbTier;
}

/** Push --fallback-model onto CLI args when a fallback exists (print-mode spawns only). */
function pushFallbackModel(args, model) {
  const fb = fallbackModelFor(model);
  if (fb) args.push("--fallback-model", fb);
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

module.exports = {
  selectModel,
  resolveModelForAgent,
  shouldEnableChrome,
  fallbackModelFor,
  pushFallbackModel,
  detectChromeUsage,
  resolveLocalModel,
  shouldRunLocal,
};
