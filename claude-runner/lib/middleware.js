// middleware.js — Express middleware: secret auth, admission control, N8N health probe
// Extracted from runner.js.

const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { N8N_CALLBACK_URL, SECRET, config } = require("./config");
const { queue } = require("./state");
const { nowIso } = require("./util");


/**
 * Timing-safe secret comparison.
 * Both sides are hashed with sha256 first so length differences neither
 * throw in timingSafeEqual nor leak length information.
 */
function secretMatches(provided) {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const providedHash = crypto.createHash("sha256").update(provided).digest();
  const secretHash = crypto.createHash("sha256").update(String(SECRET)).digest();
  return crypto.timingSafeEqual(providedHash, secretHash);
}

/**
 * ADMISSION CONTROL middleware
 * Rejects new work with 429 once the in-memory queue reaches maxQueueDepth.
 * Concurrency caps only gate execution; without this the queue grows
 * unbounded under a flood of submissions. 0 disables the check.
 */
const MAX_QUEUE_DEPTH = Number(config.maxQueueDepth || 0);

function admissionControl(req, res, next) {
  if (MAX_QUEUE_DEPTH > 0 && queue.length >= MAX_QUEUE_DEPTH) {
    res.set("retry-after", "30");
    return res.status(429).json({
      ok: false,
      error: `Queue at capacity (${queue.length}/${MAX_QUEUE_DEPTH} queued). Retry later.`,
      status: "queue-full",
    });
  }
  return next();
}

/**
 * AUTH middleware
 * Accepts either:
 *   - X-Runner-Secret: <token>
 *   - Authorization: Bearer <token>
 */
function requireSecret(req, res, next) {
  const headerSecret = req.header("x-runner-secret");
  const authHeader = req.header("authorization");

  // Check X-Runner-Secret header
  if (secretMatches(headerSecret)) {
    return next();
  }

  // Check Authorization: Bearer <token>
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const bearerToken = authHeader.slice(7); // Remove "Bearer " prefix
    if (secretMatches(bearerToken)) {
      return next();
    }
  }

  return res.status(401).json({ ok: false, error: "unauthorized" });
}

/**
 * N8N HEALTH CHECK
 * Periodically checks if N8N is reachable. Tries internal Docker URL first, then external.
 */
const n8nHealth = { reachable: false, lastCheck: null, latencyMs: 0, url: null, internalReachable: false, externalReachable: false };
const N8N_INTERNAL_URL = config.internalCallbackUrl ? new URL(config.internalCallbackUrl).origin : "http://n8n:5678";
const N8N_EXTERNAL_URL = N8N_CALLBACK_URL ? (() => { try { return new URL(N8N_CALLBACK_URL).origin; } catch { return null; } })() : null;

async function checkN8NHealth() {
  const tryUrl = async (url) => {
    const start = Date.now();
    return new Promise((resolve) => {
      const mod = url.startsWith("https") ? https : http;
      const req = mod.get(url, { timeout: 5000 }, (resp) => {
        resp.resume();
        resolve({ ok: resp.statusCode < 500, latencyMs: Date.now() - start, url });
      });
      req.on("error", () => resolve({ ok: false, latencyMs: Date.now() - start, url }));
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, latencyMs: Date.now() - start, url }); });
    });
  };

  const internalResult = await tryUrl(N8N_INTERNAL_URL);
  n8nHealth.internalReachable = internalResult.ok;

  if (N8N_EXTERNAL_URL && N8N_EXTERNAL_URL !== N8N_INTERNAL_URL) {
    const externalResult = await tryUrl(N8N_EXTERNAL_URL);
    n8nHealth.externalReachable = externalResult.ok;
  }

  // Use internal if reachable, otherwise external
  const best = internalResult.ok ? internalResult : (n8nHealth.externalReachable ? { ok: true, latencyMs: 0, url: N8N_EXTERNAL_URL } : internalResult);
  n8nHealth.reachable = best.ok;
  n8nHealth.latencyMs = best.latencyMs;
  n8nHealth.url = best.url;
  n8nHealth.lastCheck = nowIso();
}

// Check N8N health on startup and every 60 seconds
checkN8NHealth();
setInterval(checkN8NHealth, 60000);

module.exports = {
  secretMatches,
  MAX_QUEUE_DEPTH,
  admissionControl,
  requireSecret,
  n8nHealth,
  N8N_INTERNAL_URL,
  N8N_EXTERNAL_URL,
  checkN8NHealth,
};
