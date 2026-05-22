#!/usr/bin/env node
//
// Lint agent frontmatter across the repo.
//
// Rules:
//   - File must start with `---\n`, end the frontmatter block with `\n---\n`
//   - YAML must parse
//   - Required keys: name, description, model, tools
//   - `name` must be kebab-case (lowercase letters, digits, hyphen) and unique within scope
//   - `model` must be one of: opus, sonnet, haiku (case-insensitive), or include "opus"/"sonnet"/"haiku"
//   - `tools` must be a non-empty list of strings
//   - Body (after frontmatter) must be non-empty and contain at least one Markdown heading
//
// Exit non-zero on any violation. Prints a summary line at the end.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const ROOT = process.cwd();

const SCAN_DIRS = [
  'templates/agents',
  'shared-skills/agents',
];

// Also scan any *-plugin/agents at repo root.
function discoverPluginDirs() {
  return readdirSync(ROOT)
    .filter((name) => name.endsWith('-plugin'))
    .map((name) => join(name, 'agents'))
    .filter((rel) => {
      try {
        return statSync(join(ROOT, rel)).isDirectory();
      } catch {
        return false;
      }
    });
}

function listAgentFiles(dir) {
  try {
    return readdirSync(join(ROOT, dir))
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

const ALLOWED_MODELS = ['opus', 'sonnet', 'haiku'];

function lintFile(relPath) {
  const errors = [];
  const abs = join(ROOT, relPath);
  const raw = readFileSync(abs, 'utf8');

  if (!raw.startsWith('---\n')) {
    errors.push('File does not start with YAML frontmatter delimiter (`---`)');
    return errors;
  }

  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) {
    errors.push('Frontmatter not terminated with `\\n---\\n`');
    return errors;
  }

  const yamlBlock = raw.slice(4, end);
  const body = raw.slice(end + 5).trim();

  let fm;
  try {
    fm = yaml.load(yamlBlock);
  } catch (err) {
    errors.push(`YAML parse error: ${err.message}`);
    return errors;
  }

  if (!fm || typeof fm !== 'object') {
    errors.push('Frontmatter did not parse to an object');
    return errors;
  }

  if (!fm.name || typeof fm.name !== 'string') {
    errors.push('Missing or invalid `name` (must be a string)');
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(fm.name)) {
    errors.push(`\`name\` must be kebab-case (lowercase, digits, hyphens). Got: "${fm.name}"`);
  }

  if (!fm.description || typeof fm.description !== 'string') {
    errors.push('Missing or invalid `description`');
  }

  if (!fm.model || typeof fm.model !== 'string') {
    errors.push('Missing or invalid `model`');
  } else {
    const m = fm.model.toLowerCase();
    if (!ALLOWED_MODELS.some((allowed) => m.includes(allowed))) {
      errors.push(`\`model\` must include one of [${ALLOWED_MODELS.join(', ')}]. Got: "${fm.model}"`);
    }
  }

  if (!fm.tools) {
    errors.push('Missing `tools`');
  } else if (Array.isArray(fm.tools)) {
    if (fm.tools.length === 0) errors.push('`tools` is empty');
    if (!fm.tools.every((t) => typeof t === 'string')) errors.push('`tools` must contain only strings');
  } else if (typeof fm.tools !== 'string') {
    errors.push('`tools` must be a list or comma-separated string');
  }

  if (body.length === 0) {
    errors.push('Body is empty — agent needs a system prompt');
  } else if (!/^#{1,6}\s/m.test(body)) {
    errors.push('Body has no Markdown heading');
  }

  return errors;
}

const targets = [
  ...SCAN_DIRS.flatMap(listAgentFiles),
  ...discoverPluginDirs().flatMap(listAgentFiles),
];

if (targets.length === 0) {
  console.error('No agent files found. Aborting.');
  process.exit(2);
}

let failed = 0;
const namesSeen = new Map();

for (const rel of targets) {
  const errs = lintFile(rel);
  if (errs.length > 0) {
    failed += 1;
    console.error(`\n  ${rel}`);
    for (const e of errs) console.error(`    - ${e}`);
  }
  // Track duplicate names within the same scope (shared vs plugin).
  const scope = rel.split('/').slice(0, -1).join('/');
  try {
    const raw = readFileSync(join(ROOT, rel), 'utf8');
    const end = raw.indexOf('\n---\n', 4);
    if (end !== -1) {
      const fm = yaml.load(raw.slice(4, end));
      if (fm && fm.name) {
        const key = `${scope}::${fm.name}`;
        if (namesSeen.has(key)) {
          failed += 1;
          console.error(`\n  ${rel}`);
          console.error(`    - duplicate \`name\` "${fm.name}" within ${scope} (also in ${namesSeen.get(key)})`);
        } else {
          namesSeen.set(key, rel);
        }
      }
    }
  } catch {
    // already reported above
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) failed lint. ${targets.length} checked.`);
  process.exit(1);
}

console.log(`All ${targets.length} agent files passed lint.`);
