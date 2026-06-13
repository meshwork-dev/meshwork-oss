// callbacks.js — callback queue with retry, failure alerts, notification webhooks
// Extracted from runner.js.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const {
  ALERT_SLACK_WEBHOOK,
  FAILED_CALLBACKS_DIR,
  RUNNER_PUBLIC_URL,
  SECRET,
  config,
} = require("./config");
const { jobEmitter } = require("./state");
const { appendLog, postJson } = require("./util");

// Function declarations are hoisted: exporting before requiring sibling
// modules keeps require cycles safe (each module's exports are complete
// before any sibling starts loading).
module.exports = {
  enqueueCallback,
  processCallbackQueue,
  sendCallbackDirect,
  sendCallbackWithRetry,
  sendFailureAlert,
  emitNotificationWebhook,
};


// Callback serialization queue
const callbackQueue = [];
let callbackProcessing = false;
const CALLBACK_DELAY_MS = 500; // 500ms between callbacks to avoid N8N SQLite WAL corruption

async function enqueueCallback(payload, callbackUrl, secret, job, maxAttempts) {
  return new Promise((resolve, reject) => {
    callbackQueue.push({ payload, callbackUrl, secret, job, maxAttempts, resolve, reject });
    console.log(`[callback-queue] Enqueued callback, queue depth: ${callbackQueue.length}`);
    processCallbackQueue();
  });
}

async function processCallbackQueue() {
  if (callbackProcessing || callbackQueue.length === 0) return;
  callbackProcessing = true;

  while (callbackQueue.length > 0) {
    const { payload, callbackUrl, secret, job, maxAttempts, resolve, reject } = callbackQueue.shift();
    try {
      const result = await sendCallbackDirect(callbackUrl, payload, job, maxAttempts);
      console.log(`[callback-queue] Sent callback, ${callbackQueue.length} remaining`);
      resolve(result);
    } catch (err) {
      console.log(`[callback-queue] Callback failed: ${err.message}, ${callbackQueue.length} remaining`);
      reject(err);
    }
    if (callbackQueue.length > 0) {
      await new Promise(r => setTimeout(r, CALLBACK_DELAY_MS));
    }
  }

  callbackProcessing = false;
}

async function sendCallbackDirect(url, payload, job, maxAttempts = 3) {
  const headers = {};
  if (SECRET) headers["X-Runner-Secret"] = SECRET;

  // Track per-attempt details for debugging
  const attemptDetails = [];
  let lastResponseStatus = null;

  // Try internal URL first if configured (faster, no ngrok dependency)
  const internalUrl = config.internalCallbackUrl;
  const urls = internalUrl ? [internalUrl, url] : [url];

  for (const targetUrl of urls) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await postJson(targetUrl, payload, headers);
        lastResponseStatus = resp.statusCode;
        attemptDetails.push({ at: new Date().toISOString(), url: targetUrl, attempt, status: resp.statusCode, error: null });
        appendLog(job.logFile, `[${new Date().toISOString()}] Callback response ${resp.statusCode} via ${targetUrl} (attempt ${attempt})\n`);
        if (resp.statusCode >= 200 && resp.statusCode < 500) {
          return { ok: true, statusCode: resp.statusCode, attempt, url: targetUrl };
        }
        // 5xx = retryable
        throw new Error(`Server error ${resp.statusCode}`);
      } catch (e) {
        attemptDetails.push({ at: new Date().toISOString(), url: targetUrl, attempt, status: lastResponseStatus, error: e.message });
        appendLog(job.logFile, `[${new Date().toISOString()}] Callback attempt ${attempt}/${maxAttempts} via ${targetUrl} failed: ${e.message}\n`);
        if (attempt < maxAttempts) {
          const delay = Math.pow(2, attempt) * 2000; // 4s, 8s
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    // If internal URL failed all attempts, fall back to external
    if (targetUrl === internalUrl) {
      appendLog(job.logFile, `[${new Date().toISOString()}] Internal callback failed, falling back to external: ${url}\n`);
    }
  }

  // Permanent failure — write to failed-callbacks for replay
  const failedId = `cb_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const failedFile = path.join(FAILED_CALLBACKS_DIR, `${failedId}.json`);

  // Truncate payload preview to 10KB for storage
  const payloadStr = JSON.stringify(payload);
  const payloadPreview = payloadStr.length > 10240 ? payloadStr.slice(0, 10240) + "...[truncated]" : payloadStr;

  const failedRecord = {
    id: failedId,
    url,
    payload,
    payloadPreview,
    jobId: job.jobId,
    agent: job.agent || null,
    issueKey: job.issueKey || null,
    failedAt: new Date().toISOString(),
    attempts: attemptDetails.length,
    attemptDetails,
    responseStatus: lastResponseStatus,
    error: attemptDetails.length > 0 ? attemptDetails[attemptDetails.length - 1].error : "unknown",
  };
  try {
    fs.writeFileSync(failedFile, JSON.stringify(failedRecord, null, 2), "utf8");
    appendLog(job.logFile, `[${new Date().toISOString()}] Callback permanently failed, saved to ${failedFile}\n`);
  } catch (writeErr) {
    appendLog(job.logFile, `[${new Date().toISOString()}] Failed to save failed callback: ${writeErr.message}\n`);
  }
  return { ok: false, failedId };
}

// Public wrapper — serializes through the queue to prevent concurrent N8N writes
async function sendCallbackWithRetry(url, payload, job, maxAttempts = 3) {
  return enqueueCallback(payload, url, SECRET, job, maxAttempts);
}

function sendFailureAlert(eventData) {
  if (!ALERT_SLACK_WEBHOOK) return;
  const text = `:rotating_light: *Job Failed*\n` +
    `*Job ID*: ${eventData.jobId}\n` +
    `*Agent*: ${eventData.agent || "none"}\n` +
    `*Issue*: ${eventData.issueKey || "none"}\n` +
    `*Error*: ${eventData.error || "unknown"}\n` +
    `*Log*: ${RUNNER_PUBLIC_URL}/jobs/${eventData.jobId}/log`;

  postJson(ALERT_SLACK_WEBHOOK, { text }).catch(e => {
    console.error(`[${new Date().toISOString()}] Alert webhook failed: ${e.message}`);
  });
}

jobEmitter.on("job:failed", (eventData) => {
  sendFailureAlert(eventData);
});

/**
 * Emit notification to outgoing webhook (Slack/Discord/Teams/custom)
 */
function emitNotificationWebhook(event, severity, title, body, link) {
  const webhookUrl = config.notifications?.webhookUrl;
  if (!webhookUrl) return;
  const payload = JSON.stringify({
    event, severity, title, body, link,
    timestamp: new Date().toISOString(),
  });
  try {
    const u = new URL(webhookUrl);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({
      method: "POST",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    });
    req.on("error", (e) => console.error(`[notifications] Webhook error: ${e.message}`));
    req.write(payload);
    req.end();
  } catch (e) {
    console.error(`[notifications] Webhook send failed: ${e.message}`);
  }
}
