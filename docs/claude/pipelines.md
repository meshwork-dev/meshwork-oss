# Pipeline Engine Reference
> Referenced from CLAUDE.md. This file contains detailed documentation for the pipeline engine, quality gates, cross-phase coordination, and Chrome integration.

## Pipeline Engine

The runner includes a pipeline engine that sequences SDLC phases as isolated, retryable jobs with gate checks between phases.

### Pipeline Types

| Pipeline | Phases | Use Case |
|----------|--------|----------|
| `new-feature` | requirements → architecture → ux-design (optional) → implementation → code-review → security-review (optional) → verify → acceptance | Full SDLC (7 phases) |
| `bug-fix` | implementation → code-review → verify | Streamlined bug fixes |
| `security-fix` | implementation → security-review → verify | Security vulnerability fixes |
| `design-bootstrap` | design-system → component-scaffold → acceptance | Greenfield design system bootstrap (3 phases) |

### API

- `POST /pipeline` - Create and start a pipeline (`{ issueKey, pipelineType, workingDir?, labels? }`)
- `GET /pipelines/:id` - Get pipeline status with all phases
- `POST /pipelines/:id/restart` - Restart a failed/interrupted pipeline from first failed/running/pending phase
- `GET /api/pipelines` - List all pipelines
- `GET /api/timeline/:issueKey` - Chronological agent activity timeline for an issue

### Gate Types

| Gate | Evaluation |
|------|------------|
| `comment-prefix` | Job output contains the expected `[AUTO-*]` prefix |
| `quality-gate` | `job.qualityGate.passed === true` |
| `file-exists` | Specified file exists in working directory |

### Context Bridge

Each pipeline automatically maintains a context bridge file at `docs/sdlc/context/CTX-{issueKey}.md`. Each phase's results are appended as a section, providing accumulated context to subsequent phases as a prompt preamble.

### Optional Phases

Phases marked `optional: true` with a `condition` are evaluated against the issue's labels. If the condition fails, the phase is skipped automatically.

### Slack Progress Notifications

After each phase completes and its gate passes, a callback is sent (if `callbackUrl` is set) with pipeline progress. The callback includes a human-readable `message` field formatted as: `"CER-123: Phase 2/6 complete (architecture). Next: implementation."` — suitable for posting directly to Slack.

### Cost Tracking

Pipeline costs are aggregated from all phase jobs. Available via:
- `GET /api/stats` → `stats.pipelines.totalCostUsd`
- `GET /api/metrics` → `metrics.byPipeline.{type}.totalCost`

### SSE Events

Pipeline events: `pipeline:created`, `pipeline:phase-started`, `pipeline:phase-complete`, `pipeline:gate-passed`, `pipeline:gate-failed`, `pipeline:completed`, `pipeline:failed`

### N8N Routing

The Jira Webhook Listener (`Jira_Webhook_Licstener.json`) routes to pipelines based on labels:
- `needs-requirements` or `needs-ux-design` → `POST /pipeline` with `pipelineType: "new-feature"`
- `security-fix` or `security-vulnerability` on bugs → `POST /pipeline` with `pipelineType: "security-fix"`
- `needs-design-system` → `POST /pipeline` with `pipelineType: "design-bootstrap"` (also auto-routed by sprint runner)
- All other issues → existing `POST /run` direct dispatch

### Design Bootstrap Pipeline

The `design-bootstrap` pipeline establishes a product's design system before feature work begins. It runs once per greenfield product.

**Phase 1: design-system** (ux-agent) — Reads `company-brief.md`, creates Tailwind theme extension (full 50-950 colour scale), design tokens file, component style guide, and brand skill. Posts `[AUTO-DESIGN-SYSTEM]`.

**Phase 2: component-scaffold** (ui-engineer) — Reads the design system artefacts and builds a base component library (Button, Card, Badge, Input, Select, Table, Modal, Sidebar, PageHeader, EmptyState, LoadingSpinner). All components use design tokens, support dark mode, and pass quality gate.

**Phase 3: acceptance** (product-manager) — Reviews the design system and component library.

**Trigger:** Add `needs-design-system` label to a Jira Story/Task. The sprint runner auto-routes it to the `design-bootstrap` pipeline. Or invoke directly: `POST /pipeline { issueKey, pipelineType: "design-bootstrap" }`.

### Configuration

Pipeline definitions are in `config.json` under the `pipelines` key. Each phase specifies `agent`, `model`, `gate`, and optional `team: true` for Agent Teams integration.

## Quality Gate

Automated checks run after implementation agents complete. With Agent Teams, the planner session includes implementation, so the quality gate runs after both `engineer-planner` and `engineer-implementer`:

1. **type-check** - `npm run type-check` (required)
2. **lint** - `npm run lint` (required)
3. **test** - `npm test` (required)

If any required check fails:
- Job retries with failure context (up to 2 quality gate retries)
- Implementer receives detailed error output to fix
- After max retries, job fails with `quality-gate-failed` status

Configure in `config.json`:
```json
{
  "qualityGate": {
    "enabled": true,
    "runAfterAgents": ["engineer-planner", "engineer-implementer"],
    "checks": [
      { "name": "type-check", "cmd": "npm run type-check", "required": true },
      { "name": "lint", "cmd": "npm run lint", "required": true },
      { "name": "test", "cmd": "npm test", "required": true }
    ],
    "maxRetries": 2
  }
}
```

## Cross-Phase Task Coordination

The runner uses Claude Code's persistent Tasks feature (`~/.claude/tasks/`) for structured coordination between phases. All phases of the same Jira issue share a task list via `CLAUDE_CODE_TASK_LIST_ID=<issueKey>`.

**How it works:**
1. **Planner** creates Tasks with dependencies (e.g., Task #1 blocks Task #2)
2. **Implementer** reads those Tasks and works through them in dependency order, marking each complete
3. **Runner** reads task files via `GET /api/tasks/:issueKey` for progress visibility
4. **Callbacks** include `taskProgress` with completion percentages

**Task files** are stored at `~/.claude/tasks/<issueKey>/*.json` with this structure:
```json
{
  "id": "1",
  "subject": "Add schema migration",
  "status": "completed",
  "blocks": ["2"],
  "blockedBy": []
}
```

This replaces the pattern of passing context purely through Jira comments. The Jira `[AUTO-PLAN]` comment is still required for automation triggers, but Tasks provide structured, dependency-aware work items.

## Chrome Integration (Visual Testing)

Chrome browser automation is available to acceptance agents (product-manager) via the `--chrome` flag. The PM decides subjectively when visual testing adds value.

**Configuration:**
```json
{
  "chrome": {
    "enabled": true,
    "acceptanceAgents": ["product-manager"]
  }
}
```

**Usage tracking** (logged per job and aggregated in `/api/metrics`):
- `chrome.sessionsEnabled` - Jobs where Chrome was available
- `chrome.sessionsUsed` - Jobs where Chrome tools were actually called
- `chrome.toolCalls` - Total Chrome tool invocations
- `chrome.byTool` - Breakdown by specific tool (navigate, screenshot, etc.)

**When PM should use Chrome:**
- User-facing UI changes
- Acceptance criteria mentioning specific UI behavior
- Verifying user experience

**When to skip:**
- Backend-only changes
- Infrastructure changes
- Already covered by automated tests
