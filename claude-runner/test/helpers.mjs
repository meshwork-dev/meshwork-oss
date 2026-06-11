/**
 * Test harness helpers for the claude-runner integration suite.
 *
 * Requirements:
 *   - Docker must be available (a throwaway Postgres container is started, or
 *     an already-running one from a previous test invocation is reused).
 *   - Tests that need Docker skip gracefully with a clear message when it is
 *     not available.
 *
 * Design notes:
 *   - runner.js reads config from claude-runner/config.json (next to runner.js).
 *     The harness writes a temporary test config there for the lifetime of the
 *     suite; any pre-existing config.json is backed up and restored on teardown.
 *   - Jobs never invoke the real Claude CLI: config.claude.command points at a
 *     stub shell script that exits 1 immediately, and HOME is redirected to an
 *     empty temp dir so no real ~/.claude credentials are read or refreshed.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RUNNER_DIR = path.resolve(__dirname, "..");
export const SECRET = "test-secret-12345";

const PG_CONTAINER = process.env.TEST_PG_CONTAINER || "meshwork-runner-test-pg";
const PG_IMAGE = process.env.TEST_PG_IMAGE || "postgres:16-alpine";

const require = createRequire(import.meta.url);

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 120000, ...opts });
}

export function dockerAvailable() {
  try {
    sh("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: ["ignore", "pipe", "ignore"], timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start (or reuse) a throwaway Postgres container and create a fresh database
 * for this suite run. Returns { host, port, user, password, database }.
 */
export async function ensurePostgres() {
  let running = false;
  try {
    running = sh("docker", ["inspect", "-f", "{{.State.Running}}", PG_CONTAINER], { stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    running = false;
  }

  if (!running) {
    try {
      sh("docker", ["rm", "-f", PG_CONTAINER], { stdio: "ignore" });
    } catch { /* didn't exist */ }
    // 127.0.0.1:0 -> Docker picks a free host port. First run may pull the image.
    sh(
      "docker",
      ["run", "-d", "--rm", "--name", PG_CONTAINER,
        "-p", "127.0.0.1:0:5432", "-e", "POSTGRES_PASSWORD=test", PG_IMAGE],
      { timeout: 300000 }
    );
  }

  // Discover the mapped host port
  let port = null;
  for (let i = 0; i < 20 && !port; i++) {
    try {
      const out = sh("docker", ["port", PG_CONTAINER, "5432/tcp"]);
      const m = out.match(/:(\d+)\s*$/m);
      if (m) port = parseInt(m[1], 10);
    } catch { /* retry */ }
    if (!port) await sleep(250);
  }
  if (!port) throw new Error(`Could not determine mapped port for container ${PG_CONTAINER}`);

  // Wait for Postgres to accept queries (it restarts once during first init,
  // so require a few consecutive successes).
  const deadline = Date.now() + 90000;
  let successes = 0;
  while (successes < 2) {
    try {
      sh("docker", ["exec", PG_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-c", "SELECT 1"], { stdio: "ignore" });
      successes++;
    } catch {
      successes = 0;
      if (Date.now() > deadline) throw new Error("Timed out waiting for test Postgres to become ready");
    }
    await sleep(successes ? 300 : 700);
  }

  const database = `runner_test_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
  sh("docker", ["exec", PG_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-c", `CREATE DATABASE ${database}`]);

  return { host: "127.0.0.1", port, user: "postgres", password: "test", database };
}

export function dropDatabase(dbCfg) {
  try {
    sh("docker", ["exec", PG_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-c",
      `DROP DATABASE IF EXISTS ${dbCfg.database} WITH (FORCE)`]);
  } catch { /* best effort */ }
}

/** Direct SQL access to the test database from the test process. */
export async function pgClient(dbCfg) {
  const { Client } = require("pg");
  const client = new Client({
    host: dbCfg.host,
    port: dbCfg.port,
    user: dbCfg.user,
    password: dbCfg.password,
    database: dbCfg.database,
  });
  await client.connect();
  return client;
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * Create the temp workspace used by a runner instance:
 *   - allowed working-dir root (+ a sibling dir outside it for negative tests)
 *   - log dir, fake HOME, and the stub "claude" CLI that exits immediately.
 */
export function makeWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "meshwork-runner-test-"));
  const ws = {
    base,
    home: path.join(base, "home"),
    logs: path.join(base, "logs"),
    allowedRoot: path.join(base, "allowed"),
    insideAllowed: path.join(base, "allowed", "project"),
    outside: path.join(base, "outside"),
    stub: path.join(base, "fake-claude"),
  };
  for (const dir of [ws.home, ws.logs, ws.allowedRoot, ws.insideAllowed, ws.outside]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Stub CLI: never the real Claude binary; fails fast for any invocation.
  fs.writeFileSync(ws.stub, "#!/bin/sh\necho 'stub-claude: refusing to run in tests' >&2\nexit 1\n");
  fs.chmodSync(ws.stub, 0o755);
  return ws;
}

export function removeWorkspace(ws) {
  try { fs.rmSync(ws.base, { recursive: true, force: true }); } catch { /* best effort */ }
}

const CONFIG_PATH = path.join(RUNNER_DIR, "config.json");
const CONFIG_BACKUP = path.join(RUNNER_DIR, "config.json.test-backup");
let configWasBackedUp = false;
let configExisted = false;

/** Write the temporary test config.json (backing up any real one). */
export function writeTestConfig(port, ws) {
  if (!configWasBackedUp) {
    configExisted = fs.existsSync(CONFIG_PATH);
    if (configExisted) fs.copyFileSync(CONFIG_PATH, CONFIG_BACKUP);
    configWasBackedUp = true;
  }
  const cfg = {
    _testConfig: true,
    port,
    host: "127.0.0.1",
    jobTimeoutMinutes: 1,
    maxRetries: 0,
    allowedRoots: [ws.allowedRoot],
    logDir: ws.logs,
    workingDir: ws.allowedRoot,
    claude: { command: ws.stub },
    integrations: { n8n: { enabled: false } },
    agentLabelReconciler: { enabled: false },
    qualityGate: { enabled: false },
    subtasks: { enabled: false },
    chrome: { enabled: false },
    fixLoop: { enabled: false },
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function restoreConfig() {
  if (!configWasBackedUp) return;
  if (configExisted && fs.existsSync(CONFIG_BACKUP)) {
    fs.copyFileSync(CONFIG_BACKUP, CONFIG_PATH);
    fs.rmSync(CONFIG_BACKUP, { force: true });
  } else {
    fs.rmSync(CONFIG_PATH, { force: true });
  }
  configWasBackedUp = false;
}

/**
 * Spawn `node runner.js` against the test Postgres and wait until both the
 * HTTP server and the DB-backed routes are ready.
 */
export async function startRunner(dbCfg, ws, { port } = {}) {
  const runnerPort = port || (await freePort());
  writeTestConfig(runnerPort, ws);

  const env = { ...process.env };
  // Make sure nothing from the developer's environment leaks into the runner.
  for (const k of Object.keys(env)) {
    if (/^(JIRA_|TELEGRAM_|SLACK_|N8N_|ANTHROPIC_)/.test(k)) delete env[k];
  }
  delete env.RETENTION_DAYS;
  delete env.DEFAULT_WORKING_DIR;
  Object.assign(env, {
    RUNNER_SECRET: SECRET,
    RUNNER_DB_HOST: dbCfg.host,
    RUNNER_DB_PORT: String(dbCfg.port),
    RUNNER_DB_NAME: dbCfg.database,
    RUNNER_DB_USER: dbCfg.user,
    RUNNER_DB_PASSWORD: dbCfg.password,
    HOME: ws.home, // never touch the real ~/.claude credentials
  });

  const child = spawn(process.execPath, ["runner.js"], {
    cwd: RUNNER_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => { logs += d.toString(); });
  child.stderr.on("data", (d) => { logs += d.toString(); });
  let exited = false;
  child.on("exit", () => { exited = true; });

  const base = `http://127.0.0.1:${runnerPort}`;
  const deadline = Date.now() + 60000;
  let ready = false;
  while (!ready) {
    if (exited) throw new Error(`runner exited during startup. Logs:\n${logs.slice(-4000)}`);
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`runner did not become ready in time. Logs:\n${logs.slice(-4000)}`);
    }
    try {
      const h = await fetch(`${base}/health`);
      if (h.ok) {
        // /health responds before DB init completes — probe a DB-backed route too.
        const r = await fetch(`${base}/api/issues?limit=1`, { headers: { "x-runner-secret": SECRET } });
        if (r.status === 200) ready = true;
      }
    } catch { /* not up yet */ }
    if (!ready) await sleep(300);
  }

  return {
    child,
    port: runnerPort,
    base,
    getLogs: () => logs,
    async stop(signal = "SIGKILL") {
      if (exited) return;
      const done = new Promise((r) => child.on("exit", r));
      child.kill(signal);
      await Promise.race([done, sleep(5000)]);
      if (!exited) child.kill("SIGKILL");
    },
  };
}

/** Small JSON-over-HTTP helper. */
export async function api(base, method, p, { body, headers } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

export function authHeaders() {
  return { "x-runner-secret": SECRET };
}

/** Poll fn() until it returns truthy or the timeout elapses. */
export async function waitFor(fn, { timeoutMs = 20000, intervalMs = 300, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}
