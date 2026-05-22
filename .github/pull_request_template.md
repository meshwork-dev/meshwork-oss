<!--
Thanks for sending a PR. A few things to make review fast and merging painless:

- Target `dev`, not `main`.
- Keep one logical change per PR.
- Update tests and docs in the same PR.
-->

## What this PR does

One or two sentences. Mention the user-visible change before the implementation detail.

## Why

Link the issue or discussion this PR resolves: `Closes #...`

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] Feature (non-breaking)
- [ ] Breaking change (env var, schema, API contract)
- [ ] Docs / chore (no runtime impact)
- [ ] New / changed agent
- [ ] New / changed workflow

## How I tested it

- [ ] `docker compose up -d --build` succeeded locally
- [ ] `/health` returns 200
- [ ] Affected UI works in a browser (attach screenshot if visual)
- [ ] Unit / integration tests added or updated
- [ ] Agent frontmatter passes `lint-agents` (auto-checked by CI)

## Screenshots

(only if the change is visual)

## Checklist

- [ ] Targets `dev`
- [ ] No secrets, tokens, or machine-local paths in the diff
- [ ] Updated `.env.example` if a new env var was added
- [ ] Added a `## [Unreleased]` line to `CHANGELOG.md`
- [ ] Updated `docs/` if behaviour changed
- [ ] No `console.log` left in dashboard or runner code

## Anything reviewers should know

Optional. Edge cases you considered, follow-ups you're deferring, open questions.
