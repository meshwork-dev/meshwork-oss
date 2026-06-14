// provider-store.js — DB-backed provider config + encrypted API key storage
// Supports BYOK (Bring Your Own Key) for multi-provider LLM access.
// API keys are encrypted at rest using AES-256-GCM; the master key comes from
// the RUNNER_ENCRYPTION_KEY env var (32-byte hex).

const crypto = require("crypto");
const db = require("../db");
const { config } = require("./config");

const ALGORITHM = "aes-256-gcm";
const KEY_ENV = "RUNNER_ENCRYPTION_KEY";

function _getEncryptionKey() {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    // Fall back to a deterministic key derived from RUNNER_SECRET so existing
    // deployments don't break. Warn loudly in production.
    const fallback = process.env.RUNNER_SECRET || "insecure-fallback";
    if (process.env.NODE_ENV !== "test") {
      console.warn(`[provider-store] ${KEY_ENV} not set — deriving encryption key from RUNNER_SECRET. Set ${KEY_ENV} for production use.`);
    }
    return crypto.createHash("sha256").update(fallback).digest();
  }
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) throw new Error(`${KEY_ENV} must be 32 bytes (64 hex chars)`);
  return buf;
}

function encryptApiKey(plaintext) {
  const key = _getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([encrypted, tag]).toString("base64"),
    iv: iv.toString("base64"),
  };
}

function decryptApiKey(encryptedB64, ivB64) {
  const key = _getEncryptionKey();
  const iv = Buffer.from(ivB64, "base64");
  const data = Buffer.from(encryptedB64, "base64");
  const tag = data.slice(data.length - 16);
  const ciphertext = data.slice(0, data.length - 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

// ---------------------------------------------------------------------------
// Provider config CRUD
// ---------------------------------------------------------------------------

async function getProviders() {
  try {
    return await db.providers.list();
  } catch {
    return [];
  }
}

async function getProvider(id) {
  try {
    return await db.providers.get(id);
  } catch {
    return null;
  }
}

async function upsertProvider(providerData) {
  await db.providers.upsert(providerData);
}

async function deleteProvider(id) {
  await db.providers.delete(id);
}

// ---------------------------------------------------------------------------
// API key management
// ---------------------------------------------------------------------------

async function setProviderApiKey(providerId, plaintextKey) {
  const { encrypted, iv } = encryptApiKey(plaintextKey);
  await db.providers.setSecret(providerId, encrypted, iv);
}

async function getProviderApiKey(providerId) {
  const secret = await db.providers.getSecret(providerId);
  if (!secret) return null;
  try {
    return decryptApiKey(secret.encryptedKey, secret.iv);
  } catch (e) {
    console.error(`[provider-store] Failed to decrypt API key for ${providerId}: ${e.message}`);
    return null;
  }
}

async function hasProviderApiKey(providerId) {
  return db.providers.hasSecret(providerId);
}

// ---------------------------------------------------------------------------
// Agent routing overrides
// ---------------------------------------------------------------------------

async function getAgentRouting(agentName) {
  return db.agentRouting.get(agentName);
}

async function listAgentRouting() {
  return db.agentRouting.list();
}

async function upsertAgentRouting(routing) {
  await db.agentRouting.upsert(routing);
}

async function deleteAgentRouting(agentName) {
  await db.agentRouting.delete(agentName);
}

// ---------------------------------------------------------------------------
// Resolve effective provider config for a job (DB overrides file config)
// ---------------------------------------------------------------------------

async function resolveProviderConfig(providerId) {
  // 1. Try DB first
  const dbProvider = await getProvider(providerId);
  if (dbProvider) return dbProvider;

  // 2. Fall back to file-based config.providers
  const fileProvider = (config.providers || {})[providerId];
  if (fileProvider) return { ...fileProvider, id: providerId };

  return null;
}

/**
 * Get the decrypted API key for a provider, checking DB first then env vars.
 */
async function resolveApiKey(providerConfig) {
  if (!providerConfig) return null;
  const id = providerConfig.id;

  // 1. DB-stored encrypted key
  if (id) {
    const dbKey = await getProviderApiKey(id);
    if (dbKey) return dbKey;
  }

  // 2. Environment variable (legacy / fallback)
  const envVar = providerConfig.authTokenEnvVar;
  if (envVar && process.env[envVar]) return process.env[envVar];

  return null;
}

module.exports = {
  encryptApiKey,
  decryptApiKey,
  getProviders,
  getProvider,
  upsertProvider,
  deleteProvider,
  setProviderApiKey,
  getProviderApiKey,
  hasProviderApiKey,
  getAgentRouting,
  listAgentRouting,
  upsertAgentRouting,
  deleteAgentRouting,
  resolveProviderConfig,
  resolveApiKey,
};
