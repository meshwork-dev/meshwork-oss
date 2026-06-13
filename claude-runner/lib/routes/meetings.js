// meetings.js — routes/meetings routes
// Extracted from runner.js.

const db = require("../../db");
const { DEFAULT_WORKING_DIR, N8N_CALLBACK_URL, config } = require("../config");
const { checkBudget } = require("../metrics");
const { requireSecret } = require("../middleware");
const { findProduct } = require("../products");
const { getMeeting, jobEmitter, lifecycle, meetings } = require("../state");
const { nowIso } = require("../util");

const {
  checkMeetingDuplicate,
  clearMeetingQuarantineOnly,
  createMeeting,
  dispatchMeetingActions,
  normalizeMode,
  postMeetingOutcomes,
  runAutoDiscussion,
  runChairDiscussion,
  runMeetingAgentTurn,
  sendMeetingCallback,
  unquarantineMeetingCreatedIssues,
} = require("../meetings");
const { validateWorkingDir } = require("../worker");

function registerMeetingRoutes(app) {

  /**
   * ============================================================
   * MEETING ENDPOINTS
   * ============================================================
   */

  /**
   * POST /meeting - Create a new team meeting
   * Body: {
   *   topic, agents[],
   *   mode?       — "directed" (default, chair-based) | "serial" (round-robin) | legacy aliases "chair"/"roundRobin"
   *   chair?      — explicit chair agent name (defaults to product-manager if in agents list, else first agent)
   *   facilitator?, roundRobin?, maxRounds?, maxTurns?,
   *   workingDir?, telegram?, callbackUrl?, autoDiscuss?
   * }
   */
  app.post("/meeting", requireSecret, (req, res) => {
    if (lifecycle.shuttingDown) return res.status(503).json({ ok: false, error: "Server shutting down" });

    const body = req.body || {};
    const agents = body.agents || ["product-manager", "engineer-planner"];

    // Validate agents exist
    const availableAgents = Object.values(config.agentLabels || {});
    const agentModelMap = config.routing?.agentToModel || {};
    const allKnown = [...new Set([...availableAgents, ...Object.keys(agentModelMap)])];
    const invalid = agents.filter(a => !allKnown.includes(a));
    if (invalid.length > 0) {
      return res.status(400).json({ ok: false, error: `Unknown agents: ${invalid.join(", ")}`, available: allKnown });
    }

    // Dedup: reject if a meeting with the same topic is already active or scheduled
    if (!body.allowDuplicate) {
      const dup = checkMeetingDuplicate(body.topic || "Team Meeting");
      if (dup.duplicate) {
        const msg = dup.reason === "active"
          ? `Meeting "${dup.existingTopic}" is already active (${dup.existingId})`
          : `Meeting "${dup.existingTopic}" is already scheduled for ${dup.scheduledAt} (${dup.existingId})`;
        console.log(`[${nowIso()}] Meeting dedup: rejected "${body.topic}" — ${msg}`);
        return res.status(409).json({ ok: false, error: msg, existingId: dup.existingId, reason: dup.reason });
      }
    }

    let resolvedWorkingDir = DEFAULT_WORKING_DIR;
    if (body.workingDir) {
      const wd = validateWorkingDir(body.workingDir);
      if (!wd.ok) return res.status(400).json({ ok: false, error: wd.error });
      resolvedWorkingDir = wd.resolved;
    } else {
      const pid = body.product || body.productId;
      const prod = pid ? findProduct(pid) : null;
      if (prod) {
        if (prod.workingDir) {
          const wd = validateWorkingDir(prod.workingDir);
          if (wd.ok) resolvedWorkingDir = wd.resolved;
        }
      }
    }

    const autoDiscuss = body.autoDiscuss !== false; // default to auto-discuss
    // Accept "directed"/"serial" (new API) and "chair"/"roundRobin" (legacy). Default: "directed".
    const rawMode = body.mode || "directed";
    const mode = normalizeMode(rawMode);
    const maxRounds = body.maxRounds || (autoDiscuss ? 3 : 2);

    const meeting = createMeeting({
      topic: body.topic || "Team Meeting",
      agents,
      facilitator: body.facilitator || agents[0],
      // Explicit chair wins; otherwise selectChair() applies smart default inside createMeeting.
      chair: body.chair || null,
      mode,
      roundRobin: body.roundRobin !== false,
      autoDiscuss,
      maxRounds,
      maxTurns: body.maxTurns || (mode === "chair" ? 20 : 0),
      workingDir: resolvedWorkingDir,
      telegram: body.telegram || (config.meetings?.defaultTelegramChatId ? { chatId: config.meetings.defaultTelegramChatId } : null),
      callbackUrl: body.callbackUrl || N8N_CALLBACK_URL || null,
      gateBeforeDispatch: body.gateBeforeDispatch === true,
    });

    console.log(`[${nowIso()}] Meeting created: ${meeting.meetingId} topic="${meeting.topic}" mode=${meeting.mode} chair=${meeting.chair} agents=[${meeting.agents.join(",")}] autoDiscuss=${autoDiscuss} rounds=${maxRounds} maxTurns=${meeting.maxTurns} workingDir=${meeting.workingDir} productId=${meeting.productId || "NONE"} callbackUrl=${meeting.callbackUrl || "NONE"} telegram=${JSON.stringify(meeting.telegram)}`);

    // Respond immediately
    res.status(201).json({
      ok: true,
      meetingId: meeting.meetingId,
      topic: meeting.topic,
      agents: meeting.agents,
      status: meeting.status,
      mode: meeting.mode,
      chair: meeting.chair,
      autoDiscuss,
      maxRounds,
      maxTurns: meeting.maxTurns,
    });

    // If autoDiscuss, kick off the autonomous discussion in the background
    if (autoDiscuss) {
      const discussFn = meeting.mode === "chair" ? runChairDiscussion : runAutoDiscussion;
      discussFn(meeting).catch(err => {
        console.error(`[${nowIso()}] ${meeting.mode}-discussion error for ${meeting.meetingId}: ${err.message}`);
        meeting.status = "ended";
        meeting.endedAt = nowIso();
        meeting.summary = `Meeting ended due to error: ${err.message}`;
        db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));
    
      });
    }

    return;
  });

  /**
   * POST /meeting/:id/message - Send a message to the meeting (from user or trigger agent response)
   * Body: { message, from?, triggerAgents? (array of agents to respond), agent? (single agent to respond) }
   */
  app.post("/meeting/:id/message", requireSecret, async (req, res) => {
    const meeting = await getMeeting(req.params.id);
    if (!meeting) return res.status(404).json({ ok: false, error: "Meeting not found" });
    if (meeting.status !== "active") return res.status(400).json({ ok: false, error: `Meeting is ${meeting.status}` });

    const body = req.body || {};
    const message = body.message || "";
    const fromName = body.from || "Facilitator";

    // Add user message to transcript
    if (message.trim()) {
      meeting.transcript.push({
        role: "user",
        agent: null,
        name: fromName,
        content: message.trim(),
        timestamp: nowIso(),
      });
  
    }

    // Determine which agents should respond
    let respondingAgents = [];
    if (body.agent) {
      // Single agent requested
      respondingAgents = [body.agent];
    } else if (body.triggerAgents && Array.isArray(body.triggerAgents)) {
      respondingAgents = body.triggerAgents;
    } else if (meeting.roundRobin) {
      // All agents respond in order
      respondingAgents = meeting.agents;
    } else {
      // Default: facilitator agent responds
      respondingAgents = [meeting.facilitator];
    }

    // Filter to valid meeting agents
    respondingAgents = respondingAgents.filter(a => meeting.agents.includes(a));

    if (respondingAgents.length === 0) {
      return res.json({ ok: true, meetingId: meeting.meetingId, responses: [], message: "No agents to respond" });
    }

    // Respond immediately with 202, then process agent turns
    res.status(202).json({
      ok: true,
      meetingId: meeting.meetingId,
      responding: respondingAgents,
      message: `${respondingAgents.length} agent(s) will respond`,
    });

    // Run agent turns sequentially (they build on each other)
    const responses = [];
    for (const agent of respondingAgents) {
      const budgetCheck = checkBudget();
      if (!budgetCheck.ok) {
        console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Budget exceeded, stopping agent turns`);
        break;
      }

      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: ${agent} speaking...`);
      const result = await runMeetingAgentTurn(meeting, agent, message);
      if (result) {
        responses.push(result);

        // Send to Telegram callback if configured
        if (meeting.callbackUrl || meeting.telegram) {
          const callbackPayload = {
            event: "meeting:agent-response",
            meetingId: meeting.meetingId,
            agent: result.agent,
            content: result.content,
            telegram: meeting.telegram,
            topic: meeting.topic,
            transcriptLength: meeting.transcript.length,
          };
          if (meeting.callbackUrl) {
            sendMeetingCallback(meeting.callbackUrl, callbackPayload);
          }
        }
      }
    }

    // Emit SSE
    if (config.sseEnabled) {
      jobEmitter.emit("meeting:responses", {
        meetingId: meeting.meetingId,
        responses: responses.map(r => ({ agent: r.agent, contentLength: r.content.length })),
      });
    }
  });

  /**
   * POST /meeting/:id/end - End a meeting and generate summary
   */
  app.post("/meeting/:id/end", requireSecret, async (req, res) => {
    const meeting = await getMeeting(req.params.id);
    if (!meeting) return res.status(404).json({ ok: false, error: "Meeting not found" });
    if (meeting.status === "ended") return res.status(400).json({ ok: false, error: "Meeting already ended" });

    meeting.status = "ended";
    meeting.endedAt = nowIso();

    // Generate summary using facilitator agent
    const summaryTrigger = "The meeting has ended. Generate a concise summary with: 1) Key decisions made, 2) Action items (who does what), 3) Open questions, 4) Next steps. Format as Markdown.";

    // Temporarily set status back to active for the summary turn
    meeting.status = "active";
    const summaryResult = await runMeetingAgentTurn(meeting, meeting.facilitator, summaryTrigger);
    meeting.summary = summaryResult?.content || "No summary generated";
    meeting.status = "ended"; // Ensure still ended after agent turn
    db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));


    // Send summary callback
    if (meeting.callbackUrl && meeting.telegram) {
      const callbackPayload = {
        event: "meeting:ended",
        meetingId: meeting.meetingId,
        topic: meeting.topic,
        summary: meeting.summary,
        telegram: meeting.telegram,
        messageCount: meeting.transcript.length,
        agents: meeting.agents,
        duration: meeting.endedAt && meeting.createdAt
          ? Math.round((new Date(meeting.endedAt) - new Date(meeting.createdAt)) / 1000)
          : null,
      };
      sendMeetingCallback(meeting.callbackUrl, callbackPayload);
    }

    console.log(`[${nowIso()}] Meeting ended: ${meeting.meetingId} (${meeting.transcript.length} messages)`);

    return res.json({
      ok: true,
      meetingId: meeting.meetingId,
      status: meeting.status,
      summary: meeting.summary,
    });
  });

  /**
   * POST /meeting/:id/decision — resolve a gated meeting that's awaiting human approval.
   * Body: { decision: "approve" | "reject" | "refine", refinement?: string, decidedBy?: string }
   * approve → run dispatchMeetingActions + postMeetingOutcomes (Confluence + Jira), mark ended
   * reject  → mark ended without dispatch, no Confluence/Jira side-effects
   * refine  → append guidance to transcript, restart chair discussion (cap = 3 cycles)
   */
  app.post("/meeting/:id/decision", requireSecret, async (req, res) => {
    const meeting = await getMeeting(req.params.id);
    if (!meeting) return res.status(404).json({ ok: false, error: "Meeting not found" });
    if (meeting.status !== "awaiting-approval" || !meeting.awaitingApproval) {
      return res.status(400).json({ ok: false, error: `Meeting is ${meeting.status}, not awaiting-approval` });
    }

    const body = req.body || {};
    const decision = String(body.decision || "").toLowerCase();
    const decidedBy = body.decidedBy || "Mark";
    if (!["approve", "reject", "refine"].includes(decision)) {
      return res.status(400).json({ ok: false, error: "decision must be approve|reject|refine" });
    }

    meeting.decision = { decision, refinement: body.refinement || null, decidedBy, decidedAt: nowIso() };

    if (decision === "approve") {
      meeting.awaitingApproval = false;
      meeting.status = "ended";
      meeting.endedAt = nowIso();
      db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));

      // Notify Telegram that dispatch is starting.
      if (meeting.callbackUrl && meeting.telegram) {
        sendMeetingCallback(meeting.callbackUrl, {
          event: "meeting:agent-response",
          meetingId: meeting.meetingId,
          agent: "Meeting — Approved",
          content: `_Approved by ${decidedBy}. Dispatching action items + writing minutes…_`,
          telegram: meeting.telegram,
          topic: meeting.topic,
        });
      }

      // Restore the agent:* labels we stripped at gate time so the reconciler (and
      // the dispatch path) can pick up any meeting-created issues. Awaited so the
      // labels are back in place before dispatchMeetingActions fires.
      await unquarantineMeetingCreatedIssues(meeting).catch(e =>
        console.error(`[meeting-unquarantine] ${meeting.meetingId}: ${e.message}`)
      );

      // Fire dispatch + outcomes (these are async, fire-and-forget — same as the ungated path).
      postMeetingOutcomes(meeting).catch(e => {
        console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: postMeetingOutcomes error: ${e.message}`);
      });
      dispatchMeetingActions(meeting).catch(e => {
        console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: dispatchMeetingActions error: ${e.message}`);
      });

      if (config.sseEnabled) {
        jobEmitter.emit("meeting:approved", { meetingId: meeting.meetingId });
      }
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: APPROVED by ${decidedBy} — dispatching`);
      return res.json({ ok: true, meetingId: meeting.meetingId, status: meeting.status, action: "dispatched" });
    }

    if (decision === "reject") {
      meeting.awaitingApproval = false;
      meeting.status = "rejected";
      meeting.endedAt = nowIso();
      db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));

      // Remove meeting-pending-approval label; agent:* labels stay off so the
      // rejected work doesn't get picked up by the reconciler.
      await clearMeetingQuarantineOnly(meeting).catch(e =>
        console.error(`[meeting-quarantine-clear] ${meeting.meetingId}: ${e.message}`)
      );

      if (meeting.callbackUrl && meeting.telegram) {
        sendMeetingCallback(meeting.callbackUrl, {
          event: "meeting:agent-response",
          meetingId: meeting.meetingId,
          agent: "Meeting — Rejected",
          content: `_Rejected by ${decidedBy}. Nothing dispatched. Transcript retained in runner._`,
          telegram: meeting.telegram,
          topic: meeting.topic,
        });
      }

      if (config.sseEnabled) {
        jobEmitter.emit("meeting:rejected", { meetingId: meeting.meetingId });
      }
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: REJECTED by ${decidedBy}`);
      return res.json({ ok: true, meetingId: meeting.meetingId, status: meeting.status, action: "rejected" });
    }

    // refine
    if ((meeting.refinementsUsed || 0) >= 3) {
      return res.status(400).json({
        ok: false,
        error: "Refinement cap reached (3). Approve, reject, or end the meeting via the dashboard.",
      });
    }
    const refinement = String(body.refinement || "").trim();
    if (!refinement) {
      return res.status(400).json({ ok: false, error: "refinement text required for decision=refine" });
    }
    meeting.refinementsUsed = (meeting.refinementsUsed || 0) + 1;
    meeting.awaitingApproval = false;
    meeting.status = "active";
    meeting.summary = null; // re-generated after refined discussion
    meeting.transcript.push({
      role: "user",
      agent: null,
      name: decidedBy,
      content: `[Refinement #${meeting.refinementsUsed}] ${refinement}`,
      timestamp: nowIso(),
    });
    // Top up turn budget so the chair can actually resume.
    meeting.maxTurns = (meeting.maxTurns || 0) + 6;
    db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));

    // Respond immediately, then resume discussion in the background.
    res.json({
      ok: true,
      meetingId: meeting.meetingId,
      status: meeting.status,
      action: "refining",
      refinementsUsed: meeting.refinementsUsed,
    });

    if (meeting.callbackUrl && meeting.telegram) {
      sendMeetingCallback(meeting.callbackUrl, {
        event: "meeting:agent-response",
        meetingId: meeting.meetingId,
        agent: "Meeting — Refining",
        content: `_${decidedBy} added guidance (refinement ${meeting.refinementsUsed}/3). Resuming discussion…_\n\n> ${refinement.substring(0, 800)}`,
        telegram: meeting.telegram,
        topic: meeting.topic,
      });
    }

    const discussFn = meeting.mode === "chair" ? runChairDiscussion : runAutoDiscussion;
    discussFn(meeting).catch(err => {
      console.error(`[${nowIso()}] refine-discussion error for ${meeting.meetingId}: ${err.message}`);
      meeting.status = "ended";
      meeting.endedAt = nowIso();
      meeting.summary = (meeting.summary || "") + `\n\n_Refinement failed: ${err.message}_`;
      db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));
    });
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: REFINING (#${meeting.refinementsUsed}) by ${decidedBy}`);
  });

  /**
   * GET /meeting/:id - Get meeting status and transcript
   */
  app.get("/meeting/:id", requireSecret, async (req, res) => {
    const meeting = await getMeeting(req.params.id);
    if (!meeting) return res.status(404).json({ ok: false, error: "Meeting not found" });

    return res.json({
      ok: true,
      meetingId: meeting.meetingId,
      topic: meeting.topic,
      agents: meeting.agents,
      facilitator: meeting.facilitator,
      chair: meeting.chair,
      mode: meeting.mode,
      status: meeting.status,
      currentSpeaker: meeting.currentSpeaker,
      turnCount: meeting.turnCount || 0,
      maxTurns: meeting.maxTurns || 0,
      messageCount: (meeting.transcript || []).length,
      transcript: meeting.transcript,
      summary: meeting.summary,
      createdAt: meeting.createdAt,
      endedAt: meeting.endedAt,
    });
  });

  /**
   * GET /api/meetings - List all meetings
   */
  app.get("/api/meetings", requireSecret, async (_req, res) => {
    let allMeetings;
    try {
      allMeetings = await db.meetings.listAll();
      // Merge with any in-memory active meetings not yet in DB
      for (const [id, m] of meetings) {
        if (!allMeetings.find(x => x.meetingId === id)) allMeetings.push(m);
      }
    } catch {
      allMeetings = Array.from(meetings.values());
    }
    const list = allMeetings.map(m => ({
      meetingId: m.meetingId,
      topic: m.topic,
      agents: m.agents,
      status: m.status,
      messageCount: (m.transcript || []).length,
      createdAt: m.createdAt,
      endedAt: m.endedAt,
    }));
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json({ ok: true, meetings: list });
  });
}

module.exports = { registerMeetingRoutes };
