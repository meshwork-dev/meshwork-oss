/**
 * Pure unit tests (no Docker / Postgres required).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const RUNNER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { escapeJql } = require(path.join(RUNNER_DIR, "issue-tracker.js"));

test("escapeJql escapes double quotes", () => {
  assert.equal(escapeJql('summary with "quotes"'), 'summary with \\"quotes\\"');
});

test("escapeJql escapes backslashes before quotes (no double-escaping)", () => {
  assert.equal(escapeJql("back\\slash"), "back\\\\slash");
  // A pre-escaped quote in the input must not survive as an escape sequence:
  // \"  ->  \\\"  (literal backslash + literal quote when parsed by JQL)
  assert.equal(escapeJql('\\"'), '\\\\\\"');
});

test("escapeJql neutralises JQL-injection style input", () => {
  const malicious = '" OR project = "SECRET';
  const escaped = escapeJql(malicious);
  assert.equal(escaped, '\\" OR project = \\"SECRET');
  // When interpolated inside a double-quoted JQL string, every quote stays escaped
  const jql = `summary ~ "${escaped}"`;
  const unescapedQuotes = jql.match(/(?<!\\)"/g) || [];
  assert.equal(unescapedQuotes.length, 2, "only the outer delimiting quotes may remain unescaped");
});

test("escapeJql coerces non-string input safely", () => {
  assert.equal(escapeJql(42), "42");
  assert.equal(escapeJql(null), "null");
  assert.equal(escapeJql(""), "");
});
