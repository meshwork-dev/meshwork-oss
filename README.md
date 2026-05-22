# Meshwork-AutoDev

AI-powered SDLC automation with Claude Code. Accept tasks from multiple sources, route them through specialized agents, and get results back — all orchestrated automatically.

## Quick Start

```bash
git clone <repo-url> && cd Meshwork-AutoDev
./setup.sh
# Open http://localhost:3100
```

The setup wizard guides you through configuration in ~5 minutes. All external integrations are optional.

## Works Standalone

No external services required. The platform includes:

- **Built-in Issue Tracker** — Kanban board with epics, stories, tasks, bugs, subtask links, and dependencies
- **Chat Interface** — Threaded conversations with streaming agent responses, inline meetings, and `/agent` commands
- **In-App Notifications** — Notification bell with unread counts + optional outgoing webhook (Slack/Discord/Teams)
- **Pipeline Engine** — Multi-phase SDLC pipelines: implement → review → verify

## Optional Integrations

| Integration | What it adds |
|-------------|-------------|
| **Jira Cloud** | Issue sync, webhook-driven dispatch, sprint management |
| **Telegram** | Mobile notifications, PM bot, meeting commands |
| **N8N** | Workflow automation, scheduled tasks, webhook routing |
| **ngrok** | External webhook access for Jira/Telegram callbacks |
| **Outgoing Webhook** | POST notifications to Slack/Discord/Teams/custom endpoint |

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) + Docker Compose
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [jq](https://jqlang.github.io/jq/download/) (JSON processor)

## Architecture

```
External Triggers (Jira/Dashboard/Chat/Schedules)
    → Runner (Express server, port 3210)
    → Claude Code (subprocess execution)
    → Results → Dashboard / Notifications / Callbacks
```

**Core Services:**
- **Runner** (`:3210`) — Job queue, agent dispatch, pipeline engine, issue tracker API
- **Dashboard** (`:3100`) — Next.js UI with issues board, chat, jobs, pipelines, metrics
- **PostgreSQL** — Persistent storage for jobs, issues, pipelines, notifications

## Services

| Service | URL | Description |
|---------|-----|-------------|
| Dashboard | http://localhost:3100 | Web UI |
| Runner API | http://localhost:3210 | REST API (requires `x-runner-secret` header) |
| N8N | http://localhost:5678 | Workflow automation (optional) |

## Agents

| Agent | Purpose | Model |
|-------|---------|-------|
| `engineer-planner` | Implementation planning, engineering team lead | Opus |
| `engineer-implementer` | Code implementation with tests, PR creation | Sonnet |
| `engineer-reviewer` | Code review (read-only) | Opus |
| `ui-engineer` | Frontend UI implementation | Sonnet |
| `product-manager` | Acceptance review, prioritization | Opus |
| `bug-triage` | Bug analysis and severity assessment | Opus |
| `security-agent` | Security review, SAST scanning | Sonnet |
| `qa-agent` | Integration/E2E testing | Sonnet |
| `architect-jets` | System architecture design with ADRs | Sonnet |
| `ba-agent` | Business requirements enrichment | Sonnet |
| `ux-agent` | UX/UI design specifications | Sonnet |
| `ask-tom-agent` | Elite problem-solving and troubleshooting | Opus |
| `e2e-builder` | Full-lifecycle feature builder | Sonnet |

## API Quick Reference

All endpoints except `/health` require `x-runner-secret` header.

```bash
# Health check
curl http://localhost:3210/health

# Run an agent
curl -X POST http://localhost:3210/agent \
  -H "x-runner-secret: YOUR_SECRET" \
  -H "content-type: application/json" \
  -d '{"agent":"engineer-planner","prompt":"Plan the authentication system"}'

# Create an issue
curl -X POST http://localhost:3210/api/issues \
  -H "x-runner-secret: YOUR_SECRET" \
  -H "content-type: application/json" \
  -d '{"project":"PRJ","type":"story","summary":"Add user login","priority":"high"}'

# List issues
curl http://localhost:3210/api/issues?status=todo \
  -H "x-runner-secret: YOUR_SECRET"

# Chat with an agent
curl -X POST http://localhost:3210/api/chat/send \
  -H "x-runner-secret: YOUR_SECRET" \
  -H "content-type: application/json" \
  -d '{"message":"How should we structure the API?","agent":"architect-jets"}'
```

**Full endpoint list:** `GET /health` | `POST /run` | `POST /chat` | `POST /agent` | `GET /agents` | `GET /jobs/:id` | `POST /pipeline` | `GET /api/issues` | `POST /api/issues` | `GET /api/notifications` | `GET /events` (SSE)

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RUNNER_SECRET` | Yes | API authentication secret |
| `DASHBOARD_PASSWORD` | Yes | Dashboard login password |
| `RUNNER_DB_PASSWORD` | No | PostgreSQL password (default: `runner_secure_password`) |
| `RUNNER_DB_HOST` | No | Postgres host. `postgres` (bundled) or your external host. |
| `POSTGRES_MODE` | No | `bundled` (default) or `external`. Controls whether the bundled container starts. |
| `JIRA_DOMAIN` | No | Jira Cloud URL (enables Jira integration) |
| `JIRA_EMAIL` | No | Jira account email |
| `JIRA_API_TOKEN` | No | Jira API token |
| `NOTIFICATION_WEBHOOK_URL` | No | Outgoing webhook for notifications |

### Multi-Product Support

The platform supports multiple products. Each product gets its own:
- Issue project prefix (e.g., `EOS`, `WMS`)
- Plugin directory with product-specific agents and skills
- Working directory for code execution

Add products via `./setup.sh` or the `/onboard-product` command.

## Development

```bash
# Run runner locally (without Docker)
cd claude-runner && npm install
RUNNER_SECRET=dev-secret node runner.js

# Run dashboard locally
cd dashboard && npm install && npm run dev

# Docker (full stack, bundled Postgres)
docker compose --profile bundled-db build
docker compose --profile bundled-db up -d

# Docker (external Postgres — point RUNNER_DB_HOST at it in .env)
docker compose build && docker compose up -d

# View logs
docker compose logs -f runner
```

## License

Proprietary. All rights reserved.
