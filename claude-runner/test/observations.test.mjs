/**
 * Pure unit tests for lib/observations.js — the structured observations
 * protocol: payload validation, thin policy evaluation, finding-set
 * comparison (verification sampling), output-block extraction, and
 * deterministic sampling. No Docker required.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const RUNNER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  validateObservations,
  evaluateObservationPolicy,
  compareFindings,
  renderObservationsComment,
  extractObservationsBlock,
  sampledForVerification,
} = require(path.join(RUNNER_DIR, "lib", "observations.js"));

// ---------------------------------------------------------------------------
// validateObservations
// ---------------------------------------------------------------------------

test("observations: valid payload normalises", () => {
  const { ok, errors, observations } = validateObservations({
    gate: "code-review",
    findings: [
      { severity: "CRITICAL", title: "SQL injection in search", file: "src/api/search.ts", line: 42, evidence: "raw string interpolation into query" },
      { severity: "minor", title: "dead code", file: "src/old.ts" },
    ],
    acChecks: [{ id: "AC1", status: "MET", evidence: "search.spec.ts passes" }],
    summary: "Two issues found.",
  });
  assert.equal(ok, true, errors.join("; "));
  assert.equal(observations.findings.length, 2);
  assert.equal(observations.findings[0].severity, "critical"); // case-normalised
  assert.equal(observations.acChecks[0].status, "met");
  assert.equal(observations.gate, "code-review");
});

test("observations: unknown severity is rejected, not coerced", () => {
  const { ok, errors } = validateObservations({ findings: [{ severity: "blocker", title: "x" }] });
  assert.equal(ok, false);
  assert.match(errors[0], /severity must be one of/);
});

test("observations: finding without title is rejected", () => {
  const { ok, errors } = validateObservations({ findings: [{ severity: "major" }] });
  assert.equal(ok, false);
  assert.match(errors[0], /title is required/);
});

test("observations: invalid acCheck status and missing id are rejected", () => {
  const r1 = validateObservations({ acChecks: [{ id: "AC1", status: "done" }] });
  assert.equal(r1.ok, false);
  const r2 = validateObservations({ acChecks: [{ status: "met" }] });
  assert.equal(r2.ok, false);
});

test("observations: invalid root-cause tag is rejected", () => {
  const { ok, errors } = validateObservations({
    findings: [{ severity: "major", title: "x", cause: "laziness" }],
  });
  assert.equal(ok, false);
  assert.match(errors[0], /cause must be one of/);
});

test("observations: empty payload is valid (zero findings is a legitimate result)", () => {
  const { ok, observations } = validateObservations({ findings: [], summary: "Nothing found after checking auth, error paths, tests." });
  assert.equal(ok, true);
  assert.equal(observations.findings.length, 0);
});

test("observations: non-object and non-array shapes are rejected", () => {
  assert.equal(validateObservations(null).ok, false);
  assert.equal(validateObservations("PASS").ok, false);
  assert.equal(validateObservations({ findings: "none" }).ok, false);
});

// ---------------------------------------------------------------------------
// evaluateObservationPolicy
// ---------------------------------------------------------------------------

const obs = (findings = [], acChecks = []) => ({ findings, acChecks });

test("policy: no findings passes", () => {
  const r = evaluateObservationPolicy(obs(), {});
  assert.equal(r.passed, true);
  assert.equal(r.verdict, "PASS");
});

test("policy: critical finding fails the default floor", () => {
  const r = evaluateObservationPolicy(obs([{ severity: "critical", title: "auth bypass" }]), {});
  assert.equal(r.passed, false);
  assert.equal(r.verdict, "CHANGES-REQUESTED");
  assert.match(r.reasons[0], /critical/);
});

test("policy: majors pass the default floor but fail a stricter one", () => {
  const findings = [{ severity: "major", title: "missing error handling" }];
  assert.equal(evaluateObservationPolicy(obs(findings), {}).passed, true);
  assert.equal(evaluateObservationPolicy(obs(findings), { failOnSeverity: "major" }).passed, false);
});

test("policy: per-severity caps", () => {
  const findings = [
    { severity: "minor", title: "a" }, { severity: "minor", title: "b" }, { severity: "minor", title: "c" },
  ];
  assert.equal(evaluateObservationPolicy(obs(findings), { maxCounts: { minor: 2 } }).passed, false);
  assert.equal(evaluateObservationPolicy(obs(findings), { maxCounts: { minor: 5 } }).passed, true);
});

test("policy: AC gap fails by default, allowed when disabled", () => {
  const checks = [{ id: "AC2", status: "gap", evidence: null }];
  assert.equal(evaluateObservationPolicy(obs([], checks), {}).passed, false);
  assert.equal(evaluateObservationPolicy(obs([], checks), { failOnAcGap: false }).passed, true);
});

// ---------------------------------------------------------------------------
// compareFindings (verification sampling)
// ---------------------------------------------------------------------------

test("compare: identical findings produce no overturn", () => {
  const first = [{ severity: "major", title: "missing null check in parser", file: "src/parse.ts", line: 10 }];
  const second = [{ severity: "major", title: "parser missing null check", file: "src/parse.ts", line: 12 }];
  const { newFindings, overturn } = compareFindings(first, second);
  assert.equal(newFindings.length, 0);
  assert.equal(overturn, false);
});

test("compare: new critical finding overturns and tallies root cause", () => {
  const first = [{ severity: "minor", title: "naming nit", file: "src/a.ts" }];
  const second = [
    { severity: "minor", title: "naming nit", file: "src/a.ts" },
    { severity: "critical", title: "tenant id not checked on delete endpoint", file: "src/api/delete.ts", line: 33, cause: "reviewer-omission" },
  ];
  const { newFindings, overturn, rootCauses } = compareFindings(first, second);
  assert.equal(newFindings.length, 1);
  assert.equal(overturn, true);
  assert.deepEqual(rootCauses, { "reviewer-omission": 1 });
});

test("compare: new info/minor findings do not overturn", () => {
  const { overturn, newFindings } = compareFindings([], [{ severity: "info", title: "consider extracting helper", file: "src/x.ts" }]);
  assert.equal(newFindings.length, 1);
  assert.equal(overturn, false);
});

test("compare: different files are never matched", () => {
  const first = [{ severity: "major", title: "missing validation", file: "src/a.ts" }];
  const second = [{ severity: "major", title: "missing validation", file: "src/b.ts" }];
  assert.equal(compareFindings(first, second).newFindings.length, 1);
});

// ---------------------------------------------------------------------------
// extractObservationsBlock
// ---------------------------------------------------------------------------

test("extract: plain block parses", () => {
  const text = `Review complete.\n[OBSERVATIONS]\n{ "findings": [], "summary": "clean" }\n[/OBSERVATIONS]\n`;
  const { found, raw, error } = extractObservationsBlock(text);
  assert.equal(found, true);
  assert.equal(error, null);
  assert.equal(raw.summary, "clean");
});

test("extract: tolerates fenced json inside the block", () => {
  const text = `[OBSERVATIONS]\n\`\`\`json\n{ "findings": [] }\n\`\`\`\n[/OBSERVATIONS]`;
  const { found, raw } = extractObservationsBlock(text);
  assert.equal(found, true);
  assert.deepEqual(raw.findings, []);
});

test("extract: last block wins when the agent emits a draft first", () => {
  const text = `[OBSERVATIONS]\n{ "summary": "draft" }\n[/OBSERVATIONS]\n...more review...\n[OBSERVATIONS]\n{ "summary": "final" }\n[/OBSERVATIONS]`;
  assert.equal(extractObservationsBlock(text).raw.summary, "final");
});

test("extract: malformed JSON reports an error rather than silently passing", () => {
  const { found, raw, error } = extractObservationsBlock(`[OBSERVATIONS]\n{ not json }\n[/OBSERVATIONS]`);
  assert.equal(found, true);
  assert.equal(raw, null);
  assert.match(error, /JSON parse error/);
});

test("extract: absent block", () => {
  assert.equal(extractObservationsBlock("no block here").found, false);
  assert.equal(extractObservationsBlock("").found, false);
});

// ---------------------------------------------------------------------------
// sampledForVerification + renderObservationsComment
// ---------------------------------------------------------------------------

test("sampling: deterministic per jobId, respects rate bounds", () => {
  const id = "job-abc-123";
  assert.equal(sampledForVerification(id, 0.1), sampledForVerification(id, 0.1));
  assert.equal(sampledForVerification(id, 0), false);
  assert.equal(sampledForVerification(id, 1), true);
  // ~10% of a spread of ids should sample (loose bounds — deterministic hash)
  const hits = Array.from({ length: 1000 }, (_, i) => sampledForVerification(`job-${i}`, 0.1)).filter(Boolean).length;
  assert.ok(hits > 40 && hits < 250, `expected ~100 hits/1000, got ${hits}`);
});

test("render: audit projection keeps the legacy prefix + VERDICT line", () => {
  const { observations } = validateObservations({
    findings: [{ severity: "critical", title: "auth bypass", file: "src/auth.ts", line: 7 }],
    acChecks: [{ id: "AC1", status: "gap" }],
    summary: "Blocked.",
  });
  const policy = evaluateObservationPolicy(observations, {});
  const comment = renderObservationsComment("[AUTO-REVIEW]", policy, observations);
  assert.match(comment, /^\[AUTO-REVIEW\] VERDICT: CHANGES-REQUESTED/);
  assert.match(comment, /auth bypass — src\/auth\.ts:7/);
  assert.match(comment, /AC1: gap/);
  assert.match(comment, /Engine-computed/);
});
