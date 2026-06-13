// issues.js — routes/issues routes
// Extracted from runner.js.

const crypto = require("crypto");
const fs = require("fs");
const db = require("../../db");
const issueTracker = require("../../issue-tracker");
const { config } = require("../config");
const { convPath, loadConversation } = require("../conversations");
const { requireSecret } = require("../middleware");

const { emitNotificationWebhook } = require("../callbacks");

function registerIssueRoutes(app) {

  // GET /api/conversations - List all conversations
  app.get("/api/conversations", requireSecret, async (req, res) => {
    try {
      const rows = await db.conversations.listAll();
      const conversations = rows.map(r => ({
        conversationId: r.channelId,
        updatedAt: r.lastActive,
        messageCount: r.messageCount,
        productId: r.productId,
      }));
      return res.json({ ok: true, conversations });
    } catch (e) {
      return res.json({ ok: true, conversations: [] });
    }
  });

  // GET /api/conversations/:id - Get conversation messages
  app.get("/api/conversations/:id", requireSecret, async (req, res) => {
    const conv = await loadConversation(req.params.id);
    return res.json({ ok: true, conversation: conv });
  });

  // ============================================================
  // ISSUE TRACKER API ROUTES
  // ============================================================

  // POST /api/issues - Create issue
  app.post("/api/issues", requireSecret, async (req, res) => {
    try {
      const { project, type, summary, description, labels, priority, assignee, parentKey, storyPoints } = req.body || {};
      if (!project || !summary) return res.status(400).json({ ok: false, error: "project and summary are required" });
      const issue = await issueTracker.createIssue(project, { type, summary, description, labels, priority, assignee, parentKey, storyPoints });
      // Emit notification
      try {
        await db.notifications.create({ type: "issue_created", title: `Issue ${issue.key} created`, body: summary, severity: "info", link: `/issues?key=${issue.key}` });
        emitNotificationWebhook("issue.created", "info", `Issue ${issue.key} created`, summary, `/issues?key=${issue.key}`);
      } catch (_) { /* non-critical */ }
      return res.json({ ok: true, issue });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/issues - List/filter issues
  app.get("/api/issues", requireSecret, async (req, res) => {
    try {
      const { status, type, project, label, assignee, search, parentKey, limit, offset } = req.query;
      const result = await issueTracker.searchIssues({ status, type, project, label, assignee, search, parentKey, limit: limit || 50, offset: offset || 0 });
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/issues/:key - Get issue with comments + links
  app.get("/api/issues/:key", requireSecret, async (req, res) => {
    try {
      const issue = await issueTracker.getIssue(req.params.key);
      if (!issue) return res.status(404).json({ ok: false, error: "Issue not found" });
      const [comments, links, subtasks] = await Promise.all([
        issueTracker.getComments(req.params.key),
        issueTracker.getLinks(req.params.key),
        issueTracker.getSubtasks(req.params.key),
      ]);
      return res.json({ ok: true, issue, comments, links, subtasks });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // PUT /api/issues/:key - Update issue fields
  app.put("/api/issues/:key", requireSecret, async (req, res) => {
    try {
      const issue = await issueTracker.updateIssue(req.params.key, req.body || {});
      if (!issue) return res.status(404).json({ ok: false, error: "Issue not found" });
      return res.json({ ok: true, issue });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // DELETE /api/issues/:key - Delete issue
  app.delete("/api/issues/:key", requireSecret, async (req, res) => {
    try {
      const deleted = await issueTracker.deleteIssue(req.params.key);
      return res.json({ ok: true, deleted });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/issues/:key/transition - Change issue status
  app.post("/api/issues/:key/transition", requireSecret, async (req, res) => {
    try {
      const { status, actor } = req.body || {};
      if (!status) return res.status(400).json({ ok: false, error: "status is required" });
      const issue = await issueTracker.transitionIssue(req.params.key, status, actor);
      return res.json({ ok: true, issue });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
  });

  // GET /api/issues/:key/transitions - List available transitions
  app.get("/api/issues/:key/transitions", requireSecret, async (req, res) => {
    try {
      const transitions = await issueTracker.getTransitions(req.params.key);
      return res.json({ ok: true, transitions });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/issues/:key/comments - Add comment
  app.post("/api/issues/:key/comments", requireSecret, async (req, res) => {
    try {
      const { body, author } = req.body || {};
      if (!body) return res.status(400).json({ ok: false, error: "body is required" });
      const comment = await issueTracker.addComment(req.params.key, body, author || "user");
      return res.json({ ok: true, comment });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/issues/:key/link - Create dependency link
  app.post("/api/issues/:key/link", requireSecret, async (req, res) => {
    try {
      const { targetKey, linkType } = req.body || {};
      if (!targetKey || !linkType) return res.status(400).json({ ok: false, error: "targetKey and linkType are required" });
      const link = await issueTracker.createLink(req.params.key, targetKey, linkType);
      return res.json({ ok: true, link });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ============================================================
  // NOTIFICATION API ROUTES
  // ============================================================

  // GET /api/notifications - List notifications
  app.get("/api/notifications", requireSecret, async (_req, res) => {
    try {
      const notifications = await db.notifications.list({ limit: 50 });
      return res.json({ ok: true, notifications });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/notifications/count - Unread count
  app.get("/api/notifications/count", requireSecret, async (_req, res) => {
    try {
      const count = await db.notifications.unreadCount();
      return res.json({ ok: true, count });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/notifications/:id/read - Mark as read
  app.post("/api/notifications/:id/read", requireSecret, async (req, res) => {
    try {
      await db.notifications.markRead(parseInt(req.params.id, 10));
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/notifications/read-all - Mark all as read
  app.post("/api/notifications/read-all", requireSecret, async (_req, res) => {
    try {
      await db.notifications.markAllRead();
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ============================================================
  // CHAT API ENHANCEMENTS
  // ============================================================

  // POST /api/chat/send - Send chat message, returns job ID for streaming
  app.post("/api/chat/send", requireSecret, async (req, res) => {
    try {
      const { message, agent, channelId, workingDir } = req.body || {};
      if (!message) return res.status(400).json({ ok: false, error: "message is required" });

      // Reuse existing /chat logic by constructing a chat request
      const chatBody = {
        channelId: channelId || "dashboard-general",
        message,
        workingDir: workingDir || config.workingDir,
      };
      if (agent) chatBody.agent = agent;

      // Forward to the existing chat handler internally
      const chatReq = { body: chatBody, headers: req.headers };
      const jobId = crypto.randomUUID();

      // We enqueue this the same way /chat does but return the jobId immediately
      // The caller can then subscribe to /jobs/:id/stream-events for real-time output
      chatBody._dashboardJobId = jobId;

      // Use a lightweight redirect: POST to /chat internally
      const fakeRes = {
        statusCode: 200,
        json(data) { fakeRes._data = data; fakeRes.statusCode = 200; },
        status(code) { fakeRes.statusCode = code; return fakeRes; },
        _data: null,
      };

      // Trigger the existing chat handler
      try {
        const chatHandler = app._router.stack.find(
          (layer) => layer.route?.path === "/chat" && layer.route?.methods?.post
        );
        if (chatHandler) {
          await new Promise((resolve) => {
            chatHandler.route.stack[chatHandler.route.stack.length - 1].handle(
              { ...chatReq, body: chatBody },
              fakeRes,
              resolve
            );
          });
          if (fakeRes._data) return res.json({ ok: true, ...fakeRes._data });
        }
      } catch (_) { /* fallback below */ }

      return res.json({ ok: true, message: "Chat message queued", channelId: chatBody.channelId });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/chat/conversations - List all conversations (alias for existing endpoint)
  app.get("/api/chat/conversations", requireSecret, async (_req, res) => {
    try {
      const rows = await db.conversations.listAll();
      const conversations = rows.map(r => ({
        id: r.channelId,
        channelId: r.channelId,
        messageCount: r.messageCount,
        lastUpdated: r.lastActive,
      }));
      return res.json({ ok: true, conversations });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/chat/conversations/:id - Get conversation history
  app.get("/api/chat/conversations/:id", requireSecret, async (req, res) => {
    const conv = await loadConversation(req.params.id);
    return res.json({ ok: true, conversation: conv });
  });

  // DELETE /api/chat/conversations/:id - Delete conversation
  app.delete("/api/chat/conversations/:id", requireSecret, async (req, res) => {
    try {
      // Delete from DB
      await db.conversations.delete(req.params.id);
      // Also remove any residual legacy file
      const filePath = convPath(req.params.id);
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) { /* best-effort */ }
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { registerIssueRoutes };
