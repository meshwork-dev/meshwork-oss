// util.js — generic helpers (ids, timestamps, logging, HTTP JSON, file collection)
// Extracted from runner.js.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { signCallbackPayload } = require("./protocol");
const { OUTBOUND_HTTP_TIMEOUT_MS, SECRET } = require("./config");


/**
 * Read task progress from ~/.claude/tasks/<taskListId>/
 * Tasks are JSON files created by Claude Code's Tasks feature.
 * Returns structured progress info for cross-phase visibility.
 */
function readTaskProgress(taskListId) {
  if (!taskListId) return null;

  const tasksDir = path.join(os.homedir(), ".claude", "tasks", taskListId);

  if (!fs.existsSync(tasksDir)) {
    return { taskListId, found: false, tasks: [] };
  }

  try {
    const files = fs.readdirSync(tasksDir).filter(f => f.endsWith(".json")).sort();
    const tasks = [];

    for (const file of files) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(tasksDir, file), "utf8"));
        tasks.push({
          id: content.id,
          subject: content.subject,
          status: content.status,
          blockedBy: content.blockedBy || [],
          blocks: content.blocks || [],
        });
      } catch {}
    }

    const total = tasks.length;
    const completed = tasks.filter(t => t.status === "completed").length;
    const inProgress = tasks.filter(t => t.status === "in_progress").length;
    const pending = tasks.filter(t => t.status === "pending").length;

    return {
      taskListId,
      found: true,
      total,
      completed,
      inProgress,
      pending,
      progress: total > 0 ? Math.round((completed / total) * 100) : 0,
      tasks,
    };
  } catch {
    return { taskListId, found: false, tasks: [] };
  }
}

function truncateForLesson(text, max = 1500) {
  const s = String(text || "").trim();
  return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}

/**
 * Check if file sets overlap (for detecting conflicts)
 */
function filesOverlap(files1, files2) {
  if (!files1 || !files2 || files1.length === 0 || files2.length === 0) return false;

  for (const f1 of files1) {
    for (const f2 of files2) {
      // Exact match or one is a prefix of the other (directory check)
      if (f1 === f2 || f1.startsWith(f2 + "/") || f2.startsWith(f1 + "/")) {
        return true;
      }
    }
  }
  return false;
}

function nowIso() {
  return new Date().toISOString();
}

function makeJobId() {
  return `job_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

function appendLog(logFile, line) {
  fs.appendFileSync(logFile, line, { encoding: "utf8" });
}

/**
 * Conversation memory helpers
 */
function safeKeyToFilename(key) {
  // stable, filesystem-safe
  const h = crypto.createHash("sha1").update(String(key)).digest("hex");
  return `${h}.json`;
}

// ─── End Hybrid Team ─────────────────────────────────────────────────────────

/**
 * Collect files matching glob-like patterns from a directory.
 * Simple pattern matching without external dependencies.
 */
function collectFiles(dir, patterns, excludes, maxFiles) {
  const results = [];
  const excludeSet = new Set(excludes || []);

  function matchPattern(relPath, pattern) {
    // Exact match
    if (relPath === pattern) return true;
    // Simple glob: "*.ext" matches files ending with .ext
    if (pattern.startsWith("*.")) {
      return relPath.endsWith(pattern.slice(1));
    }
    // Directory glob: "dir/**/*.ext"
    if (pattern.includes("**")) {
      const parts = pattern.split("**");
      const prefix = parts[0].replace(/\/$/, "");
      const suffix = (parts[1] || "").replace(/^\//, "");
      const matchesPrefix = !prefix || relPath.startsWith(prefix + "/") || relPath.startsWith(prefix);
      if (!matchesPrefix) return false;
      if (!suffix) return true;
      // suffix like "/*.ts" → check extension
      if (suffix.startsWith("/*.") || suffix.startsWith("*.")) {
        const ext = suffix.replace(/^\/?\*/, "");
        return relPath.endsWith(ext);
      }
      return true;
    }
    return false;
  }

  function walk(currentDir, depth) {
    if (depth > 6 || results.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (excludeSet.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(dir, fullPath);

      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        for (const pat of patterns) {
          if (matchPattern(relPath, pat)) {
            results.push(fullPath);
            break;
          }
        }
      }
    }
  }

  walk(dir, 0);
  return results;
}

function postJson(urlStr, payload, headers = {}, timeoutMs = OUTBOUND_HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === "https:" ? https : http;

      const bodyStr = JSON.stringify(payload);
      const body = Buffer.from(bodyStr, "utf8");
      const sigHeaders = signCallbackPayload(bodyStr, SECRET);

      const req = lib.request(
        {
          method: "POST",
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + (u.search || ""),
          timeout: timeoutMs,
          headers: {
            "content-type": "application/json",
            "content-length": body.length,
            ...sigHeaders,
            ...headers,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (d) => (data += d.toString()));
          res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
        }
      );

      req.on("timeout", () => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${u.hostname}`));
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function getJson(urlStr, headers = {}, timeoutMs = OUTBOUND_HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === "https:" ? https : http;

      const req = lib.request(
        {
          method: "GET",
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + (u.search || ""),
          timeout: timeoutMs,
          headers: { accept: "application/json", ...headers },
        },
        (res) => {
          let data = "";
          res.on("data", (d) => (data += d.toString()));
          res.on("end", () => {
            let parsed = null;
            try { parsed = JSON.parse(data); } catch {}
            resolve({ statusCode: res.statusCode, body: data, json: parsed });
          });
        }
      );
      req.on("timeout", () => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${u.hostname}`));
      });
      req.on("error", reject);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = {
  readTaskProgress,
  truncateForLesson,
  filesOverlap,
  nowIso,
  makeJobId,
  appendLog,
  safeKeyToFilename,
  collectFiles,
  postJson,
  getJson,
};
