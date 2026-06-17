// llm-direct.js — direct API executor for non-CLI LLM providers
// Handles OpenAI, Gemini, and direct Anthropic API calls.
// Implements an agentic tool-calling loop: built-in tools (bash, file I/O) +
// MCP tools loaded from the product's .mcp.json.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { config } = require("./config");
const { resolveApiKey } = require("./provider-store");
const { loadMcpServers, enumerateMcpTools, callMcpTool, closeMcpServers } = require("./mcp-bridge");
const { resolveProduct, resolvePluginDir } = require("./products");
const { appendLog, nowIso } = require("./util");
const { buildDeliveryPrompt, buildChatPrompt, buildAgentPrompt } = require("./prompts");

const MAX_ITERATIONS = 50;
const TOOL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Built-in tool definitions (OpenAI function schema format)
// ---------------------------------------------------------------------------

const BUILTIN_TOOL_DEFS = [
  {
    name: "execute_bash",
    description: "Execute a shell command in the job working directory. Returns stdout+stderr.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        workingDir: { type: "string", description: "Optional override for working directory" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute or relative file path" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file, creating it or overwriting it",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories at a path",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path to list" } },
      required: ["path"],
    },
  },
  {
    name: "glob_files",
    description: "Find files matching a glob pattern",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. src/**/*.ts" },
        baseDir: { type: "string", description: "Base directory for the glob" },
      },
      required: ["pattern"],
    },
  },
];

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function resolveSafePath(filePath, workingDir) {
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.normalize(path.join(workingDir || process.cwd(), filePath));

  const allowedRoots = config.allowedRoots || [];
  if (allowedRoots.length > 0) {
    const allowed = allowedRoots.some((root) => resolved.startsWith(path.normalize(root)));
    if (!allowed) throw new Error(`Path ${resolved} is outside allowed roots`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Built-in tool executor
// ---------------------------------------------------------------------------

function executeBuiltinTool(name, args, job) {
  const workingDir = job.workingDir || process.cwd();

  if (name === "execute_bash") {
    const cwd = args.workingDir ? resolveSafePath(args.workingDir, workingDir) : workingDir;
    try {
      const output = execSync(args.command, {
        cwd,
        shell: true,
        timeout: TOOL_TIMEOUT_MS,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return output || "(no output)";
    } catch (e) {
      return `Exit ${e.status || 1}: ${e.stdout || ""}${e.stderr || ""}`.trim() || e.message;
    }
  }

  if (name === "read_file") {
    const resolved = resolveSafePath(args.path, workingDir);
    return fs.readFileSync(resolved, "utf8");
  }

  if (name === "write_file") {
    const resolved = resolveSafePath(args.path, workingDir);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, args.content, "utf8");
    return `Written ${args.content.length} chars to ${resolved}`;
  }

  if (name === "list_directory") {
    const resolved = resolveSafePath(args.path, workingDir);
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    return entries.map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`).join("\n") || "(empty)";
  }

  if (name === "glob_files") {
    const base = args.baseDir ? resolveSafePath(args.baseDir, workingDir) : workingDir;
    // Simple recursive glob using find (avoids extra dependencies)
    try {
      const pattern = args.pattern.replace(/\*\*/g, "___DSTAR___").replace(/\*/g, "[^/]*").replace(/___DSTAR___/g, ".*");
      const output = execSync(`find "${base}" -type f`, {
        timeout: TOOL_TIMEOUT_MS,
        encoding: "utf8",
        shell: true,
      });
      const re = new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, (c) => (c === "*" ? c : `\\${c}`)));
      const matches = output.split("\n").filter((f) => f && re.test(path.relative(base, f)));
      return matches.join("\n") || "(no matches)";
    } catch (e) {
      return `Error: ${e.message}`;
    }
  }

  throw new Error(`Unknown built-in tool: ${name}`);
}

// ---------------------------------------------------------------------------
// Tool schema translation helpers
// ---------------------------------------------------------------------------

function toOpenAiToolSchema(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.inputSchema || { type: "object", properties: {} },
    },
  };
}

function toGeminiToolSchema(tools) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description || "",
        parameters: t.inputSchema || { type: "object", properties: {} },
      })),
    },
  ];
}

function toAnthropicToolSchema(tool) {
  return {
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.inputSchema || { type: "object", properties: {} },
  };
}

// ---------------------------------------------------------------------------
// Provider-specific API callers
// ---------------------------------------------------------------------------

function buildOpenAIUrl(baseUrl) {
  const base = (baseUrl || "https://api.openai.com").replace(/\/$/, "");
  try {
    const { pathname } = new URL(base);
    if (pathname.endsWith("/chat/completions")) return base;
    if (pathname !== "/") return `${base}/chat/completions`;
  } catch (_) {}
  return `${base}/v1/chat/completions`;
}

async function callOpenAI(messages, tools, modelId, apiKey, baseUrl) {
  const url = buildOpenAIUrl(baseUrl);
  const body = {
    model: modelId,
    messages,
    stream: false,
  };
  if (tools && tools.length > 0) {
    body.tools = tools.map(toOpenAiToolSchema);
    body.tool_choice = "auto";
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${text.slice(0, 500)}`);
  }

  const data = await resp.json();
  const choice = data.choices?.[0];
  return {
    text: choice?.message?.content || "",
    finishReason: choice?.finish_reason,
    toolCalls: (choice?.message?.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function?.name,
      args: (() => { try { return JSON.parse(tc.function?.arguments || "{}"); } catch { return {}; } })(),
    })),
    usage: { inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0 },
    rawMessage: choice?.message,
  };
}

async function callGemini(messages, tools, modelId, apiKey) {
  // Convert OpenAI messages format to Gemini contents format
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool") {
        return {
          role: "user",
          parts: [{ functionResponse: { name: m.name, response: { content: m.content } } }],
        };
      }
      if (m.role === "assistant" && m.tool_calls) {
        return {
          role: "model",
          parts: m.tool_calls.map((tc) => ({
            functionCall: {
              name: tc.function?.name,
              args: (() => { try { return JSON.parse(tc.function?.arguments || "{}"); } catch { return {}; } })(),
            },
          })),
        };
      }
      return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content || "" }] };
    });

  const body = {
    contents,
    systemInstruction: systemParts ? { parts: [{ text: systemParts }] } : undefined,
  };

  if (tools && tools.length > 0) {
    body.tools = toGeminiToolSchema(tools);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${text.slice(0, 500)}`);
  }

  const data = await resp.json();
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  const textParts = parts.filter((p) => p.text).map((p) => p.text).join("");
  const funcCalls = parts.filter((p) => p.functionCall).map((p) => ({
    id: `gemini_${p.functionCall.name}_${Date.now()}`,
    name: p.functionCall.name,
    args: p.functionCall.args || {},
  }));

  return {
    text: textParts,
    finishReason: candidate?.finishReason,
    toolCalls: funcCalls,
    usage: {
      inputTokens: data.usageMetadata?.promptTokenCount || 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
    },
    rawMessage: candidate?.content,
  };
}

async function callAnthropicDirect(messages, tools, modelId, apiKey) {
  const systemMessages = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const conversationMessages = messages.filter((m) => m.role !== "system");

  const body = {
    model: modelId,
    max_tokens: 8192,
    messages: conversationMessages,
  };
  if (systemMessages) body.system = systemMessages;
  if (tools && tools.length > 0) body.tools = tools.map(toAnthropicToolSchema);

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${text.slice(0, 500)}`);
  }

  const data = await resp.json();
  const textBlocks = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const toolUseBlocks = (data.content || []).filter((c) => c.type === "tool_use");

  return {
    text: textBlocks,
    finishReason: data.stop_reason,
    toolCalls: toolUseBlocks.map((t) => ({ id: t.id, name: t.name, args: t.input || {} })),
    usage: { inputTokens: data.usage?.input_tokens || 0, outputTokens: data.usage?.output_tokens || 0 },
    rawMessage: data.content,
  };
}

// ---------------------------------------------------------------------------
// Main agentic loop
// ---------------------------------------------------------------------------

async function runDirectApi(job, provider, providerConfig, modelId) {
  const startMs = Date.now();
  appendLog(job.logFile, `[${nowIso()}] Direct API executor: provider=${provider} model=${modelId}\n`);

  // Resolve API key (DB first, then env var)
  const apiKey = await resolveApiKey({ ...providerConfig, id: provider });
  if (!apiKey) {
    const err = `No API key configured for provider '${provider}'. Set via dashboard or env var.`;
    appendLog(job.logFile, `[${nowIso()}] ERROR: ${err}\n`);
    return { success: false, output: err, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  // Build initial prompt
  let prompt;
  if (job.mode === "chat") {
    prompt = buildChatPrompt(job);
  } else if (job.mode === "agent") {
    prompt = buildAgentPrompt(job);
  } else {
    prompt = buildDeliveryPrompt(job);
  }

  // Inject CLAUDE.md project context
  if (job.workingDir) {
    const claudeMdPath = path.join(job.workingDir, "CLAUDE.md");
    try {
      if (fs.existsSync(claudeMdPath)) {
        const claudeMdContent = fs.readFileSync(claudeMdPath, "utf8");
        if (claudeMdContent.trim()) {
          prompt = `<project-instructions>\n${claudeMdContent}\n</project-instructions>\n\n${prompt}`;
          appendLog(job.logFile, `[${nowIso()}] Injected CLAUDE.md (${claudeMdContent.length} chars)\n`);
        }
      }
    } catch { /* ignore */ }
  }

  // Load MCP tools from product's .mcp.json
  let mcpServers = new Map();
  let mcpTools = [];
  try {
    const jobProduct = resolveProduct(job.workingDir);
    const pluginDir = jobProduct ? resolvePluginDir(jobProduct) : null;
    const mcpJsonPath = pluginDir ? path.join(pluginDir, ".mcp.json") : null;
    if (mcpJsonPath && fs.existsSync(mcpJsonPath)) {
      mcpServers = await loadMcpServers(mcpJsonPath);
      mcpTools = enumerateMcpTools(mcpServers);
      if (mcpTools.length > 0) {
        appendLog(job.logFile, `[${nowIso()}] Loaded ${mcpTools.length} MCP tools from ${mcpJsonPath}\n`);
      }
    }
  } catch (e) {
    appendLog(job.logFile, `[${nowIso()}] WARNING: Failed to load MCP tools: ${e.message}\n`);
  }

  const allTools = [...BUILTIN_TOOL_DEFS, ...mcpTools];
  const type = providerConfig?.type || "openai";

  // Build initial messages
  const messages = [
    { role: "system", content: "You are a helpful AI assistant. Use the available tools to complete tasks." },
    { role: "user", content: prompt },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let fullOutput = "";
  let iteration = 0;

  // Retry delays for rate-limit errors (keeps message history, no full restart)
  const RATE_LIMIT_DELAYS_MS = [10_000, 30_000, 60_000];

  async function callProviderWithBackoff() {
    let rateLimitAttempt = 0;
    while (true) {
      try {
        if (type === "openai") {
          return await callOpenAI(messages, allTools, modelId, apiKey, providerConfig?.baseUrl);
        } else if (type === "gemini") {
          return await callGemini(messages, allTools, modelId, apiKey);
        } else if (type === "anthropic-direct") {
          return await callAnthropicDirect(messages, allTools, modelId, apiKey);
        } else {
          throw new Error(`Unsupported direct-API provider type: ${type}`);
        }
      } catch (e) {
        const isRateLimit = /429|overloaded|rate.?limit/i.test(e.message);
        if (isRateLimit && rateLimitAttempt < RATE_LIMIT_DELAYS_MS.length) {
          const delayMs = RATE_LIMIT_DELAYS_MS[rateLimitAttempt++];
          appendLog(job.logFile, `[${nowIso()}] Rate limited — retrying in ${delayMs / 1000}s (attempt ${rateLimitAttempt}/${RATE_LIMIT_DELAYS_MS.length})\n`);
          await new Promise(r => setTimeout(r, delayMs));
        } else {
          throw e;
        }
      }
    }
  }

  try {
    while (iteration < MAX_ITERATIONS) {
      iteration++;
      appendLog(job.logFile, `[${nowIso()}] Iteration ${iteration}/${MAX_ITERATIONS}\n`);

      const result = await callProviderWithBackoff();

      totalInputTokens += result.usage.inputTokens;
      totalOutputTokens += result.usage.outputTokens;

      if (result.text) {
        fullOutput += result.text;
        appendLog(job.logFile, result.text);
      }

      // No tool calls — we're done
      if (!result.toolCalls || result.toolCalls.length === 0) {
        appendLog(job.logFile, `\n[${nowIso()}] No tool calls — finishing\n`);
        break;
      }

      // Execute tool calls and build tool result messages
      appendLog(job.logFile, `[${nowIso()}] Executing ${result.toolCalls.length} tool call(s)\n`);

      // Add assistant message with tool calls
      if (type === "openai") {
        messages.push({
          role: "assistant",
          content: result.text || null,
          tool_calls: result.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        });
      } else if (type === "anthropic-direct") {
        messages.push({ role: "assistant", content: result.rawMessage });
      } else {
        messages.push({ role: "model", parts: [{ text: result.text || "" }] });
      }

      for (const tc of result.toolCalls) {
        appendLog(job.logFile, `[${nowIso()}] Tool: ${tc.name}(${JSON.stringify(tc.args).slice(0, 200)})\n`);
        let toolResult;
        try {
          const isMcp = tc.name.includes("__");
          if (isMcp) {
            toolResult = await callMcpTool(mcpServers, tc.name, tc.args);
          } else {
            toolResult = executeBuiltinTool(tc.name, tc.args, job);
          }
        } catch (e) {
          toolResult = `Error: ${e.message}`;
        }
        appendLog(job.logFile, `[${nowIso()}] → ${String(toolResult).slice(0, 500)}\n`);

        // Append tool result in provider-specific format
        if (type === "openai") {
          messages.push({ role: "tool", tool_call_id: tc.id, content: String(toolResult) });
        } else if (type === "anthropic-direct") {
          messages.push({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: tc.id, content: String(toolResult) }],
          });
        } else {
          // Gemini: function response
          messages.push({
            role: "user",
            parts: [{ functionResponse: { name: tc.name, response: { content: String(toolResult) } } }],
          });
        }
      }
    }

    if (iteration >= MAX_ITERATIONS) {
      appendLog(job.logFile, `[${nowIso()}] WARNING: reached max iterations (${MAX_ITERATIONS})\n`);
    }

    const durationMs = Date.now() - startMs;
    appendLog(job.logFile, `[${nowIso()}] Direct API complete: ${iteration} iterations, ${totalInputTokens}in/${totalOutputTokens}out tokens, ${durationMs}ms\n`);

    return {
      stdout: fullOutput,
      stderr: "",
      lastStreamEvent: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: fullOutput,
        usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
      },
    };
  } catch (e) {
    appendLog(job.logFile, `[${nowIso()}] Direct API error: ${e.message}\n`);
    throw e;
  } finally {
    await closeMcpServers(mcpServers);
  }
}

module.exports = { runDirectApi, buildOpenAIUrl };
