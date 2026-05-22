# Workflows Reference
> Referenced from CLAUDE.md. This file contains detailed documentation for N8N workflows, Jira automation rules, proactive PM capabilities, and pipeline automation gaps.

## N8N Workflows

### Core Workflows
- **Jira_Actuator.json** - MCP-based Jira AND Confluence operations (issues, comments, transitions, pages, subtasks, issue links)
- **Jira_Webhook_Licstener.json** - Webhook listener with idempotency, routes to agents or pipelines based on issue characteristics and labels. Issues with `needs-requirements` or `needs-ux-design` labels are routed to `POST /pipeline` (new-feature pipeline). Security-labeled bugs go to the security-fix pipeline. All other issues follow the existing direct dispatch path.
- **Subtask_Webhook_Listener.json** - Handles Jira subtask events, checks blockers, triggers agents based on labels
- **Slack_PM_Bot.json** - Slack DM → normalize → runner → reply
- **Runner_Callback.json** - Receives runner completion → posts to Slack → parses CREATE-SUBTASKS → creates subtasks with links
- **Zai_Creative_MCP.json** - MCP-based Z.ai image/video generation (CogView-4, CogVideoX-3)

### Sprint Management
- **Sprint_Manager.json** - Daily 24-hour sprint lifecycle (09:00 daily, 7 days/week). Closes yesterday's sprint, creates today's sprint (named "Sprint YYYY-MM-DD"), pulls To Do + carry-over In Progress issues into sprint, starts sprint, notifies Engineering Telegram. Board 34, cap 20 new issues per sprint.

### Automation Workflows
- **Bug_Triage_Webhook.json** - Auto-triggers bug-triage agent when Bug issues created
- **Bug_Triaged_Dispatch.json** - When `[AUTO-TRIAGE]` posted on High/Critical bug, auto-dispatches engineer-planner
- **Backlog_Grooming.json** - Weekly scheduled backlog review and cleanup (Monday 9am)
- **Security_Scan_Schedule.json** - Weekly security vulnerability scanning (Sunday 8pm)
- **Sprint_Report.json** - End-of-sprint velocity reports (Friday 5pm)
- **Daily_Standup.json** - Daily standup summaries (Daily 9am, 7 days/week — repurposed as sprint planning standup)
- **Parent_Complete.json** - Receives subtask-done events, transitions parent to Done when all subtasks complete
- **Runner_Health_Monitor.json** - Every 5 minutes, checks `/health`, alerts Slack if unhealthy

### Product Management Workflows
- **Outcome_Review.json** - Bi-weekly (Monday 10am), dispatches PM to review recently accepted features for bugs/gaps
- **Feedback_Capture.json** - Slack trigger on #product-feedback, dispatches PM to classify and create Jira issues

### Marketing Workflows
- **Marketing_Content_Aging_Check.json** - Weekly check for published content older than 6 months, creates review tasks
- **Marketing_Content_Review.json** - Handles content approval workflow, updates Confluence labels

### LinkedIn Engagement Workflows
- **LinkedIn_Content_Schedule.json** - 3x/week (Mon/Wed/Fri 07:00 UTC) post generation, 3 options queued to Confluence for human selection and posting
- **LinkedIn_Monitor_Schedule.json** - Twice daily (08:00, 14:00 UTC, weekdays) RSS monitoring of IASME/NCSC/ICO/Def Stan/ADS Group, comment drafts generated and staged in Confluence

### Sales Workflows
- **Sales_Prospecting_Schedule.json** - Weekly prospecting cycle (Monday 10am)
- **Sales_Enrichment_Schedule.json** - Weekly prospect enrichment (Wednesday 10am)
- **Sales_Outreach_Schedule.json** - Weekly outreach drafting (Thursday 10am)
- **Sales_Pipeline_Report.json** - Weekly pipeline report (Friday 4pm)

### Meeting Workflows
- **Team_Meeting.json** - Telegram-triggered multi-agent meetings with chair-based directed conversation
- **Meeting_Callback.json** - Agent response callbacks during meetings
- **Meeting_Context.json** - Pre-meeting Jira sprint + Confluence minutes loader (sync webhook)
- **Meeting_Outcomes.json** - Post-meeting Confluence page creation + Jira task extraction
- **Meeting_Schedule.json** - Autonomous reconvening (daily standup 9:15 weekdays, weekly planning Mon 10:00)

### Observability & Digest Workflows
- **Daily_Digest.json** - KPI summary to Telegram (weekdays 18:00), reads from `/api/kpi`
- **Outcome_Tracker.json** - Post-ship bug correlation (weekdays 17:00)
- **Escalation_Handler.json** - Human approval gate (webhook: escalation/review)
- **Weekly_Retro.json** - Friday KPI review and retrospective (Friday 16:00)
- **Cross_Functional.json** - Cross-functional trigger routing (webhook: cross-functional/trigger)

### Email Workflows
- **Email_Gmail_Trigger.json** - OAuth2 Gmail inbox polling (every minute, ACTIVE)
- **Email_Inbox_Trigger.json** - Webhook fallback for email (inactive)

### Bug Auto-Routing
Bugs identified by agents (during meetings or reviews) are auto-routed:
- Jira Webhook Listener routes `agent-created-bug` + `agent:engineer-planner` labels directly to `bug-fix` pipeline (skips triage)
- `engineer-planner` and `architect` add these labels when creating bugs
- `bug-triage` adds `agent:engineer-planner` label after triaging critical/major bugs

## Jira Automation Rules (`JiraAutomation/`)

**Subtask workflow (new):**
- **SubtaskCreated_AgentTrigger.json** - Subtask created with `agent:*` label → N8N checks blockers → triggers runner
- **SubtaskDone_UnblockCheck.json** - Subtask → Done → N8N checks if siblings are now unblocked
- **AllSubtasksDone_CloseParent.json** - All subtasks Done → N8N transitions parent to Done

**Bug triage automation:**
- **AutoTriage_ToPlan.json** - `[AUTO-TRIAGE]` on High/Critical bug → triggers Bug_Triaged_Dispatch workflow

**Comment-based webhooks:**
- **BugCreated_Triage.json** - Bug created → bug-triage webhook
- **TransitionToInProgress_Webhook.json** - In Progress → plan webhook
- **AutoPlanComment_Webhook.json** - [AUTO-PLAN] → implement webhook — **DISABLE when Agent Teams is active** (planner spawns implementer as teammate)
- **AutoImplementComment_Webhook.json** - [AUTO-IMPLEMENT] → code-review webhook — **DISABLE when Agent Teams is active** (planner spawns reviewer as teammate)
- **AutoReviewComment_Webhook.json** - [AUTO-REVIEW] → acceptance-review webhook — **KEEP** (PM is a separate session)

## Proactive Autonomy

### PM Agent Proactive Capabilities

The product-manager agent now operates proactively through scheduled workflows:

| Capability | Trigger | Workflow |
|------------|---------|----------|
| **Epic Decomposition** | On-demand via `/agent` | PM breaks Epics into implementable stories |
| **Outcome Review** | Bi-weekly Monday 10am | `Outcome_Review.json` dispatches PM to review accepted features |
| **Feedback Ingestion** | Slack #product-feedback | `Feedback_Capture.json` dispatches PM to classify and create Jira issues |
| **Sprint Planning** | After sprint-report completes | Callback workflow dispatches PM with velocity data |
| **Backlog Grooming** | Weekly Monday 9am | Wire `Backlog_Grooming.json` output to PM agent dispatch |
| **Capacity-Aware Prioritization** | During sprint planning | PM reads velocity data from sprint reports and `/api/pm-digest` |

### PM Telemetry Digest

`GET /api/pm-digest` returns curated system health data for the PM agent:
- **last24h / lastWeek**: job counts, success rates, cost
- **qualityGate**: pass/fail/total with pass rate percentage
- **stalledJobs**: jobs running >30min or queued >10min
- **agentPerformance**: per-agent success rate and avg duration
- **budget**: current daily/hourly spend vs limits

## Pipeline Automation Gaps Fixed

| Gap | Fix | Status |
|-----|-----|--------|
| Subtask webhook URL mismatch (`jira-subtask` vs `subtask-created`) | Change N8N webhook path | Manual: edit in N8N UI |
| Parent issues never auto-close | `Parent_Complete.json` workflow | Import into N8N |
| Triaged bugs sit idle | `AutoTriage_ToPlan.json` rule + `Bug_Triaged_Dispatch.json` workflow | Import both |
| Legacy comment webhooks duplicate work with Agent Teams | N8N routing blocks `implement`/`code-review` events with Agent Teams guard | **Done** (live in N8N) |
| Runner health invisible | `Runner_Health_Monitor.json` every 5min | Import into N8N |

## Scheduler

The runner includes a scheduler for deferred jobs and meetings. Items are persisted in state and survive restarts.

**How it works:**
1. Every 60 seconds, `tickScheduler()` checks for items whose `scheduledAt` has passed
2. Scheduled jobs are created and queued (same as immediate dispatch)
3. Scheduled meetings are created via `createMeeting()` and auto-discussion begins

**Sources of scheduled items:**
- **Meeting outcomes**: Action items with `— Schedule: [time]` suffix are deferred instead of dispatched immediately
- **Follow-up meetings**: `## Follow-Up Meetings` section in outcomes creates scheduled meetings
- **API**: `POST /schedule` allows manual scheduling from external systems

**Time parsing** (`parseScheduleTime()`):
- ISO dates: `2026-03-10T09:00:00Z`, `2026-03-10 09:00`
- Relative: `in 2 hours`, `in 3 days`, `in 1 week`
- Named: `tomorrow 09:00`, `today 14:00`, `next Monday 10:00`

**Meeting outcome format for scheduling:**
```markdown
## Action Items
- [ ] [task] — Owner: [agent-name] — Priority: High — Schedule: tomorrow 14:00

## Follow-Up Meetings
- Topic: [what to discuss] — Agents: engineer-planner, architect — Schedule: next Monday 09:00
```
