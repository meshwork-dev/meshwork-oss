// oauth.js — Claude OAuth credential cache, refresh, and spawn environment
// Extracted from runner.js.

const fs = require("fs");
const https = require("https");
const path = require("path");
const { spawn } = require("child_process");
const { config } = require("./config");
const { appendLog, nowIso } = require("./util");

// Cached default provider ID, loaded from DB at startup and refreshed when set
let _defaultProvider = null;
function getDefaultProvider() { return _defaultProvider; }
async function loadDefaultProvider() {
  try {
    const db = require("../db");
    _defaultProvider = await db.providers.getDefault();
  } catch (_) { /* DB not ready yet — will use config fallback */ }
}
function setDefaultProviderCache(id) { _defaultProvider = id; }

/**
 * OAuth credential cache — read from .credentials.json (bind-mounted from host).
 * On macOS, Claude CLI stores OAuth in Keychain; Docker containers can't access Keychain,
 * so we read from a synced file and inject tokens as env vars into spawned processes.
 * The host-side sync-auth.sh script writes Keychain → .credentials.json periodically.
 */
let _oauthCache = { accessToken: null, refreshToken: null, expiresAt: 0, lastRead: 0 };
const OAUTH_CACHE_TTL_MS = 30_000; // Re-read file every 30s at most

function getOAuthEnvVars() {
  const now = Date.now();

  // Return cached values if fresh
  if (_oauthCache.accessToken && now - _oauthCache.lastRead < OAUTH_CACHE_TTL_MS && _oauthCache.expiresAt > now + 60_000) {
    return {
      CLAUDE_CODE_OAUTH_TOKEN: _oauthCache.accessToken,
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: _oauthCache.refreshToken || "",
    };
  }

  // Read from .credentials.json
  const homeDir = process.env.HOME || "/home/node";
  const credFile = path.join(homeDir, ".claude", ".credentials.json");
  try {
    if (!fs.existsSync(credFile)) return {};
    const creds = JSON.parse(fs.readFileSync(credFile, "utf8"));
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) return {};

    _oauthCache = {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken || null,
      expiresAt: oauth.expiresAt || 0,
      lastRead: now,
    };

    // If token expires within 5 min, attempt refresh
    if (oauth.expiresAt && oauth.expiresAt - now < 5 * 60 * 1000 && oauth.refreshToken) {
      console.log(`[${nowIso()}] OAuth token near expiry (${Math.round((oauth.expiresAt - now) / 60000)}min left) — refreshing`);
      refreshOAuthToken(oauth.refreshToken).then((result) => {
        if (result) {
          _oauthCache.accessToken = result.access_token;
          _oauthCache.expiresAt = now + result.expires_in * 1000;
          if (result.refresh_token) _oauthCache.refreshToken = result.refresh_token;
          // Write back to file so other processes and future restarts get the fresh token
          try {
            const updated = { claudeAiOauth: { ...oauth, accessToken: result.access_token, expiresAt: _oauthCache.expiresAt } };
            if (result.refresh_token) updated.claudeAiOauth.refreshToken = result.refresh_token;
            fs.writeFileSync(credFile, JSON.stringify(updated, null, 2), "utf8");
            console.log(`[${nowIso()}] OAuth token refreshed and written to ${credFile}`);
          } catch (e) {
            console.error(`[${nowIso()}] Failed to write refreshed token: ${e.message}`);
          }
        }
      }).catch(() => {});
    }

    return {
      CLAUDE_CODE_OAUTH_TOKEN: _oauthCache.accessToken,
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: _oauthCache.refreshToken || "",
    };
  } catch (e) {
    console.error(`[${nowIso()}] Failed to read OAuth credentials: ${e.message}`);
    return {};
  }
}

/**
 * Determine whether a provider should use API key auth instead of OAuth.
 * - "oauth"   → always OAuth
 * - "api-key" → always API key
 * - "auto"    → use API key if the named env var is set, otherwise OAuth
 */
function isApiKeyMode(providerConfig) {
  const mode = providerConfig?.authMode || "auto";
  if (mode === "oauth")    return false;
  if (mode === "api-key")  return true;
  return Boolean(process.env[providerConfig?.authTokenEnvVar || "ANTHROPIC_API_KEY"]);
}

/**
 * Get spawn environment based on provider routing.
 * - claude-cli providers: inject OAuth tokens unless API key mode is active
 * - Non-claude-cli providers (openai, gemini, etc.): handled by llm-direct.js; env not used
 * - Anthropic-compatible providers with baseUrl (z.ai): set ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
 */
function getSpawnEnv(job) {
  const routing = config.routing || {};
  const providers = config.providers || {};
  const agentToProvider = routing.agentToProvider || {};

  // Provider priority: explicit job request > agent routing > DB default > config default > "claude"
  const systemDefault = _defaultProvider || config.defaultProvider || "claude";
  const provider = job.requestedProvider || agentToProvider[job.agent] || systemDefault;
  const providerConfig = providers[provider] || providers[systemDefault] || providers.claude;
  const providerType = providerConfig?.type || "claude-cli";

  const env = { ...process.env };

  if (providerType === "claude-cli") {
    if (!isApiKeyMode(providerConfig)) {
      // OAuth mode: inject token env vars so Claude CLI can authenticate
      Object.assign(env, getOAuthEnvVars());
    }
    // For Anthropic-compatible base URL providers (z.ai, etc.)
    if (providerConfig?.baseUrl) {
      env.ANTHROPIC_BASE_URL = providerConfig.baseUrl;
      const apiKey = process.env[providerConfig.authTokenEnvVar];
      if (apiKey) {
        env.ANTHROPIC_AUTH_TOKEN = apiKey;
      }
      if (providerConfig.timeoutMs) {
        env.API_TIMEOUT_MS = String(providerConfig.timeoutMs);
      }
      if (provider !== "claude") {
        console.log(`[getSpawnEnv] Provider routing: agent=${job.agent}, provider=${provider}, baseUrl=${providerConfig.baseUrl}`);
      }
    }
  }

  return { env, provider, providerConfig };
}

/**
 * Pre-flight auth check using `claude auth status`.
 * Detects expired/missing auth before wasting a job attempt.
 * Also attempts token refresh via Anthropic's OAuth endpoint if token is near expiry.
 */
async function ensureOAuthValid(job) {
  // Skip OAuth check when the provider uses API key auth
  const providers = config.providers || {};
  const routing = config.routing || {};
  const agentToProvider = routing.agentToProvider || {};
  const systemDefault = _defaultProvider || config.defaultProvider || "claude";
  const provider = job.requestedProvider || agentToProvider[job.agent] || systemDefault;
  const providerConfig = providers[provider] || providers.claude;
  if (isApiKeyMode(providerConfig)) return true;

  // 1. Fast check: inspect credentials file for token expiry
  const homeDir = process.env.HOME || "/home/node";
  const credFile = path.join(homeDir, ".claude", ".credentials.json");

  try {
    if (fs.existsSync(credFile)) {
      const creds = JSON.parse(fs.readFileSync(credFile, "utf8"));
      const oauth = creds.claudeAiOauth;
      if (oauth?.expiresAt) {
        const remainingMs = oauth.expiresAt - Date.now();
        const remainingMin = Math.round(remainingMs / 60000);

        if (remainingMs > 5 * 60 * 1000) {
          return true; // Token valid for >5 minutes
        }

        appendLog(job.logFile, `[${nowIso()}] OAuth token expires in ${remainingMin}min — attempting refresh\n`);

        // Attempt refresh using the refresh token
        if (oauth.refreshToken) {
          const refreshResult = await refreshOAuthToken(oauth.refreshToken);
          if (refreshResult) {
            creds.claudeAiOauth.accessToken = refreshResult.access_token;
            creds.claudeAiOauth.expiresAt = Date.now() + (refreshResult.expires_in * 1000);
            if (refreshResult.refresh_token) {
              creds.claudeAiOauth.refreshToken = refreshResult.refresh_token;
            }
            fs.writeFileSync(credFile, JSON.stringify(creds, null, 2), "utf8");
            appendLog(job.logFile, `[${nowIso()}] OAuth token refreshed — new expiry in ${Math.round(refreshResult.expires_in / 60)}min\n`);
            console.log(`[${nowIso()}] OAuth token refreshed for job ${job.jobId}`);
            return true;
          }
        }
      }
    }

    // 2. Fallback: run `claude auth status` to check if CLI thinks it's logged in
    return new Promise((resolve) => {
      const child = spawn(config.claude.command || "claude", ["auth", "status"], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...getOAuthEnvVars() },
        timeout: 10000,
      });

      let stdout = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.on("close", (code) => {
        try {
          const status = JSON.parse(stdout);
          if (status.loggedIn) {
            return resolve(true);
          }
          appendLog(job.logFile, `[${nowIso()}] WARNING: claude auth status reports not logged in\n`);
          console.error(`[${nowIso()}] Auth check failed: not logged in. Run 'claude' then '/login' from the project.`);
          resolve(false);
        } catch {
          // Non-JSON output or parse error
          resolve(code === 0);
        }
      });
      child.on("error", () => resolve(false));
    });
  } catch (e) {
    console.error(`[${nowIso()}] OAuth check error:`, e.message);
    return false;
  }
}

/**
 * Refresh an OAuth token using Anthropic's token endpoint.
 * Returns { access_token, expires_in, refresh_token } or null on failure.
 */
function refreshOAuthToken(refreshToken) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    });

    const req = https.request({
      hostname: "platform.claude.com",
      path: "/v1/oauth/token",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
      timeout: 10000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        } else {
          console.error(`[${nowIso()}] OAuth refresh failed: ${res.statusCode} ${data.substring(0, 200)}`);
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

module.exports = {
  _oauthCache,
  OAUTH_CACHE_TTL_MS,
  getOAuthEnvVars,
  getSpawnEnv,
  isApiKeyMode,
  ensureOAuthValid,
  refreshOAuthToken,
  loadDefaultProvider,
  setDefaultProviderCache,
};
