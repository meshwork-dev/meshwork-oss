<div align="center">

# Meshwork

**An open, self-hosted SDLC automation platform powered by Claude Code.**

Route work to specialised AI agents — planning, implementation, review, QA, security — across one repo or a fleet of products. Standalone by default. Wire up Jira, Telegram, or N8N when you want.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](./CODE_OF_CONDUCT.md)
[![Powered by Claude](https://img.shields.io/badge/Powered%20by-Claude%20Code-d97757)](https://docs.anthropic.com/en/docs/claude-code)

[Quick Start](#quick-start) · [Architecture](#architecture) · [Agents](#agents) · [API](#api) · [Contributing](./CONTRIBUTING.md) · [Roadmap](./ROADMAP.md)

</div>

---

## Why Meshwork?

Most "AI dev tools" stop at code completion. Meshwork orchestrates the full lifecycle: a planner breaks the work down, an implementer ships it, a reviewer pushes back, QA verifies, security audits — each one is a Claude Code subprocess with its own prompt, tools, and memory, glued together by a queue, a pipeline engine, and a dashboard.

- **Multi-agent, not monolith.** 13+ specialised agents with delegation, not one generalist.
- **Self-hosted.** Your code, your container, your data. No SaaS lock-in.
- **Pluggable.** Add products via a plugin directory. Add agents via Markdown.
- **Works without anything else.** Built-in issue tracker, chat, notifications, pipelines.
- **Bring your own loop.** Optional Jira / Telegram / N8N / webhook integrations layer on top.

## Quick Start

```bash
git clone https://github.com/meshwork-dev/meshwork.git
cd meshwork
./setup.sh
# Open http://localhost:3100
```

The setup wizard handles configuration in ~5 minutes. Defaults are sane; external integrations are optional. New to the platform? See the [5-minute getting-started walkthrough](./docs/getting-started.md).

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) + Docker Compose
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` then `/login`)
- [jq](https://jqlang.github.io/jq/download/) (JSON processor used by `setup.sh`)

## Works Standalone

No external services required. Out of the box you get:

| Feature | What it does |
|---|---|
| **Issue Tracker** | Kanban with epics, stories, tasks, bugs, subtask links, dependencies |
| **Chat** | Threaded conversations, streaming agent responses, inline meetings, `/agent` commands |
| **Notifications** | In-app bell with unread counts, optional outgoing webhook (Slack/Discord/Teams) |
| **Pipeline Engine** | Multi-phase SDLC pipelines: implement → review → verify |
| **Metrics** | Per-agent cost, latency, success rates, retry counts |

## Optional Integrations

| Integration | Adds |
|---|---|
| **Jira Cloud** | Webhook-driven dispatch, issue sync, sprint management |
| **Telegram** | Mobile push, PM bot, meeting commands |
| **N8N** | Workflow automation, scheduled tasks, webhook routing |
| **ngrok** | External webhook ingress for Jira/Telegram callbacks |
| **Outgoing Webhook** | POST notifications to Slack/Discord/Teams or any HTTP endpoint |

## Architecture

```
External Triggers (Jira / Dashboard / Chat / Schedules)
        │
        ▼
   ┌──────────┐
   │  Runner  │  Express :3210 — queue, dispatch, pipeline engine, issue API
   └────┬─────┘
        │ spawn
        ▼
   ┌──────────────┐
   │ Claude Code  │  subprocess per job, agent-scoped prompt + tools
   └────┬─────────┘
        │
        ▼
   ┌──────────┐    ┌──────────────┐    ┌───────────────┐
   │ Postgres │    │  Dashboard   │    │  Callbacks    │
   │ (state)  │    │   :3100      │    │  (webhooks)   │
   └──────────┘    └──────────────┘    └───────────────┘
```

**Core services:**
- **Runner** (`:3210`) — Job queue, agent dispatch, pipeline engine, issue tracker API
- **Dashboard** (`:3100`) — Next.js UI: issues board, chat, jobs, pipelines, metrics
- **PostgreSQL** — Persistent state for jobs, issues, pipelines, notifications

Two execution modes: **DELIVERY** (`/run`, issue-driven) and **CHAT** (`/chat`, conversational with memory).

## Agents

| Agent | Purpose | Model |
|---|---|---|
| `engineer-planner` | Implementation planning, engineering team lead | Opus |
| `engineer-implementer` | Code implementation with tests, PR creation | Sonnet |
| `engineer-reviewer` | Code review (read-only) | Opus |
| `ui-engineer` | Frontend UI implementation | Sonnet |
| `product-manager` | Acceptance review, prioritisation | Opus |
| `bug-triage` | Bug analysis and severity assessment | Opus |
| `security-agent` | Security review, SAST scanning | Sonnet |
| `qa-agent` | Integration / E2E testing | Sonnet |
| `architect` | System architecture with ADRs | Sonnet |
| `ba-agent` | Business requirements enrichment | Sonnet |
| `ux-agent` | UX/UI design specifications | Sonnet |
| `ask-dave-agent` | Deep problem-solving and troubleshooting | Opus |
| `e2e-builder` | Full-lifecycle feature builder | Sonnet |
| `uat-agent` | Playwright-based User Acceptance Testing | Sonnet |
| `codebase-locator` | Utility: locate files relevant to a feature | Opus |
| `codebase-analyzer` | Utility: explain HOW code works with file:line refs | Opus |
| `codebase-pattern-finder` | Utility: find existing patterns to model after | Opus |

Agents are plain Markdown with YAML frontmatter — write your own and drop them into `shared-skills/agents/` or a product plugin. See [docs/agents.md](./docs/agents.md). New to Meshwork? Start with the [getting-started walkthrough](./docs/getting-started.md).

## API

All endpoints except `/health` require the `x-runner-secret` header.

```bash
# Health
curl http://localhost:3210/health

# Run an agent
curl -X POST http://localhost:3210/agent \
  -H "x-runner-secret: $RUNNER_SECRET" \
  -H "content-type: application/json" \
  -d '{"agent":"engineer-planner","prompt":"Plan the authentication system"}'

# Create an issue
curl -X POST http://localhost:3210/api/issues \
  -H "x-runner-secret: $RUNNER_SECRET" \
  -H "content-type: application/json" \
  -d '{"project":"PRJ","type":"story","summary":"Add user login","priority":"high"}'

# Stream events
curl -N http://localhost:3210/events -H "x-runner-secret: $RUNNER_SECRET"
```

Endpoints: `/health` · `/run` · `/chat` · `/agent` · `/agents` · `/jobs/:id` · `/pipeline` · `/api/issues` · `/api/notifications` · `/events` (SSE)

## Configuration

### Required env vars

| Variable | Description |
|---|---|
| `RUNNER_SECRET` | API authentication secret |
| `DASHBOARD_PASSWORD` | Dashboard login password |

### Common optional env vars

| Variable | Description |
|---|---|
| `RUNNER_DB_PASSWORD` | Postgres password (default: `runner_secure_password`) |
| `RUNNER_DB_HOST` | Postgres host. `postgres` (bundled) or your external host |
| `POSTGRES_MODE` | `bundled` (default) or `external` |
| `JIRA_DOMAIN` / `JIRA_EMAIL` / `JIRA_API_TOKEN` | Enable Jira integration |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Enable Telegram notifications |
| `NOTIFICATION_WEBHOOK_URL` | Generic outgoing webhook |

See [.env.example](./.env.example) for the full list.

### Multi-product

Each product gets:
- A project key (e.g. `EOS`, `WMS`)
- A plugin directory with product-specific agents and skills
- A working directory where code execution happens

Add via `./setup.sh` or the `/onboard-product` command.

## Development

```bash
# Runner locally
cd claude-runner && npm install
RUNNER_SECRET=dev-secret node runner.js

# Dashboard locally
cd dashboard && npm install && npm run dev

# Full stack (bundled Postgres)
docker compose --profile bundled-db up -d --build

# Full stack (external Postgres — set RUNNER_DB_HOST in .env)
docker compose up -d --build

# Logs
docker compose logs -f runner
```

## Documentation

- [Agents](./docs/agents.md) — Roster, delegation, writing your own
- [Pipelines](./docs/pipelines.md) — Phase config, gates, retry rules
- [API](./docs/api.md) — Full endpoint reference
- [Workflows](./docs/workflows.md) — N8N integration
- [Reliability](./docs/reliability.md) — State persistence, retries, budgets

## Contributing

PRs welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md) — it covers dev setup, branch policy (we merge to `dev`, then maintainers cut `main`), commit conventions, and the test checklist.

Good first issues: <https://github.com/meshwork-dev/meshwork/labels/good%20first%20issue>

## Security

Found a vulnerability? Don't open a public issue. See [SECURITY.md](./SECURITY.md) for our private disclosure process.

## Community

- **Discussions** — <https://github.com/meshwork-dev/meshwork/discussions>
- **Issues** — <https://github.com/meshwork-dev/meshwork/issues>
- **Website** — <https://meshwork.dev>

## License

[MIT](./LICENSE) — do whatever you want, just don't sue us.
