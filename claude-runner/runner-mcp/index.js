import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const RUNNER_URL = (process.env.RUNNER_URL || "http://localhost:3210").replace(/\/$/, "");
const RUNNER_SECRET = process.env.RUNNER_SECRET || "";

async function api(method, path, body) {
  const opts = {
    method,
    headers: { "x-runner-secret": RUNNER_SECRET, "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${RUNNER_URL}${path}`, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

const get  = (p)    => api("GET",    p);
const post = (p, b) => api("POST",   p, b);
const del  = (p)    => api("DELETE", p);

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: "runner-admin", version: "1.0.0" });

// ── Health & stats ────────────────────────────────────────────────────

server.registerTool("runner_health",
  { description: "Check runner health and current queue (running, queued, total jobs)" },
  async () => ok(await get("/health")));

server.registerTool("runner_stats",
  { description: "Job statistics broken down by status, product, and agent" },
  async () => ok(await get("/api/stats")));

server.registerTool("runner_metrics",
  { description: "Performance metrics: latency percentiles, success rates, cost" },
  async () => ok(await get("/api/metrics")));

server.registerTool("runner_kpi",
  { description: "3-tier KPI summary: business / operational / cost" },
  async () => ok(await get("/api/kpi")));

server.registerTool("runner_context_budget",
  { description: "Context budget usage and circuit-breaker status (daily/hourly limits)" },
  async () => ok(await get("/api/context-budget")));

// ── Jobs ─────────────────────────────────────────────────────────────

server.registerTool("runner_list_jobs",
  {
    description: "List jobs with optional filters. Use this to find recent failures or in-progress work.",
    inputSchema: {
      status:  z.enum(["running", "queued", "completed", "failed", "cancelled"]).optional(),
      product: z.string().optional().describe("Product ID e.g. meshwork"),
      agent:   z.string().optional().describe("Agent name e.g. engineer-planner"),
      limit:   z.number().int().min(1).max(100).optional().describe("Max results, default 20"),
    },
  },
  async ({ status, product, agent, limit }) => {
    const p = new URLSearchParams();
    if (status)  p.set("status",  status);
    if (product) p.set("product", product);
    if (agent)   p.set("agent",   agent);
    if (limit)   p.set("limit",   String(limit));
    const qs = p.toString() ? `?${p}` : "";
    return ok(await get(`/api/jobs${qs}`));
  });

server.registerTool("runner_get_job",
  {
    description: "Get full details of a specific job including status, timing, and metadata",
    inputSchema: { jobId: z.string() },
  },
  async ({ jobId }) => ok(await get(`/jobs/${jobId}`)));

server.registerTool("runner_get_job_output",
  {
    description: "Get the Claude output text from a completed job",
    inputSchema: { jobId: z.string() },
  },
  async ({ jobId }) => ok(await get(`/jobs/${jobId}/output`)));

server.registerTool("runner_get_job_log",
  {
    description: "Get the structured execution log for a job (tool calls, events, errors)",
    inputSchema: { jobId: z.string() },
  },
  async ({ jobId }) => ok(await get(`/jobs/${jobId}/log`)));

server.registerTool("runner_retry_job",
  {
    description: "Retry a failed job with the same parameters",
    inputSchema: { jobId: z.string() },
  },
  async ({ jobId }) => ok(await post(`/jobs/${jobId}/retry`)));

server.registerTool("runner_delete_job",
  {
    description: "Delete a job and its logs from history",
    inputSchema: { jobId: z.string() },
  },
  async ({ jobId }) => ok(await del(`/jobs/${jobId}`)));

// ── Failed callbacks ──────────────────────────────────────────────────

server.registerTool("runner_list_failed_callbacks",
  { description: "List failed webhook callbacks that need replay (N8N notifications that didn't land)" },
  async () => ok(await get("/api/failed-callbacks")));

server.registerTool("runner_replay_callback",
  {
    description: "Replay a failed webhook callback",
    inputSchema: { callbackId: z.string() },
  },
  async ({ callbackId }) => ok(await post(`/api/failed-callbacks/${callbackId}/replay`)));

server.registerTool("runner_delete_callback",
  {
    description: "Discard a failed callback (won't retry)",
    inputSchema: { callbackId: z.string() },
  },
  async ({ callbackId }) => ok(await del(`/api/failed-callbacks/${callbackId}`)));

// ── Products & agents ─────────────────────────────────────────────────

server.registerTool("runner_list_products",
  { description: "List all registered products with their working dirs, plugin dirs, and board IDs" },
  async () => ok(await get("/api/products")));

server.registerTool("runner_reload_product",
  {
    description: "Hot-reload a product's config without restarting the runner",
    inputSchema: { productId: z.string().describe("e.g. meshwork, estateos, warranty-management") },
  },
  async ({ productId }) => ok(await post(`/api/products/${productId}/reload`)));

server.registerTool("runner_list_agents",
  { description: "List all available agents and their assigned models" },
  async () => ok(await get("/agents")));

server.registerTool("runner_list_product_agents",
  {
    description: "List agents available for a specific product",
    inputSchema: { productId: z.string() },
  },
  async ({ productId }) => ok(await get(`/api/products/${productId}/agents`)));

// ── Scheduled jobs ────────────────────────────────────────────────────

server.registerTool("runner_list_scheduled",
  { description: "List all scheduled jobs (meetings, deferred actions, etc.)" },
  async () => ok(await get("/api/scheduled")));

server.registerTool("runner_delete_scheduled",
  {
    description: "Cancel a scheduled job before it fires",
    inputSchema: { scheduledId: z.string() },
  },
  async ({ scheduledId }) => ok(await del(`/api/scheduled/${scheduledId}`)));

// ── Conversations ─────────────────────────────────────────────────────

server.registerTool("runner_list_conversations",
  { description: "List active chat conversation histories (channel memory)" },
  async () => ok(await get("/api/conversations")));

server.registerTool("runner_get_conversation",
  {
    description: "Get the message history for a specific conversation channel",
    inputSchema: { conversationId: z.string() },
  },
  async ({ conversationId }) => ok(await get(`/api/conversations/${conversationId}`)));

// ── PM digest ─────────────────────────────────────────────────────────

server.registerTool("runner_pm_digest",
  { description: "Get the latest PM digest: sprint health, blockers, and action items" },
  async () => ok(await get("/api/pm-digest")));

// ── Structured observations ──────────────────────────────────────────

server.registerTool("runner_submit_observations",
  {
    description: "Submit structured review observations (findings with severity + evidence, AC checks) for the CURRENT job. The pipeline engine computes the gate verdict from these — do not issue a verdict yourself. Job identity and token are read from the job environment (MESHWORK_JOB_ID / MESHWORK_JOB_TOKEN); only pass them explicitly when submitting for a different job.",
    inputSchema: {
      findings: z.array(z.object({
        severity: z.enum(["critical", "major", "minor", "info"]),
        title: z.string(),
        file: z.string().optional(),
        line: z.number().int().positive().optional(),
        detail: z.string().optional(),
        evidence: z.string().optional(),
        cause: z.enum(["spec-ambiguity", "reviewer-omission", "implementer-error", "context-starvation", "other"]).optional(),
      })).default([]),
      acChecks: z.array(z.object({
        id: z.string(),
        status: z.enum(["met", "gap", "partial"]),
        evidence: z.string().optional(),
      })).default([]),
      summary: z.string().optional(),
      gate: z.string().optional(),
      jobId: z.string().optional().describe("Defaults to MESHWORK_JOB_ID from the environment"),
      jobToken: z.string().optional().describe("Defaults to MESHWORK_JOB_TOKEN from the environment"),
    },
  },
  async ({ findings, acChecks, summary, gate, jobId, jobToken }) => {
    const id = jobId || process.env.MESHWORK_JOB_ID;
    const token = jobToken || process.env.MESHWORK_JOB_TOKEN;
    if (!id) return ok({ error: "No jobId provided and MESHWORK_JOB_ID is not set" });
    const res = await fetch(`${RUNNER_URL}/jobs/${id}/observations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "x-meshwork-job-token": token } : { "x-runner-secret": RUNNER_SECRET }),
      },
      body: JSON.stringify({ findings, acChecks, summary, gate }),
    });
    const text = await res.text();
    try { return ok(JSON.parse(text)); } catch { return ok({ status: res.status, body: text }); }
  });

server.registerTool("runner_verification_stats",
  { description: "Verification sampling metrics: overturn rate of passed review gates, new-finding counts, and root-cause tallies (spec-ambiguity / reviewer-omission / implementer-error / context-starvation)" },
  async () => ok(await get("/api/verification-stats")));

const transport = new StdioServerTransport();
await server.connect(transport);
