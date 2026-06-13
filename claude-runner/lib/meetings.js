// meetings.js — agent meeting engine: gating, prompts, chair discussion, outcomes, dispatch
// Extracted from runner.js.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const db = require("../db");
const { DEFAULT_WORKING_DIR, LOG_DIR, N8N_CALLBACK_URL, SECRET, config } = require("./config");
const { jiraRestGet, jiraRestPut, transitionIssueToInProgress } = require("./jira");
const { checkBudget } = require("./metrics");
const { pushFallbackModel, selectModel } = require("./models");
const { getOAuthEnvVars } = require("./oauth");
const {
  applyProductPluginDir,
  products,
  resolveConfluenceSpace,
  resolveJiraProject,
  resolvePluginDir,
  resolvePluginDirs,
  resolveProduct,
  resolveProductFromTelegramChat,
} = require("./products");
const { jobEmitter, jobs, meetings, queue, scheduledItems } = require("./state");
const { getJson, makeJobId, nowIso, postJson } = require("./util");

// Function declarations are hoisted: exporting before requiring sibling
// modules keeps require cycles safe (each module's exports are complete
// before any sibling starts loading).
module.exports = {
  normalizeMode,
  selectChair,
  normalizeTopic,
  getActiveMeetingSchedule,
  checkMeetingDuplicate,
  detectGateIntent,
  detectGateIntentForMeeting,
  detectImplicitGateNeed,
  judgeBorderlineGate,
  createMeeting,
  getMeetingTranscriptText,
  getMeetingProductContext,
  buildMeetingPrompt,
  buildOutcomesPrompt,
  fetchMeetingContext,
  postMeetingOutcomes,
  sendMeetingCallback,
  runAutoDiscussion,
  buildChairPrompt,
  buildCalledAgentPrompt,
  buildHandRaisePrompt,
  parseHandRaiseResponses,
  runHandRaiseRound,
  parseChairDirectives,
  runChairDiscussion,
  generateAndFinalizeOutcomes,
  isMeetingTopicEcho,
  dispatchMeetingActions,
  runMeetingAgentTurn,
  closeMeetingJiraTask,
  quarantineMeetingCreatedIssues,
  unquarantineMeetingCreatedIssues,
  clearMeetingQuarantineOnly,
};

const { parseScheduleTime, scheduleItem } = require("./scheduler");
const { tickWorker } = require("./worker");


/**
 * Normalize meeting mode values to canonical internal strings.
 * Accepts both public aliases ("directed", "serial") and legacy values ("chair", "roundRobin").
 *   "directed"   → "chair"      (chair-based, agent called by chair)
 *   "serial"     → "roundRobin" (every agent speaks each round)
 * Unknown values default to "chair".
 */
function normalizeMode(mode) {
  if (!mode) return "chair";
  switch (mode) {
    case "directed": return "chair";
    case "serial":   return "roundRobin";
    case "chair":    return "chair";
    case "roundRobin": return "roundRobin";
    default:
      console.warn(`[normalizeMode] Unknown meeting mode "${mode}", defaulting to "chair"`);
      return "chair";
  }
}

/**
 * Select the best chair agent from a participants list.
 * Prefers "product-manager" if present; falls back to explicit chair arg,
 * then to the first participant, then to "product-manager" as a hardcoded default.
 */
function selectChair(agents, explicitChair) {
  if (explicitChair) return explicitChair;
  if (agents && agents.includes("product-manager")) return "product-manager";
  return (agents && agents[0]) || "product-manager";
}

/**
 * Normalize a meeting topic for dedup comparison.
 * Strips dates, whitespace, punctuation, and lowercases.
 */
function normalizeTopic(topic) {
  return (topic || "")
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}/g, "")   // strip ISO dates
    .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, "") // strip DD/MM/YYYY
    .replace(/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check if a meeting with a similar topic is already active or scheduled.
 * Returns { duplicate: true, reason, existingId } or { duplicate: false }.
 */
/**
 * Build a human-readable summary of active and scheduled meetings.
 * Agents use this to avoid proposing duplicate meetings.
 */
function getActiveMeetingSchedule() {
  const lines = [];

  // Active meetings
  for (const [id, m] of meetings.entries()) {
    if (m.status === "ended") continue;
    lines.push(`- [ACTIVE] "${m.topic}" (agents: ${m.agents.join(", ")}, started: ${m.createdAt})`);
  }

  // Pending scheduled meetings
  for (const [id, item] of scheduledItems.entries()) {
    if (item.type !== "meeting") continue;
    if (item.status === "done" || item.status === "cancelled") continue;
    const d = item.data || {};
    lines.push(`- [SCHEDULED ${item.scheduledAt}] "${d.topic || "unknown"}" (agents: ${(d.agents || []).join(", ")})`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function checkMeetingDuplicate(topic) {
  const normalizedTopic = normalizeTopic(topic);
  if (!normalizedTopic) return { duplicate: false };

  // Check active meetings (not ended)
  for (const [id, m] of meetings.entries()) {
    if (m.status === "ended") continue;
    const existingNorm = normalizeTopic(m.topic);
    if (existingNorm === normalizedTopic) {
      return { duplicate: true, reason: "active", existingId: id, existingTopic: m.topic };
    }
  }

  // Check pending scheduled meetings
  for (const [id, item] of scheduledItems.entries()) {
    if (item.type !== "meeting") continue;
    if (item.status === "done" || item.status === "cancelled") continue;
    const existingNorm = normalizeTopic(item.data?.topic);
    if (existingNorm === normalizedTopic) {
      return { duplicate: true, reason: "scheduled", existingId: id, existingTopic: item.data?.topic, scheduledAt: item.scheduledAt };
    }
  }

  return { duplicate: false };
}

// Detects user requests for a human-in-the-loop gate.
// Deterministic source of truth — runs against the topic AND any user-injected transcript turns.
// Patterns require first-person framing or explicit "any/all/the" determiners to avoid false
// positives on benign meeting topics ("talk through approach before writing tests").
const GATE_INTENT_RE = /(prompt me|ask me first|don'?t (?:write|create|make|do|dispatch)(?: any| anything| yet|\b)|wait for (?:me|my (?:input|approval|decision|sign[- ]?off|review))|before (?:you )?(?:writ(?:e|ing)|creat(?:e|ing)|mak(?:e|ing)|dispatch(?:ing)?) (?:any|all|anything)\b|present (?:me )?(?:the )?options(?: to me)?|let me (?:see|review|decide|weigh|choose|approve)|nothing yet|hold (?:off|on)|check with me|discuss with me first|gate (?:before|on)|approval (?:before|first|required)|i (?:want to|need to|will) (?:approve|review|decide))/i;

function detectGateIntent(text) {
  if (!text) return false;
  return GATE_INTENT_RE.test(String(text).toLowerCase());
}

// Re-scan a meeting at outcomes time. Belt-and-braces fallback in case the in-memory
// gateBeforeDispatch flag was lost (DB reload, restart, alternate creation path).
// Checks: explicit flag, topic, AND any human/user turns in the transcript.
function detectGateIntentForMeeting(meeting) {
  if (meeting.gateBeforeDispatch === true) return { gated: true, source: "flag" };
  if (detectGateIntent(meeting.topic)) return { gated: true, source: "topic" };
  for (const turn of meeting.transcript || []) {
    const role = (turn.role || turn.speaker || "").toLowerCase();
    const isHuman = role === "user" || role === "human" || role === "mark" || turn.fromUser === true;
    if (!isHuman) continue;
    const txt = turn.content || turn.text || turn.message || "";
    if (detectGateIntent(txt)) return { gated: true, source: "transcript" };
  }
  return { gated: false, source: null };
}

// Implicit gate detection: pause for human input when the meeting outcome shows
// signals that warrant review even if the user never asked for it explicitly.
// Cheap, deterministic rules over the generated outcomes summary. Returns a gate
// result on first matching rule, or null if nothing fires.
function detectImplicitGateNeed(meeting, summary) {
  if (!summary || typeof summary !== "string") return null;
  const reasons = [];

  // 1. New stories / epics proposed in bulk
  // (no m-flag here — we want $ to mean end-of-string, not end-of-line, so the
  // lazy [\s\S]*? doesn't terminate immediately at the heading's own newline)
  let storyCount = 0;
  const storyHeading = summary.match(/##+\s*(?:new\s+)?(?:stories|epics)\b[\s\S]*?(?=\n##|$)/i);
  if (storyHeading) {
    storyCount = (storyHeading[0].match(/^\s*[-*]\s+/gm) || []).length;
  }
  const createStoryMentions = (summary.match(/\bcreate\s+(?:a\s+|new\s+|several\s+|multiple\s+)?(?:story|stories|epic|epics)\b/gi) || []).length;
  const totalNewStories = Math.max(storyCount, createStoryMentions);
  const storyThreshold = config.meetings?.implicitGateStoryThreshold ?? 3;
  if (totalNewStories > storyThreshold) reasons.push(`stories>${storyThreshold}(${totalNewStories})`);

  // 2. Schema / migration / DB structural change
  if (/\b(schema\s+(?:change|migration)|database\s+migration|alter\s+table|drop\s+table|drop\s+column|add\s+column|new\s+migration|prisma\s+migrate|knex\s+migrate)\b/i.test(summary)) {
    reasons.push("schema/migration");
  }

  // 3. Multi-product touch (more than one Jira project key or product name)
  // Derives keys/names dynamically from the registered products map so any
  // deployment's product set is honoured (no hardcoded list).
  const projects = new Set();
  const projectKeys = [];
  const productNames = [];
  const nameToKey = {};
  for (const [, p] of products) {
    if (p?.jira?.projectKey) projectKeys.push(p.jira.projectKey);
    if (p?.name) {
      productNames.push(p.name);
      if (p.jira?.projectKey) nameToKey[p.name] = p.jira.projectKey;
    }
  }
  if (projectKeys.length) {
    const keyRe = new RegExp(`\\b(${projectKeys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})-\\d+\\b`, "g");
    const issueKeyMatches = summary.match(keyRe) || [];
    for (const m of issueKeyMatches) projects.add(m.split("-")[0]);
  }
  if (productNames.length) {
    const nameRe = new RegExp(`\\b(${productNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "g");
    const productMatches = summary.match(nameRe) || [];
    for (const m of productMatches) projects.add(nameToKey[m] || m);
  }
  if (projects.size > 1) reasons.push(`products>1(${[...projects].join(",")})`);

  // 4. Closing / superseding / deprecating an existing tracked issue
  if (/\b(close|won'?t\s*do|wont[- ]do|supersede|deprecate|archive|rollback|abandon)\b[^.\n]{0,40}\b[A-Z]{2,5}-\d+\b/i.test(summary)
      || /\b[A-Z]{2,5}-\d+\b[^.\n]{0,40}\b(close|won'?t\s*do|deprecate|supersede|archive)\b/i.test(summary)) {
    reasons.push("closing-existing-issue");
  }

  // 5. Destructive operations on infrastructure / shared resources
  // (verb and noun within ~40 chars on the same line — tolerates object names like "drop the audit_log table")
  if (/\b(?:delete|drop|wipe|purge|truncate|remove|deprecate)\b[^.\n]{0,40}\b(?:database|table|service|component|module|repository|repo|workflow|pipeline|api\s+endpoint|microservice|cluster|namespace)\b/i.test(summary)) {
    reasons.push("destructive-op");
  }

  // 6. Broad action surface — many items dispatched at once
  const actionItemCount = (summary.match(/^\s*-\s*\[\s*\]/gm) || []).length;
  const actionThreshold = config.meetings?.implicitGateActionThreshold ?? 5;
  if (actionItemCount > actionThreshold) reasons.push(`actions>${actionThreshold}(${actionItemCount})`);

  if (reasons.length === 0) return null;
  return { gated: true, source: `rule:${reasons[0]}`, reason: reasons.join("; ") };
}

// Borderline LLM judgment: invoked only when no deterministic rule fires AND
// there are action items to dispatch. Uses Haiku for cost. Fails open (no gate)
// on parse error, timeout, or non-zero exit so this never blocks a meeting.
async function judgeBorderlineGate(meeting, summary) {
  if (!summary) return null;
  if (config.meetings?.implicitGateLLMEnabled === false) return null;
  const actionItemCount = (summary.match(/^\s*-\s*\[\s*\]/gm) || []).length;
  if (actionItemCount === 0) return null;

  const threshold = config.meetings?.implicitGateLLMThreshold ?? 6;
  const truncated = summary.length > 6000 ? summary.substring(0, 6000) + "\n... (truncated)" : summary;
  const prompt = [
    `You are a meeting governance assistant for an AI-driven dev platform.`,
    ``,
    `Score 0-10 the likelihood that the human owner (Mark) should review and approve the action items below BEFORE they are dispatched as Jira issues, code changes, and agent work.`,
    ``,
    `High score (7-10): broad refactor, multi-product impact, ambiguous direction, novel initiative, deletion or deprecation of working features, items contradicting each other, scope creep beyond the meeting topic, business or product strategy decisions.`,
    `Low score (0-3): a few small bug fixes, well-defined narrow tasks, routine maintenance, clear single-component changes, items already discussed and agreed.`,
    ``,
    `Reply on a single line with EXACTLY this format and nothing else:`,
    `SCORE: <0-10> | REASON: <short reason in <=15 words>`,
    ``,
    `Meeting topic: ${meeting.topic}`,
    `Outcomes summary:`,
    truncated,
  ].join("\n");

  const args = [...config.claude.baseArgs];
  args.push("--model", config.claude?.models?.haiku || "claude-haiku-4-5-20251101");
  pushFallbackModel(args, "haiku");
  args.push("-p");
  args.push("--output-format", "stream-json", "--verbose");
  const cliCmd = config.claude?.command || "claude";

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cliCmd, args, {
        cwd: meeting.workingDir,
        env: { ...process.env, ...getOAuthEnvVars() },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: borderline judgment spawn failed: ${e.message}`);
      return resolve(null);
    }
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", () => {});
    try {
      proc.stdin.write(prompt);
      proc.stdin.end();
    } catch {}

    const timeout = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: borderline judgment timed out — failing open (no gate)`);
      resolve(null);
    }, 30_000);

    proc.on("close", () => {
      clearTimeout(timeout);
      const textParts = [];
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t);
          if (ev.type === "assistant" && ev.message) {
            for (const b of (ev.message.content || [])) {
              if (b.type === "text" && b.text) textParts.push(b.text);
            }
          } else if (ev.type === "result" && ev.result) {
            if (!textParts.length) textParts.push(ev.result);
          }
        } catch {}
      }
      const content = textParts.join("").trim();
      const m = content.match(/SCORE:\s*(\d+(?:\.\d+)?)\s*\|\s*REASON:\s*(.+)/i);
      if (!m) {
        console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: borderline judgment unparseable: "${content.substring(0, 200)}"`);
        return resolve(null);
      }
      const score = Math.round(parseFloat(m[1]));
      const reason = m[2].trim();
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: borderline judgment score=${score} threshold=${threshold} reason="${reason}"`);
      if (score >= threshold) {
        return resolve({ gated: true, source: `llm:confidence=${score}`, reason });
      }
      resolve(null);
    });

    proc.on("error", (e) => {
      clearTimeout(timeout);
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: borderline judgment proc error: ${e.message}`);
      resolve(null);
    });
  });
}

function createMeeting(options) {
  const meetingId = `mtg_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  // Normalize mode: "directed"/"chair" → "chair", "serial"/"roundRobin" → "roundRobin".
  // Default is "chair" (directed discussion).
  const mode = normalizeMode(options.mode || "chair");
  const agents = options.agents || ["product-manager", "engineer-planner"];
  // Smart chair selection: prefer product-manager if present, else first participant.
  const chair = selectChair(agents, options.chair);
  const topic = options.topic || "Team Meeting";
  // Gate-before-dispatch: explicit body flag wins; otherwise sniff topic for "prompt me"-style asks.
  const gateBeforeDispatch =
    options.gateBeforeDispatch === true || detectGateIntent(topic);
  const meeting = {
    meetingId,
    topic,
    agents,
    facilitator: options.facilitator || agents[0] || "product-manager",
    chair,
    mode, // canonical: "chair" or "roundRobin"
    transcript: [], // { role: "user"|"agent", agent?: string, name: string, content: string, timestamp: string }
    status: "active", // active, paused, ended, awaiting-approval, rejected
    telegram: options.telegram || null,
    callbackUrl: options.callbackUrl || null,
    workingDir: options.workingDir || DEFAULT_WORKING_DIR,
    productId: null, // resolved below
    createdAt: nowIso(),
    endedAt: null,
    currentSpeaker: null, // agent currently generating a response
    roundRobin: options.roundRobin !== false, // whether agents auto-respond to each other
    autoDiscuss: options.autoDiscuss || false, // agents discuss autonomously without user input
    maxRounds: options.maxRounds || (options.autoDiscuss ? 3 : 2), // rounds of discussion
    maxTurns: options.maxTurns || (mode === "chair" ? 20 : 0), // chair mode turn limit
    turnCount: 0, // total CLI invocations in this meeting
    summary: null,
    gateBeforeDispatch, // true → pause for human approval after outcomes generation
    awaitingApproval: false, // set true when paused waiting for /meeting/:id/decision
    refinementsUsed: 0, // number of refine cycles consumed (cap = 3)
    decision: null, // { decision: "approve"|"reject"|"refine", refinement?, decidedAt }
  };
  // Resolve product from workingDir for cross-project isolation.
  // If workingDir is the default (no explicit override), also try resolving from telegram chatId
  // so that meetings started from product-specific Telegram groups get the correct Jira project.
  let meetingProduct = resolveProduct(meeting.workingDir);
  if (!meetingProduct && meeting.telegram?.chatId) {
    meetingProduct = resolveProductFromTelegramChat(meeting.telegram.chatId);
    if (meetingProduct && meetingProduct.workingDir) {
      meeting.workingDir = meetingProduct.workingDir;
    }
  }
  if (meetingProduct) {
    meeting.productId = meetingProduct.id;
    // Use product's Telegram chat if none provided
    if (!meeting.telegram && meetingProduct.telegram?.chatId) {
      meeting.telegram = { chatId: String(meetingProduct.telegram.chatId) };
    }
  }

  meetings.set(meetingId, meeting);
  db.meetings.set(meeting).catch(e => console.error('[db] meeting persist failed: ' + e.message));


  // Emit SSE event
  if (config.sseEnabled) {
    jobEmitter.emit("meeting:created", {
      meetingId,
      topic: meeting.topic,
      agents: meeting.agents,
      status: "active",
    });
  }

  return meeting;
}

function getMeetingTranscriptText(meeting, lastN) {
  const msgs = lastN ? meeting.transcript.slice(-lastN) : meeting.transcript;
  return msgs
    .map((m) => {
      const label = m.role === "user" ? `[${m.name}]` : `[${m.agent}]`;
      return `${label}: ${m.content}`;
    })
    .join("\n\n");
}

const AGENT_ROLE_DESCRIPTIONS = {
  "product-manager": "Product strategy, user needs, acceptance criteria, prioritization, and business value",
  "engineer-planner": "Technical architecture, implementation planning, codebase structure, and technical feasibility",
  "engineer-implementer": "Hands-on coding, build systems, testing, and practical implementation concerns",
  "engineer-reviewer": "Code quality, patterns, security vulnerabilities, and engineering standards",
  "architect": "System architecture, ADRs, scalability, integration patterns, and technical debt",
  "security-agent": "Security threats, OWASP risks, authentication, authorization, and compliance",
  "qa-agent": "Unified verification: unit/integration tests, type-check, lint, acceptance criteria, Playwright browser tests, and regression",
  "ux-agent": "User experience, accessibility, interaction design, and UI patterns",
  "ba-agent": "Business requirements, acceptance criteria, stakeholder needs, and process flows",
  "marketing": "Market positioning, content strategy, competitive landscape, and messaging",
  "sales-development": "Customer pain points, sales pipeline, prospect feedback, and market demand",
  "ask-dave-agent": "Root cause analysis, debugging complex issues, and creative problem-solving",
  "bug-triage": "Bug analysis, severity assessment, and reproduction steps",
  "sprint-reporter": "Team velocity, sprint metrics, and delivery performance",
};

/**
 * Build product context block for meeting prompts.
 * Tells agents which Jira project, product name, etc. to use.
 */
function getMeetingProductContext(meeting) {
  const product = meeting.productId
    ? products.get(meeting.productId)
    : resolveProduct(meeting.workingDir);
  if (!product) return null;
  const lines = [
    "=== PRODUCT CONTEXT ===",
    `Product: ${product.name || product.id}`,
  ];
  if (product.jira?.projectKey) {
    lines.push(`Jira Project: ${product.jira.projectKey} — ALWAYS use project key "${product.jira.projectKey}" for ALL Jira operations: creating issues, JQL queries, transitions, comments, and searches. Do NOT use any other project key. Every issue you create or reference MUST be in ${product.jira.projectKey}.`);
  }
  if (product.confluence?.space) {
    lines.push(`Confluence Space: ${product.confluence.space}`);
  }
  if (product.description) {
    lines.push(`Description: ${product.description}`);
  }
  if (product.sprint?.boardId) {
    lines.push(`Sprint Board ID: ${product.sprint.boardId}`);
  }
  // Inject plugin directory paths so agents can find skill files (MASTER.md, OVERRIDES.md, etc.)
  const pluginDirs = resolvePluginDirs(product);
  if (pluginDirs.length > 0) {
    lines.push(`Plugin Directories (skill files live here):`);
    for (const dir of pluginDirs) {
      lines.push(`  - ${dir}`);
    }
    const productPluginDir = resolvePluginDir(product);
    lines.push(`Product Plugin: ${productPluginDir}`);
    lines.push(`When skills reference <product-plugin>, use: ${productPluginDir}`);
    lines.push(`MASTER.md location: ${productPluginDir}/skills/ux-design/MASTER.md`);
  }
  lines.push("");
  lines.push("FILE ROUTING: Plugin files (agents/, skills/, commands/, hooks/) MUST be written to the Plugin directory above, NOT inside the working directory.");
  lines.push("=== END PRODUCT CONTEXT ===");
  return lines.join("\n");
}

function buildMeetingPrompt(meeting, agent, userMessage, options = {}) {
  const agentNames = meeting.agents.join(", ");
  const transcriptText = getMeetingTranscriptText(meeting, 20);
  const roleDesc = AGENT_ROLE_DESCRIPTIONS[agent] || "general expertise";
  const isAutoDiscuss = meeting.autoDiscuss;
  const round = options.round || 0;
  const maxRounds = meeting.maxRounds || 3;
  const isFinalRound = round >= maxRounds;

  const hasMcpTools = (config.meetings?.allowedTools || []).length > 0;
  const rules = [
    "- Be concise (2-4 paragraphs max). This is a discussion, not a monologue.",
    "- Build on what others said. Reference their points by name.",
    "- If you disagree, say so directly and explain why.",
    "- If you have nothing new to add, say 'No further input' — don't repeat others.",
    "- Stay in character as your agent role.",
    "- CRITICAL: Do NOT assume any Jira issue is open or resolved without verifying. If you need to know the status of an issue, USE THE JIRA MCP TOOL to look it up. Do not speculate about ticket statuses.",
  ];

  if (hasMcpTools) {
    rules.push(
      "- You have access to MCP tools (Jira, etc). USE THEM to look up issue statuses, check sprint boards, and verify facts before discussing. Do not say 'I don't have statuses in front of me' — you DO have the tools to check.",
      "- When you commit to doing something (review, implement, investigate), be specific: what exactly, by when, what issue key.",
    );
  }

  if (isAutoDiscuss) {
    rules.push(
      "- Drive towards concrete decisions and actionable outcomes.",
      "- Propose specific solutions, not vague suggestions.",
      "- Raise risks or concerns early — don't just agree with everyone.",
      "- If another agent's proposal has a flaw, challenge it constructively.",
    );
    if (isFinalRound) {
      rules.push(
        "- This is the FINAL round. Converge on decisions. State your final position clearly.",
        "- Identify any remaining blockers or open questions.",
        "- For each action item you propose, specify: what, who (agent name), priority (High/Medium/Low).",
      );
    }
  } else {
    rules.push("- Address the human facilitator's questions directly.");
  }

  const parts = [
    `You are ${agent} in a team meeting.`,
    `Your expertise: ${roleDesc}.`,
    `Topic: ${meeting.topic}`,
    `Participants: ${agentNames}${isAutoDiscuss ? "" : " + the human facilitator"}`,
    isAutoDiscuss ? `Round ${round}/${maxRounds}` : "",
    "",
    "MEETING RULES:",
    ...rules,
  ];

  // Inject product context (Jira project, product name, etc.)
  const productCtx = getMeetingProductContext(meeting);
  if (productCtx) {
    parts.push("", productCtx);
  }

  // Inject external context (Jira statuses + previous meeting minutes)
  if (meeting.externalContext) {
    parts.push("", "=== CURRENT CONTEXT (from Jira & previous meetings) ===");
    parts.push(meeting.externalContext);
    parts.push("=== END CONTEXT ===");
  }

  // Inject active/scheduled meetings so agents don't propose duplicates
  const meetingSchedule = getActiveMeetingSchedule();
  if (meetingSchedule) {
    parts.push("", "=== EXISTING MEETING SCHEDULE ===");
    parts.push("The following meetings are already active or scheduled. Do NOT propose follow-up meetings that overlap with these:");
    parts.push(meetingSchedule);
    parts.push("=== END SCHEDULE ===");
  }

  parts.push(
    "",
    transcriptText ? "=== MEETING TRANSCRIPT ===\n" + transcriptText + "\n=== END TRANSCRIPT ===" : "",
    "",
  );

  if (userMessage) {
    parts.push(isAutoDiscuss ? `Discussion prompt: "${userMessage}"` : `The facilitator just said: "${userMessage}"`);
  } else {
    parts.push("It's your turn to contribute to the discussion.");
  }

  parts.push("", `Respond as ${agent}. Be direct and substantive.`);

  return parts.filter(Boolean).join("\n");
}

/**
 * Build the structured outcomes prompt for the facilitator at end of auto-discussion
 */
function buildOutcomesPrompt(meeting) {
  const transcriptText = getMeetingTranscriptText(meeting);
  const allAgents = Object.values(config.agentLabels || {});
  const productCtx = getMeetingProductContext(meeting);
  return [
    `You are ${meeting.facilitator}, facilitating a team meeting that has concluded.`,
    `Topic: ${meeting.topic}`,
    `Participants: ${meeting.agents.join(", ")}`,
    "",
    productCtx || "",
    "",
    "=== FULL MEETING TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Generate a structured meeting summary. Be specific — reference who said what and extract real commitments.",
    "",
    "HUMAN-APPROVAL CHECK (read carefully):",
    "Look back at the meeting topic and transcript. Did the user (NOT an agent) explicitly request human input or approval before any action is taken? Phrases that count: \"prompt me\", \"ask me first\", \"don't write/create yet\", \"present options to me\", \"discuss with me first\", \"hold off\", \"wait for my input\", \"let me decide\", \"check with me\".",
    "If YES — emit the literal directive `[REQUIRES-APPROVAL]` on its OWN LINE at the very TOP of the summary, before the `## Decisions` heading. This will pause dispatch until the user approves.",
    "If NO — do NOT emit the directive. Default is to dispatch immediately.",
    "Be conservative: only emit it when the user explicitly asked for a gate. Agents flagging caution does NOT count.",
    "",
    "Format your response EXACTLY as follows:",
    "",
    "## Decisions",
    "- [Decision 1: what was agreed, with rationale]",
    "- [Decision 2: ...]",
    "",
    "## Action Items",
    "IMPORTANT: Each action item below will be AUTOMATICALLY DISPATCHED as a real job to the named agent.",
    "Only list items where the agent CAN and SHOULD act autonomously. Be specific enough for the agent to execute without further context.",
    "DEFAULT: All action items are dispatched IMMEDIATELY (no Schedule field). This is the preferred behaviour.",
    "ONLY add a Schedule field if there is a genuine timing dependency (e.g. must wait for another task to finish first, or a specific calendar slot like a meeting).",
    "Do NOT schedule things for 'tomorrow' or 'next week' unless there is a real reason to wait.",
    "",
    "DO NOT list the meeting topic itself as an action item. The topic is the conversation, not a task. Examples of what NOT to write as action items:",
    "  ✗ \"Talk about X\" / \"Discuss Y\" / \"Where do we stand on Z\" / \"Give an update on Q\" — these are meeting topics, not work to be done.",
    "  ✗ Re-statements of the topic prefixed with verbs like 'discuss', 'talk about', 'review', 'cover', 'address'.",
    "Action items must be CONCRETE WORK PRODUCTS — something an agent will produce, change, send, or decide. If you cannot describe the deliverable in one sentence, it is not an action item.",
    `- [ ] [task] — Owner: [agent-name] — Priority: [High/Medium/Low]`,
    `- [ ] [task with timing dependency] — Owner: [agent-name] — Priority: [High/Medium/Low] — Schedule: [ISO datetime or relative like 'in 30 minutes', 'today 14:00']`,
    `- [ ] [task that depends on a prior action item] — Owner: [agent-name] — Priority: [High/Medium/Low] — DependsOn: [N]`,
    "If an action item cannot start until another action item in this list completes, add — DependsOn: [N] where N is the 1-based index of the prerequisite (e.g. DependsOn: [1] means it waits for action item 1; DependsOn: [1, 2] means it waits for both). Omit DependsOn if the task is independent. The runner uses these to set Jira blocks/is-blocked-by links and gates execution order automatically.",
    "",
    `CRITICAL: The Owner field MUST be one of these exact agent names (no prefix): ${[...new Set([...meeting.agents, ...allAgents])].join(", ")}`,
    "Do NOT prefix with 'meshwork:' or any namespace. Just the plain agent name (e.g. 'product-manager', NOT 'meshwork:product-manager').",
    "",
    "## Feature Subtasks",
    "For new features discussed in this meeting, break the work into TYPED SUBTASKS on the parent Jira story.",
    "Each subtask runs through the lean pipeline (implement → code-review → verify) with the appropriate agent.",
    "Use this format — each subtask will be AUTOMATICALLY CREATED as a Jira subtask with the correct agent label:",
    "",
    "[CREATE-SUBTASKS]",
    "parent: [JIRA-KEY of the parent story]",
    "---",
    "summary: [Backend] [concise task description]",
    "agent: engineer-implementer",
    "priority: [High/Medium/Low]",
    "labels: [needs-architecture]  ← ONLY if this subtask needs a gate (DB schema, new services, system design)",
    "description: [Specific implementation details, files to change, API endpoints, etc.]",
    "---",
    "summary: [UI] [concise task description]",
    "agent: ui-engineer",
    "priority: [High/Medium/Low]",
    "labels: [needs-ux-design]  ← ONLY if this subtask needs UX review (new user flows, significant UI work)",
    "description: [Components, pages, design specs, interactions]",
    "---",
    "summary: [Tests] [concise task description]",
    "agent: e2e-builder",
    "priority: [Medium/Low]",
    "description: [What to test, coverage targets, test scenarios]",
    "[/CREATE-SUBTASKS]",
    "",
    "SUBTASK RULES:",
    "- Use [Backend] prefix for API/data/logic work → engineer-implementer",
    "- Use [UI] prefix for frontend/components/styling → ui-engineer",
    "- Use [Tests] prefix for test coverage → e2e-builder or qa-agent",
    "- Use [Security] prefix for security hardening → security-agent",
    "- Keep each subtask focused — one concern per subtask",
    "- Only create subtasks for features that were DECIDED in this meeting (not speculative)",
    "- Add labels: [needs-architecture] for DB schema / new services / system design subtasks",
    "- Add labels: [needs-ux-design] for significant UI / user flow subtasks",
    "- Add labels: [needs-requirements] for vague scope subtasks needing BA enrichment",
    "- Only add gate labels to subtasks that actually need them — not all subtasks",
    "",
    "DEPENDENCY RULES (CRITICAL — get the direction right):",
    "- After creating subtasks, add issue links via POST /rest/api/3/issueLink:",
    "  {\"type\":{\"name\":\"Blocks\"}, \"inwardIssue\":{\"key\":\"BLOCKER_KEY\"}, \"outwardIssue\":{\"key\":\"BLOCKED_KEY\"}}",
    "  inwardIssue = the one that must FINISH FIRST (the prerequisite)",
    "  outwardIssue = the one that WAITS (depends on the prerequisite)",
    "",
    "  Execution order: [Backend] FIRST → [UI] SECOND → [Tests] LAST",
    "  So the links must be:",
    "  • UI is blocked by Backend:   inwardIssue=Backend, outwardIssue=UI",
    "  • Tests is blocked by Backend: inwardIssue=Backend, outwardIssue=Tests",
    "  • Tests is blocked by UI:      inwardIssue=UI, outwardIssue=Tests",
    "  • Security is blocked by Backend: inwardIssue=Backend, outwardIssue=Security",
    "",
    "  [Backend] subtasks get NO inward links (they run first, nothing blocks them)",
    "- This ensures agents don't write UI before the API exists, or tests before the code exists",
    "",
    "SPRINT RULES:",
    "- Move SUBTASKS into the active sprint, NOT the parent story",
    "- Parent stories stay in the backlog as containers",
    "- Only subtasks are executable work units",
    "",
    "## Bugs Identified",
    "If the meeting surfaced any bugs (code defects, broken behaviour, regressions), list them here.",
    "Each bug will be AUTOMATICALLY CREATED as a Jira Bug issue and routed to engineer-planner for immediate fix.",
    "Only list genuine defects — not feature requests or improvements.",
    "- Summary: [one-line bug title] — Severity: [Critical/Major/Minor] — RootCause: [brief root cause or suspected area] — Priority: [High/Medium/Low]",
    "",
    "## Follow-Up Meetings",
    "If the meeting concluded that a follow-up discussion is needed (with same or different agents), list them here.",
    "Each meeting will be AUTOMATICALLY SCHEDULED at the specified time.",
    "Only schedule a follow-up if the current meeting cannot resolve the topic and more agents or time is genuinely needed.",
    "IMPORTANT: Check the existing meeting schedule below BEFORE proposing any follow-up. Do NOT propose a meeting if the same topic is already active or scheduled.",
    (() => {
      const sched = getActiveMeetingSchedule();
      return sched
        ? `\nEXISTING SCHEDULE (do not duplicate):\n${sched}\n`
        : "\n(No meetings currently active or scheduled.)\n";
    })(),
    "- Topic: [what to discuss] — Agents: [comma-separated agent names] — Schedule: [ISO datetime or relative time]",
    "",
    "## Risks & Concerns",
    "- [Risk raised by agent-name: description]",
    "",
    "## Open Questions",
    "- [Unresolved question that needs human input]",
    "",
    "## Next Steps",
    "- [What happens next, by whom, by when]",
    "",
    "Be concrete. No filler. Every action item must have an owner.",
  ].join("\n");
}

/**
 * Run autonomous multi-round discussion.
 * Agents discuss the topic with each other across multiple rounds.
 * Each round, every agent speaks once (building on the full transcript).
 * At the end, the facilitator produces structured outcomes.
 */

/**
 * Fetch real-time Jira + Confluence context for a meeting.
 * Calls N8N Meeting Context webhook to get:
 * - Current status of any issues mentioned in topic
 * - Active sprint issues summary
 * - Recent meeting minutes from Confluence (agent memory)
 * Returns formatted context string to inject into meeting prompts.
 */
async function fetchMeetingContext(meeting) {
  const contextUrl = config.meetings?.contextWebhookUrl;
  if (!contextUrl) {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: No context webhook configured, skipping context fetch`);
    return null;
  }

  try {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Fetching Jira + Confluence context...`);

    const headers = {};
    if (SECRET) headers["X-Runner-Secret"] = SECRET;

    const resp = await postJson(contextUrl, {
      meetingId: meeting.meetingId,
      topic: meeting.topic,
      agents: meeting.agents,
      confluenceSpace: resolveConfluenceSpace(meeting.productId || meeting.workingDir),
      confluenceParentPage: config.meetings?.confluenceParentPage || "Meetings",
      jiraProject: resolveJiraProject(meeting.productId || meeting.workingDir),
    }, headers);

    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      let data;
      try { data = JSON.parse(resp.body); } catch { data = null; }
      if (data?.context) {
        console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Context fetched (${data.context.length} chars)`);
        return data.context;
      }
    }

    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Context fetch returned ${resp.statusCode}`);
    return null;
  } catch (e) {
    console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: Context fetch error: ${e.message}`);
    return null;
  }
}

/**
 * Post meeting outcomes to N8N for:
 * 1. Confluence page creation (meeting minutes with timestamp)
 * 2. Jira task creation from action items
 * 3. Agent dispatch for high-priority action items
 */
async function postMeetingOutcomes(meeting) {
  const outcomesUrl = config.meetings?.outcomesWebhookUrl;
  if (!outcomesUrl) {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: No outcomes webhook configured, skipping outcomes post`);
    return;
  }

  try {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Posting outcomes to N8N...`);

    const headers = {};
    if (SECRET) headers["X-Runner-Secret"] = SECRET;

    const duration = meeting.endedAt && meeting.createdAt
      ? Math.round((new Date(meeting.endedAt) - new Date(meeting.createdAt)) / 1000)
      : null;

    const payload = {
      meetingId: meeting.meetingId,
      topic: meeting.topic,
      agents: meeting.agents,
      facilitator: meeting.facilitator,
      summary: meeting.summary,
      transcript: meeting.transcript,
      createdAt: meeting.createdAt,
      endedAt: meeting.endedAt,
      duration,
      messageCount: meeting.transcript.length,
      telegram: meeting.telegram,
      confluenceSpace: resolveConfluenceSpace(meeting.productId || meeting.workingDir),
      confluenceParentPage: config.meetings?.confluenceParentPage || "Meetings",
      jiraProject: resolveJiraProject(meeting.productId || meeting.workingDir),
      runnerUrl: process.env.RUNNER_INTERNAL_URL || `http://runner:${config.port || 3210}`,
    };

    const resp = await postJson(outcomesUrl, payload, headers);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Outcomes posted successfully`);
    } else {
      console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: Outcomes post failed (${resp.statusCode}): ${resp.body?.substring(0, 200)}`);
    }
  } catch (e) {
    console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: Outcomes post error: ${e.message}`);
  }
}

// Direct callback for meetings — bypasses internalCallbackUrl to use the meeting-specific callback URL
async function sendMeetingCallback(url, payload) {
  try {
    const headers = {};
    if (SECRET) headers["X-Runner-Secret"] = SECRET;
    const resp = await postJson(url, payload, headers);
    if (resp.statusCode >= 200 && resp.statusCode < 300) return;
    console.error(`[${nowIso()}] Meeting callback ${resp.statusCode}: ${resp.body?.substring(0, 200)}`);
  } catch (e) {
    console.error(`[${nowIso()}] Meeting callback error: ${e.message}`);
  }
}

async function runAutoDiscussion(meeting) {
  const { agents, maxRounds, callbackUrl, telegram, topic } = meeting;

  console.log(`[${nowIso()}] Auto-discussion started: ${meeting.meetingId} topic="${topic}" rounds=${maxRounds} agents=[${agents.join(",")}] callbackUrl=${callbackUrl || "NONE"} telegram=${JSON.stringify(telegram)}`);

  // === Fetch external context (Jira statuses + previous meeting minutes) ===
  const externalContext = await fetchMeetingContext(meeting);
  if (externalContext) {
    meeting.externalContext = externalContext;
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: External context loaded (${externalContext.length} chars)`);
  }

  // Send initial "thinking" callback
  if (callbackUrl && telegram) {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Sending initial callback to ${callbackUrl}`);
  } else {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: SKIPPING callbacks - callbackUrl=${callbackUrl || "NONE"} telegram=${JSON.stringify(telegram)}`);
  }
  if (callbackUrl && telegram) {
    const contextNote = externalContext ? " Context loaded from Jira + Confluence." : "";
    const initPayload = {
      event: "meeting:agent-response",
      meetingId: meeting.meetingId,
      agent: "system",
      content: `_Meeting started: "${topic}"_\n_${agents.length} agents, ${maxRounds} rounds_\n_Agents are now discussing...${contextNote}_`,
      telegram,
      topic,
    };
    const logFile = path.join(LOG_DIR, `${meeting.meetingId}.log`);
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, `[${nowIso()}] Meeting ${meeting.meetingId}\n`, "utf8");
    }
    sendMeetingCallback(callbackUrl, initPayload);
  }

  for (let round = 1; round <= maxRounds; round++) {
    if (meeting.status !== "active") break;

    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Round ${round}/${maxRounds}`);

    for (const agent of agents) {
      if (meeting.status !== "active") break;

      const budgetCheck = checkBudget();
      if (!budgetCheck.ok) {
        console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Budget exceeded at round ${round}`);
        meeting.status = "ended";
        meeting.endedAt = nowIso();
        break;
      }

      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: R${round} - ${agent} speaking...`);

      // Send "thinking" status so user sees progress
      if (callbackUrl && telegram) {
        const agentName = agent.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase());
        const thinkingPayload = {
          event: "meeting:agent-response",
          meetingId: meeting.meetingId,
          agent: "status",
          content: `Round ${round}/${maxRounds} — ${agentName} is thinking...`,
          telegram,
          topic,
          round,
          maxRounds,
        };
        sendMeetingCallback(callbackUrl, thinkingPayload);
      }

      // First agent in first round gets the topic as the trigger
      const triggerMessage = (round === 1 && agent === agents[0])
        ? topic
        : null;

      const result = await runMeetingAgentTurn(meeting, agent, triggerMessage, { round, maxRounds });
      if (!result) continue;

      // Post each response to Telegram via callback
      if (callbackUrl && telegram) {
        const payload = {
          event: "meeting:agent-response",
          meetingId: meeting.meetingId,
          agent: result.agent,
          content: result.content,
          telegram,
          topic,
          round,
          maxRounds,
          transcriptLength: meeting.transcript.length,
        };
        sendMeetingCallback(callbackUrl, payload);
      }

      // Emit SSE
      if (config.sseEnabled) {
        jobEmitter.emit("meeting:agent-response", {
          meetingId: meeting.meetingId,
          agent: result.agent,
          round,
          contentLength: result.content.length,
        });
      }
    }
  }

  if (meeting.status !== "active") return;

  // === Generate outcomes and finalize (shared with chair mode) ===
  console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Generating outcomes...`);
  await generateAndFinalizeOutcomes(meeting);
}

/**
 * ============================================================
 * CHAIR-BASED MEETING MODEL
 * The chair agent controls the meeting flow, calling on specific
 * agents by name and deciding when to close items or end the
 * meeting. Replaces serial round-robin with directed discussion.
 * ============================================================
 */

/**
 * Build the prompt for the chair agent.
 * The chair gets: participant roster with expertise, directives syntax, transcript, context.
 */
function buildChairPrompt(meeting, options = {}) {
  const { isOpening, agentResponses, closedItems } = options;
  const chair = meeting.chair;
  const roleDesc = AGENT_ROLE_DESCRIPTIONS[chair] || "meeting facilitation";
  const hasMcpTools = (config.meetings?.allowedTools || []).length > 0;

  // Build participant roster (exclude chair)
  const participants = meeting.agents
    .filter(a => a !== chair)
    .map(a => `  - ${a}: ${AGENT_ROLE_DESCRIPTIONS[a] || "general expertise"}`)
    .join("\n");

  const transcriptText = getMeetingTranscriptText(meeting, 30);

  const parts = [
    `You are ${chair}, CHAIRING this team meeting.`,
    `Your expertise: ${roleDesc}.`,
    `Topic: ${meeting.topic}`,
    "",
    "PARTICIPANTS YOU CAN CALL ON:",
    participants,
    "",
    "=== CHAIR DIRECTIVES ===",
    "You control the meeting flow using these directives:",
    "",
    "[CALL: agent-name] Your question or topic for them",
    "  — Calls a specific agent to speak. Include a focused question.",
    "  — You can call multiple agents in one turn (one [CALL:] per agent).",
    "",
    "[CLOSE-ITEM: description]",
    "  — Close a discussion topic and note the decision/outcome.",
    "  — After you close an item, agents who haven't spoken on it will be given",
    "    a chance to raise their hand. You'll see their names and brief reasons.",
    "    Call on them if their input is relevant; skip if not.",
    "",
    "[OPEN-FLOOR]",
    "  — Mid-topic: invite any participant to raise a concern or add input.",
    "  — Use when you sense someone may have something important to add.",
    "",
    "[END-MEETING]",
    "  — End the meeting. Use this after all items are resolved.",
    "  — IMPORTANT: Before ending, summarize decisions and action items.",
    "",
    "CHAIR RULES:",
    "- Open with a brief agenda. Don't monologue — get agents talking quickly.",
    "- Only call agents whose expertise is relevant to the current topic.",
    "- If an agent's response raises a point for another agent, call them to respond.",
    "- Drive toward decisions. Don't let discussion loop without resolution.",
    "- Challenge vague answers. Ask for specifics: what, who, when.",
    "- You can provide your own analysis between calling agents.",
    "- Close items as they're resolved — don't revisit settled topics.",
    "- Aim for efficiency: a focused 5-turn meeting beats a sprawling 15-turn one.",
  ];

  if (hasMcpTools) {
    parts.push(
      "- You have MCP tools (Jira, etc). Use them to verify facts and check statuses.",
      "- When agents make claims about ticket statuses, verify with Jira if in doubt.",
    );
  }

  // Inject product context (Jira project, product name, etc.)
  const productCtx = getMeetingProductContext(meeting);
  if (productCtx) {
    parts.push("", productCtx);
  }

  // Inject external context
  if (meeting.externalContext) {
    parts.push("", "=== CURRENT CONTEXT (from Jira & previous meetings) ===");
    parts.push(meeting.externalContext);
    parts.push("=== END CONTEXT ===");
  }

  // Transcript
  if (transcriptText) {
    parts.push("", "=== MEETING TRANSCRIPT ===", transcriptText, "=== END TRANSCRIPT ===");
  }

  // Closed items so far
  if (closedItems && closedItems.length > 0) {
    parts.push("", "ITEMS ALREADY CLOSED:", ...closedItems.map(i => `  ✓ ${i}`));
  }

  // Opening vs follow-up
  if (isOpening) {
    parts.push(
      "",
      `Open the meeting on: "${meeting.topic}"`,
      "Set the agenda, provide context, then call on the first agent(s) you need to hear from.",
    );
  } else if (agentResponses && agentResponses.length > 0) {
    const responsesSummary = agentResponses
      .map(r => `${r.agent} just responded.`)
      .join(" ");
    parts.push(
      "",
      responsesSummary,
      "Review their input. Then: call more agents, close items, or end the meeting.",
    );
  } else {
    parts.push("", "Continue chairing. Call on agents, close items, or end the meeting.");
  }

  parts.push("", `Respond as ${chair} (chair). Use directives to control the flow.`);

  // Hand-raisers waiting to speak
  if (options.handRaisers && options.handRaisers.length > 0) {
    const raiserLines = options.handRaisers
      .map(r => `  - ${r.agent}: "${r.reason}"`)
      .join("\n");
    parts.push(
      "",
      "=== AGENTS REQUESTING TO SPEAK ===",
      "These agents raised their hands after the last topic closed:",
      raiserLines,
      "Use [CALL: agent-name] to invite them to speak, or proceed if their input isn't needed.",
      "=== END HAND-RAISERS ===",
    );
  }

  return parts.filter(Boolean).join("\n");
}

/**
 * Build the prompt for an agent called by the chair with a specific question.
 */
function buildCalledAgentPrompt(meeting, agent, question) {
  const roleDesc = AGENT_ROLE_DESCRIPTIONS[agent] || "general expertise";
  const hasMcpTools = (config.meetings?.allowedTools || []).length > 0;
  const transcriptText = getMeetingTranscriptText(meeting, 15);

  const parts = [
    `You are ${agent} in a team meeting chaired by ${meeting.chair}.`,
    `Your expertise: ${roleDesc}.`,
    `Topic: ${meeting.topic}`,
    "",
    `The chair has directed a question to you:`,
    `"${question}"`,
    "",
    "RULES:",
    "- Answer the chair's question directly and concisely (2-4 paragraphs max).",
    "- Reference other participants' points by name if relevant.",
    "- If you disagree with something said earlier, say so directly.",
    "- If you have nothing substantive to add, say so briefly — don't pad your response.",
    "- Stay in character as your agent role.",
    "- CRITICAL: Do NOT assume any Jira issue is open or resolved without verifying.",
  ];

  if (hasMcpTools) {
    parts.push(
      "- You have MCP tools (Jira, etc). USE THEM to verify issue statuses before discussing.",
      "- When you commit to doing something, be specific: what, by when, what issue key.",
    );
  }

  // Inject product context (Jira project, product name, etc.)
  const productCtx = getMeetingProductContext(meeting);
  if (productCtx) {
    parts.push("", productCtx);
  }

  // Inject external context
  if (meeting.externalContext) {
    parts.push("", "=== CURRENT CONTEXT (from Jira & previous meetings) ===");
    parts.push(meeting.externalContext);
    parts.push("=== END CONTEXT ===");
  }

  if (transcriptText) {
    parts.push("", "=== RECENT TRANSCRIPT ===", transcriptText, "=== END TRANSCRIPT ===");
  }

  parts.push("", `Respond as ${agent}. Be direct and substantive.`);

  return parts.filter(Boolean).join("\n");
}

/**
 * Build a short (~100 token) prompt for agents who didn't speak on a topic,
 * asking whether they have relevant input to add before the meeting moves on.
 */
function buildHandRaisePrompt(agentName, topicSummary, meeting) {
  const roleDesc = AGENT_ROLE_DESCRIPTIONS[agentName] || "general expertise";
  return [
    `You are ${agentName} in a team meeting. Your expertise: ${roleDesc}.`,
    `Topic: ${meeting.topic}`,
    "",
    "The chair is about to close the following discussion item:",
    `"${topicSummary}"`,
    "",
    "You have not yet spoken on this item.",
    "If you have relevant information, a concern, or a different perspective that",
    "the group should hear BEFORE the item is closed, reply:",
    "  [RAISE-HAND: one concise sentence explaining what you'd add]",
    "Otherwise reply:",
    "  [PASS]",
    "",
    "Be honest and brief. Do NOT pad your response. One line only.",
  ].join("\n");
}

/**
 * Parse hand-raise responses from agents.
 * Takes an array of {agent, output} and returns {raisers: [{agent, reason}], passers: string[]}.
 */
function parseHandRaiseResponses(responses) {
  const raisers = [];
  const passers = [];
  for (const { agent, output } of responses) {
    const raiseMatch = /\[RAISE-HAND:\s*(.+?)\]/i.exec(output);
    if (raiseMatch) {
      raisers.push({ agent, reason: raiseMatch[1].trim() });
    } else {
      // Treat anything that isn't a RAISE-HAND as a pass (includes [PASS], errors, timeouts)
      passers.push(agent);
    }
  }
  return { raisers, passers };
}

/**
 * Run a hand-raise round: send short prompts in parallel to all non-speakers,
 * parse their responses, and return the list of agents who raised hands.
 * Returns an array of {agent, reason}.
 */
async function runHandRaiseRound(meeting, topicSummary, nonSpeakers) {
  if (!nonSpeakers || nonSpeakers.length === 0) return [];

  console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Hand-raise round for ${nonSpeakers.length} non-speaker(s): [${nonSpeakers.join(",")}]`);

  const cliCmd = config.claude?.command || "claude";

  // Spawn all hand-raise prompts in parallel
  const handRaisePromises = nonSpeakers.map((agentName) => {
    const prompt = buildHandRaisePrompt(agentName, topicSummary, meeting);
    const model = config.routing?.agentToModel?.[agentName] || "sonnet";
    const selectedModel = selectModel(model, agentName, null);

    const args = [...config.claude.baseArgs];
    args.push("--model", selectedModel);
    pushFallbackModel(args, model);
    args.push("-p");
    args.push("--output-format", "stream-json", "--verbose");
    if (agentName) args.push("--agent", agentName);
    // No MCP tools for hand-raise — keep it lightweight

    // Per-product plugin directory for meeting hand-raise — use productId first
    const hrProduct = meeting.productId
      ? products.get(meeting.productId)
      : resolveProduct(meeting.workingDir);
    applyProductPluginDir(args, hrProduct);

    return new Promise((resolve) => {
      const proc = spawn(cliCmd, args, {
        cwd: meeting.workingDir,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });

      proc.stdin.write(prompt);
      proc.stdin.end();

      // Short timeout — hand-raise is just one line
      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        resolve({ agent: agentName, output: "[PASS]" }); // timeout = treat as pass
      }, 60_000); // 60s

      proc.on("close", () => {
        clearTimeout(timeout);
        let output = "[PASS]";
        const textParts = [];
        for (const line of stdout.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          try {
            const ev = JSON.parse(t);
            if (ev.type === "assistant" && ev.message) {
              for (const b of (ev.message.content || [])) {
                if (b.type === "text" && b.text) textParts.push(b.text);
              }
            } else if (ev.type === "result" && ev.result) {
              if (!textParts.length) textParts.push(ev.result);
            }
          } catch {}
        }
        if (textParts.length) output = textParts.join("").trim();
        else if (stdout.trim()) output = stdout.trim();
        else if (stderr.trim()) output = stderr.trim();
        resolve({ agent: agentName, output });
      });
    });
  });

  const responses = await Promise.all(handRaisePromises);
  const { raisers } = parseHandRaiseResponses(responses);

  if (raisers.length > 0) {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Hand-raisers: [${raisers.map(r => r.agent).join(",")}]`);
  } else {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: No agents raised hands.`);
  }

  return raisers;
}

/**
 * Parse chair directives from the chair's response.
 * Returns: { calls: [{agent, question}], closedItems: string[], endMeeting: boolean, openFloor: boolean, commentary: string }
 */
function parseChairDirectives(content) {
  const result = { calls: [], closedItems: [], endMeeting: false, openFloor: false, commentary: "" };

  // Check for [END-MEETING]
  if (/\[END-MEETING\]/i.test(content)) {
    result.endMeeting = true;
  }

  // Check for [OPEN-FLOOR]
  if (/\[OPEN-FLOOR\]/i.test(content)) {
    result.openFloor = true;
  }

  // Parse [CLOSE-ITEM: description]
  const closeRegex = /\[CLOSE-ITEM(?::\s*(.+?))?\]/gi;
  let closeMatch;
  while ((closeMatch = closeRegex.exec(content)) !== null) {
    result.closedItems.push(closeMatch[1] || "Item closed");
  }

  // Parse [CALL: agent-name] question
  // Each [CALL:] starts a question that continues until the next [CALL:], [CLOSE-ITEM], [OPEN-FLOOR], [END-MEETING], or end of text
  const callRegex = /\[CALL:\s*([a-z0-9_-]+)\]\s*/gi;
  const callMatches = [...content.matchAll(callRegex)];

  for (let i = 0; i < callMatches.length; i++) {
    const agent = callMatches[i][1].toLowerCase();
    const startIdx = callMatches[i].index + callMatches[i][0].length;
    // Question extends until next directive or end
    let endIdx = content.length;
    // Find next directive after this one
    const nextDirective = content.slice(startIdx).search(/\[(?:CALL:|CLOSE-ITEM|OPEN-FLOOR|END-MEETING)/i);
    if (nextDirective !== -1) {
      endIdx = startIdx + nextDirective;
    }
    const question = content.slice(startIdx, endIdx).trim();
    if (question) {
      result.calls.push({ agent, question });
    }
  }

  // Everything that's not a directive is commentary
  let commentary = content
    .replace(/\[CALL:\s*[a-z0-9_-]+\]\s*[^[]*(?=\[|$)/gi, "")
    .replace(/\[CLOSE-ITEM(?::\s*.+?)?\]/gi, "")
    .replace(/\[OPEN-FLOOR\]/gi, "")
    .replace(/\[END-MEETING\]/gi, "")
    .trim();
  result.commentary = commentary;

  return result;
}

/**
 * Run a chair-driven meeting. The chair controls who speaks and when.
 * Flow: chair opens → calls agents → reviews → calls more or closes items → ends
 */
async function runChairDiscussion(meeting) {
  const { agents, callbackUrl, telegram, topic, chair, maxTurns } = meeting;

  console.log(`[${nowIso()}] Chair discussion started: ${meeting.meetingId} topic="${topic}" chair=${chair} agents=[${agents.join(",")}] maxTurns=${maxTurns} callbackUrl=${callbackUrl || "NONE"}`);

  // === Fetch external context ===
  const externalContext = await fetchMeetingContext(meeting);
  if (externalContext) {
    meeting.externalContext = externalContext;
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: External context loaded (${externalContext.length} chars)`);
  }

  // Send initial callback
  if (callbackUrl && telegram) {
    const contextNote = externalContext ? " Context loaded from Jira + Confluence." : "";
    const participantList = agents.filter(a => a !== chair).join(", ");
    const initPayload = {
      event: "meeting:agent-response",
      meetingId: meeting.meetingId,
      agent: "system",
      content: `_Meeting started: "${topic}"_\n_Chair: ${chair} | Participants: ${participantList}_\n_Max ${maxTurns} turns. Chair-directed discussion.${contextNote}_`,
      telegram,
      topic,
    };
    const logFile = path.join(LOG_DIR, `${meeting.meetingId}.log`);
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, `[${nowIso()}] Meeting ${meeting.meetingId}\n`, "utf8");
    }
    sendMeetingCallback(callbackUrl, initPayload);
  }

  const closedItems = [];
  let consecutiveNoCall = 0; // safety: end if chair stops calling agents

  // Per-topic speaker tracking for hand-raise rounds.
  // Resets when a new [CLOSE-ITEM] triggers a new item.
  let topicSpeakers = new Set(); // agents who spoke on the current open item
  // Maximum hand-raise rounds per [CLOSE-ITEM] to cap runaway discussion.
  const MAX_HAND_RAISE_ROUNDS = 2;

  // === Chair opening turn ===
  console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Chair (${chair}) opening...`);

  if (callbackUrl && telegram) {
    const chairName = chair.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase());
    sendMeetingCallback(callbackUrl, {
      event: "meeting:agent-response",
      meetingId: meeting.meetingId,
      agent: "status",
      content: `${chairName} (chair) is opening the meeting...`,
      telegram, topic,
    });
  }

  const openingResult = await runMeetingAgentTurn(meeting, chair, topic, { isChairTurn: true });
  meeting.turnCount++;

  if (!openingResult || meeting.status !== "active") {
    meeting.status = "ended";
    meeting.endedAt = nowIso();
    return;
  }

  // Post chair's opening to Telegram
  if (callbackUrl && telegram) {
    sendMeetingCallback(callbackUrl, {
      event: "meeting:agent-response",
      meetingId: meeting.meetingId,
      agent: openingResult.agent,
      content: openingResult.content,
      telegram, topic,
      turn: meeting.turnCount,
      maxTurns,
    });
  }

  // Parse opening directives
  let directives = parseChairDirectives(openingResult.content);

  // === Main chair loop ===
  while (meeting.status === "active" && meeting.turnCount < maxTurns) {
    // Budget check
    const budgetCheck = checkBudget();
    if (!budgetCheck.ok) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Budget exceeded at turn ${meeting.turnCount}`);
      break;
    }

    // Handle [END-MEETING]
    if (directives.endMeeting) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Chair ended meeting at turn ${meeting.turnCount}`);
      break;
    }

    // === Hand-raise round triggered by [CLOSE-ITEM] ===
    // For each item the chair just closed, run a hand-raise round before
    // new agents are called. This happens synchronously (items closed one at
    // a time) using the last closed item description as topic summary.
    let pendingHandRaisers = []; // carried into the next chair turn
    if (directives.closedItems.length > 0 && meeting.turnCount < maxTurns) {
      // The last closed item description is the most relevant summary.
      const topicSummary = directives.closedItems[directives.closedItems.length - 1];

      // Non-speakers = participants minus chair minus anyone who already spoke
      const nonSpeakers = agents.filter(a => a !== chair && !topicSpeakers.has(a));

      if (nonSpeakers.length > 0) {
        let handRaiseRound = 0;
        let handRaisers = [];

        do {
          handRaiseRound++;
          if (callbackUrl && telegram) {
            sendMeetingCallback(callbackUrl, {
              event: "meeting:agent-response",
              meetingId: meeting.meetingId,
              agent: "status",
              content: `_Open floor check (round ${handRaiseRound}): asking ${nonSpeakers.length} agent(s) if they have input on "${topicSummary.substring(0, 60)}"..._`,
              telegram, topic,
            });
          }

          handRaisers = await runHandRaiseRound(meeting, topicSummary, nonSpeakers);

          if (handRaisers.length > 0) {
            // Let the chair know — carried into the next chair turn prompt
            pendingHandRaisers = handRaisers;

            if (callbackUrl && telegram) {
              const raiserNames = handRaisers.map(r => `${r.agent} ("${r.reason.substring(0, 60)}")`).join(", ");
              sendMeetingCallback(callbackUrl, {
                event: "meeting:agent-response",
                meetingId: meeting.meetingId,
                agent: "status",
                content: `_Hand-raisers: ${raiserNames}_`,
                telegram, topic,
              });
            }
          }

          // Only loop for a second round if any agents raised hands the first time
          // (the second round would go to remaining non-speakers after chair calls hand-raisers)
          break; // single round per [CLOSE-ITEM]; chair controls follow-up via [CALL:]
        } while (handRaiseRound < MAX_HAND_RAISE_ROUNDS && handRaisers.length > 0);
      }

      // Reset per-topic speaker tracking for the next agenda item
      topicSpeakers = new Set();
    }

    // Track closed items (after hand-raise processing)
    closedItems.push(...directives.closedItems);

    // === Handle [OPEN-FLOOR] mid-topic ===
    // Chair explicitly invited input — run a hand-raise round for all non-speakers now.
    if (directives.openFloor && meeting.turnCount < maxTurns) {
      const nonSpeakersMidTopic = agents.filter(a => a !== chair && !topicSpeakers.has(a));
      if (nonSpeakersMidTopic.length > 0) {
        if (callbackUrl && telegram) {
          sendMeetingCallback(callbackUrl, {
            event: "meeting:agent-response",
            meetingId: meeting.meetingId,
            agent: "status",
            content: `_Chair opened the floor: checking ${nonSpeakersMidTopic.length} agent(s) for input..._`,
            telegram, topic,
          });
        }
        const midTopicRaisers = await runHandRaiseRound(meeting, topic, nonSpeakersMidTopic);
        if (midTopicRaisers.length > 0) {
          pendingHandRaisers = [...pendingHandRaisers, ...midTopicRaisers];
          if (callbackUrl && telegram) {
            const raiserNames = midTopicRaisers.map(r => `${r.agent} ("${r.reason.substring(0, 60)}")`).join(", ");
            sendMeetingCallback(callbackUrl, {
              event: "meeting:agent-response",
              meetingId: meeting.meetingId,
              agent: "status",
              content: `_Agents requesting to speak: ${raiserNames}_`,
              telegram, topic,
            });
          }
        }
      }
    }

    // If chair called no agents, track it (safety valve)
    if (directives.calls.length === 0) {
      consecutiveNoCall++;
      if (consecutiveNoCall >= 2) {
        console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Chair made no calls for 2 turns, forcing end`);
        break;
      }
    } else {
      consecutiveNoCall = 0;
    }

    // === Run called agents ===
    const agentResponses = [];
    for (const call of directives.calls) {
      if (meeting.status !== "active") break;
      if (meeting.turnCount >= maxTurns) break;

      // Validate agent is in meeting
      if (!agents.includes(call.agent)) {
        console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Chair called unknown agent "${call.agent}", skipping`);
        // Add a system note to transcript
        meeting.transcript.push({
          role: "agent", agent: "system", name: "system",
          content: `(${call.agent} is not in this meeting)`,
          timestamp: nowIso(),
        });
        continue;
      }

      // Don't let chair call themselves
      if (call.agent === chair) {
        console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Chair tried to call themselves, skipping`);
        continue;
      }

      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Chair called ${call.agent}: "${call.question.substring(0, 80)}..."`);

      // Send thinking status
      if (callbackUrl && telegram) {
        const agentName = call.agent.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase());
        sendMeetingCallback(callbackUrl, {
          event: "meeting:agent-response",
          meetingId: meeting.meetingId,
          agent: "status",
          content: `${agentName} was called by the chair...`,
          telegram, topic,
          turn: meeting.turnCount + 1,
          maxTurns,
        });
      }

      const agentResult = await runMeetingAgentTurn(meeting, call.agent, call.question, { calledByChair: true });
      meeting.turnCount++;

      if (agentResult) {
        agentResponses.push(agentResult);
        // Track this agent as having spoken on the current topic
        topicSpeakers.add(call.agent);

        // Post to Telegram
        if (callbackUrl && telegram) {
          sendMeetingCallback(callbackUrl, {
            event: "meeting:agent-response",
            meetingId: meeting.meetingId,
            agent: agentResult.agent,
            content: agentResult.content,
            telegram, topic,
            turn: meeting.turnCount,
            maxTurns,
          });
        }
      }
    }

    // === Chair reviews and decides next action ===
    if (meeting.status !== "active" || meeting.turnCount >= maxTurns) break;

    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Chair (${chair}) reviewing responses... (turn ${meeting.turnCount + 1}/${maxTurns})`);

    if (callbackUrl && telegram) {
      const chairName = chair.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase());
      sendMeetingCallback(callbackUrl, {
        event: "meeting:agent-response",
        meetingId: meeting.meetingId,
        agent: "status",
        content: `${chairName} (chair) is reviewing... (turn ${meeting.turnCount + 1}/${maxTurns})`,
        telegram, topic,
      });
    }

    // Build chair follow-up prompt, including any hand-raisers from this iteration
    const chairResult = await runMeetingAgentTurn(meeting, chair, null, {
      isChairTurn: true,
      agentResponses,
      closedItems,
      handRaisers: pendingHandRaisers,
    });
    meeting.turnCount++;

    if (!chairResult || meeting.status !== "active") break;

    // Post chair response
    if (callbackUrl && telegram) {
      sendMeetingCallback(callbackUrl, {
        event: "meeting:agent-response",
        meetingId: meeting.meetingId,
        agent: chairResult.agent,
        content: chairResult.content,
        telegram, topic,
        turn: meeting.turnCount,
        maxTurns,
      });
    }

    // Parse new directives
    directives = parseChairDirectives(chairResult.content);
  }

  if (meeting.status !== "active") return;

  // === Generate structured outcomes (same as round-robin) ===
  console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Generating outcomes...`);

  // Reuse the shared outcomes generation from endAndFinalizeChairMeeting
  await generateAndFinalizeOutcomes(meeting);
}

/**
 * Shared outcomes generation and finalization for both meeting modes.
 * Generates structured outcomes via Claude, posts to Telegram, N8N, and dispatches actions.
 */
async function generateAndFinalizeOutcomes(meeting) {
  const { callbackUrl, telegram, topic } = meeting;

  const outcomesPrompt = buildOutcomesPrompt(meeting);
  const facilitatorModel = config.routing?.agentToModel?.[meeting.facilitator] || "sonnet";
  const selectedModel = selectModel(facilitatorModel, meeting.facilitator, null);

  const args = [...config.claude.baseArgs];
  args.push("--model", selectedModel);
  pushFallbackModel(args, facilitatorModel);
  args.push("-p");
  args.push("--output-format", "stream-json", "--verbose");
  if (meeting.facilitator) args.push("--agent", meeting.facilitator);

  // Per-product plugin directory for outcomes generation
  const outcomesProduct = resolveProduct(meeting.workingDir);
  applyProductPluginDir(args, outcomesProduct);

  const cliCmd = config.claude?.command || "claude";

  const outcomesResult = await new Promise((resolve) => {
    const proc = spawn(cliCmd, args, {
      cwd: meeting.workingDir,
      env: { ...process.env, ...getOAuthEnvVars() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.stdin.write(outcomesPrompt);
    proc.stdin.end();

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ content: "(outcomes generation timed out)", error: true });
    }, 180_000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      const textParts = [];
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t);
          if (ev.type === "assistant" && ev.message) {
            for (const b of (ev.message.content || [])) {
              if (b.type === "text" && b.text) textParts.push(b.text);
            }
          } else if (ev.type === "result" && ev.result) {
            if (!textParts.length) textParts.push(ev.result);
          }
        } catch {}
      }
      const content = textParts.join("").trim() || stderr.trim() || "(no outcomes generated)";
      resolve({ content, error: code !== 0 });
    });
  });

  // Detect [REQUIRES-APPROVAL] directive emitted by the outcomes LLM (extra signal, not relied on).
  // Strip the directive from the displayed summary so it doesn't leak into Telegram/Confluence.
  const requiresApprovalDirective = /^[ \t]*\[REQUIRES-APPROVAL\][ \t]*\r?\n/im.test(outcomesResult.content);
  const cleanSummary = outcomesResult.content.replace(/^[ \t]*\[REQUIRES-APPROVAL\][ \t]*\r?\n/im, "").trim();
  // Deterministic recompute: defends against lost in-memory flags (restart, DB reload, alt creation paths)
  // and against the LLM forgetting to emit [REQUIRES-APPROVAL]. Source of truth is the user's words.
  const intentResult = detectGateIntentForMeeting(meeting);
  let gated = intentResult.gated || requiresApprovalDirective;
  let gateSource = intentResult.gated ? intentResult.source : (requiresApprovalDirective ? "llm-directive" : null);
  let gateReason = null;

  // Implicit gate — fires when no explicit ask was made but the outcomes show
  // signals warranting human review (broad scope, schema changes, multi-product, etc.).
  // Cheap rules first, then optional LLM borderline judgment for ambiguous cases.
  if (!gated) {
    const ruleResult = detectImplicitGateNeed(meeting, cleanSummary);
    if (ruleResult) {
      gated = true;
      gateSource = ruleResult.source;
      gateReason = ruleResult.reason;
    } else {
      const llmResult = await judgeBorderlineGate(meeting, cleanSummary);
      if (llmResult) {
        gated = true;
        gateSource = llmResult.source;
        gateReason = llmResult.reason;
      }
    }
  }

  meeting.summary = cleanSummary;

  if (gated) {
    // Pause: hold dispatch + Confluence + N8N outcomes until /meeting/:id/decision is called.
    meeting.gateBeforeDispatch = true; // persist canonical truth
    meeting.status = "awaiting-approval";
    meeting.awaitingApproval = true;
    meeting.awaitingApprovalSince = nowIso();
    meeting.gateSource = gateSource;
    meeting.gateReason = gateReason;
    db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));

    // Strip agent:* labels from any issues meeting agents created mid-conversation,
    // BEFORE the user is told the meeting is awaiting approval. Stops the periodic
    // reconciler from racing the human and dispatching the work without approval.
    await quarantineMeetingCreatedIssues(meeting).catch(e =>
      console.error(`[meeting-quarantine] ${meeting.meetingId}: ${e.message}`)
    );

    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: GATED — awaiting approval (source=${gateSource}, reason=${gateReason || "n/a"}, directive=${requiresApprovalDirective}, flag=${meeting.gateBeforeDispatch})`);

    // Post the summary + approval instructions to Telegram (via existing N8N callback path).
    if (callbackUrl && telegram) {
      let outcomesText = cleanSummary;
      if (outcomesText.length > 3400) outcomesText = outcomesText.substring(0, 3400) + "\n…(truncated)";
      const isImplicit = gateSource && (gateSource.startsWith("rule:") || gateSource.startsWith("llm:"));
      const whyLine = isImplicit
        ? `_Auto-paused (${gateSource}): ${gateReason || "needs review"}._`
        : `_Nothing has been written to Jira and no agents have been dispatched._`;
      const prompt = [
        `*⏸ Meeting awaiting your input* — \`${meeting.meetingId}\``,
        ``,
        outcomesText,
        ``,
        whyLine,
        `Reply in admin DM:`,
        `• \`/approve ${meeting.meetingId}\` — dispatch all action items`,
        `• \`/reject ${meeting.meetingId}\` — discard, do nothing`,
        `• \`/refine ${meeting.meetingId} <your guidance>\` — keep discussing (max 3 rounds)`,
      ].join("\n");
      sendMeetingCallback(callbackUrl, {
        event: "meeting:agent-response",
        meetingId: meeting.meetingId,
        agent: "Meeting — Awaiting Approval",
        content: prompt,
        telegram, topic,
      });
    }

    if (config.sseEnabled) {
      jobEmitter.emit("meeting:awaiting-approval", { meetingId: meeting.meetingId, topic });
    }
    return;
  }

  // End meeting (ungated path — original behaviour)
  meeting.status = "ended";
  meeting.endedAt = nowIso();
  db.meetings.set(meeting).catch(e => console.error('[db] meeting update failed: ' + e.message));


  // Post outcomes to Telegram
  if (callbackUrl && telegram) {
    let outcomesText = meeting.summary;
    if (outcomesText.length > 3800) {
      outcomesText = outcomesText.substring(0, 3790) + "\n...(truncated)";
    }

    sendMeetingCallback(callbackUrl, {
      event: "meeting:agent-response",
      meetingId: meeting.meetingId,
      agent: "Meeting Outcomes",
      content: outcomesText,
      telegram, topic,
    });

    const duration = Math.round((new Date(meeting.endedAt) - new Date(meeting.createdAt)) / 1000);
    sendMeetingCallback(callbackUrl, {
      event: "meeting:ended",
      meetingId: meeting.meetingId,
      topic, summary: meeting.summary, telegram,
      messageCount: meeting.transcript.length,
      agents: meeting.agents,
      duration,
      mode: meeting.mode,
      turnCount: meeting.turnCount || 0,
    });
  }

  console.log(`[${nowIso()}] Meeting finalized: ${meeting.meetingId} mode=${meeting.mode} (${meeting.turnCount || 0} turns, ${meeting.transcript.length} messages)`);

  // Post outcomes to N8N + dispatch actions
  postMeetingOutcomes(meeting).catch(e => {
    console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: postMeetingOutcomes error: ${e.message}`);
  });

  dispatchMeetingActions(meeting).catch(e => {
    console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: dispatchMeetingActions error: ${e.message}`);
  });
}

/**
 * Detect action items that are just echoes of the meeting topic (Bug B).
 * Catches openers like "talk about", "discuss", "give an update on", "where do we stand on",
 * and items whose normalised body substantially overlaps with the topic.
 */
function isMeetingTopicEcho(task, topic) {
  if (!task) return false;
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const t = norm(task);
  if (!t) return false;
  const conversationalOpeners = /^(talk about|discuss|cover|review|address|debate|chat about|give (?:me )?(?:an )?update on|provide (?:an )?update on|where (?:do|are) we stand|read this|need an intro)/;
  if (conversationalOpeners.test(t)) return true;
  const topicNorm = norm(topic);
  if (topicNorm && topicNorm.length >= 8) {
    if (t === topicNorm) return true;
    const topicWords = new Set(topicNorm.split(" ").filter(w => w.length > 3));
    if (topicWords.size >= 3) {
      const taskWords = t.split(" ").filter(w => w.length > 3);
      const overlap = taskWords.filter(w => topicWords.has(w)).length;
      if (overlap / topicWords.size >= 0.8 && taskWords.length <= topicWords.size + 2) return true;
    }
  }
  return false;
}

/**
 * Parse action items from meeting summary and dispatch them as real runner jobs.
 * Pattern: "- [ ] [task] — Owner: [agent-name] — Priority: [High/Medium/Low]"
 * Also parses "## Bugs Identified" section and creates Jira bugs via engineer-planner.
 */
async function dispatchMeetingActions(meeting) {
  const summary = meeting.summary || "";
  if (!summary) return;

  // Map agent names used in meetings to actual agent identifiers
  const agentNameMap = {};
  for (const agentId of Object.values(config.agentLabels || {})) {
    agentNameMap[agentId] = agentId;
  }
  // Also accept natural names
  for (const agent of meeting.agents || []) {
    agentNameMap[agent] = agent;
  }

  // Parse bugs identified in meeting and dispatch as engineer-planner jobs to create + fix them
  const bugRegex = /- Summary:\s*(.+?)\s*[—–-]\s*Severity:\s*(Critical|Major|Minor)\s*[—–-]\s*RootCause:\s*(.+?)\s*[—–-]\s*Priority:\s*(High|Medium|Low)$/gim;
  let bugMatch;
  while ((bugMatch = bugRegex.exec(summary)) !== null) {
    const bugSummary = bugMatch[1].trim();
    const severity = bugMatch[2].trim();
    const rootCause = bugMatch[3].trim();
    const priority = bugMatch[4].trim();
    const priorityMap = { High: "High", Medium: "Medium", Low: "Low" };
    const jiraPriority = priorityMap[priority] || "Medium";
    const severityLabel = `severity-${severity.toLowerCase()}`;

    const bugPrompt = [
      `A bug was identified during a team meeting that requires immediate attention.`,
      ``,
      `**Meeting topic:** ${meeting.topic}`,
      `**Bug summary:** ${bugSummary}`,
      `**Severity:** ${severity}`,
      `**Root cause / suspected area:** ${rootCause}`,
      `**Priority:** ${priority}`,
      ``,
      `Your task:`,
      `1. Create a Jira Bug in project ${resolveJiraProject(meeting.productId || meeting.workingDir)} with the summary above.`,
      `2. Set the priority to ${jiraPriority}.`,
      `3. Set labels to: ["${severityLabel}", "agent:engineer-planner", "agent-created-bug"]`,
      `4. Add a description that includes:`,
      `   - Root cause: ${rootCause}`,
      `   - Source: Identified during meeting "${meeting.topic}" (meeting ID: ${meeting.meetingId})`,
      `   - Meeting decisions context (paste the relevant decisions from the meeting summary)`,
      `5. After creating the bug, post an \`[AUTO-PLAN]\` comment on the new issue with an initial investigation plan based on the root cause.`,
      `6. Then begin investigating and implementing the fix. Use the bug-fix workflow (investigate, implement, test, PR).`,
      ``,
      `Meeting summary for context:`,
      summary,
    ].join("\n");

    const jobId = makeJobId();
    const logFile = path.join(LOG_DIR, `${jobId}.log`);
    const metaFile = path.join(LOG_DIR, `${jobId}.json`);
    const job = {
      jobId,
      status: "queued",
      mode: "agent",
      agent: "engineer-planner",
      prompt: bugPrompt,
      context: "",
      workingDir: meeting.workingDir || config.workingDir || DEFAULT_WORKING_DIR,
      issueKey: null,
      model: config.routing?.agentToModel?.["engineer-planner"] || "opus",
      selectedModel: null,
      requestedProvider: null,
      callbackUrl: config.callbackUrl || null,
      logFile,
      metaFile,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      pid: null,
      output: null,
      error: null,
      retryCount: 0,
      maxRetries: config.maxRetries || 3,
      source: `meeting:${meeting.meetingId}`,
      meetingAction: { task: `Create and fix bug: ${bugSummary}`, priority, meetingId: meeting.meetingId, type: "agent-created-bug" },
    };

    jobs.set(jobId, job);
    db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${jobId}: ${e.message}`));
    queue.push({ jobId });
  
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Dispatched agent-created bug "${bugSummary.substring(0, 60)}" -> engineer-planner (job ${jobId})`);

    if (config.sseEnabled) {
      jobEmitter.emit("job:queued", { jobId, agent: "engineer-planner", source: `meeting:${meeting.meetingId}`, type: "agent-created-bug" });
    }
  }

  // Parse action items — with optional Schedule and DependsOn fields
  // Groups: 1=task, 2=owner, 3=priority, 4=scheduleStr, 5=dependsOnStr
  const actionRegex = /- \[ \] (.+?)(?:\s*[—–-]\s*Owner:\s*\*{0,2}(\S+?)\*{0,2}\s*[—–-]\s*Priority:\s*\*{0,2}(High|Medium|Low)\*{0,2})(?:\s*[—–-]\s*Schedule:\s*([^—–\n\r]+?))?(?:\s*[—–-]\s*DependsOn:\s*\[([^\]]*)\])?$/gim;
  const actions = [];
  let match;
  while ((match = actionRegex.exec(summary)) !== null) {
    const task = match[1].trim();
    let owner = match[2].trim().replace(/\*+/g, "");
    const priority = match[3].trim();
    const scheduleStr = match[4]?.trim() || null;
    const dependsOnStr = match[5]?.trim() || null;
    const dependsOn = dependsOnStr
      ? dependsOnStr.split(",").map(s => parseInt(s.trim(), 10) - 1).filter(n => Number.isFinite(n) && n >= 0)
      : [];
    // Strip namespace prefixes like "meshwork:" that agents sometimes add
    if (owner.includes(":")) {
      owner = owner.split(":").pop();
    }
    if (!agentNameMap[owner]) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Skipping action item — unknown owner "${owner}" (original: ${match[2]})`);
      continue;
    }
    // Filter out items that are just restatements of the meeting topic (Bug B)
    if (isMeetingTopicEcho(task, meeting.topic)) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Skipping action item — looks like a meeting-topic echo: "${task.substring(0, 80)}"`);
      continue;
    }
    actions.push({ task, owner, priority, scheduleStr, dependsOn });
  }

  // Parse follow-up meetings
  const followUpMeetings = [];
  const meetingRegex = /- Topic:\s*(.+?)\s*[—–-]\s*Agents?:\s*(.+?)\s*[—–-]\s*Schedule:\s*(.+?)$/gim;
  while ((match = meetingRegex.exec(summary)) !== null) {
    const topic = match[1].trim();
    const agentsStr = match[2].trim();
    const scheduleStr = match[3].trim();
    const agents = agentsStr.split(/[,\s]+/).map(a => a.trim().replace(/\*+/g, "")).filter(Boolean);
    // Strip namespace prefixes from agents
    const cleanAgents = agents.map(a => a.includes(":") ? a.split(":").pop() : a);
    followUpMeetings.push({ topic, agents: cleanAgents, scheduleStr });
  }

  const totalItems = actions.length + followUpMeetings.length;
  if (totalItems === 0) {
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: No dispatchable action items or follow-up meetings found in summary`);
    return;
  }

  console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Processing ${actions.length} action items + ${followUpMeetings.length} follow-up meetings (bugs already dispatched above)`);

  const actionJiraProject = resolveJiraProject(meeting.productId || meeting.workingDir);
  const actionProductName = (meeting.productId && products.get(meeting.productId)?.name) || meeting.productId || "";

  // ── Tier classification — prevent duplicate Jira stories per meeting.
  // Tier 1 (storyCreators: ba-agent, product-manager) own story creation.
  // Tier 2 (enrichers: ux-agent, engineer-planner, etc.) must comment on
  // tier-1 stories rather than create their own. Tier 2 jobs are gated on
  // tier 1 via blockedByJobIds so they only run after stories exist.
  const tierConfig = config.meetings?.actionItemTiers || {};
  const storyCreators = new Set(tierConfig.storyCreators || ["ba-agent", "product-manager"]);
  const enrichers = new Set(tierConfig.enrichers || ["ux-agent", "engineer-planner", "architect", "security-agent", "qa-agent", "ui-engineer", "ask-dave-agent"]);
  const tierOf = (owner) => {
    if (storyCreators.has(owner)) return 1;
    if (enrichers.has(owner)) return 2;
    return 0;
  };
  const tier1Indices = [];
  const tier2Indices = [];
  for (let i = 0; i < actions.length; i++) {
    const t = tierOf(actions[i].owner);
    if (t === 1) tier1Indices.push(i);
    else if (t === 2) tier2Indices.push(i);
  }
  // Auto-wire tier-2 dependencies on tier-1 (only if the agent author didn't set explicit deps).
  if (tier1Indices.length > 0) {
    for (const t2idx of tier2Indices) {
      if (!actions[t2idx].dependsOn || actions[t2idx].dependsOn.length === 0) {
        actions[t2idx].dependsOn = [...tier1Indices];
        actions[t2idx].autoTieredDep = true;
      }
    }
    if (tier2Indices.length > 0) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Tier-gated dispatch — tier1=[${tier1Indices.join(",")}] tier2=[${tier2Indices.join(",")}]`);
    }
  }

  // Jira auth for creating meeting-action tasks
  const { domain: jiraDomain, email: jiraEmail, apiToken: jiraApiToken } = config.jira || {};
  const canCreateJiraTasks = !!(jiraDomain && jiraEmail && jiraApiToken);
  const jiraAuthHeader = canCreateJiraTasks ? "Basic " + Buffer.from(`${jiraEmail}:${jiraApiToken}`).toString("base64") : null;
  const jiraBaseUrl = jiraDomain ? jiraDomain.replace(/\/+$/, "") : "";
  const jiraHeaders = jiraAuthHeader ? { authorization: jiraAuthHeader } : {};

  // ── Pass 1: create all Jira tasks + build all immediate job objects.
  // Nothing is pushed to the queue yet so no job can start before deps are wired.
  const pendingJobs = []; // { job, actionIdx } — immediate-dispatch only
  const jobIdsByIdx = {}; // actionIdx → jobId
  const issueKeysByIdx = {}; // actionIdx → issueKey

  for (let actionIdx = 0; actionIdx < actions.length; actionIdx++) {
    const action = actions[actionIdx];
    const tier = tierOf(action.owner);
    const meetingStoryLabel = `meeting:${meeting.meetingId}`;

    let tierGuidance = "";
    if (tier === 1) {
      // Story creators: tag their stories so tier-2 enrichers can find them.
      tierGuidance = [
        ``,
        `**Tier 1 — story creator role:**`,
        `- If this action requires you to create a Jira Story, add the label \`${meetingStoryLabel}\` to it so other agents from this meeting can locate it.`,
        `- Create ONE story per distinct scope. Do not create multiple stories for the same outcome.`,
      ].join("\n");
    } else if (tier === 2) {
      // Enrichers: forbidden from creating new Stories. Must comment on tier-1 output.
      tierGuidance = [
        ``,
        `**Tier 2 — enrichment role (STRICT):**`,
        `- DO NOT create new Jira Stories. This work is enrichment of an existing Story produced by a Tier 1 agent (BA / PM) in the same meeting.`,
        `- Find the parent Story via JQL: \`project = ${actionJiraProject} AND labels = "${meetingStoryLabel}" AND issuetype = Story\``,
        `- Add your output (audit findings, tech assessment, UX spec, etc.) as a COMMENT on the most relevant parent Story.`,
        `- Use a prefixed header in your comment, e.g. \`[UX-AUDIT]\`, \`[TECH-ASSESSMENT]\`, \`[SECURITY-REVIEW]\`, so other agents can find your contribution.`,
        `- Your meeting Task (this ticket) IS your work container — close it when complete; the Story does the long-term tracking.`,
        `- If you cannot find a parent Story (Tier 1 produced none), add your output as a comment on THIS meeting Task and flag it in your report — do not silently create a new Story.`,
      ].join("\n");
    }

    const prompt = [
      `You were in a meeting and committed to the following action item:`,
      ``,
      `**Task:** ${action.task}`,
      `**Priority:** ${action.priority}`,
      `**Meeting topic:** ${meeting.topic}`,
      actionProductName ? `**Product:** ${actionProductName}` : "",
      `**Jira Project:** ${actionJiraProject} — ALL Jira issues MUST be created in project ${actionJiraProject}. Do NOT use any other project key.`,
      tierGuidance,
      ``,
      `Meeting decisions and context:`,
      summary,
      ``,
      `Execute this task now. Be thorough and report what you did.`,
    ].filter(Boolean).join("\n");

    // Create a Jira Task for this action item so the job is linked in the dashboard
    let actionIssueKey = null;
    if (canCreateJiraTasks) {
      try {
        const agentLabel = `agent:${action.owner}`;
        const taskSummary = `[Meeting] ${action.task}`.substring(0, 255);
        const priorityMap = { High: "High", Medium: "Medium", Low: "Low" };
        const taskPayload = {
          fields: {
            project: { key: actionJiraProject },
            summary: taskSummary,
            description: {
              type: "doc",
              version: 1,
              content: [{
                type: "paragraph",
                content: [{
                  type: "text",
                  text: `Action item from meeting "${meeting.topic}" (${meeting.meetingId}).\n\nTask: ${action.task}\nOwner: ${action.owner}\nPriority: ${action.priority}`
                }]
              }]
            },
            issuetype: { name: "Task" },
            labels: ["meeting-action", agentLabel],
            priority: { name: priorityMap[action.priority] || "Medium" },
          }
        };
        const createRes = await postJson(`${jiraBaseUrl}/rest/api/3/issue`, taskPayload, jiraHeaders);
        if (createRes.statusCode === 201) {
          try { actionIssueKey = JSON.parse(createRes.body)?.key; } catch (_) {}
          console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Created Jira task ${actionIssueKey} for action "${action.task.substring(0, 60)}..."`);
          if (actionIssueKey) {
            await transitionIssueToInProgress(actionIssueKey);
          }
        } else {
          console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Jira task creation failed (${createRes.statusCode}): ${(createRes.body || "").substring(0, 200)}`);
        }
      } catch (e) {
        console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: Jira task creation error: ${e.message}`);
      }
    }
    issueKeysByIdx[actionIdx] = actionIssueKey;

    const scheduledAt = action.scheduleStr ? parseScheduleTime(action.scheduleStr) : null;

    if (scheduledAt && scheduledAt > new Date()) {
      // Scheduled items fire via tickScheduler — dependencies not tracked for these
      const schedId = scheduleItem({
        type: "job",
        scheduledAt: scheduledAt.toISOString(),
        status: "pending",
        source: `meeting:${meeting.meetingId}`,
        data: {
          agent: action.owner,
          prompt,
          workingDir: meeting.workingDir || config.workingDir || DEFAULT_WORKING_DIR,
          task: action.task,
          priority: action.priority,
          issueKey: actionIssueKey,
        },
      });
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Scheduled action "${action.task.substring(0, 60)}..." -> ${action.owner} for ${scheduledAt.toISOString()} (${schedId})`);
    } else {
      // Build job object but do NOT queue yet
      const jobId = makeJobId();
      const logFile = path.join(LOG_DIR, `${jobId}.log`);
      const metaFile = path.join(LOG_DIR, `${jobId}.json`);
      const job = {
        jobId,
        status: "queued",
        mode: "agent",
        agent: action.owner,
        prompt,
        context: "",
        workingDir: meeting.workingDir || config.workingDir || DEFAULT_WORKING_DIR,
        issueKey: actionIssueKey,
        model: config.routing?.agentToModel?.[action.owner] || "sonnet",
        selectedModel: null,
        requestedProvider: null,
        callbackUrl: config.callbackUrl || null,
        logFile,
        metaFile,
        createdAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        pid: null,
        output: null,
        error: null,
        retryCount: 0,
        maxRetries: config.maxRetries || 3,
        source: `meeting:${meeting.meetingId}`,
        meetingAction: { task: action.task, priority: action.priority, meetingId: meeting.meetingId },
        blockedByJobIds: [], // populated in pass 2
      };
      jobs.set(jobId, job);
      jobIdsByIdx[actionIdx] = jobId;
      pendingJobs.push({ job, actionIdx });
    }
  }

  // ── Pass 2: wire dependencies, then enqueue everything atomically.
  // Set Jira blocks/is-blocked-by links and blockedByJobIds before anything can start.
  const linkPromises = [];
  for (const { job, actionIdx } of pendingJobs) {
    const action = actions[actionIdx];
    if (!action.dependsOn?.length) continue;

    const validDeps = action.dependsOn.filter(depIdx => depIdx >= 0 && depIdx < actions.length && depIdx !== actionIdx);
    if (!validDeps.length) continue;

    // Jira links (fire-and-forget, best effort)
    if (canCreateJiraTasks) {
      for (const depIdx of validDeps) {
        const depKey = issueKeysByIdx[depIdx];
        const thisKey = issueKeysByIdx[actionIdx];
        if (depKey && thisKey) {
          linkPromises.push(
            postJson(`${jiraBaseUrl}/rest/api/3/issueLink`, {
              type: { name: "Blocks" },
              inwardIssue: { key: depKey },
              outwardIssue: { key: thisKey },
            }, jiraHeaders).catch(e => {
              console.error(`[${nowIso()}] Meeting ${meeting.meetingId}: Failed to set Jira link ${depKey} blocks ${thisKey}: ${e.message}`);
            })
          );
        }
      }
    }

    // In-memory dependency gate
    job.blockedByJobIds = validDeps
      .map(depIdx => jobIdsByIdx[depIdx])
      .filter(Boolean);
  }

  if (linkPromises.length) {
    await Promise.all(linkPromises);
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Set ${linkPromises.length} Jira dependency link(s)`);
  }

  // Enqueue all immediate jobs now that deps are fully wired
  for (const { job } of pendingJobs) {
    db.jobs.set(job).catch(e => console.error(`[db] Failed to persist job ${job.jobId}: ${e.message}`));
    queue.push({ jobId: job.jobId });
    const blockedNote = job.blockedByJobIds?.length ? ` [blocked by: ${job.blockedByJobIds.join(", ")}]` : "";
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Queued action "${(job.meetingAction?.task || "").substring(0, 60)}..." -> ${job.agent} (job ${job.jobId}, issueKey: ${job.issueKey || "none"}${blockedNote})`);
    if (config.sseEnabled) {
      jobEmitter.emit("job:queued", { jobId: job.jobId, agent: job.agent, source: job.source });
    }
  }

  if (pendingJobs.length) tickWorker();

  // Schedule follow-up meetings (with dedup)
  for (const fm of followUpMeetings) {
    const scheduledAt = parseScheduleTime(fm.scheduleStr);
    if (!scheduledAt) {
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Could not parse follow-up meeting schedule "${fm.scheduleStr}", skipping`);
      continue;
    }

    // Dedup: skip if same topic is already active or scheduled
    const dup = checkMeetingDuplicate(fm.topic);
    if (dup.duplicate) {
      const msg = dup.reason === "active"
        ? `already active as ${dup.existingId}`
        : `already scheduled as ${dup.existingId} for ${dup.scheduledAt}`;
      console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Skipping follow-up "${fm.topic}" — ${msg}`);
      continue;
    }

    const schedId = scheduleItem({
      type: "meeting",
      scheduledAt: scheduledAt.toISOString(),
      status: "pending",
      source: `meeting:${meeting.meetingId}`,
      data: {
        topic: fm.topic,
        agents: fm.agents,
        facilitator: fm.agents[0],
        maxRounds: 3,
        workingDir: meeting.workingDir || DEFAULT_WORKING_DIR,
        telegram: meeting.telegram || null,
        callbackUrl: meeting.callbackUrl || N8N_CALLBACK_URL || null,
      },
    });
    console.log(`[${nowIso()}] Meeting ${meeting.meetingId}: Scheduled follow-up meeting "${fm.topic.substring(0, 60)}" with [${fm.agents.join(",")}] for ${scheduledAt.toISOString()} (${schedId})`);
  }

  // Kick the queue for immediate items
  tickWorker();
}

async function runMeetingAgentTurn(meeting, agent, triggerMessage, options = {}) {
  if (meeting.status !== "active") return null;
  meeting.currentSpeaker = agent;

  // Chair mode: use chair-specific or called-agent prompts
  let prompt;
  if (meeting.mode === "chair") {
    if (options.isChairTurn) {
      prompt = buildChairPrompt(meeting, {
        isOpening: !meeting.transcript.some(t => t.agent === meeting.chair),
        agentResponses: options.agentResponses || [],
        closedItems: options.closedItems || [],
        handRaisers: options.handRaisers || [],
      });
    } else if (options.calledByChair && triggerMessage) {
      prompt = buildCalledAgentPrompt(meeting, agent, triggerMessage);
    } else {
      prompt = buildMeetingPrompt(meeting, agent, triggerMessage, options);
    }
  } else {
    prompt = buildMeetingPrompt(meeting, agent, triggerMessage, options);
  }
  const model = config.routing?.agentToModel?.[agent] || "sonnet";
  const selectedModel = selectModel(model, agent, null);

  const jobId = makeJobId();
  const logFile = path.join(LOG_DIR, `${jobId}.log`);

  // Build Claude CLI args
  const args = [...config.claude.baseArgs];
  args.push("--model", selectedModel);
  pushFallbackModel(args, model);
  args.push("-p");
  args.push("--output-format", "stream-json", "--verbose");
  if (agent) args.push("--agent", agent);

  // Enable MCP tools during meetings so agents can look up Jira issues,
  // check statuses, and take real actions (not just talk about them)
  const meetingAllowedTools = config.meetings?.allowedTools;
  if (meetingAllowedTools && meetingAllowedTools.length > 0) {
    args.push("--allowedTools", ...meetingAllowedTools);
  }

  // Per-product plugin directory for meetings — use productId first, fall back to workingDir
  const meetingProduct = meeting.productId
    ? products.get(meeting.productId)
    : resolveProduct(meeting.workingDir);
  applyProductPluginDir(args, meetingProduct);

  const cliCmd = config.claude?.command || "claude";

  return new Promise((resolve) => {
    const proc = spawn(cliCmd, args, {
      cwd: meeting.workingDir,
      env: { ...process.env, ...getOAuthEnvVars() },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    // Send prompt via stdin
    proc.stdin.write(prompt);
    proc.stdin.end();

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ agent, content: "(timed out)", error: true });
    }, 180_000); // 3 min timeout — longer to allow tool calls

    proc.on("close", (code) => {
      clearTimeout(timeout);
      meeting.currentSpeaker = null;

      // Extract assistant text from stream-json events
      let content = "";
      const textParts = [];
      const lines = stdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (event.type === "assistant" && event.message) {
            for (const block of (event.message.content || [])) {
              if (block.type === "text" && block.text) {
                textParts.push(block.text);
              }
            }
          } else if (event.type === "result" && event.result) {
            // Fallback: use result field if it has content
            if (!textParts.length) textParts.push(event.result);
          }
        } catch { /* skip non-JSON lines */ }
      }
      content = textParts.join("").trim() || stderr.trim() || "(no response)";

      // Truncate for Telegram (4096 limit minus overhead)
      if (content.length > 3500) {
        content = content.substring(0, 3490) + "\n...(truncated)";
      }

      // Add to transcript
      meeting.transcript.push({
        role: "agent",
        agent,
        name: agent,
        content,
        timestamp: nowIso(),
      });
    

      resolve({ agent, content, error: code !== 0 });
    });
  });
}

/**
 * Close the matching [Meeting] Jira task when a meeting-dispatched job succeeds.
 * Searches Jira for the task by summary/label match and transitions to Done.
 * Uses direct Jira REST API — no Claude CLI overhead.
 */
async function closeMeetingJiraTask(job) {
  if (!job.meetingAction?.task || job.status !== "succeeded") return;

  const { domain, email, apiToken } = config.jira || {};
  if (!domain || !email || !apiToken) {
    console.log(`[${nowIso()}] Meeting task closure skipped: JIRA_DOMAIN/JIRA_EMAIL/JIRA_API_TOKEN not configured`);
    return;
  }

  const authHeader = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const baseUrl = domain.replace(/\/+$/, "");
  const headers = { authorization: authHeader };

  try {
    // Use job.issueKey directly if available (created by dispatchMeetingActions)
    let issueKey = job.issueKey;

    // Fallback: search Jira by text match for legacy jobs without issueKey
    if (!issueKey) {
      const taskSnippet = (job.meetingAction.task || "").substring(0, 80).replace(/[^\w\s]/g, " ").trim();
      if (!taskSnippet) return;
      const projectKey = resolveJiraProject(job.workingDir);
      const jql = encodeURIComponent(`project = ${projectKey} AND labels = meeting-action AND summary ~ "[Meeting]" AND text ~ "${taskSnippet.substring(0, 40)}" AND status != Done`);
      const searchRes = await getJson(`${baseUrl}/rest/api/3/search?jql=${jql}&fields=key,summary,status&maxResults=5`, headers);

      if (searchRes.statusCode !== 200 || !searchRes.json?.issues?.length) {
        console.log(`[${nowIso()}] Meeting task closure for job ${job.jobId}: No matching task found (no issueKey, text search failed)`);
        return;
      }
      issueKey = searchRes.json.issues[0].key;
    }

    // Get transitions and transition to Done
    const transRes = await getJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, headers);
    const transitions = transRes.json?.transitions || [];
    const doneTrans = transitions.find(t => t.name?.toLowerCase() === "done");
    if (!doneTrans) {
      console.log(`[${nowIso()}] Meeting task closure for job ${job.jobId}: ${issueKey} has no Done transition`);
      return;
    }

    const result = await postJson(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: doneTrans.id } }, headers);
    if (result.statusCode === 204 || result.statusCode === 200) {
      console.log(`[${nowIso()}] Meeting task closure for job ${job.jobId}: Closed ${issueKey}`);
    } else {
      console.log(`[${nowIso()}] Meeting task closure for job ${job.jobId}: transition failed for ${issueKey} (${result.statusCode})`);
    }
  } catch (e) {
    console.error(`[${nowIso()}] Meeting task closure error: ${e.message}`);
  }
}

/**
 * Meeting gate quarantine.
 *
 * Meeting agents can create Jira issues with `agent:*` labels mid-conversation
 * (via the Jira MCP). When the meeting then gates on approval, the periodic
 * agent-label reconciler (every 15 min) can pick those issues up and dispatch
 * them BEFORE the user approves — bypassing the gate entirely.
 *
 * Fix: on gate fire, find every issue created in the meeting's product project
 * during the meeting window that carries any `agent:*` label, strip those
 * labels, replace with `meeting-pending-approval`, and save the originals on
 * the meeting record so /approve can restore them.
 */
const MEETING_QUARANTINE_LABEL = "meeting-pending-approval";

async function quarantineMeetingCreatedIssues(meeting) {
  if (!meeting?.productId || !meeting?.createdAt) return;
  const product = products.get(meeting.productId);
  const projectKey = product?.jira?.projectKey;
  if (!projectKey) return;

  const agentLabelMap = config.agentLabels || {};
  const agentLabelKeys = Object.keys(agentLabelMap);
  if (!agentLabelKeys.length) return;

  // Jira JQL datetime: "yyyy-MM-dd HH:mm" (no seconds, no T separator).
  const startStr = meeting.createdAt.replace("T", " ").substring(0, 16);
  const labelClause = agentLabelKeys.map(l => `"${l}"`).join(", ");
  const jql = encodeURIComponent(
    `project = ${projectKey} AND created >= "${startStr}" AND labels in (${labelClause})`
  );

  try {
    const res = await jiraRestGet(`/search/jql?jql=${jql}&fields=labels&maxResults=50`);
    if (!res || res.statusCode !== 200) {
      console.log(`[meeting-quarantine] ${meeting.meetingId}: JQL search failed (${res?.statusCode || "no response"})`);
      return;
    }
    const issues = res.json?.issues || [];
    if (!issues.length) {
      console.log(`[meeting-quarantine] ${meeting.meetingId}: no agent-labelled issues created during meeting`);
      return;
    }

    meeting.gatedIssueLabels = meeting.gatedIssueLabels || {};

    for (const issue of issues) {
      const issueKey = issue.key;
      const labels = issue.fields?.labels || [];
      const agentLabels = labels.filter(l => agentLabelMap[l]);
      if (!agentLabels.length) continue;
      // If we've already quarantined this one (e.g., from a prior refine cycle), preserve original map.
      if (!meeting.gatedIssueLabels[issueKey]) {
        meeting.gatedIssueLabels[issueKey] = agentLabels;
      }
      const newLabels = labels.filter(l => !agentLabelMap[l]);
      if (!newLabels.includes(MEETING_QUARANTINE_LABEL)) newLabels.push(MEETING_QUARANTINE_LABEL);
      try {
        await jiraRestPut(`/issue/${issueKey}`, { fields: { labels: newLabels } });
        console.log(`[meeting-quarantine] ${meeting.meetingId}/${issueKey}: stripped [${agentLabels.join(", ")}], added ${MEETING_QUARANTINE_LABEL}`);
      } catch (e) {
        console.error(`[meeting-quarantine] ${meeting.meetingId}/${issueKey}: PUT failed: ${e.message}`);
      }
    }
    db.meetings.set(meeting).catch(e => console.error(`[db] meeting quarantine save failed: ${e.message}`));
  } catch (e) {
    console.error(`[meeting-quarantine] ${meeting.meetingId}: error: ${e.message}`);
  }
}

async function unquarantineMeetingCreatedIssues(meeting) {
  const savedMap = meeting?.gatedIssueLabels || {};
  const keys = Object.keys(savedMap);
  if (!keys.length) return;
  for (const issueKey of keys) {
    const saved = savedMap[issueKey] || [];
    try {
      const res = await jiraRestGet(`/issue/${issueKey}?fields=labels`);
      if (!res || res.statusCode !== 200) continue;
      const labels = res.json?.fields?.labels || [];
      const restored = labels.filter(l => l !== MEETING_QUARANTINE_LABEL);
      for (const l of saved) if (!restored.includes(l)) restored.push(l);
      await jiraRestPut(`/issue/${issueKey}`, { fields: { labels: restored } });
      console.log(`[meeting-unquarantine] ${meeting.meetingId}/${issueKey}: restored [${saved.join(", ")}], removed ${MEETING_QUARANTINE_LABEL}`);
    } catch (e) {
      console.error(`[meeting-unquarantine] ${meeting.meetingId}/${issueKey}: failed: ${e.message}`);
    }
  }
}

async function clearMeetingQuarantineOnly(meeting) {
  const savedMap = meeting?.gatedIssueLabels || {};
  const keys = Object.keys(savedMap);
  if (!keys.length) return;
  for (const issueKey of keys) {
    try {
      const res = await jiraRestGet(`/issue/${issueKey}?fields=labels`);
      if (!res || res.statusCode !== 200) continue;
      const labels = res.json?.fields?.labels || [];
      const filtered = labels.filter(l => l !== MEETING_QUARANTINE_LABEL);
      if (filtered.length === labels.length) continue;
      await jiraRestPut(`/issue/${issueKey}`, { fields: { labels: filtered } });
      console.log(`[meeting-quarantine-clear] ${meeting.meetingId}/${issueKey}: removed ${MEETING_QUARANTINE_LABEL} (work rejected)`);
    } catch (e) {
      console.error(`[meeting-quarantine-clear] ${meeting.meetingId}/${issueKey}: failed: ${e.message}`);
    }
  }
}
