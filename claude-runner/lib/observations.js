"use strict";

/**
 * Structured observations protocol — pure helpers shared by runner.js and the
 * test suite.
 *
 * Agents emit OBSERVATIONS (findings with severity + evidence, AC checks);
 * the ENGINE computes gate verdicts from them via a thin policy layer. This
 * replaces agent self-issued verdicts for gates that opt in
 * (gate.structured: true in pipeline config), dual-running with the legacy
 * comment-prefix protocol: when no observations are submitted, the prefix
 * path still applies.
 *
 * Also houses the finding-set comparison used by the verification sampling
 * loop (adversarial second review → overturn-rate measurement).
 *
 * No config, network, or filesystem access — keep it that way so the unit
 * tests stay hermetic.
 */

const SEVERITIES = ["critical", "major", "minor", "info"];
const AC_STATUSES = ["met", "gap", "partial"];
const ROOT_CAUSES = ["spec-ambiguity", "reviewer-omission", "implementer-error", "context-starvation", "other"];
const SCHEMA_ID = "meshwork.observations/v1";

const MAX_FINDINGS = 200;
const MAX_AC_CHECKS = 100;
const MAX_TEXT = 4000;

function clampText(val, max = MAX_TEXT) {
  if (val == null) return null;
  const s = String(val);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Validate and normalise an observations payload.
 * Returns { ok, errors: string[], observations|null }.
 * Strict on shape (unknown severities/statuses are errors, not coerced) so
 * malformed submissions are rejected with actionable messages the agent can
 * retry on — silent coercion would defeat the point of a structured channel.
 */
function validateObservations(input) {
  const errors = [];
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["payload must be a JSON object"], observations: null };
  }

  const out = {
    schema: SCHEMA_ID,
    agent: input.agent ? String(input.agent).slice(0, 100) : null,
    gate: input.gate ? String(input.gate).slice(0, 100) : null,
    summary: clampText(input.summary),
    findings: [],
    acChecks: [],
  };

  const findings = input.findings == null ? [] : input.findings;
  if (!Array.isArray(findings)) {
    errors.push("findings must be an array");
  } else {
    if (findings.length > MAX_FINDINGS) errors.push(`findings exceeds maximum of ${MAX_FINDINGS}`);
    findings.slice(0, MAX_FINDINGS).forEach((f, i) => {
      if (f == null || typeof f !== "object") {
        errors.push(`findings[${i}] must be an object`);
        return;
      }
      const severity = String(f.severity || "").toLowerCase();
      if (!SEVERITIES.includes(severity)) {
        errors.push(`findings[${i}].severity must be one of [${SEVERITIES.join(", ")}], got "${f.severity}"`);
        return;
      }
      if (!f.title || typeof f.title !== "string") {
        errors.push(`findings[${i}].title is required (short description of the issue)`);
        return;
      }
      const finding = {
        severity,
        title: clampText(f.title, 300),
        file: f.file ? clampText(f.file, 500) : null,
        line: Number.isInteger(f.line) && f.line > 0 ? f.line : null,
        detail: clampText(f.detail),
        evidence: clampText(f.evidence, 1000),
      };
      if (f.cause != null) {
        const cause = String(f.cause).toLowerCase();
        if (!ROOT_CAUSES.includes(cause)) {
          errors.push(`findings[${i}].cause must be one of [${ROOT_CAUSES.join(", ")}], got "${f.cause}"`);
          return;
        }
        finding.cause = cause;
      }
      out.findings.push(finding);
    });
  }

  const acChecks = input.acChecks == null ? [] : input.acChecks;
  if (!Array.isArray(acChecks)) {
    errors.push("acChecks must be an array");
  } else {
    if (acChecks.length > MAX_AC_CHECKS) errors.push(`acChecks exceeds maximum of ${MAX_AC_CHECKS}`);
    acChecks.slice(0, MAX_AC_CHECKS).forEach((c, i) => {
      if (c == null || typeof c !== "object") {
        errors.push(`acChecks[${i}] must be an object`);
        return;
      }
      const status = String(c.status || "").toLowerCase();
      if (!AC_STATUSES.includes(status)) {
        errors.push(`acChecks[${i}].status must be one of [${AC_STATUSES.join(", ")}], got "${c.status}"`);
        return;
      }
      if (!c.id || typeof c.id !== "string") {
        errors.push(`acChecks[${i}].id is required (e.g. "AC1")`);
        return;
      }
      out.acChecks.push({
        id: clampText(c.id, 100),
        status,
        evidence: clampText(c.evidence, 1000),
      });
    });
  }

  if (errors.length > 0) return { ok: false, errors, observations: null };
  return { ok: true, errors: [], observations: out };
}

/**
 * Thin policy layer: hard floors only, model judgment stays above them.
 * policy: {
 *   failOnSeverity: "critical" (any finding at or above this severity fails),
 *   maxCounts: { critical: 0, major: null, ... } (optional per-severity caps),
 *   failOnAcGap: true (any acCheck with status "gap" fails)
 * }
 * Returns { passed, verdict: "PASS"|"CHANGES-REQUESTED", reasons: string[] }.
 */
function evaluateObservationPolicy(observations, policy = {}) {
  const reasons = [];
  const findings = observations?.findings || [];
  const acChecks = observations?.acChecks || [];

  const failOnSeverity = SEVERITIES.includes(String(policy.failOnSeverity || "").toLowerCase())
    ? String(policy.failOnSeverity).toLowerCase()
    : "critical";
  const failRank = SEVERITIES.indexOf(failOnSeverity);

  const counts = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  for (const sev of SEVERITIES) {
    if (SEVERITIES.indexOf(sev) <= failRank && counts[sev] > 0) {
      reasons.push(`${counts[sev]} ${sev} finding(s) (floor: zero at severity "${failOnSeverity}" or above)`);
    }
  }

  const maxCounts = policy.maxCounts || {};
  for (const sev of SEVERITIES) {
    const cap = maxCounts[sev];
    if (cap != null && Number.isInteger(cap) && counts[sev] > cap) {
      reasons.push(`${counts[sev]} ${sev} finding(s) exceeds cap of ${cap}`);
    }
  }

  if (policy.failOnAcGap !== false) {
    const gaps = acChecks.filter((c) => c.status === "gap");
    if (gaps.length > 0) {
      reasons.push(`${gaps.length} acceptance criteria gap(s): ${gaps.map((g) => g.id).join(", ")}`);
    }
  }

  const passed = reasons.length === 0;
  return { passed, verdict: passed ? "PASS" : "CHANGES-REQUESTED", reasons, counts };
}

/** Normalise a finding for matching: file path + lowercased title tokens. */
function findingKeyTokens(f) {
  const title = String(f.title || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
  return new Set(title.split(/\s+/).filter((t) => t.length > 3));
}

function sameFinding(a, b) {
  const fileA = (a.file || "").replace(/^\.\//, "");
  const fileB = (b.file || "").replace(/^\.\//, "");
  if (fileA && fileB && fileA !== fileB) return false;
  if (fileA && fileB && a.line && b.line && Math.abs(a.line - b.line) <= 5) return true;
  const ta = findingKeyTokens(a);
  const tb = findingKeyTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap / Math.min(ta.size, tb.size) >= 0.5;
}

/**
 * Compare a first review's findings against an adversarial second review's.
 * Returns { newFindings, overturn, rootCauses } where newFindings are the
 * second reviewer's findings not matched in the first set, overturn is true
 * when any new finding is critical or major, and rootCauses tallies the
 * `cause` tags on new findings (the measurement the sampling loop exists for).
 */
function compareFindings(firstFindings, secondFindings) {
  const first = Array.isArray(firstFindings) ? firstFindings : [];
  const second = Array.isArray(secondFindings) ? secondFindings : [];
  const newFindings = second.filter((s) => !first.some((f) => sameFinding(f, s)));
  const overturn = newFindings.some((f) => f.severity === "critical" || f.severity === "major");
  const rootCauses = {};
  for (const f of newFindings) {
    const cause = f.cause || "other";
    rootCauses[cause] = (rootCauses[cause] || 0) + 1;
  }
  return { newFindings, overturn, rootCauses };
}

/**
 * Render the engine-posted audit projection comment for a structured gate.
 * Keeps the legacy prefix + VERDICT line so humans and existing N8N consumers
 * see exactly the trail they already know — the prefix is demoted from
 * control signal to projection, not removed.
 */
function renderObservationsComment(prefix, policyResult, observations) {
  const lines = [
    `${prefix} VERDICT: ${policyResult.verdict}`,
    ``,
    `_Engine-computed from structured observations (${observations.findings.length} finding(s), ${observations.acChecks.length} AC check(s))._`,
  ];
  if (!policyResult.passed) {
    lines.push(``, `**Policy floors violated:**`);
    for (const r of policyResult.reasons) lines.push(`- ${r}`);
  }
  const top = observations.findings
    .slice()
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
    .slice(0, 10);
  if (top.length > 0) {
    lines.push(``, `**Findings:**`);
    for (const f of top) {
      const loc = f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ""}` : "";
      lines.push(`- [${f.severity}] ${f.title}${loc}`);
    }
    if (observations.findings.length > top.length) {
      lines.push(`- …and ${observations.findings.length - top.length} more`);
    }
  }
  const gaps = observations.acChecks.filter((c) => c.status !== "met");
  if (gaps.length > 0) {
    lines.push(``, `**AC checks not met:**`);
    for (const g of gaps) lines.push(`- ${g.id}: ${g.status}${g.evidence ? ` — ${g.evidence}` : ""}`);
  }
  if (observations.summary) {
    lines.push(``, `**Reviewer summary:** ${observations.summary.slice(0, 1000)}`);
  }
  return lines.join("\n");
}

/**
 * Extract an [OBSERVATIONS]...[/OBSERVATIONS] JSON block from agent output.
 * This is the universal transport — it works for read-only agents (the
 * reviewer has Bash/Write disallowed, so it can neither curl the endpoint nor
 * write the worktree file) and for local models with MCP stripped. The last
 * block wins when the agent emits more than one (draft then final).
 * Returns { found, raw, error } — raw is the parsed-but-unvalidated object.
 */
function extractObservationsBlock(text) {
  if (!text) return { found: false, raw: null, error: null };
  const matches = [...String(text).matchAll(/\[OBSERVATIONS\]([\s\S]*?)\[\/OBSERVATIONS\]/g)];
  if (matches.length === 0) return { found: false, raw: null, error: null };
  let body = matches[matches.length - 1][1].trim();
  body = body.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  try {
    return { found: true, raw: JSON.parse(body), error: null };
  } catch (e) {
    return { found: true, raw: null, error: `JSON parse error: ${e.message}` };
  }
}

/**
 * Deterministic sampling decision from a job id (no Math.random — replayable
 * and testable). Hash the id, map to [0,1), compare against rate.
 */
function sampledForVerification(jobId, rate) {
  if (!rate || rate <= 0) return false;
  if (rate >= 1) return true;
  let h = 0;
  const s = String(jobId);
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return (h % 10000) / 10000 < rate;
}

module.exports = {
  SCHEMA_ID,
  SEVERITIES,
  ROOT_CAUSES,
  validateObservations,
  evaluateObservationPolicy,
  compareFindings,
  renderObservationsComment,
  extractObservationsBlock,
  sampledForVerification,
};
