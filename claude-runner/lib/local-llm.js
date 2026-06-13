// local-llm.js — local model execution (LM Studio / Qwen-Code) and hybrid Claude+local teams
// Extracted from runner.js.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { config } = require("./config");
const { metrics, saveMetrics } = require("./metrics");
const { pushFallbackModel, resolveLocalModel } = require("./models");
const { applyProductPluginDir, resolvePluginDir, resolveProduct } = require("./products");
const { jobEmitter } = require("./state");
const { appendLog, nowIso, postJson } = require("./util");

// Function declarations are hoisted: exporting before requiring sibling
// modules keeps require cycles safe (each module's exports are complete
// before any sibling starts loading).
module.exports = {
  detectHybridTeam,
  parseFileBlocks,
  runLocalTeamMember,
  runLocalTeamMemberQwen,
  runLocalTeamMemberRaw,
  runLocalDirect,
  runLocalDirectRaw,
  runClaudeForTeammate,
  runHybridTeam,
};

const { extractResultText, runClaude } = require("./claude-exec");
const { buildAgentPrompt, buildChatPrompt, buildDeliveryPrompt } = require("./prompts");


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
  pushFallbackModel(args, modelTier);
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
