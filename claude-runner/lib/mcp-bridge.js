// mcp-bridge.js — MCP client bridge for direct-API providers
// Connects to MCP servers defined in .mcp.json and exposes their tools to the
// agentic loop in llm-direct.js. Supports both stdio and HTTP server types.
//
// Tool names are namespaced as `${serverName}__${toolName}` to avoid collisions.

const fs = require("fs");

// Lazy-require the MCP SDK so the runner doesn't crash on startup if the
// package isn't installed yet.
function getMcpSdk() {
  try {
    return require("@modelcontextprotocol/sdk/client/index.js");
  } catch {
    try {
      return require("@modelcontextprotocol/sdk");
    } catch {
      return null;
    }
  }
}

/**
 * Substitute ${VAR_NAME} placeholders in a string using process.env.
 */
function interpolateEnv(str) {
  if (typeof str !== "string") return str;
  return str.replace(/\$\{([^}]+)\}/g, (_, varName) => process.env[varName] || "");
}

function interpolateHeaders(headers) {
  if (!headers || typeof headers !== "object") return headers;
  const result = {};
  for (const [k, v] of Object.entries(headers)) {
    result[k] = interpolateEnv(v);
  }
  return result;
}

/**
 * Load and connect to MCP servers defined in a .mcp.json file.
 * Returns a Map<serverName, { client, tools }>.
 */
async function loadMcpServers(mcpJsonPath) {
  const sdk = getMcpSdk();
  if (!sdk) {
    console.warn("[mcp-bridge] @modelcontextprotocol/sdk not installed — MCP tools unavailable");
    return new Map();
  }

  let mcpConfig;
  try {
    mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8"));
  } catch (e) {
    console.warn(`[mcp-bridge] Cannot read ${mcpJsonPath}: ${e.message}`);
    return new Map();
  }

  const servers = new Map();
  const mcpServers = mcpConfig.mcpServers || {};

  await Promise.all(
    Object.entries(mcpServers).map(async ([serverName, serverDef]) => {
      try {
        const client = new sdk.Client({ name: "meshwork-runner", version: "1.0.0" });
        let transport;

        if (serverDef.type === "http" && serverDef.url) {
          // HTTP MCP server (StreamableHTTP transport)
          const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
          transport = new StreamableHTTPClientTransport(new URL(interpolateEnv(serverDef.url)), {
            requestInit: { headers: interpolateHeaders(serverDef.headers || {}) },
          });
        } else if (serverDef.command) {
          // Stdio MCP server
          const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
          const env = { ...process.env };
          for (const [k, v] of Object.entries(serverDef.env || {})) {
            env[k] = interpolateEnv(v);
          }
          transport = new StdioClientTransport({
            command: serverDef.command,
            args: serverDef.args || [],
            env,
          });
        } else {
          console.warn(`[mcp-bridge] Unknown server type for ${serverName} — skipping`);
          return;
        }

        await client.connect(transport);
        const { tools } = await client.listTools();
        servers.set(serverName, { client, tools: tools || [] });
        console.log(`[mcp-bridge] Connected to ${serverName} (${(tools || []).length} tools)`);
      } catch (e) {
        console.warn(`[mcp-bridge] Failed to connect to MCP server ${serverName}: ${e.message}`);
      }
    })
  );

  return servers;
}

/**
 * Enumerate all tools from connected MCP servers.
 * Returns an array of tool descriptors in OpenAI function-calling format.
 * Tool names are prefixed with the server name: serverName__toolName
 */
function enumerateMcpTools(servers) {
  const tools = [];
  for (const [serverName, { tools: serverTools }] of servers) {
    for (const tool of serverTools) {
      tools.push({
        name: `${serverName}__${tool.name}`,
        description: tool.description || `${tool.name} (from ${serverName})`,
        inputSchema: tool.inputSchema || { type: "object", properties: {} },
        _serverName: serverName,
        _originalName: tool.name,
      });
    }
  }
  return tools;
}

/**
 * Execute a named MCP tool call (serverName__toolName format).
 * Returns the tool result as a string.
 */
async function callMcpTool(servers, qualifiedName, inputArgs) {
  const sep = qualifiedName.indexOf("__");
  if (sep === -1) throw new Error(`Invalid MCP tool name: ${qualifiedName} (expected serverName__toolName)`);
  const serverName = qualifiedName.slice(0, sep);
  const toolName = qualifiedName.slice(sep + 2);

  const serverEntry = servers.get(serverName);
  if (!serverEntry) throw new Error(`MCP server '${serverName}' not connected`);

  const result = await serverEntry.client.callTool({ name: toolName, arguments: inputArgs || {} });
  // MCP tool results come back as content blocks; join text parts
  if (Array.isArray(result.content)) {
    return result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n") || JSON.stringify(result.content);
  }
  return String(result.content || "");
}

/**
 * Disconnect all connected MCP servers.
 */
async function closeMcpServers(servers) {
  await Promise.all(
    [...servers.values()].map(async ({ client }) => {
      try {
        await client.close();
      } catch { /* ignore close errors */ }
    })
  );
  servers.clear();
}

module.exports = {
  loadMcpServers,
  enumerateMcpTools,
  callMcpTool,
  closeMcpServers,
};
