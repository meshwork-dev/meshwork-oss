// schedule.js — routes/schedule routes
// Extracted from runner.js.

const db = require("../../db");
const { DEFAULT_WORKING_DIR, N8N_CALLBACK_URL } = require("../config");
const { requireSecret } = require("../middleware");
const { scheduledItems } = require("../state");
const { nowIso } = require("../util");

const { checkMeetingDuplicate } = require("../meetings");
const { parseScheduleTime, scheduleItem } = require("../scheduler");

function registerScheduleRoutes(app) {

  /**
   * POST /schedule - Schedule a future job or meeting
   * Body: { type: "job"|"meeting", scheduledAt: "ISO date or relative time", data: { ... } }
   * For jobs: data = { agent, prompt, context?, workingDir? }
   * For meetings: data = { topic, agents[], facilitator?, maxRounds?, telegram? }
   */
  app.post("/schedule", requireSecret, (req, res) => {
    const body = req.body || {};
    const type = body.type;
    if (!type || !["job", "meeting"].includes(type)) {
      return res.status(400).json({ ok: false, error: 'type must be "job" or "meeting"' });
    }

    const scheduledAt = parseScheduleTime(body.scheduledAt || body.schedule);
    if (!scheduledAt) {
      return res.status(400).json({ ok: false, error: "Could not parse scheduledAt. Use ISO datetime or relative time (e.g. 'tomorrow 09:00', 'in 2 hours', 'next Monday 10:00')" });
    }

    const data = body.data || {};

    if (type === "job") {
      if (!data.agent) return res.status(400).json({ ok: false, error: "data.agent is required for job scheduling" });
      if (!data.prompt) return res.status(400).json({ ok: false, error: "data.prompt is required for job scheduling" });
    } else if (type === "meeting") {
      if (!data.topic) return res.status(400).json({ ok: false, error: "data.topic is required for meeting scheduling" });
      if (!data.agents || !data.agents.length) return res.status(400).json({ ok: false, error: "data.agents is required for meeting scheduling" });
    }

    // Set defaults for meetings
    if (type === "meeting") {
      data.facilitator = data.facilitator || data.agents[0];
      data.maxRounds = data.maxRounds || 3;
      data.workingDir = data.workingDir || DEFAULT_WORKING_DIR;
      data.telegram = data.telegram || null;
      data.callbackUrl = data.callbackUrl || N8N_CALLBACK_URL || null;

      // Dedup: reject if same topic is active or already scheduled
      if (!body.allowDuplicate) {
        const dup = checkMeetingDuplicate(data.topic);
        if (dup.duplicate) {
          const msg = dup.reason === "active"
            ? `Meeting "${dup.existingTopic}" is already active (${dup.existingId})`
            : `Meeting "${dup.existingTopic}" is already scheduled for ${dup.scheduledAt} (${dup.existingId})`;
          console.log(`[${nowIso()}] Schedule dedup: rejected "${data.topic}" — ${msg}`);
          return res.status(409).json({ ok: false, error: msg, existingId: dup.existingId, reason: dup.reason });
        }
      }
    }

    const id = scheduleItem({
      type,
      scheduledAt: scheduledAt.toISOString(),
      status: "pending",
      source: body.source || "api",
      data,
    });

    return res.status(201).json({
      ok: true,
      scheduleId: id,
      type,
      scheduledAt: scheduledAt.toISOString(),
      scheduledAtHuman: scheduledAt.toLocaleString(),
      data: { topic: data.topic, agent: data.agent, agents: data.agents },
    });
  });

  /**
   * GET /api/scheduled - List scheduled items (pending and recent)
   */
  app.get("/api/scheduled", requireSecret, async (_req, res) => {
    let allItems;
    try {
      allItems = await db.scheduled.listAll();
      // Merge with any in-memory scheduled items not yet in DB
      for (const [id, s] of scheduledItems) {
        if (!allItems.find(x => x.id === id)) allItems.push(s);
      }
    } catch {
      allItems = Array.from(scheduledItems.values());
    }
    const items = allItems.map(s => ({
      id: s.id,
      type: s.type,
      status: s.status || "pending",
      scheduledAt: s.scheduledAt,
      createdAt: s.createdAt,
      firedAt: s.firedAt,
      source: s.source,
      topic: s.data?.topic,
      agent: s.data?.agent,
      agents: s.data?.agents,
      task: s.data?.task?.substring(0, 120),
      jobId: s.jobId,
      meetingId: s.meetingId,
      acceleratedFrom: s.acceleratedFrom || null,
      acceleratedBy: s.acceleratedBy || null,
    }));
    items.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
    const pending = items.filter(i => i.status === "pending");
    const done = items.filter(i => i.status !== "pending");
    return res.json({ ok: true, pending, done: done.slice(-20) });
  });

  /**
   * DELETE /api/scheduled/:id - Cancel a scheduled item
   */
  app.delete("/api/scheduled/:id", requireSecret, async (req, res) => {
    let item = scheduledItems.get(req.params.id);
    if (!item) {
      try { item = await db.scheduled.get(req.params.id); } catch { item = null; }
    }
    if (!item) return res.status(404).json({ ok: false, error: "Scheduled item not found" });
    if (item.status === "done") return res.status(400).json({ ok: false, error: "Item already executed" });
    item.status = "cancelled";
    item.cancelledAt = nowIso();
    db.scheduled.set(item).catch(e => console.error('[db] scheduled update failed: ' + e.message));

    return res.json({ ok: true, id: item.id, status: "cancelled" });
  });
}

module.exports = { registerScheduleRoutes };
