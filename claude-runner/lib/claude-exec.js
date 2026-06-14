// claude-exec.js — Claude CLI subprocess execution, output parsing, consultations
// Extracted from runner.js.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  DEFAULT_WORKING_DIR,
  JOB_TIMEOUT_MINUTES,
  TOKEN_PRICE_INPUT,
  TOKEN_PRICE_OUTPUT,
  config,
} = require("./config");
const { detectSkillEvent, trackSkillUsage } = require("./metrics");
const { pushFallbackModel, resolveModelForAgent, shouldEnableChrome } = require("./models");
const { ensureOAuthValid, getOAuthEnvVars, getSpawnEnv } = require("./oauth");
const {
  applyProductPluginDir,
  buildFilteredMcpConfig,
  buildOptimizedPluginDir,
  resolvePluginDir,
  resolveProduct,
} = require("./products");
const { jobEmitter, jobs } = require("./state");
const { appendLog, nowIso } = require("./util");

// Resolve model ID for a non-CLI provider: prefer exact named match, then
// "default", then the first value in the mapping, then fall back to the tier name.
function resolveProviderModel(providerConfig, tier) {
  const m = providerConfig?.modelMapping;
  if (!m) return tier || "default";
  return m[tier] || m.default || Object.values(m).find(Boolean) || tier || "default";
}

// Function declarations are hoisted: exporting before requiring sibling
// modules keeps require cycles safe (each module's exports are complete
// before any sibling starts loading).
module.exports = {
  tryParseClaudeJson,
  extractAssistantText,
  extractResultText,
  runConsultation,
  runClaude,
  extractUsageFromOutput,
  resolveProviderModel,
};

const { buildAgentPrompt, buildChatPrompt, buildDeliveryPrompt } = require("./prompts");


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
 * Run a short, stateless Claude subprocess for inter-agent consultation.
 * Runs outside the job queue (no MAX_CONCURRENCY slot consumed).
 * Returns { output: string, model: string }.
 */
async function runConsultation({ agent, prompt, timeout = 120000, parentJobId }) {
  const modelId = resolveModelForAgent(agent);

  const args = [...(config.claude.baseArgs || ["--dangerously-skip-permissions"])];
  args.push("--model", modelId);
  pushFallbackModel(args, modelId);
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
  const providerType = providerConfig?.type || "claude-cli";

  // Route non-CLI providers to the direct API executor
  // (openai, gemini, anthropic-direct, etc.)
  if (providerType !== "claude-cli") {
    const modelId = resolveProviderModel(providerConfig, job.selectedModel);
    const { runDirectApi } = require("./llm-direct");
    return runDirectApi(job, provider, providerConfig, modelId);
  }

  // Pre-flight: ensure OAuth token is valid (skip for non-claude-cli providers)
  if (provider === "claude") {
    await ensureOAuthValid(job).catch(() => {}); // Best-effort — don't block if check fails
  }

  // Get selected model and resolve to full model ID
  const model = job.selectedModel || "sonnet";
  let modelId;
  if (providerConfig?.modelMapping) {
    modelId = resolveProviderModel(providerConfig, model);
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

    // Config-driven fallback chain (opus→sonnet→haiku). Non-Claude models (e.g. GLM) get no flag.
    if (provider === "claude") pushFallbackModel(args, model);

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
    if (job.agent) spawnEnv.MESHWORK_AGENT = job.agent;
    if (job.issueKey) spawnEnv.MESHWORK_ISSUE = job.issueKey;
    const _jobProductId = resolveProduct(job.workingDir);
    if (_jobProductId) spawnEnv.MESHWORK_PRODUCT = _jobProductId;
    if (Array.isArray(job.labels) && job.labels.length) spawnEnv.MESHWORK_LABELS = job.labels.join(",");
    spawnEnv.MESHWORK_RUNNER_URL = process.env.RUNNER_INTERNAL_URL || `http://runner:${config.port || 3210}`;
    if (process.env.RUNNER_SECRET) spawnEnv.MESHWORK_RUNNER_SECRET = process.env.RUNNER_SECRET;
    // Job-scoped credentials for the structured observations channel
    // (POST /jobs/:id/observations). Scoped to this job only — unlike the
    // global secret, a leaked token can't touch any other job.
    job.jobToken = job.jobToken || crypto.randomBytes(16).toString("hex");
    spawnEnv.MESHWORK_JOB_ID = job.jobId;
    spawnEnv.MESHWORK_JOB_TOKEN = job.jobToken;

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
