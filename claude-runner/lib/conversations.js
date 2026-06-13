// conversations.js — conversation persistence and prompt formatting
// Extracted from runner.js.

const fs = require("fs");
const path = require("path");
const db = require("../db");
const { CONV_DIR, CONV_MAX_CHARS, CONV_TURNS } = require("./config");
const { safeKeyToFilename } = require("./util");


function convPath(conversationId) {
  return path.join(CONV_DIR, safeKeyToFilename(conversationId));
}

/**
 * Load conversation messages from PostgreSQL.
 * On a DB miss, checks for a legacy file at CONV_DIR and migrates it into the DB
 * (one-time per channel), then deletes the file.
 *
 * @param {string} conversationId
 * @returns {Promise<{conversationId: string, messages: Array}>}
 */
async function loadConversation(conversationId) {
  try {
    const turns = await db.conversations.load(conversationId);
    if (turns !== null) {
      return { conversationId, messages: turns };
    }

    // DB miss — check for a legacy file and migrate if found
    const legacyPath = convPath(conversationId);
    if (fs.existsSync(legacyPath)) {
      try {
        const obj = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
        const messages = Array.isArray(obj?.messages) ? obj.messages : [];
        await db.conversations.save(conversationId, messages, null);
        try { fs.unlinkSync(legacyPath); } catch (_) { /* best-effort delete */ }
        return { conversationId, messages };
      } catch (migErr) {
        console.warn(`[conv] Migration failed for ${conversationId}: ${migErr.message}`);
      }
    }

    return { conversationId, messages: [] };
  } catch (err) {
    console.warn(`[conv] loadConversation error for ${conversationId}: ${err.message}`);
    return { conversationId, messages: [] };
  }
}

/**
 * Save conversation messages to PostgreSQL only.
 * File-based writes no longer occur; CONV_DIR is only used for legacy migration.
 *
 * @param {string} conversationId
 * @param {Array} messages
 * @param {string|null} [productId]
 */
async function saveConversation(conversationId, messages, productId) {
  try {
    await db.conversations.save(conversationId, messages, productId || null);
  } catch (err) {
    console.error(`[conv] saveConversation error for ${conversationId}: ${err.message}`);
  }
}

function trimConversationMessages(messages) {
  // keep last N messages (turns) and cap total chars
  let trimmed = messages.slice(-Math.max(1, CONV_TURNS));
  let totalChars = trimmed.reduce((acc, m) => acc + (m?.content ? String(m.content).length : 0), 0);

  while (totalChars > CONV_MAX_CHARS && trimmed.length > 1) {
    const removed = trimmed.shift();
    totalChars -= removed?.content ? String(removed.content).length : 0;
  }

  return trimmed;
}

function formatConversationForPrompt(messages) {
  // simple readable transcript
  return messages
    .map((m) => {
      const role = m.role === "assistant" ? "Assistant" : "User";
      return `${role}: ${m.content}`;
    })
    .join("\n\n");
}

module.exports = {
  convPath,
  loadConversation,
  saveConversation,
  trimConversationMessages,
  formatConversationForPrompt,
};
