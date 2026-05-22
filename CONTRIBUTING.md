# Contributing to Meshwork

Thanks for your interest in making Meshwork better. This document covers everything you need to land a PR.

## Code of Conduct

This project adheres to the [Contributor Covenant](./CODE_OF_CONDUCT.md). By participating, you're agreeing to uphold it. Report unacceptable behaviour to <conduct@meshwork.dev>.

## Ways to Contribute

- **Report a bug** — open an issue with the [bug template](./.github/ISSUE_TEMPLATE/bug_report.md)
- **Request a feature** — open an issue with the [feature template](./.github/ISSUE_TEMPLATE/feature_request.md)
- **Write an agent** — add a Markdown file under `shared-skills/agents/` (see [docs/agents.md](./docs/agents.md))
- **Fix a bug or ship a feature** — follow the workflow below
- **Improve docs** — typo fixes through full rewrites, all welcome

## Development Setup

### Prerequisites

- Node.js 20+
- Docker + Docker Compose
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code), authenticated
- `jq`, `git`

### First-time setup

```bash
git clone https://github.com/meshwork-dev/meshwork.git
cd meshwork
cp .env.example .env             # fill in RUNNER_SECRET, DASHBOARD_PASSWORD
./setup.sh                       # interactive — or skip and run docker compose directly
docker compose --profile bundled-db up -d --build
```

Verify:

```bash
curl http://localhost:3210/health
open http://localhost:3100
```

### Running pieces individually

```bash
# Runner
cd claude-runner && npm install
RUNNER_SECRET=dev-secret node runner.js

# Dashboard
cd dashboard && npm install && npm run dev
```

## Branching & PR Workflow

We use a two-tier branch model:

- **`dev`** — integration branch. All PRs target this.
- **`main`** — release branch. Maintainers cut `main` from `dev` after verification.

**Don't open PRs against `main`.** They'll be redirected.

### Steps

1. Fork the repo (external contributors) or branch off `dev` (maintainers).
2. Create a feature branch: `git checkout -b feat/short-description` or `fix/short-description`.
3. Make your changes. Keep commits focused — squash before opening a PR if useful.
4. Update tests and docs in the same PR.
5. Run the checklist below.
6. Open the PR against `dev`. Fill in the PR template.

### Commit message convention

We use [Conventional Commits](https://www.conventionalcommits.org/). Examples:

```
feat(runner): add per-agent retry budgets
fix(dashboard): notification bell count off-by-one
docs(agents): explain delegation matrix
chore(deps): bump express to 4.19.2
```

Scopes that are common in this repo: `runner`, `dashboard`, `agents`, `pipelines`, `workflows`, `docs`, `setup`.

## Pre-flight Checklist

Before opening a PR:

- [ ] `npm test` passes in any package you touched
- [ ] `docker compose up -d --build` succeeds locally
- [ ] `/health` endpoint returns 200
- [ ] Dashboard loads and the affected UI works in a browser
- [ ] New env vars documented in `.env.example` **and** `README.md`
- [ ] New API endpoints documented in `docs/api.md`
- [ ] New agents documented in `docs/agents.md`
- [ ] No secrets, tokens, or absolute paths from your machine
- [ ] CHANGELOG entry under `## [Unreleased]`

## Writing Agents

Agents are Markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: One-line summary of what this agent does.
model: sonnet
tools:
  - Read
  - Write
  - Bash
---

# System prompt body lives here.
```

Place them in `shared-skills/agents/` (platform-wide) or `<product>-plugin/agents/` (product-specific). The runner hot-reloads on next request.

Test your agent:

```bash
curl -X POST http://localhost:3210/agent \
  -H "x-runner-secret: $RUNNER_SECRET" \
  -H "content-type: application/json" \
  -d '{"agent":"my-agent","prompt":"test prompt"}'
```

## Adding a Product

A product is a working directory + plugin pair. Use the wizard:

```bash
./setup.sh
# choose "Add product"
```

Or manually create `products/<id>/product.json` and `<id>-plugin/` — see [docs/onboarding.md](./docs/onboarding.md).

## Coding Style

- **Runner:** CommonJS, Express, async/await. No TypeScript on the runner side.
- **Dashboard:** Next.js App Router, TypeScript, Tailwind CSS 4, SWR for data fetching.
- **No frameworks for the sake of frameworks.** Prefer plain JS modules over heavy abstractions.
- **Errors:** throw rich errors; the runner has a global handler that surfaces them.
- **Logging:** `console.log` with a `[component]` prefix. Avoid logging secrets.

## Testing

- Runner: Jest-style tests under `claude-runner/__tests__/`
- Dashboard: Playwright + Vitest under `dashboard/tests/`
- E2E: Playwright suites under `e2e/`

Run everything:

```bash
cd claude-runner && npm test
cd ../dashboard && npm test
```

## Reporting Security Issues

**Don't open public issues for security bugs.** See [SECURITY.md](./SECURITY.md).

## Maintainer Notes

- Squash-merge to `dev`.
- Cut `main` from `dev` weekly (or sooner for critical fixes).
- Tag releases with `vMAJOR.MINOR.PATCH`. CHANGELOG entries move from `## [Unreleased]` to the new version.

## Getting Help

- **Stuck on setup?** Open a [discussion](https://github.com/meshwork-dev/meshwork/discussions/categories/q-a).
- **Found a bug?** Open an [issue](https://github.com/meshwork-dev/meshwork/issues/new/choose).
- **Want to chat about a big change?** Open an [RFC discussion](https://github.com/meshwork-dev/meshwork/discussions/categories/ideas) before coding.

Thanks for contributing.
