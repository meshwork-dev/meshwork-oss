// lessons.js — LESSONS.md persistence (cross-job learning notes)
// Extracted from runner.js.

const fs = require("fs");
const { LESSONS_DIR, LESSONS_FILE, config } = require("./config");


function appendLesson(category, issueKey, text) {
  if (!config.lessons?.enabled || !text) return;
  try {
    fs.mkdirSync(LESSONS_DIR, { recursive: true });
    const entry = `\n## [${new Date().toISOString()}] ${category}${issueKey ? ` (${issueKey})` : ""}\n${String(text).trim()}\n`;
    let existing = "";
    try { existing = fs.readFileSync(LESSONS_FILE, "utf8"); } catch {}
    let combined = existing + entry;
    // Trim oldest entries when over budget — keep whole sections
    const maxChars = config.lessons.maxChars || 48000;
    if (combined.length > maxChars) {
      const cut = combined.length - maxChars;
      const nextSection = combined.indexOf("\n## ", cut);
      combined = nextSection >= 0 ? combined.slice(nextSection) : combined.slice(cut);
    }
    fs.writeFileSync(LESSONS_FILE, combined, "utf8");
  } catch (e) {
    console.warn(`[${new Date().toISOString()}] appendLesson failed: ${e.message}`);
  }
}

function readLessons(maxChars) {
  if (!config.lessons?.enabled) return "";
  try {
    const content = fs.readFileSync(LESSONS_FILE, "utf8");
    const cap = maxChars || config.lessons.promptChars || 4000;
    if (content.length <= cap) return content.trim();
    const cutAt = content.length - cap;
    const nextSection = content.indexOf("\n## ", cutAt);
    return (nextSection >= 0 ? content.slice(nextSection) : content.slice(cutAt)).trim();
  } catch {
    return "";
  }
}

module.exports = {
  appendLesson,
  readLessons,
};
