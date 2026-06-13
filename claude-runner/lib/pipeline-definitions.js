// pipeline-definitions.js — atomic read/write helpers for pipeline templates and routing rules in config.json

const fs = require("fs");
const path = require("path");
const { RUNNER_ROOT } = require("./config");

const BUILTIN_NAMES = new Set(["new-feature", "bug-fix", "security-fix", "new-feature-enterprise", "design-bootstrap", "subtask"]);

function configPath() {
  return path.join(RUNNER_ROOT, "config.json");
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch (e) {
    throw new Error(`Failed to read config.json: ${e.message}`);
  }
}

function writeConfig(cfg) {
  const p = configPath();
  const tmp = p + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, p);
  } catch (e) {
    // Clean up temp file if rename failed
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`Failed to write config.json: ${e.message}`);
  }
}

/**
 * Returns all pipeline definitions (built-ins from config.pipelines + any saved user definitions).
 * @returns {Object} map of name -> definition
 */
function listPipelineDefinitions() {
  const cfg = readConfig();
  return cfg.pipelines || {};
}

/**
 * Save (create or update) a user-defined pipeline definition.
 * Throws if name is a built-in. Validates name format.
 * @param {string} name
 * @param {{ description?: string, phases: Array }} def
 */
function savePipelineDefinition(name, def) {
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`Invalid pipeline name '${name}': must match /^[a-z0-9-]+$/`);
  }
  if (BUILTIN_NAMES.has(name)) {
    throw new Error(`Cannot overwrite built-in pipeline '${name}'`);
  }
  const cfg = readConfig();
  if (!cfg.pipelines) cfg.pipelines = {};
  cfg.pipelines[name] = def;
  writeConfig(cfg);
}

/**
 * Delete a user-defined pipeline definition.
 * Throws if name is a built-in.
 * @param {string} name
 */
function deletePipelineDefinition(name) {
  if (BUILTIN_NAMES.has(name)) {
    throw new Error(`Cannot delete built-in pipeline '${name}'`);
  }
  const cfg = readConfig();
  if (!cfg.pipelines || !cfg.pipelines[name]) {
    throw new Error(`Pipeline definition '${name}' not found`);
  }
  delete cfg.pipelines[name];
  writeConfig(cfg);
}

/**
 * Returns the current pipeline routing rules.
 * @returns {Array}
 */
function listPipelineRoutingRules() {
  const cfg = readConfig();
  return cfg.pipelineRouting || [];
}

/**
 * Replace the pipeline routing rules entirely.
 * @param {Array} rules
 */
function savePipelineRoutingRules(rules) {
  const cfg = readConfig();
  cfg.pipelineRouting = rules;
  writeConfig(cfg);
}

module.exports = {
  listPipelineDefinitions,
  savePipelineDefinition,
  deletePipelineDefinition,
  listPipelineRoutingRules,
  savePipelineRoutingRules,
  BUILTIN_NAMES,
};
