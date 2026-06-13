// batches.js — routes/batches routes
// Extracted from runner.js.

const crypto = require("crypto");
const db = require("../../db");
const { requireSecret } = require("../middleware");
const { batches } = require("../state");
const { nowIso } = require("../util");

function registerBatchRoutes(app) {

  /**
   * BATCH ENDPOINTS
   */

  // POST /batches - Create a new batch
  app.post("/batches", requireSecret, (req, res) => {
    const { total, slack, telegram } = req.body || {};

    if (!total || typeof total !== "number" || total < 1) {
      return res.status(400).json({ ok: false, error: "total must be a positive number" });
    }

    const batchId = `batch_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const batchRecord = {
      batchId,
      total,
      completed: 0,
      failed: 0,
      results: [],
      slack: slack || null,
      telegram: telegram || null,
      createdAt: nowIso(),
    };
    batches.set(batchId, batchRecord);
    db.batches.set(batchRecord).catch(e => console.error('[db] batch persist failed: ' + e.message));

    console.log(`[${nowIso()}] Created batch ${batchId} with total=${total}`);

    return res.status(201).json({ ok: true, batchId });
  });

  // GET /batches/:batchId - Get batch status
  app.get("/batches/:batchId", requireSecret, async (req, res) => {
    let batch = batches.get(req.params.batchId);
    if (!batch) {
      try { batch = await db.batches.get(req.params.batchId); } catch { batch = null; }
    }
    if (!batch) return res.status(404).json({ ok: false, error: "batch not found" });

    const isComplete = (batch.completed + batch.failed) >= batch.total;
    return res.json({ ok: true, batch, isComplete });
  });

  // POST /batches/:batchId/complete - Called by callback when a job finishes
  app.post("/batches/:batchId/complete", requireSecret, async (req, res) => {
    const { jobId, status, result, issueKey, error } = req.body || {};
    let batch = batches.get(req.params.batchId);
    if (!batch) {
      try { batch = await db.batches.get(req.params.batchId); } catch { batch = null; }
    }

    if (!batch) return res.status(404).json({ ok: false, error: "batch not found" });

    batch.results.push({
      jobId: jobId || null,
      issueKey: issueKey || null,
      status: status || "unknown",
      result: result || null,
      error: error || null,
      completedAt: nowIso(),
    });

    if (status === "succeeded" || status === "completed") {
      batch.completed++;
    } else {
      batch.failed++;
    }

    const isComplete = (batch.completed + batch.failed) >= batch.total;
    db.batches.set(batch).catch(e => console.error('[db] batch update failed: ' + e.message));

    console.log(`[${nowIso()}] Batch ${req.params.batchId}: ${batch.completed + batch.failed}/${batch.total} (complete=${isComplete})`);

    return res.json({ ok: true, isComplete, batch });
  });

  // GET /api/batches - List all batches
  app.get("/api/batches", requireSecret, async (req, res) => {
    let allBatches;
    try {
      allBatches = await db.batches.listAll();
      // Merge with any in-memory batches not yet in DB
      for (const [id, b] of batches) {
        if (!allBatches.find(x => x.batchId === id)) allBatches.push(b);
      }
    } catch {
      allBatches = Array.from(batches.values());
    }
    const batchList = allBatches.map(b => ({
      batchId: b.batchId,
      total: b.total,
      completed: b.completed,
      failed: b.failed,
      slack: b.slack,
      telegram: b.telegram,
      createdAt: b.createdAt,
      resultsCount: b.results?.length || 0,
    }));

    // Sort by createdAt descending
    batchList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.json({ ok: true, batches: batchList });
  });
}

module.exports = { registerBatchRoutes };
