// integrations.js — routes for querying and saving integration settings
// (Jira, Telegram, N8N, Slack). Never returns raw secrets.

const http = require("http");
const https = require("https");
const { config } = require("../config");
const { requireSecret } = require("../middleware");
const { readConfig, writeConfig } = require("../pipeline-definitions");

const TIMEOUT_MS = Math.min(Number(config.outboundHttpTimeoutMs || 10000), 15000);

/**
 * Pick the right built-in module based on URL scheme.
 */
function modFor(url) {
  return url.startsWith("https") ? https : http;
}

/**
 * GET a URL and return { status, body }. Never throws on network errors —
 * resolves with an error property instead.
 */
function httpsGet(url) {
  return new Promise((resolve) => {
    try {
      const req = modFor(url).get(url, { timeout: TIMEOUT_MS }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      req.on("timeout", () => { req.destroy(); resolve({ status: null, body: null, error: "Request timed out" }); });
      req.on("error", (e) => resolve({ status: null, body: null, error: e.message }));
    } catch (e) {
      resolve({ status: null, body: null, error: e.message });
    }
  });
}

/**
 * POST JSON to a URL and return { status, body }. Never throws.
 */
function httpsPost(url, payload) {
  return new Promise((resolve) => {
    try {
      const body = JSON.stringify(payload);
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (url.startsWith("https") ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: TIMEOUT_MS,
      };
      const req = modFor(url).request(options, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      req.on("timeout", () => { req.destroy(); resolve({ status: null, body: null, error: "Request timed out" }); });
      req.on("error", (e) => resolve({ status: null, body: null, error: e.message }));
      req.write(body);
      req.end();
    } catch (e) {
      resolve({ status: null, body: null, error: e.message });
    }
  });
}

/**
 * GET a URL with Basic auth header. Never throws.
 */
function httpsGetBasicAuth(url, username, password) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "Authorization": "Basic " + Buffer.from(`${username}:${password}`).toString("base64"),
          "Accept": "application/json",
        },
        timeout: TIMEOUT_MS,
      };
      const req = modFor(url).request(options, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      req.on("timeout", () => { req.destroy(); resolve({ status: null, body: null, error: "Request timed out" }); });
      req.on("error", (e) => resolve({ status: null, body: null, error: e.message }));
      req.end();
    } catch (e) {
      resolve({ status: null, body: null, error: e.message });
    }
  });
}

function registerIntegrationRoutes(app) {
  /**
   * GET /api/integrations
   * Returns current status of each integration — never exposes raw secrets.
   */
  app.get("/api/integrations", requireSecret, (_req, res) => {
    // Read from config.json directly so this reflects saved values (not just in-memory state).
    let fileCfg = {};
    try { fileCfg = readConfig(); } catch (_) { /* file may not exist yet */ }

    // Also check environment variables for legacy configs
    const jiraDomain = fileCfg.jira?.domain || process.env.JIRA_DOMAIN || "";
    const jiraEmail = fileCfg.jira?.email || process.env.JIRA_EMAIL || "";
    const jiraHasToken = !!(fileCfg.jira?.apiToken || process.env.JIRA_API_TOKEN);

    const telegramHasToken = !!(fileCfg.telegram?.botToken || process.env.TELEGRAM_BOT_TOKEN);
    const telegramEnabled = !!(fileCfg.telegram?.enabled || process.env.TELEGRAM_BOT_TOKEN);

    const n8nCallbackUrl = fileCfg.callbackUrl || process.env.N8N_CALLBACK_URL || null;

    // Slack webhook URL is a non-secret capability URL — it can be shown
    // (it's used for capability, not auth), but we follow the pattern of
    // returning it so the form can be pre-filled.
    const slackWebhookUrl = fileCfg.alerting?.slackWebhookUrl || null;

    res.json({
      ok: true,
      integrations: {
        jira: {
          enabled: !!(jiraDomain && jiraEmail) || !!(fileCfg.integrations?.jira?.enabled),
          domain: jiraDomain || undefined,
          email: jiraEmail || undefined,
          hasToken: jiraHasToken,
        },
        telegram: {
          enabled: telegramEnabled,
          hasToken: telegramHasToken,
          chatId: fileCfg.telegram?.chatId || undefined,
        },
        n8n: {
          enabled: !!(n8nCallbackUrl) || !!(fileCfg.integrations?.n8n?.enabled),
          callbackUrl: n8nCallbackUrl || undefined,
        },
        slack: {
          enabled: !!(slackWebhookUrl) || !!(fileCfg.integrations?.slack?.enabled),
          webhookUrl: slackWebhookUrl || undefined,
        },
      },
    });
  });

  // ─── Jira ──────────────────────────────────────────────────────────────────

  /**
   * POST /api/integrations/jira/test
   * Body: { domain, email, apiToken }
   * Always returns HTTP 200. ok:false if test fails.
   */
  app.post("/api/integrations/jira/test", requireSecret, async (req, res) => {
    try {
      const { domain, email, apiToken } = req.body || {};
      if (!domain || !email || !apiToken) {
        return res.json({ ok: false, error: "domain, email, and apiToken are required" });
      }
      const url = `https://${domain}/rest/api/3/myself`;
      const result = await httpsGetBasicAuth(url, email, apiToken);
      if (result.error) {
        return res.json({ ok: false, error: result.error });
      }
      if (result.status !== 200) {
        return res.json({ ok: false, error: `Jira returned HTTP ${result.status}` });
      }
      let parsed;
      try { parsed = JSON.parse(result.body); } catch (_) {
        return res.json({ ok: false, error: "Unexpected response from Jira" });
      }
      return res.json({ ok: true, user: { displayName: parsed.displayName, emailAddress: parsed.emailAddress } });
    } catch (e) {
      return res.json({ ok: false, error: e.message });
    }
  });

  /**
   * POST /api/integrations/jira/save
   * Body: { domain, email, apiToken }
   */
  app.post("/api/integrations/jira/save", requireSecret, (req, res) => {
    try {
      const { domain, email, apiToken } = req.body || {};
      if (typeof domain !== "string" || !domain.trim()) return res.status(400).json({ ok: false, error: "domain is required" });
      if (typeof email !== "string" || !email.trim()) return res.status(400).json({ ok: false, error: "email is required" });
      if (typeof apiToken !== "string" || !apiToken.trim()) return res.status(400).json({ ok: false, error: "apiToken is required" });

      const cfg = readConfig();
      cfg.jira = { domain: domain.trim(), email: email.trim(), apiToken: apiToken.trim() };
      cfg.integrations = cfg.integrations || {};
      cfg.integrations.jira = cfg.integrations.jira || {};
      cfg.integrations.jira.enabled = true;
      writeConfig(cfg);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ─── Telegram ──────────────────────────────────────────────────────────────

  /**
   * POST /api/integrations/telegram/test
   * Body: { botToken }
   * Always returns HTTP 200. ok:false if test fails.
   */
  app.post("/api/integrations/telegram/test", requireSecret, async (req, res) => {
    try {
      const { botToken } = req.body || {};
      if (!botToken) {
        return res.json({ ok: false, error: "botToken is required" });
      }
      const url = `https://api.telegram.org/bot${botToken}/getMe`;
      const result = await httpsGet(url);
      if (result.error) {
        return res.json({ ok: false, error: result.error });
      }
      let parsed;
      try { parsed = JSON.parse(result.body); } catch (_) {
        return res.json({ ok: false, error: "Unexpected response from Telegram" });
      }
      if (!parsed.ok) {
        return res.json({ ok: false, error: parsed.description || "Telegram rejected the token" });
      }
      return res.json({ ok: true, bot: { username: parsed.result?.username, firstName: parsed.result?.first_name } });
    } catch (e) {
      return res.json({ ok: false, error: e.message });
    }
  });

  /**
   * POST /api/integrations/telegram/save
   * Body: { botToken, chatId? }
   */
  app.post("/api/integrations/telegram/save", requireSecret, (req, res) => {
    try {
      const { botToken, chatId } = req.body || {};
      if (typeof botToken !== "string" || !botToken.trim()) return res.status(400).json({ ok: false, error: "botToken is required" });

      const cfg = readConfig();
      cfg.telegram = { botToken: botToken.trim(), chatId: chatId || null, enabled: true };
      cfg.integrations = cfg.integrations || {};
      cfg.integrations.telegram = cfg.integrations.telegram || {};
      cfg.integrations.telegram.enabled = true;
      writeConfig(cfg);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ─── N8N ───────────────────────────────────────────────────────────────────

  /**
   * POST /api/integrations/n8n/test
   * Body: { callbackUrl }
   * Always returns HTTP 200. ok:false if test fails.
   */
  app.post("/api/integrations/n8n/test", requireSecret, async (req, res) => {
    try {
      const { callbackUrl } = req.body || {};
      if (!callbackUrl) {
        return res.json({ ok: false, error: "callbackUrl is required" });
      }
      // Any HTTP response (even non-200) means the host is reachable
      const result = await httpsGet(callbackUrl);
      if (result.error) {
        return res.json({ ok: false, error: result.error });
      }
      return res.json({ ok: true, reachable: true, status: result.status });
    } catch (e) {
      return res.json({ ok: false, error: e.message });
    }
  });

  /**
   * POST /api/integrations/n8n/save
   * Body: { callbackUrl }
   */
  app.post("/api/integrations/n8n/save", requireSecret, (req, res) => {
    try {
      const { callbackUrl } = req.body || {};
      if (typeof callbackUrl !== "string" || !callbackUrl.trim()) return res.status(400).json({ ok: false, error: "callbackUrl is required" });

      const cfg = readConfig();
      cfg.callbackUrl = callbackUrl.trim();
      cfg.integrations = cfg.integrations || {};
      cfg.integrations.n8n = cfg.integrations.n8n || {};
      cfg.integrations.n8n.enabled = true;
      writeConfig(cfg);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ─── Slack ─────────────────────────────────────────────────────────────────

  /**
   * POST /api/integrations/slack/test
   * Body: { webhookUrl }
   * Always returns HTTP 200. ok:false if test fails.
   */
  app.post("/api/integrations/slack/test", requireSecret, async (req, res) => {
    try {
      const { webhookUrl } = req.body || {};
      if (!webhookUrl) {
        return res.json({ ok: false, error: "webhookUrl is required" });
      }
      const result = await httpsPost(webhookUrl, { text: "Meshwork connection test ✓" });
      if (result.error) {
        return res.json({ ok: false, error: result.error });
      }
      if (result.status !== 200) {
        return res.json({ ok: false, error: `Slack returned HTTP ${result.status}: ${result.body}` });
      }
      return res.json({ ok: true });
    } catch (e) {
      return res.json({ ok: false, error: e.message });
    }
  });

  /**
   * POST /api/integrations/slack/save
   * Body: { webhookUrl }
   */
  app.post("/api/integrations/slack/save", requireSecret, (req, res) => {
    try {
      const { webhookUrl } = req.body || {};
      if (typeof webhookUrl !== "string" || !webhookUrl.trim()) return res.status(400).json({ ok: false, error: "webhookUrl is required" });

      const cfg = readConfig();
      cfg.alerting = cfg.alerting || {};
      cfg.alerting.slackWebhookUrl = webhookUrl.trim();
      cfg.integrations = cfg.integrations || {};
      cfg.integrations.slack = cfg.integrations.slack || {};
      cfg.integrations.slack.enabled = true;
      writeConfig(cfg);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { registerIntegrationRoutes };
