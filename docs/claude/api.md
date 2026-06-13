# API Reference
> Referenced from CLAUDE.md. This file contains detailed documentation for all API endpoints, the dashboard, event system, and real-time features.

## API Endpoints

All endpoints except `/health` require `x-runner-secret` header.

### Core Endpoints
- `GET /health` - Queue status, no auth
- `POST /run` - Delivery mode (Jira issue)
- `POST /chat` - Chat mode (conversational)
- `POST /agent` - Direct agent mode (no Jira required)
- `GET /agents` - List available agents with model/provider info
- `GET /jobs/:jobId` - Job status
- `GET /jobs/:jobId/output` - Parsed Claude output
- `GET /jobs/:jobId/log` - Stream job log
- `DELETE /jobs/:jobId` - Cancel a job
- `POST /jobs/:jobId/observations` - Submit structured observations (findings, AC checks) for a running job; auth via the job-scoped `x-meshwork-job-token` (issued into the job env) or the runner secret. See [pipelines.md](pipelines.md) "Structured Observations".

### Real-Time & Metrics
- `GET /events` - SSE stream for job lifecycle events (includes `job:progress` for real-time tool calls and cost)
- `GET /jobs/:jobId/stream-events` - Tool call timeline for a job (collected from stream-json)
- `GET /api/stats` - Aggregated statistics and costs
- `GET /api/metrics` - Detailed metrics by agent
- `GET /api/pm-digest` - Curated telemetry digest for PM agent (24h/week stats, quality gate rates, stalled jobs, agent performance, budget status)
- `GET /api/kpi` - 3-tier metrics (business/operational/cost), consumed by Daily Digest + Weekly Retro workflows
- `GET /api/verification-stats` - Verification sampling metrics: overturn rate of passed review gates, new-finding counts, root-cause tallies

### Reliability & Operations
- `GET /api/failed-callbacks` - List failed callback deliveries
- `POST /api/failed-callbacks/:id/replay` - Replay a failed callback
- `DELETE /api/failed-callbacks/:id` - Dismiss a failed callback

### Pipeline Operations
- `POST /pipeline` - Create and start a pipeline (`{ issueKey, pipelineType, workingDir?, labels? }`)
- `GET /pipelines/:id` - Get pipeline status with all phases
- `POST /pipelines/:id/restart` - Restart a failed/interrupted pipeline from first failed/running/pending phase
- `GET /api/pipelines` - List all pipelines
- `GET /api/timeline/:issueKey` - Chronological agent activity timeline for an issue

### Batch Operations
- `POST /batches` - Create a batch
- `GET /batches/:batchId` - Get batch status
- `POST /batches/:batchId/complete` - Mark batch job complete

### Scheduling
- `POST /schedule` - Schedule a future job or meeting (`{ type: "job"|"meeting", scheduledAt, data }`)
- `GET /api/scheduled` - List pending and recent scheduled items
- `DELETE /api/scheduled/:id` - Cancel a scheduled item

### Meetings
- `POST /meeting` - Create a new meeting (`{ topic, agents[], mode?, chair? }`)
  - `mode`: `"chair"` (default, directed) or `"roundRobin"` (serial). Aliases: `"directed"`→`"chair"`, `"serial"`→`"roundRobin"`
  - `chair`: Override auto-selected chair (defaults to `product-manager` if present)
- `POST /meeting/:id/message` - Send a message during a meeting
- `POST /meeting/:id/end` - End a meeting
- `GET /meeting/:id` - Get meeting status and transcript
- `GET /api/meetings` - List all meetings

### Inter-Agent Consultation
- `POST /internal/consult` - Ask another agent for input inline (no queue, 2-minute timeout)
  - Body: `{ agent, question, context?, requestingAgent?, jobId? }`
  - Response: `{ agent, response, model }`
  - Agents can call this via Bash during chat or delivery jobs when a question falls outside their domain
  - Does not count against MAX_CONCURRENCY

### Product Registry
- `GET /api/products` - List all registered products (id, name, description, workingDir, pluginDir)
- `POST /api/products/onboard` - Dispatch a `product-onboarder` Claude agent job that generates `products/<id>/product.json` and the full `<id>-plugin/` scaffold non-interactively. Body: `{ name, description, workingDir, industry?, targetMarket?, jira?, confluence?, techStack?, domain?, branding?, sprint?, agents? }`. Returns `{ ok, jobId, productId }`. Track progress via `GET /jobs/:id/log/stream`. Product is auto-registered on job success.
- `POST /api/products/:id/reload` - Hot-reload a product config from disk without restarting the runner

### Dashboard & Lists
- `GET /dashboard` - Web dashboard UI
- `GET /api/jobs` - List all jobs
- `GET /api/batches` - List all batches
- `GET /api/conversations` - List conversations
- `GET /api/conversations/:id` - Get conversation messages
- `GET /api/tasks/:issueKey` - Get task progress for a Jira issue (cross-phase visibility)
- `GET /api/subtasks/:parentKey` - Get subtask tracking for a parent issue (parallel execution visibility)

## Dashboard

The dashboard is a Next.js 15 app in `dashboard/` that provides a modern UI for the runner.

**Pages:**
- **Overview** (`/`) - Health status, summary stats, recent jobs
- **Products** (`/products`) - Registered product list; **Onboard Product** button opens a 6-step wizard that dispatches a `product-onboarder` Claude job to generate the full domain-aware scaffold
- **Jobs** (`/jobs`) - Filterable job list with status badges, click-through to detail
- **Job Detail** (`/jobs/[id]`) - Full job info, output, error display
- **Agents** (`/agents`) - Agent list + direct execution form
- **Metrics** (`/metrics`) - Cost charts (Recharts), success rate donut, agent performance table
- **Pipelines** (`/pipelines`) - Pipeline list with phase progress bars, detail view with timeline
- **Batches** (`/batches`) - Batch list with progress
- **Conversations** (`/conversations`) - Conversation browser with message viewer
- **Operations** (`/operations`) - Failed callbacks with replay/dismiss
- **Settings** (`/settings`) - Integration configuration (Jira, Telegram, N8N, Slack)

**Tech stack:** Next.js 15, React 19, Tailwind CSS 4, SWR (data fetching), Recharts (charts)

**Auth:** Secret stored in localStorage, entered on first visit. All API calls include `x-runner-secret` header.

**SSE:** Real-time events via `/events` endpoint with query param auth (`?secret=...` for EventSource compatibility).

**CORS:** Runner accepts requests from dashboard origin (`dashboardOrigins` in config.json).

## Event System

Job lifecycle emits events via EventEmitter:
- `job:queued`, `job:started`, `job:succeeded`, `job:failed`, `job:cancelled`, `job:retry`, `job:quality-gate-retry`
- `job:progress` — real-time streaming events from Claude CLI (tool calls, assistant messages, cost updates). `streamType` field: `init`, `assistant`, `tool_use`, `tool_result`, `result`

Pipeline events: `pipeline:created`, `pipeline:phase-started`, `pipeline:phase-complete`, `pipeline:gate-passed`, `pipeline:gate-failed`, `pipeline:completed`, `pipeline:failed`

Subscribe via SSE at `/events` or internally via `jobEmitter`.
