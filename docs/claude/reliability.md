# Reliability & Infrastructure Reference
> Referenced from CLAUDE.md. This file contains detailed documentation for reliability features, hooks, the Meshwork plugin, Claude execution internals, and key runner patterns.

## Reliability

### State Persistence
Jobs, batches, subtask groups, and pipelines are persisted to `~/claude-runner-logs/runner-state.json` on every state change (debounced to 1 write/sec). On startup, state is restored from disk. Interrupted `running` jobs and pipelines are marked as `failed` with retry budget.

### Graceful Shutdown
SIGTERM/SIGINT handlers stop accepting requests, SIGTERM running Claude processes, save state, and exit cleanly. 10-second timeout for forced exit.

### Callback Retry
All callback deliveries use `sendCallbackWithRetry()` with 3 attempts and exponential backoff (4s, 8s). Permanently failed callbacks are written to `~/claude-runner-logs/failed-callbacks/` for manual replay via `/api/failed-callbacks` endpoints.

### Pipeline Failure Alerting
On `job:failed` (after all retries exhausted), a notification is POSTed to a configurable Slack webhook (`config.json` → `alerting.slackWebhookUrl`).

### Log Rotation
Job `.log` and `.json` meta files older than `logRetentionDays` (default 30) are cleaned up on the daily cleanup interval alongside stale conversations.

### Cost Budget / Circuit Breaker
New jobs are rejected with `429 budget-exceeded` if daily or hourly cost limits are exceeded. Configure in `config.json`:
```json
"budget": {
  "enabled": true,
  "dailyLimitUsd": 50,
  "hourlyLimitUsd": 20
}
```

### Admission Control (queue backpressure)
`POST /run`, `/chat`, `/agent`, and `/pipeline` return `429 queue-full` (with
`retry-after`) once the in-memory queue reaches `maxQueueDepth` (default 200,
`MAX_QUEUE_DEPTH` env; 0 disables). Concurrency caps gate execution; this gates
admission, so a submission flood degrades instead of growing memory unbounded.

### Outbound HTTP Timeouts
All runner-originated HTTP (callbacks, alerts, Jira API) carries a hard timeout
(`outboundHttpTimeoutMs`, default 30s; Jira: `jira.timeoutMs` + transient retry
with backoff via `jira.maxRetries`, default 2). Dead endpoints can no longer
accumulate hanging sockets.

### Signed Callbacks
Every runner callback carries `x-meshwork-timestamp` and `x-meshwork-signature`
(HMAC-SHA256 of `timestamp.body` keyed with `RUNNER_SECRET`). The N8N webhook
workflows ship with a "Verify caller" node that validates this signature (or a
shared token for external callers) — see SECURITY.md for enabling enforcement.

### DB Transient-Error Retry & Persist Escalation
`pool.query` retries transient Postgres/network errors (connection drops,
failovers, deadlocks) up to 3 times with backoff. Terminal-job persistence
failures additionally schedule a delayed retry, emit `job:persist-failed`, and
keep the job in memory plus its meta file on disk — a DB blip no longer makes a
finished job invisible to history and the stale-job sweep.

### Shared Lessons (cross-agent learning)
Quality-gate failures and review/QA findings are appended to
`~/claude-runner-logs/lessons/LESSONS.md` (size-capped). The most recent tail
is injected into prompts for code-writing agents (`lessons.agents`, default
implementer/ui/e2e/qa) so the same failure class isn't rediscovered on every
issue. Disable with `lessons.enabled: false`.

### Postgres Backup & Restore
Postgres holds all job history, pipeline state, conversations, and N8N state.
Back it up nightly:
```bash
# cron: 0 3 * * *
./scripts/backup-postgres.sh            # dumps runner + n8n DBs, keeps newest 14
```
Restore:
```bash
docker compose --profile bundled-db up -d postgres
gunzip -c backups/runner-YYYYMMDD-HHMMSS.sql.gz | \
  docker compose exec -T postgres psql -U runner -d runner
gunzip -c backups/n8n-YYYYMMDD-HHMMSS.sql.gz | \
  docker compose exec -T postgres psql -U n8n -d n8n
docker compose --profile bundled-db up -d   # start the rest of the stack
```
External-Postgres mode: run `pg_dump`/`psql` against your own host (the script
prints the exact command). Retention: `BACKUP_RETENTION_COUNT` (default 14).

## Hooks System

The plugin includes Claude Code hooks that run during agent sessions.

### PreToolUse Hooks

| Hook | Matcher | Purpose |
|------|---------|---------|
| `guard_bash.py` | `Bash` | Blocks `rm -rf /`, `sudo`, `npm publish`, `git push --force`, `drop table` |
| `guard_paths.py` | `Write\|Edit\|MultiEdit` | Blocks writes outside `$CLAUDE_PROJECT_DIR` |

### PostToolUse Hooks

| Hook | Matcher | Purpose |
|------|---------|---------|
| `auto_format.py` | `Write\|Edit\|MultiEdit` | Runs `npx prettier --write` on supported file types |

### Stop Hook

| Hook | Purpose |
|------|---------|
| `on_stop.py` | Posts completion notification to `$MESHWORK_CALLBACK_URL` if set |

### Runner Quality Gates vs Plugin Hooks

These serve complementary purposes:
- **Runner quality gates** (`runQualityGate()` in runner.js): Run AFTER Claude finishes, external validation
- **Plugin hooks**: Run DURING the Claude session, inline with tool use

Both remain active. Hooks provide real-time safety, quality gates provide final validation.

## Meshwork Plugin

All agents, skills, commands, and hooks are packaged as a Claude Code plugin in `meshwork-plugin/`.

### Plugin Structure

```
meshwork-plugin/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── .mcp.json                # MCP server references (Jira, Z.ai)
├── agents/                  # 20 agent definitions
├── commands/                # 19 slash commands
├── skills/                  # 18 skill directories
├── hooks/
│   ├── hooks.json           # Hook configuration
│   ├── guard_bash.py        # Block dangerous Bash commands
│   ├── guard_paths.py       # Block writes outside project
│   ├── auto_format.py       # Auto-format with prettier
│   └── on_stop.py           # Completion callback
└── README.md
```

### Installation

```bash
# Install in a project
claude plugin install /path/to/meshwork-plugin

# Or use directly
claude --plugin-dir /path/to/meshwork-plugin
```

### Development

The plugin source lives in this repo. After changes, reinstall in target projects.

## Claude Execution

Spawns `claude --dangerously-skip-permissions --model <model-id> -p --output-format stream-json --verbose` as subprocess. Parses line-delimited JSON events in real-time for live progress, with the final `result` event used for job output.

### Real-Time Streaming

The runner processes stream-json events as they arrive:
- `system.init` — session start, available tools, model info
- `assistant.message` — text chunks and tool_use blocks
- `tool_result` — tool execution results
- `result` — final output with cost, tokens, duration
- `rate_limit_event` — rate limit status

Events are emitted as `job:progress` SSE events to the dashboard for live visualization. Each job stores its tool call timeline in `streamEvents` accessible via `GET /jobs/:jobId/stream-events`.

### CLI Flags

- `--output-format stream-json --verbose` — real-time event streaming (replaces `/proc` polling)
- `--no-session-persistence` — all runner jobs are one-shot, don't persist sessions to disk
- `--fallback-model <sonnet-id>` — on opus jobs, auto-fallback to sonnet when overloaded
- `--effort low` — for chat mode and haiku jobs (faster responses)
- `--max-budget-usd <n>` — per-job cost cap (if `config.budget.perJobLimitUsd` set)
- `--disallowedTools` — agent-specific tool restrictions from `config.routing.agentToolRestrictions` (e.g., reviewer can't Edit/Write/Bash) and team lead restrictions from `config.teams.teamLeads[agent].disallowedTools`
- `--chrome` — enabled for acceptance agents when `config.chrome.enabled` is true
- `--agent <name>` — routes to the correct agent definition in the plugin
- `--teammate-mode in-process` — for team lead agents (Agent Teams)

### Cost Tracking

Prefers the CLI's own `total_cost_usd` from the result event over manual token-based estimates. Also extracts `duration_ms`, `num_turns`, `session_id`, cache read/creation tokens.

### Pre-Flight Auth Check

`ensureOAuthValid()` validates OAuth token before spawning, attempts refresh if expired. OAuth only — NO API key.

### Post-Pipeline Safety Net

`autoTransitionIssueToDone()` spawns a lightweight haiku call (using `--output-format json`) to transition the Jira issue to Done after pipeline completion.

## Key Runner Patterns

### Idempotency
Jobs are deduplicated using keys like `jira:auto:${issueId}:${statusId}:${timestamp}`. Idempotency keys can be passed via `x-idempotency-key` header or in request body.

### Retry Logic
Failed jobs automatically retry with exponential backoff (default 3 attempts). Retry state tracked in job record with `retryCount`, `retryAt`, `lastError`.

### Token/Cost Tracking
Jobs track usage (`inputTokens`, `outputTokens`, `estimatedCostUsd`) when available. Aggregated in `/api/stats` and `/api/metrics`.

### Conversation Memory
Chat mode stores per-conversation JSON files (SHA1-hashed filenames). Messages are trimmed to CONV_TURNS and CONV_MAX_CHARS limits. Stale conversations cleaned up after CONV_STALE_DAYS.

### Jira Integration
Use N8N Jira MCP tools for all Jira operations. Always call "get transitions" before transitioning issues.

### loadConfig Gotcha
`loadConfig()` explicitly destructures config.json properties — new config keys must be added to `loadConfig()` or they'll be silently dropped. Common pattern: add new property to config.json AND add `fileConfig.section?.newProp` line in `loadConfig()`.
