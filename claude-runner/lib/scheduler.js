// scheduler.js — scheduled jobs/meetings: parsing, acceleration, due-item dispatch
// Extracted from runner.js.

const https = require("https");
const path = require("path");
const db = require("../db");
const { DEFAULT_WORKING_DIR, LOG_DIR, N8N_CALLBACK_URL, config } = require("./config");
const { products } = require("./products");
const { jobEmitter, jobs, queue, scheduledItems } = require("./state");
const { makeJobId, nowIso } = require("./util");

// Function declarations are hoisted: exporting before requiring sibling
// modules keeps require cycles safe (each module's exports are complete
// before any sibling starts loading).
module.exports = {
  parseScheduleTime,
  scheduleItem,
  accelerateScheduledItems,
  doAccelerate,
  checkGlmReadiness,
  tickScheduler,
};

const { extractAssistantText } = require("./claude-exec");
const {
  checkMeetingDuplicate,
  createMeeting,
  normalizeMode,
  runAutoDiscussion,
  runChairDiscussion,
} = require("./meetings");
const { tickWorker } = require("./worker");


/**
 * Parse relative time strings into absolute Date.
 * Supports: "tomorrow 09:00", "in 2 hours", "next Monday 10:00", ISO dates, etc.
 */
function parseScheduleTime(timeStr) {
  if (!timeStr) return null;
  const s = timeStr.trim();

  // Already ISO? e.g. "2026-03-10T09:00:00Z" or "2026-03-10 09:00"
  const isoDate = new Date(s.replace(" ", "T"));
  if (!isNaN(isoDate.getTime()) && s.match(/^\d{4}-/)) return isoDate;

  const now = new Date();

  // "in X hours/minutes/days"
  const inMatch = s.match(/^in\s+(\d+)\s+(hour|minute|min|day|week)s?$/i);
  if (inMatch) {
    const n = parseInt(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    const ms = unit.startsWith("hour") ? n * 3600000
      : unit.startsWith("min") ? n * 60000
      : unit.startsWith("day") ? n * 86400000
      : unit.startsWith("week") ? n * 604800000 : 0;
    return new Date(now.getTime() + ms);
  }

  // "tomorrow HH:MM" or just "tomorrow"
  const tomorrowMatch = s.match(/^tomorrow\s*(\d{1,2}:\d{2})?$/i);
  if (tomorrowMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    if (tomorrowMatch[1]) {
      const [h, m] = tomorrowMatch[1].split(":").map(Number);
      d.setHours(h, m, 0, 0);
    } else {
      d.setHours(9, 0, 0, 0); // default 9am
    }
    return d;
  }

  // "next Monday/Tuesday/... HH:MM"
  const dayNames = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const nextDayMatch = s.match(/^next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*(\d{1,2}:\d{2})?$/i);
  if (nextDayMatch) {
    const targetDay = dayNames.indexOf(nextDayMatch[1].toLowerCase());
    const d = new Date(now);
    let daysAhead = targetDay - d.getDay();
    if (daysAhead <= 0) daysAhead += 7;
    d.setDate(d.getDate() + daysAhead);
    if (nextDayMatch[2]) {
      const [h, m] = nextDayMatch[2].split(":").map(Number);
      d.setHours(h, m, 0, 0);
    } else {
      d.setHours(9, 0, 0, 0);
    }
    return d;
  }

  // "today HH:MM"
  const todayMatch = s.match(/^today\s+(\d{1,2}:\d{2})$/i);
  if (todayMatch) {
    const d = new Date(now);
    const [h, m] = todayMatch[1].split(":").map(Number);
    d.setHours(h, m, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1); // if past, push to tomorrow
    return d;
  }

  return null; // Couldn't parse — will execute immediately
}

function scheduleItem(item) {
  const id = `sched_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const scheduledEntry = { ...item, id, createdAt: nowIso() };
  scheduledItems.set(id, scheduledEntry);
  db.scheduled.set(scheduledEntry).catch(e => console.error('[db] scheduled persist failed: ' + e.message));

  console.log(`[${nowIso()}] Scheduled ${item.type}: "${(item.data?.topic || item.data?.task || "").substring(0, 60)}" for ${item.scheduledAt}`);
  return id;
}

/**
 * Schedule Acceleration: When a scheduled job completes successfully,
 * check if downstream scheduled items from the same meeting can fire early.
 * Items are brought forward to now + accelerationDelayMs.
 */
function accelerateScheduledItems(completedJob) {
  if (!config.scheduler?.accelerateOnCompletion) return;

  // Only accelerate if this job came from a scheduled item
  const sourceMatch = completedJob.source?.match(/^meeting:(.+)$/);
  if (!sourceMatch) return;
  const meetingSource = completedJob.source;

  // Find pending items from the same meeting source, sorted by scheduledAt
  const pendingFromSameMeeting = [];
  for (const [id, item] of scheduledItems.entries()) {
    if (item.status !== "pending") continue;
    if (item.source !== meetingSource) continue;
    pendingFromSameMeeting.push({ id, item });
  }

  if (pendingFromSameMeeting.length === 0) return;

  // Sort by scheduledAt (earliest first)
  pendingFromSameMeeting.sort((a, b) =>
    new Date(a.item.scheduledAt).getTime() - new Date(b.item.scheduledAt).getTime()
  );

  // Only accelerate the NEXT item in sequence (not all at once)
  const next = pendingFromSameMeeting[0];
  const originalTime = next.item.scheduledAt;
  const delayMs = config.scheduler?.accelerationDelayMs || 300000; // 5 min default
  const newTime = new Date(Date.now() + delayMs).toISOString();

  // Don't accelerate if it's already due soon (within 2x the delay)
  const timeUntilOriginal = new Date(originalTime).getTime() - Date.now();
  if (timeUntilOriginal < delayMs * 2) {
    console.log(`[${nowIso()}] Schedule acceleration: "${(next.item.data?.task || next.item.data?.topic || "").substring(0, 60)}" already due in ${Math.round(timeUntilOriginal / 60000)}min, skipping`);
    return;
  }

  // Optionally run GLM readiness check
  if (config.scheduler?.glmReadinessCheck && process.env.ZAI_API_KEY) {
    // Fire async — don't block the completion flow
    checkGlmReadiness(completedJob, next).then(ready => {
      if (ready) {
        doAccelerate(next, originalTime, newTime, completedJob);
      } else {
        console.log(`[${nowIso()}] Schedule acceleration: GLM says "${(next.item.data?.task || "").substring(0, 60)}" not ready yet, keeping original schedule`);
      }
    }).catch(err => {
      console.log(`[${nowIso()}] Schedule acceleration: GLM check failed (${err.message}), accelerating anyway`);
      doAccelerate(next, originalTime, newTime, completedJob);
    });
    return;
  }

  doAccelerate(next, originalTime, newTime, completedJob);
}

function doAccelerate(next, originalTime, newTime, completedJob) {
  next.item.scheduledAt = newTime;
  next.item.acceleratedFrom = originalTime;
  next.item.acceleratedBy = completedJob.jobId;


  const savedHours = Math.round((new Date(originalTime).getTime() - new Date(newTime).getTime()) / 3600000 * 10) / 10;
  const taskDesc = (next.item.data?.task || next.item.data?.topic || "unknown").substring(0, 80);
  console.log(`[${nowIso()}] Schedule acceleration: "${taskDesc}" brought forward ${savedHours}h (was ${originalTime}, now ${newTime})`);

  // Emit SSE event
  if (config.sseEnabled) {
    jobEmitter.emit("schedule:accelerated", {
      scheduledItemId: next.id,
      type: next.item.type,
      originalTime,
      newTime,
      savedHours,
      acceleratedBy: completedJob.jobId,
      agent: completedJob.agent,
      task: taskDesc,
    });
  }
}

async function checkGlmReadiness(completedJob, nextItem) {
  const https = require("https");
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) return true; // No key = skip check, just accelerate

  const completedTask = completedJob.meetingAction?.task || completedJob.prompt?.substring(0, 500) || "unknown";
  const completedOutput = extractAssistantText(completedJob.parsedOutput)?.substring(0, 1000) || "completed successfully";
  const nextTask = nextItem.item.data?.task || nextItem.item.data?.topic || "unknown";

  const prompt = `A team of AI agents is working through a sequence of tasks from a meeting. The previous task just completed. Determine if the next task can start now.

COMPLETED TASK: ${completedTask}
RESULT SUMMARY: ${completedOutput}

NEXT TASK: ${nextTask}

Can the next task start now based on the completed result? Answer only YES or NO, then one sentence explaining why.`;

  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model: config.scheduler?.glmModel || "GLM-5",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0,
    });

    const url = new URL("https://api.z.ai/api/anthropic/v1/messages");
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(postData),
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const result = JSON.parse(body);
          const answer = result.content?.[0]?.text || "";
          const isReady = answer.trim().toUpperCase().startsWith("YES");
          console.log(`[${nowIso()}] GLM readiness check: ${isReady ? "READY" : "NOT READY"} — ${answer.substring(0, 100)}`);
          resolve(isReady);
        } catch (e) {
          resolve(true); // Parse error = assume ready
        }
      });
    });

    req.on("error", () => resolve(true));
    req.on("timeout", () => { req.destroy(); resolve(true); });
    req.write(postData);
    req.end();
  });
}

function tickScheduler() {
  const now = Date.now();
  for (const [id, item] of scheduledItems.entries()) {
    if (item.status === "done" || item.status === "cancelled") continue;
    const schedTime = new Date(item.scheduledAt).getTime();
    if (isNaN(schedTime) || schedTime > now) continue;

    // Time to execute
    console.log(`[${nowIso()}] Scheduler: firing ${item.type} "${(item.data?.topic || item.data?.task || "").substring(0, 60)}" (was scheduled for ${item.scheduledAt})`);

    if (item.type === "meeting") {
      // Dedup: skip if a meeting with same topic is already active
      const dup = checkMeetingDuplicate(item.data?.topic);
      if (dup.duplicate && dup.reason === "active") {
        console.log(`[${nowIso()}] Scheduler dedup: skipping "${item.data?.topic}" — already active as ${dup.existingId}`);
        item.status = "cancelled";
        item.cancelReason = `Duplicate of active meeting ${dup.existingId}`;
      
        continue;
      }

      // Create and start the meeting
      const d = item.data;
      // Resolve workingDir: explicit > product lookup > default
      let meetingWorkingDir = d.workingDir;
      if (!meetingWorkingDir && d.product) {
        const prod = products.get(d.product);
        if (prod && prod.workingDir) meetingWorkingDir = prod.workingDir;
      }
      // Normalize mode from stored data; default to "directed" (chair-based).
      const scheduledMode = normalizeMode(d.mode || "directed");
      const meeting = createMeeting({
        topic: d.topic,
        agents: d.agents || ["product-manager"],
        facilitator: d.facilitator || d.agents?.[0] || "product-manager",
        // Explicit chair only — selectChair() inside createMeeting applies smart default.
        chair: d.chair || null,
        mode: scheduledMode,
        roundRobin: true,
        autoDiscuss: true,
        maxRounds: d.maxRounds || 3,
        maxTurns: d.maxTurns || (scheduledMode === "roundRobin" ? 0 : 20),
        workingDir: meetingWorkingDir || DEFAULT_WORKING_DIR,
        telegram: d.telegram || null,
        callbackUrl: d.callbackUrl || N8N_CALLBACK_URL || null,
      });
      console.log(`[${nowIso()}] Scheduler: created meeting ${meeting.meetingId} topic="${meeting.topic}"`);
      const discussFn = meeting.mode === "chair" ? runChairDiscussion : runAutoDiscussion;
      discussFn(meeting).catch(err => {
        console.error(`[${nowIso()}] Scheduler: ${meeting.mode}-discussion error for ${meeting.meetingId}: ${err.message}`);
        meeting.status = "ended";
        meeting.endedAt = nowIso();
        meeting.summary = `Meeting ended due to error: ${err.message}`;
        db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));
      
      });
      item.status = "done";
      item.firedAt = nowIso();
      item.meetingId = meeting.meetingId;

    } else if (item.type === "job") {
      // Create and queue the job
      const d = item.data;
      // Resolve workingDir: explicit > product lookup > default
      let scheduledWorkingDir = d.workingDir;
      if (!scheduledWorkingDir && d.product) {
        const prod = products.get(d.product);
        if (prod && prod.workingDir) scheduledWorkingDir = prod.workingDir;
      }
      // Propagate meeting action context so closeMeetingJiraTask can transition
      // the [Meeting] subtask to Done after the scheduled job succeeds.
      let meetingAction = null;
      if (typeof item.source === "string" && item.source.startsWith("meeting:") && d.task) {
        meetingAction = {
          task: d.task,
          priority: d.priority || null,
          meetingId: item.source.slice("meeting:".length),
        };
      }
      const jobId = makeJobId();
      const logFile = path.join(LOG_DIR, `${jobId}.log`);
      const metaFile = path.join(LOG_DIR, `${jobId}.json`);
      const job = {
        jobId,
        status: "queued",
        mode: "agent",
        agent: d.agent,
        prompt: d.prompt,
        context: d.context || "",
        workingDir: scheduledWorkingDir || DEFAULT_WORKING_DIR,
        issueKey: d.issueKey || null,
        model: config.routing?.agentToModel?.[d.agent] || "sonnet",
        selectedModel: null,
        requestedProvider: null,
        callbackUrl: config.callbackUrl || null,
        logFile,
        metaFile,
        createdAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        pid: null,
        output: null,
        error: null,
        retryCount: 0,
        maxRetries: config.maxRetries || 3,
        source: item.source || "scheduler",
        scheduledItemId: id,
        meetingAction,
      };
      jobs.set(jobId, job);
      db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
      queue.push({ jobId });
      tickWorker();
      item.status = "done";
      item.firedAt = nowIso();
      item.jobId = jobId;
      console.log(`[${nowIso()}] Scheduler: queued job ${jobId} agent=${d.agent}`);

      if (config.sseEnabled) {
        jobEmitter.emit("job:queued", { jobId, agent: d.agent, source: item.source || "scheduler" });
      }
    }

  
  }
}
