// dispatch.js — routes/dispatch routes
// Extracted from runner.js.

const db = require("../../db");
const {
  DEFAULT_WORKING_DIR,
  IDEMPOTENCY_TTL_HOURS,
  MAX_CONCURRENCY_PER_PRODUCT,
  N8N_CALLBACK_URL,
  config,
} = require("../config");
const {
  formatConversationForPrompt,
  loadConversation,
  trimConversationMessages,
} = require("../conversations");
const { idempotencyStore, pruneIdempotency, saveIdempotency } = require("../idempotency");
const { moveSubtaskToParentSprint } = require("../jira");
const { checkBudget } = require("../metrics");
const { admissionControl, n8nHealth, requireSecret, secretMatches } = require("../middleware");
const { findProduct, products } = require("../products");
const { getTotalRunningCount, jobs, lifecycle, queue, runningByProduct } = require("../state");
const { nowIso } = require("../util");

const { runConsultation } = require("../claude-exec");
const { canRunSubtaskParallel, getSubtaskConfig, trackSubtask } = require("../subtasks");
const { createJob, enqueue, validateWorkingDir } = require("../worker");

function registerDispatchRoutes(app) {

  /**
   * ROUTES
   */
  app.get("/health", async (req, res) => {
    // If protection is enabled, require secret for detailed info
    if (config.protectHealthEndpoint) {
      if (!secretMatches(req.header("x-runner-secret"))) {
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
  app.post("/run", requireSecret, admissionControl, (req, res) => {
    if (lifecycle.shuttingDown) return res.status(503).json({ ok: false, error: "Server shutting down" });

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
    const idempotencyKey = req.header("x-idempotency-key") || jobIn.idempotencyKey || null;

    const callbackUrl = jobIn.callbackUrl || N8N_CALLBACK_URL || null;
    const slack = jobIn.slack || null;

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

    const job = createJob({
      mode: "delivery",
      jobIn,
      callbackUrl,
      fields: {
        issueKey: String(issueKey),
        summary: summary ? String(summary) : "",
        description: description ? String(description) : "",
        workingDir: wd.resolved,
        agent: agent ? String(agent) : "",
        slack,

        // Subtask-related fields
        parentKey,
        subtaskFiles,
        subtaskDepth,
        isSubtask: !!parentKey,
      },
    });
    const jobId = job.jobId;

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
  app.post("/chat", requireSecret, admissionControl, async (req, res) => {
    if (lifecycle.shuttingDown) return res.status(503).json({ ok: false, error: "Server shutting down" });
    const budgetCheck = checkBudget();
    if (!budgetCheck.ok) return res.status(429).json({ ok: false, error: budgetCheck.reason, status: "budget-exceeded" });

    const body = req.body || {};
    const jobIn = body.job || body;

    const agent = jobIn.agent || "product-manager";
    const message = jobIn.message || jobIn.text || "";
    if (!String(message).trim()) return res.status(400).json({ ok: false, error: "message is required" });

    const callbackUrl = jobIn.callbackUrl || null;
    const slack = jobIn.slack || null;
    const telegram = jobIn.telegram || null;
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

    const job = createJob({
      mode: "chat",
      jobIn,
      callbackUrl,
      fields: {
        agent: String(agent),
        message: String(message),
        conversationId: String(conversationId),
        historyText,
        workingDir: resolvedWorkingDir || DEFAULT_WORKING_DIR, // Use default if not specified
        issueKey: null,
        slack,
      },
    });
    const jobId = job.jobId;

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
  app.post("/agent", requireSecret, admissionControl, (req, res) => {
    if (lifecycle.shuttingDown) return res.status(503).json({ ok: false, error: "Server shutting down" });
    const budgetCheck = checkBudget();
    if (!budgetCheck.ok) return res.status(429).json({ ok: false, error: budgetCheck.reason, status: "budget-exceeded" });

    const body = req.body || {};
    const jobIn = body.job || body;

    const agent = jobIn.agent;
    if (!agent) return res.status(400).json({ ok: false, error: "agent is required" });

    const prompt = jobIn.prompt || jobIn.message || jobIn.task || "";
    if (!String(prompt).trim()) return res.status(400).json({ ok: false, error: "prompt is required" });

    const context = jobIn.context || "";
    const callbackUrl = jobIn.callbackUrl || N8N_CALLBACK_URL || null;

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

    const job = createJob({
      mode: "agent",
      jobIn,
      callbackUrl,
      fields: {
        agent: String(agent),
        prompt: String(prompt),
        context: context ? String(context) : "",
        workingDir: resolvedWorkingDir || DEFAULT_WORKING_DIR,
        issueKey: null,
      },
    });
    const jobId = job.jobId;

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
}

module.exports = { registerDispatchRoutes };
