// worktrees.js — routes/worktrees routes
// Extracted from runner.js.

const { requireSecret } = require("../middleware");
const { getWorktree } = require("../state");

const { listWorktreesWithStats, mergeWorktree, removeWorktree } = require("../worktrees");

function registerWorktreeRoutes(app) {


  // ============================================================
  // WORKTREE API ENDPOINTS
  // ============================================================

  // GET /api/worktrees - List all tracked worktrees with git stats
  app.get("/api/worktrees", requireSecret, (req, res) => {
    const results = listWorktreesWithStats();
    res.json({ ok: true, worktrees: results, total: results.length });
  });

  // POST /api/worktrees/:id/merge - Merge worktree branch into the integration branch (dev)
  app.post("/api/worktrees/:id/merge", requireSecret, async (req, res) => {
    const wt = await getWorktree(req.params.id);
    if (!wt) return res.status(404).json({ ok: false, error: "worktree not found" });
    try {
      const result = mergeWorktree(wt.issueKey);
      res.json({ ok: true, merged: true, ...result });
    } catch (e) {
      res.status(409).json({ ok: false, error: e.message });
    }
  });

  // DELETE /api/worktrees/:id - Delete worktree (optionally delete branch)
  app.delete("/api/worktrees/:id", requireSecret, async (req, res) => {
    const wt = await getWorktree(req.params.id);
    if (!wt) return res.status(404).json({ ok: false, error: "worktree not found" });
    try {
      removeWorktree(wt.issueKey);
      res.json({ ok: true, deleted: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/worktrees/:id/pr - Legacy alias for /merge (kept for dashboard back-compat).
  // The runner no longer opens GitHub PRs; it merges the branch into the integration
  // branch (dev) directly. Humans open PRs from dev -> main manually for deployment.
  app.post("/api/worktrees/:id/pr", requireSecret, async (req, res) => {
    const wt = await getWorktree(req.params.id);
    if (!wt) return res.status(404).json({ ok: false, error: "worktree not found" });
    try {
      const result = mergeWorktree(wt.issueKey);
      res.json({ ok: true, merged: true, ...result, note: "PR endpoint is deprecated; merged into integration branch instead" });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { registerWorktreeRoutes };
