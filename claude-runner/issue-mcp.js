"use strict";

/**
 * Lightweight MCP (Model Context Protocol) server for the built-in issue tracker.
 *
 * When Jira is disabled, agents need MCP tools to interact with issues. This server
 * maps standard issue tool names to the built-in tracker, keeping agent prompts identical
 * regardless of whether Jira or the built-in tracker is active.
 *
 * Runs as a stdio MCP server that Claude CLI connects to via .mcp.json config.
 *
 * Tools provided:
 *   mcp__issues__search_issues   - Search/filter issues
 *   mcp__issues__get_issue       - Get single issue by key
 *   mcp__issues__create_issue    - Create a new issue
 *   mcp__issues__add_comment     - Add a comment to an issue
 *   mcp__issues__get_transitions - List available status transitions
 *   mcp__issues__transition_issue - Change issue status
 */

const http = require("http");

const RUNNER_URL = process.env.RUNNER_URL || "http://localhost:3210";
const RUNNER_SECRET = process.env.RUNNER_SECRET || "";

// ---------------------------------------------------------------------------
// HTTP helper to call runner API
// ---------------------------------------------------------------------------

function runnerRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, RUNNER_URL);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + (url.search || ""),
        headers: {
          "x-runner-secret": RUNNER_SECRET,
          "content-type": "application/json",
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d.toString()));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (_) {
            resolve({ error: data });
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "search_issues",
    description: "Search and filter issues. Returns a list of issues matching the given criteria.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter by project key (e.g. 'EOS')" },
        status: { type: "string", description: "Filter by status: todo, in_progress, done, cancelled" },
        type: { type: "string", description: "Filter by type: epic, story, task, bug, subtask" },
        label: { type: "string", description: "Filter by label" },
        assignee: { type: "string", description: "Filter by assignee" },
        search: { type: "string", description: "Search text in key, summary, description" },
      },
    },
  },
  {
    name: "get_issue",
    description: "Get a single issue by its key, including comments, links, and subtasks.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Issue key (e.g. 'PROJ-42')" },
      },
      required: ["key"],
    },
  },
  {
    name: "create_issue",
    description: "Create a new issue in the tracker.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project key (e.g. 'EOS')" },
        type: { type: "string", description: "Issue type: epic, story, task, bug, subtask" },
        summary: { type: "string", description: "Issue summary/title" },
        description: { type: "string", description: "Detailed description" },
        priority: { type: "string", description: "Priority: highest, high, medium, low, lowest" },
        labels: { type: "array", items: { type: "string" }, description: "Labels to apply" },
        parentKey: { type: "string", description: "Parent issue key (for subtasks)" },
      },
      required: ["project", "summary"],
    },
  },
  {
    name: "add_comment",
    description: "Add a comment to an issue.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Issue key" },
        body: { type: "string", description: "Comment text" },
        author: { type: "string", description: "Comment author name" },
      },
      required: ["key", "body"],
    },
  },
  {
    name: "get_transitions",
    description: "List available status transitions for an issue.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Issue key" },
      },
      required: ["key"],
    },
  },
  {
    name: "transition_issue",
    description: "Change the status of an issue.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Issue key" },
        status: { type: "string", description: "Target status: todo, in_progress, done, cancelled" },
      },
      required: ["key", "status"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleTool(name, args) {
  switch (name) {
    case "search_issues": {
      const qs = new URLSearchParams();
      if (args.project) qs.set("project", args.project);
      if (args.status) qs.set("status", args.status);
      if (args.type) qs.set("type", args.type);
      if (args.label) qs.set("label", args.label);
      if (args.assignee) qs.set("assignee", args.assignee);
      if (args.search) qs.set("search", args.search);
      const query = qs.toString();
      return runnerRequest("GET", `/api/issues${query ? `?${query}` : ""}`);
    }
    case "get_issue":
      return runnerRequest("GET", `/api/issues/${encodeURIComponent(args.key)}`);
    case "create_issue":
      return runnerRequest("POST", "/api/issues", {
        project: args.project,
        type: args.type || "task",
        summary: args.summary,
        description: args.description,
        priority: args.priority,
        labels: args.labels,
        parentKey: args.parentKey,
      });
    case "add_comment":
      return runnerRequest("POST", `/api/issues/${encodeURIComponent(args.key)}/comments`, {
        body: args.body,
        author: args.author || "agent",
      });
    case "get_transitions":
      return runnerRequest("GET", `/api/issues/${encodeURIComponent(args.key)}/transitions`);
    case "transition_issue":
      return runnerRequest("POST", `/api/issues/${encodeURIComponent(args.key)}/transition`, {
        status: args.status,
        actor: args.actor || "agent",
      });
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// MCP stdio server (JSON-RPC over stdin/stdout)
// ---------------------------------------------------------------------------

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  // Process complete JSON-RPC messages (newline-delimited)
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg);
    } catch (e) {
      sendResponse({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }
  }
});

function sendResponse(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handleMessage(msg) {
  const { method, params, id } = msg;

  if (method === "initialize") {
    return sendResponse({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "certpilot-issues", version: "1.0.0" },
      },
    });
  }

  if (method === "notifications/initialized") {
    return; // no response needed for notifications
  }

  if (method === "tools/list") {
    return sendResponse({
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS },
    });
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    try {
      const result = await handleTool(name, args || {});
      return sendResponse({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      });
    } catch (e) {
      return sendResponse({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        },
      });
    }
  }

  // Unknown method
  sendResponse({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

process.stderr.write("[issue-mcp] Server started on stdio\n");
