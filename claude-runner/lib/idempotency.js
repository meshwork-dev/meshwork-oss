// idempotency.js — idempotency cache (dedup of repeated dispatches)
// Extracted from runner.js.

const fs = require("fs");
const db = require("../db");
const { IDEMPOTENCY_FILE, IDEMPOTENCY_TTL_HOURS } = require("./config");


function loadIdempotency() {
  try {
    if (!fs.existsSync(IDEMPOTENCY_FILE)) return {};
    return JSON.parse(fs.readFileSync(IDEMPOTENCY_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function saveIdempotency(store) {
  fs.writeFileSync(IDEMPOTENCY_FILE, JSON.stringify(store, null, 2), "utf8");
}

function pruneIdempotency(store) {
  const now = Date.now();
  const ttlMs = IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000;
  let changed = false;

  for (const [key, rec] of Object.entries(store)) {
    if (!rec || !rec.createdAt) {
      delete store[key];
      changed = true;
      continue;
    }
    if (now - rec.createdAt > ttlMs) {
      delete store[key];
      changed = true;
    }
  }

  if (changed) saveIdempotency(store);
}

let idempotencyStore = loadIdempotency();
pruneIdempotency(idempotencyStore);
// Also prune DB idempotency records (non-blocking, runs after DB init)
setImmediate(() => {
  db.idempotency.prune(IDEMPOTENCY_TTL_HOURS).catch(e => console.error('[db] idempotency startup prune failed: ' + e.message));
});

module.exports = {
  loadIdempotency,
  saveIdempotency,
  pruneIdempotency,
  idempotencyStore,
};
