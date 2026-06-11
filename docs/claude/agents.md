# Agents Reference
> Referenced from CLAUDE.md. This file contains detailed documentation for agents, agent teams, multi-model routing, subtask workflows, and comment prefixes.

## Available Agents

Agents are defined in `meshwork-plugin/agents/`:

| Agent | Purpose | Triggered By |
|-------|---------|--------------|
| `product-manager` | Acceptance review, prioritization, release notes | `acceptance-review` action, `release-notes` action |
| `engineer-planner` | Implementation planning, issue linking | `plan` action |
| `engineer-implementer` | Code implementation with tests, PR creation | `implement` action, `create-pr` action |
| `engineer-reviewer` | Code review | `code-review` action |
| `ui-engineer` | Frontend UI with brand application | `[UI]` prefix, `needs-ui-work` label |
| `bug-triage` | Analyzes bugs, suggests severity | `bug-triage` action, Jira webhook |
| `security-agent` | Security review, SAST, scheduled scanning | `security-review` action, `security-scan` action, schedule |
| `marketing` | Creates marketing content in Confluence, creates website dev stories | `marketing` action, `[Marketing]` prefix, `needs-marketing` label |
| `creative-assets` | Generates images/videos for marketing (Z.ai) | `creative-assets` action, dispatch from `marketing` |
| `sprint-reporter` | Sprint velocity reports, daily standup summaries | `sprint-report` action, `standup` action, schedules |
| `sales-development` | Sales pipeline lead, prospect management, Attio CRM | `sales-dev` action, scheduled workflows |
| `sales-researcher` | Prospect research, enrichment, buying signals | Dispatched by `sales-development` |
| `sales-outreach` | Cold emails, LinkedIn messages, follow-up sequences | Dispatched by `sales-development` |
| `ba-agent` | Enriches Jira stories with structured requirements (ACs, NFRs) | `requirements` action, PM teammate |
| `architect` | System architecture design with ADRs | `architecture` action, pipeline phase |
| `ux-agent` | UX/UI design specifications and accessibility | `ux-design` action, pipeline phase |
| `qa-agent` | Unified verification: code quality + Playwright browser tests + AC validation | `verify` pipeline phase (mandatory) |
| `ask-dave-agent` | Elite problem-solving and troubleshooting | `troubleshoot` action, direct invocation |
| `e2e-builder` | Full-lifecycle feature builder (requirements to tests) | `e2e-build` action, direct invocation |
| `uat-agent` | Browser-level UAT via Playwright: runs user journeys against the live app with screenshot/trace evidence (distinct from `qa-agent`'s code-level testing) | Direct invocation, subtask routing |

## Direct Agent Mode

Interact with any agent directly without a Jira ticket.

### Dashboard UI

The easiest way is via the web dashboard at `http://localhost:3210/dashboard` → **Agents** tab:
- Select an agent from the dropdown
- Enter your prompt/task
- Optionally add context
- Click "Run Agent" and see results in real-time

### API: `POST /agent`

### Request Body
```json
{
  "agent": "ui-engineer",
  "prompt": "Create a hero section component with the Meshwork brand colours",
  "context": "This is for the new landing page",
  "workingDir": "/path/to/repo",
  "model": "sonnet"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `agent` | Yes | Agent name (e.g., `ui-engineer`, `marketing`, `engineer-planner`) |
| `prompt` | Yes | Task description for the agent |
| `context` | No | Additional context to provide |
| `workingDir` | No | Working directory (defaults to config.workingDir) |
| `model` | No | Override model selection (opus/sonnet/haiku) |

### Example Usage

**List available agents:**
```bash
curl -H "x-runner-secret: $SECRET" http://localhost:3210/agents
```

**Run an agent directly:**
```bash
curl -X POST http://localhost:3210/agent \
  -H "x-runner-secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "ui-engineer",
    "prompt": "Create a dashboard card component for displaying compliance status"
  }'
```

**Check job status:**
```bash
curl -H "x-runner-secret: $SECRET" http://localhost:3210/jobs/<jobId>
```

**Get output:**
```bash
curl -H "x-runner-secret: $SECRET" http://localhost:3210/jobs/<jobId>/output
```

### Use Cases
- **Testing agents** before integrating with Jira workflows
- **One-off tasks** that don't need ticket tracking
- **Interactive development** with specific agents
- **Debugging** agent behavior with custom prompts

## Comment Prefixes (Jira)

| Prefix | Agent | Meaning |
|--------|-------|---------|
| `[AUTO-PLAN]` | engineer-planner | Implementation plan ready |
| `[AUTO-IMPLEMENT]` | engineer-implementer | Implementation complete |
| `[AUTO-UI-IMPLEMENT]` | ui-engineer | UI implementation complete |
| `[AUTO-REVIEW]` | engineer-reviewer | Code review complete |
| `[AUTO-ACCEPT]` | product-manager | Issue accepted |
| `[AUTO-RELEASE-NOTES]` | product-manager | Release notes generated |
| `[AUTO-PR]` | engineer-implementer | Pull request created |
| `[AUTO-TRIAGE]` | bug-triage | Bug triaged |
| `[AUTO-SECURITY-SCAN]` | security-agent | Scheduled scan results |
| `[AUTO-MARKETING]` | marketing | Marketing content created in Confluence |
| `[AUTO-MARKETING-REVIEW]` | marketing | Content ready for review |
| `[AUTO-MARKETING-APPROVED]` | workflow | Content approved |
| `[AUTO-CREATIVE-ASSETS]` | creative-assets | Visual assets generated |
| `[AUTO-STANDUP]` | sprint-reporter | Daily standup summary |
| `[AUTO-COMPLETE]` | workflow | Parent auto-closed (all subtasks done) |
| `[AUTO-REQUIREMENTS]` | ba-agent | Story enriched with structured requirements |
| `[AUTO-ARCHITECTURE]` | architect | Architecture design complete |
| `[AUTO-UX]` | ux-agent | UX specification complete |
| `[AUTO-VERIFY]` | qa-agent | Verification passed (code quality + browser tests) |
| `[AUTO-VERIFY-FAIL]` | qa-agent | Verification failed |
| `[AUTO-SECURITY-REVIEW]` | security-agent | Security review approved |
| `[AUTO-SECURITY-BLOCKED]` | security-agent | Security review blocked |
| `[AUTO-TROUBLESHOOT]` | ask-dave-agent | Problem diagnosed and resolved |
| `[AUTO-E2E-COMPLETE]` | e2e-builder | End-to-end build complete |

## Subtask-Based Workflow (Primary Pattern)

Agents create Jira subtasks to break down and delegate work. This replaces the legacy `[DISPATCH-ACTIONS]` pattern.

**Agent output format:**
```markdown
[CREATE-SUBTASKS parent=CER-XXX]
- summary: Add database schema for feature
  agent: implementer
  labels: [needs-architecture]
  description: |
    Create new schema table for preferences.
  files: [src/db/schema/preferences.ts]

- summary: Add tRPC router for API
  agent: implementer
  blockedBy: [1]
  files: [src/trpc/routers/preferences.ts]

- summary: Build frontend preferences panel
  agent: ui
  labels: [needs-ux-design]
  blockedBy: [2]
  files: [src/components/Preferences.tsx]
[/CREATE-SUBTASKS]
```

**Key features:**
- Subtasks are native Jira issues with full visibility
- Dependencies via Jira issue links (`blocks`/`is-blocked-by`)
- Agent routing via labels (`agent:implementer`, `agent:ui`, etc.)
- Gate labels per-subtask (`needs-architecture`, `needs-ux-design`, `needs-requirements`)
- Parallel execution for non-conflicting file sets
- Recursive decomposition (max 3 levels)

**Gate labels** — applied per-subtask by the creating agent (planner/PM). The sprint runner dispatches gate agents (`ba-agent`, `architect`, `ux-agent`) on subtasks that have these labels before implementation. Do NOT put gate labels on parent stories.

**Agent labels:**
| Label | Agent |
|-------|-------|
| `agent:planner` | engineer-planner |
| `agent:implementer` | engineer-implementer |
| `agent:reviewer` | engineer-reviewer |
| `agent:pm` | product-manager |
| `agent:ui` | ui-engineer |
| `agent:marketing` | marketing |
| `agent:creative-assets` | creative-assets |
| `agent:sales-dev` | sales-development |
| `agent:sales-research` | sales-researcher |
| `agent:sales-outreach` | sales-outreach |
| `agent:ba` | ba-agent |
| `agent:architect` | architect |
| `agent:ux` | ux-agent |
| `agent:qa` | qa-agent (unified verify) |
| `agent:security-review` | security-agent |
| `agent:troubleshoot` | ask-dave-agent |
| `agent:e2e-builder` | e2e-builder |

**Delegation matrix (who can create subtasks for whom):**
| Agent | Can Delegate To |
|-------|-----------------|
| `engineer-planner` | implementer, ui, reviewer, pm, marketing |
| `engineer-implementer` | ui, sub-implementer tasks |
| `ui-engineer` | creative-assets |
| `marketing` | creative-assets |
| `product-manager` | implementer, marketing |
| `engineer-reviewer` | implementer (for fixes) |
| `bug-triage` | planner |
| `security-agent` | planner |
| `sales-development` | sales-researcher, sales-outreach |

**Configuration** in `config.json`:
```json
{
  "subtasks": {
    "enabled": true,
    "maxConcurrency": 10,
    "maxPerParent": 3,
    "maxDepth": 3,
    "parallelAgents": ["engineer-implementer", "ui-engineer", "creative-assets", "marketing"]
  }
}
```

## Legacy: Action Dispatch Pattern (Deprecated)

For backwards compatibility, agents can still output `[DISPATCH-ACTIONS]...[/DISPATCH-ACTIONS]` blocks which the callback workflow parses:
```
[DISPATCH-ACTIONS]
- action: acceptance-review
  issueKey: CER-XXX
[/DISPATCH-ACTIONS]
```

**Note:** Prefer `[CREATE-SUBTASKS]` for new work. The legacy pattern is maintained for backwards compatibility.

Available actions: `acceptance-review`, `code-review`, `implement`, `plan`, `create-pr`, `bug-triage`, `security-scan`, `release-notes`, `marketing`, `ui-implement`, `creative-assets`, `sprint-report`, `standup`

## Post-Acceptance Automation

When `[AUTO-ACCEPT]` is detected (not REJECTED/FAILED):
1. `engineer-implementer` subtask created for PR creation
2. `product-manager` handles release notes directly (if `needs-release-note` label present)
3. `marketing` dispatched if `needs-marketing` label present

## Gap Discovery → Story Creation

All agents that perform exploration, verification, or review MUST create Jira stories for any gaps discovered outside the scope of the current issue. This ensures nothing falls through the cracks.

**Policy:**
- **Planner**: Creates stories for gaps found during codebase exploration (missing wiring, unimplemented workers, dead code)
- **Reviewer**: Flags gaps to the planner (who creates the stories)
- **PM**: Creates stories for gaps found during acceptance review or audits
- **Before creating**: Search Jira to verify no existing story covers the gap
- **After creating**: Link to the source issue and mention in the relevant comment

**Story template:**
```
Summary: [descriptive title]
Description:
  h2. Problem - [what's missing]
  h2. Acceptance Criteria - [testable criteria]
  h2. Source - Discovered during [source issue key]
Priority: High/Medium
Labels: [relevant labels]
```

## Agent Teams

Agent Teams enables team lead agents to spawn teammates directly within a session with full shared context. All teammates share the lead's provider and conversation context.

### Configuration (`config.json`)

```json
{
  "teams": {
    "enabled": true,
    "teamLeads": {
      "engineer-planner": {
        "teammates": ["engineer-implementer", "ui-engineer", "engineer-reviewer"],
        "teammateMode": "in-process"
      },
      "product-manager": {
        "teammates": ["ba-agent"],
        "teammateMode": "in-process"
      }
    }
  }
}
```

### How It Works

1. When a team lead agent is spawned, the runner sets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and `--teammate-mode in-process`
2. The team lead can spawn teammates directly during its session
3. Teammates share the task list (`CLAUDE_CODE_TASK_LIST_ID`) and full conversation context
4. The entire team session is tracked as a single runner job

### Teams

| Team Lead | Teammates | Purpose |
|-----------|-----------|---------|
| `engineer-planner` (Opus 4.6) | `engineer-implementer`, `ui-engineer`, `engineer-reviewer` | Plan → implement → review in one session |
| `product-manager` (Opus 4.6) | `ba-agent` | Requirements enrichment |
| `sales-development` (Opus 4.6) | `sales-researcher`, `sales-outreach` | Prospecting, enrichment, outreach |

### Engineering Pipeline

```
Claude (Agent Teams, shared context, single session):
  engineer-planner (Opus 4.6)
    → engineer-implementer (Sonnet 4.6) — backend, services, functional frontend
    → ui-engineer (Sonnet 4.6) — brand-heavy frontend
    → engineer-reviewer (Opus 4.6) — code review (read-only)
```

The planner creates Tasks, posts `[AUTO-PLAN]` to Jira, spawns implementer(s) as teammates, then spawns the reviewer. All three Jira comments (`[AUTO-PLAN]`, `[AUTO-IMPLEMENT]`, `[AUTO-REVIEW]`) are posted within the same session. The planner ensures all comments exist before the session ends.

**Important**: The `[AUTO-PLAN]` → implementer Jira webhook should be disabled when Agent Teams is active, since the planner spawns the implementer directly. Otherwise both the webhook and the teammate would trigger implementation.

### When to Use Teams vs Subtasks

| Scenario | Use |
|----------|-----|
| Plan → implement → review | Agent Teams: planner → implementer + ui-engineer + reviewer |
| PM post-acceptance | PM handles release notes directly; implementer creates PR via subtask |
| Creative assets | **Subtasks** (Z.ai CogView/CogVideoX MCP, different provider) |
| Marketing content | **Subtasks** (Confluence workflow) |
| Cross-repo work | **Subtasks** (different working directory) |
| Sales prospecting/enrichment/outreach | Agent Teams: sales-development → sales-researcher + sales-outreach |

## Persistent Agent Memory

Four agents have `memory: project` enabled, allowing them to accumulate knowledge across sessions:

| Agent | Remembers |
|-------|-----------|
| `engineer-planner` | Codebase architecture, planning approaches, design decisions |
| `engineer-implementer` | Code patterns, quality gate fixes, implementation conventions |
| `engineer-reviewer` | Review conventions, common issues, project-specific standards |
| `product-manager` | Product context, acceptance decisions, feedback patterns |

Memory files are stored at `~/.claude/agent-memory/<agent-name>/MEMORY.md` per project. Claude Code manages memory size automatically through summarization.

## Meeting System

Agents participate in multi-agent meetings via the runner's meeting engine. Meetings are started via Telegram (`/meeting`), API (`POST /meeting`), or autonomous scheduling.

### Meeting Modes

| Mode | Alias | Behavior | Default |
|------|-------|----------|---------|
| `chair` | `directed` | Chair agent controls flow, calls on specific agents | **Yes** |
| `roundRobin` | `serial` | Every agent speaks in sequence (legacy) | No |

### Chair-Based Directed Meetings (Default)

One agent acts as **chair** (prefers `product-manager` if present, else first participant). The chair:
- Opens with agenda and context
- Calls on specific agents: `[CALL: engineer-planner] What's the status on PROJ-295?`
- Decides who speaks next based on conversation, not fixed order
- Can ask follow-ups or direct agents to respond to each other
- Closes topics with `[CLOSE-ITEM: topic name]`
- Ends the meeting with `[END-MEETING]`

**Chair directives:**
| Directive | Purpose |
|-----------|---------|
| `[CALL: agent-name] question` | Call a specific agent to speak |
| `[CLOSE-ITEM: topic]` | Close current topic (triggers hand-raise) |
| `[OPEN-FLOOR]` | Mid-topic invitation for any agent to speak |
| `[END-MEETING]` | End the meeting |

**Safety limits:** Max 20 turns per meeting. Auto-ends if chair stops calling agents for 2 consecutive turns.

### Hand-Raise / Open Floor Mechanism

When the chair closes a topic (`[CLOSE-ITEM]`) or invites input (`[OPEN-FLOOR]`), all agents who haven't spoken on that topic get a short prompt:

1. Runner sends a condensed summary of the discussion to non-speakers
2. Each agent replies `[RAISE-HAND: brief reason]` or `[PASS]`
3. Hand-raise prompts run **in parallel** (~50 tokens each, no MCP tools, 60s timeout)
4. Raised hands are presented to the chair, who decides who to call
5. If nobody raises, chair moves on immediately

**Safety:** Max 2 hand-raise rounds per topic. Errors/timeouts treated as `[PASS]`.

### Meeting Intelligence

**Pre-meeting:** `fetchMeetingContext()` calls N8N to load Jira sprint data, resolved issues, and previous Confluence meeting minutes. Agents see real-time issue statuses.

**During meeting:** Agents have MCP tool access (`config.meetings.allowedTools`) — Jira search/get/comment/transition, Read, Glob, Grep.

**Post-meeting:** `postMeetingOutcomes()` sends transcript to N8N which creates a Confluence page and Jira tasks from action items. Agents dispatched automatically for high-priority items.

### Bug Auto-Routing from Meetings

Bugs identified during meetings are auto-dispatched:
1. `buildOutcomesPrompt` includes a `## Bugs Identified` section
2. `dispatchMeetingActions` parses bugs and dispatches `engineer-planner` jobs immediately
3. Created Jira bugs with `agent-created-bug` + `agent:engineer-planner` labels auto-route to `bug-fix` pipeline (skips triage)

### Meeting Parameters (`POST /meeting`)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `topic` | Required | Meeting topic/agenda |
| `agents` | Required | Array of agent names |
| `mode` | `"chair"` | `"chair"`/`"directed"` or `"roundRobin"`/`"serial"` |
| `chair` | Auto-selected | Override chair agent name |

## Multi-Model & Provider Routing

All engineering agents run on Claude. Only `creative-assets` uses Z.ai for image/video generation via CogView/CogVideoX.

| Agent | Provider | Model | Role |
|-------|----------|-------|------|
| `engineer-planner` | Claude | **Opus 4.6** | Plans implementation, leads engineering team, links issues |
| `engineer-implementer` | Claude | **Sonnet 4.6** | Backend + frontend implementation, PR creation |
| `ui-engineer` | Claude | **Sonnet 4.6** | Brand-heavy frontend implementation |
| `engineer-reviewer` | Claude | **Opus 4.6** | Code review (read-only, no Bash access) |
| `product-manager` | Claude | **Opus 4.6** | Acceptance review, prioritization, release notes |
| `bug-triage` | Claude | **Opus 4.6** | Root cause analysis |
| `marketing` | Claude | **Sonnet** | Content generation |
| `security-agent` | Claude | **Sonnet 4.6** | Security review, SAST, scheduled scanning |
| `creative-assets` | **Z.ai** | **GLM-5** | Image/video generation via CogView/CogVideoX |
| `sprint-reporter` | Claude | **Sonnet** | Sprint reports, daily standup summaries |
| `sales-development` | Claude | **Opus 4.6** | Sales pipeline lead, Attio CRM |
| `sales-researcher` | Claude | **Sonnet 4.6** | Prospect research, enrichment |
| `sales-outreach` | Claude | **Sonnet 4.6** | Outreach content drafting |
| `ba-agent` | Claude | **Sonnet 4.6** | Story enrichment with structured requirements |
| `architect` | Claude | **Opus 4.6** | System architecture design |
| `ux-agent` | Claude | **Sonnet 4.6** | UX/UI design specifications |
| `qa-agent` | Claude | **Sonnet 4.6** | Unified verification (code quality + browser tests) |
| `ask-dave-agent` | Claude | **Opus 4.6** | Problem-solving and troubleshooting |
| `e2e-builder` | Claude | **Sonnet 4.6** | Full-lifecycle feature builder |
| Chat mode (no agent) | Claude | **Haiku** | Quick responses |
| Delivery mode (no agent) | Claude | **Sonnet** | Default for Jira work |

**Key insight**: Claude for all engineering (planning, implementation, review). Z.ai only for creative asset generation.

**Provider configuration** in `config.json`:
```json
"providers": {
  "claude": { "baseUrl": null, "authTokenEnvVar": "ANTHROPIC_API_KEY" },
  "zai": {
    "baseUrl": "https://api.z.ai/api/anthropic",
    "authTokenEnvVar": "ZAI_API_KEY",
    "modelMapping": { "opus": "GLM-5", "sonnet": "GLM-5", "haiku": "GLM-5" }
  }
},
"routing": {
  "agentToProvider": {
    "creative-assets": "zai"
  }
}
```

**Z.ai** is only used by the `creative-assets` agent. The runner sets `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` automatically for Z.ai-routed agents.

To override model selection, pass `model: "opus"` (or `"sonnet"`, `"haiku"`) in the job request.
