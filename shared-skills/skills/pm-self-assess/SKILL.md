---
name: pm-self-assess
description: Product function self-assessment framework. Enables domain-specialist PMs to evaluate team capability, detect expertise gaps, analyse pipeline health, and propose organic team growth (new agents or prompt updates). Shared skill — works across all products.
last_updated: 2026-04-02
---

# PM Self-Assessment — Team Capability & Organic Growth

## Purpose

You are a domain-specialist PM running a periodic health check on your product function. Your goal is to identify where the agent team lacks the domain expertise needed to ship quality work — and propose concrete improvements.

This is NOT a generic retrospective. Every finding must be grounded in **your product's domain knowledge**. A gap is not "QA needs more tests" — it's "QA doesn't understand that LPA certificate providers must sign before attorneys, so it never catches signing order violations."

---

## When to Run

| Trigger | Source |
|---------|--------|
| Weekly schedule | N8N scheduled workflow dispatches PM with `action: self-assess` |
| Manual | Mark requests via Telegram or Jira |
| Post-pipeline | After a pipeline completes, if quality gate failures > 2 |
| Post-sprint | As part of sprint retrospective when carry-over > 40% |

---

## Assessment Framework

### Phase 0: Skill Usage & Prior Proposal Review

Before gathering new signals, check the adoption status of previously proposed improvements.

#### 0.1 Skill Usage Telemetry

```bash
# Get all skill usage data
curl -s -H "x-runner-secret: $RUNNER_SECRET" http://localhost:3210/api/skill-usage
```

This returns per-skill metrics: `{ reads, scriptRuns, lastUsed, byAgent }`. Analyse:

- **Loaded but never used** — Skills that exist in the plugin directory but have zero reads/scriptRuns. These are candidates for removal or promotion (if agents don't know about them).
- **Heavily used skills** — High-value skills the team depends on. Protect and document these.
- **Agent-skill mismatch** — Skills that should be used by certain agents but aren't (e.g., `uk-estate-law` exists but `qa-agent` never reads it).
- **Missing skills** — Agents consulting each other repeatedly on the same domain topic = missing shared skill.

#### 0.2 Prior Proposal Adoption

Search Jira for previously created self-assessment stories:

```
project = {KEY} AND labels = "pm-self-assess" AND created >= -30d ORDER BY created DESC
```

For each prior proposal, check:
- **Implemented?** — Is the story Done? Was the agent prompt / skill / agent actually updated?
- **Adopted?** — If a new skill was created, does it appear in skill-usage telemetry? Which agents use it? How often?
- **Effective?** — Did the gap it targeted recur? (Check if similar bugs/failures appeared after implementation)

Include an **Adoption Scorecard** in the report:

| Prior Proposal | Jira Status | Skill Usage (7d) | Gap Recurrence | Verdict |
|----------------|-------------|-------------------|----------------|---------|
| {proposal name} | {Done/In Progress/To Do} | {reads/runs or N/A} | {Yes/No} | {Adopted/Underused/Not Started} |

If a prior proposal was implemented but is underused, **re-propose it as a prompt update** — add explicit instructions to the consuming agents to reference the skill.

---

### Phase 1: Gather Signals

Collect data from the last 7 days (or since last assessment). Use these sources:

#### 1.1 Pipeline & Sprint Metrics

```bash
# Get KPI data
curl -s -H "x-runner-secret: $RUNNER_SECRET" http://localhost:3210/api/kpi
```

```bash
# Get recent job history
curl -s -H "x-runner-secret: $RUNNER_SECRET" http://localhost:3210/api/stats
```

```bash
# Get skill usage telemetry (already fetched in Phase 0 — reference here)
curl -s -H "x-runner-secret: $RUNNER_SECRET" http://localhost:3210/api/skill-usage
```

Extract:
- **Pipeline completion rate** — How many pipelines completed vs stalled?
- **Phase failure distribution** — Which phases fail most? (requirements, implementation, QA, acceptance)
- **Average phase duration** — Which phases take unexpectedly long?
- **Sprint carry-over rate** — What % of sprint items carried over?
- **Bug rate by product area** — Which product areas generate the most bugs?
- **Skill utilisation rate** — For each registered skill, what % of eligible jobs actually invoked it?
- **Agent-skill coverage** — Which agents use which skills? Are there gaps?

#### 1.2 Jira Analysis

Query recent issues to identify patterns:

```
# Bugs by product area (last 14 days)
project = {KEY} AND issuetype = Bug AND created >= -14d ORDER BY created DESC

# Rejected acceptance reviews
project = {KEY} AND labels = "acceptance-failed" AND updated >= -14d

# Issues that bounced back to In Progress
project = {KEY} AND status changed to "In Progress" AND status was "Acceptance" AND updated >= -14d

# Stalled issues (In Progress > 3 days in 24hr sprint system)
project = {KEY} AND status = "In Progress" AND updated <= -3d
```

#### 1.3 Agent Consultation Patterns

Check runner logs or meeting transcripts for:
- Which agents are repeatedly consulted by other agents? (indicates missing embedded knowledge)
- Which agent outputs get rejected or require rework?
- Are there recurring topics where no agent has expertise?

#### 1.4 Meeting Outcomes

Read recent meeting minutes from Confluence (if available):
- Action items that couldn't be assigned to any agent
- Domain questions that went unanswered
- Recurring themes across multiple meetings

---

### Phase 2: Analyse Gaps

For each signal, classify the gap type:

| Gap Type | Description | Example |
|----------|-------------|---------|
| **Domain Knowledge Gap** | An agent lacks understanding of a regulated process, legal requirement, or industry practice | QA doesn't test multi-executor probate scenarios because it doesn't know executors must act unanimously |
| **Coverage Gap** | No agent covers a needed capability | No agent handles HMRC Trust Registration Service compliance tracking |
| **Depth Gap** | An agent covers the area superficially but misses nuance | BA captures requirements for LPA workflow but doesn't distinguish P&FA from H&W constraints |
| **Coordination Gap** | Agents work in isolation when they should share context | Implementer builds will execution UI without knowing the witness co-presence requirement from domain rules |
| **Tool Gap** | An agent needs MCP tools or integrations it doesn't have | Security agent can't check data protection compliance because it lacks ICO guidance access |

### Domain Validation Rule

**Every gap must reference a specific domain concept.** If you can't name the regulation, process, or domain rule that's being missed, it's not a domain gap — it's a generic process issue. Generic process issues are out of scope for this assessment.

---

### Phase 3: Propose Improvements

For each gap, propose ONE of these actions (in order of preference):

#### 3.1 Prompt Update (Lightest Touch)

Update an existing agent's prompt to embed missing domain knowledge.

**When to use**: The right agent exists but lacks specific domain knowledge.

**Output format:**
```markdown
### Prompt Update: {agent-name}

**Gap**: {description grounded in domain}
**Evidence**: {Jira issues, pipeline failures, or meeting outcomes that demonstrate the gap}
**Change**: Add the following to the agent's domain knowledge section:

> {Specific domain knowledge to add — regulatory reference, process description, edge case}

**Expected impact**: {What this prevents — e.g., "Prevents QA from approving LPA workflows with incorrect signing order"}
```

#### 3.2 Skill Creation (Medium Touch)

Create a new shared or product skill that any agent can read.

**When to use**: Multiple agents need the same domain knowledge, or the knowledge is too large for a prompt section.

**Output format:**
```markdown
### New Skill: {skill-name}

**Gap**: {description}
**Evidence**: {data}
**Scope**: {What domain knowledge the skill covers}
**Consumers**: {Which agents would read this skill}
**Location**: `shared-skills/skills/{name}/SKILL.md` or `{product}-plugin/skills/{name}/SKILL.md`
```

#### 3.3 New Agent Proposal (Heaviest Touch)

Propose a new specialist agent when an entire capability is missing.

**When to use**: The gap can't be filled by updating an existing agent — it requires a fundamentally different role, toolset, or expertise.

**Output format:**
```markdown
### New Agent Proposal: {agent-name}

**Gap**: {description grounded in domain}
**Evidence**: {3+ data points — bugs, pipeline failures, unanswered questions}
**Role**: {What this agent does that no existing agent covers}
**Domain knowledge**: {Key domain concepts this agent must understand}
**Model**: {Opus/Sonnet — justify based on reasoning complexity}
**Tools needed**: {MCP tools, file access, web access}
**Team placement**: {Which team lead manages this agent}
**Justification**: {Why this can't be a prompt update to an existing agent}
```

---

### Phase 4: Prioritise

Rank all proposals using this matrix:

| Factor | Weight | Scale |
|--------|--------|-------|
| **Domain risk** | 3x | How likely is a regulatory or legal error without this fix? (1-5) |
| **Frequency** | 2x | How often does this gap cause problems? (1-5) |
| **Effort** | 1x | How much work to implement? (5=trivial prompt edit, 1=new agent + skill) |

**Score** = (Domain Risk x 3) + (Frequency x 2) + (Effort x 1)

Rank proposals by score, highest first.

---

## Output: Product Function Health Report

Post this report to the product's Telegram channel and optionally to Confluence.

```markdown
# Product Function Health Report — {Product Name}
**Date**: {date}
**Period**: {start} to {end}
**PM**: {product-manager agent}

## Executive Summary
{2-3 sentences: Overall health of the product function. Are we shipping quality domain-correct work? Where are we falling short?}

## Key Metrics
| Metric | Value | Trend | Assessment |
|--------|-------|-------|------------|
| Pipeline completion rate | {%} | {up/down/stable} | {healthy/warning/critical} |
| Sprint carry-over rate | {%} | | |
| Acceptance rejection rate | {%} | | |
| Bug rate (domain-related) | {count} | | |
| Agent consultation frequency | {pattern} | | |

## Domain Gaps Identified

### Critical (Action Required)
{List gaps with domain risk score >= 12}

### Moderate (Scheduled Fix)
{List gaps with domain risk score 8-11}

### Minor (Backlog)
{List gaps with domain risk score < 8}

## Skill Usage Analysis

### Most Active Skills (Last 7 Days)
| Skill | Reads | Script Runs | Primary Agents | Assessment |
|-------|-------|-------------|----------------|------------|
| {skill-name} | {n} | {n} | {agent1, agent2} | {healthy/underused/overloaded} |

### Unused or Underused Skills
| Skill | Last Used | Expected Consumers | Issue |
|-------|-----------|-------------------|-------|
| {skill-name} | {date or "never"} | {agents that should use it} | {Not referenced in prompt / Not triggered by pipeline / Unknown to agents} |

### Missing Skills (Inferred from Gaps)
| Domain Area | Evidence | Proposed Skill |
|-------------|----------|---------------|
| {area} | {bugs/failures/consultations} | {proposed skill name or "prompt update sufficient"} |

## Prior Proposal Adoption

| Proposal (Date) | Jira Key | Status | Skill Usage (7d) | Gap Recurred? | Verdict |
|-----------------|----------|--------|-------------------|---------------|---------|
| {title} ({date}) | {KEY-123} | {Done/In Progress/To Do} | {reads/runs or N/A} | {Yes/No/N/A} | {Adopted/Underused/Not Started/Effective} |

{Commentary: Are prior proposals being implemented and adopted? Any systemic blockers?}

## New Proposals (Ranked)

| # | Type | Target | Gap | Score | Status |
|---|------|--------|-----|-------|--------|
| 1 | {prompt-update/skill/new-agent} | {agent or skill name} | {one-line gap} | {score} | Auto-created as subtask |
| 2 | ... | ... | ... | ... | ... |

{For each proposal, include the full detail from Phase 3}

## Team Composition Review
**Current team size**: {n agents}
**Current team**: {List current agents and their domain strengths}
**Skill coverage**: {n} shared skills, {n} product skills — {n} actively used, {n} dormant
**Recommended changes**: {Summary of proposals that affect team composition}
**Team expansion needed?**: {Yes/No — justify based on coverage gaps that can't be filled by skills or prompt updates}
**Next assessment**: {date — typically 7 days from now}
```

---

## Actioning Proposals — Automatic Subtask Creation

After completing the health report, **always emit a `[CREATE-SUBTASKS]` block** for all proposals. This ensures proposals become trackable Jira stories that are automatically routed to the right agents for implementation.

The runner parses these blocks and creates native Jira subtasks with agent routing labels.

**Emit this block at the end of your output, after the health report:**

```
[CREATE-SUBTASKS parent={ISSUE_KEY}]
- summary: "[PM-Assess] {Proposal title — max 80 chars}"
  agent: {routing label — see table below}
  description: |
    h2. Source
    PM Self-Assessment {date}

    h2. Gap
    {Description grounded in domain — include regulation/process/rule reference}

    h2. Evidence
    {Jira issues, pipeline failures, skill usage data that demonstrate the gap}

    h2. Change Required
    {Specific additions — prompt text, skill content, agent definition}

    h2. Acceptance Criteria
    * {Measurable outcome — e.g., "Agent correctly validates signing order in next pipeline run"}
    * {Skill appears in usage telemetry within 7 days of deployment}

    h2. Skill Usage Baseline
    Current: {reads}/{scriptRuns} in last 7d by {agents}
    Target: {expected usage after implementation}
  labels: ["pm-self-assess", "{proposal-type}"]

- summary: "[PM-Assess] {Next proposal...}"
  agent: {routing label}
  blockedBy: [1]  # Use if proposals have dependencies
  ...
[/CREATE-SUBTASKS]
```

### Agent Routing Labels for Proposals

| Proposal Type | Agent Label | Routed To |
|---------------|-------------|-----------|
| Prompt update for any agent | `implementer` | engineer-implementer (edits agent .md files) |
| New shared skill | `implementer` | engineer-implementer (creates skill files) |
| New product-specific skill | `implementer` | engineer-implementer |
| New agent proposal | `implementer` | engineer-implementer (creates agent def + registers) |
| Skill needs UI/UX guidelines | `ui` | ui-engineer |
| Skill needs domain research | `ba` | ba-agent |

### Proposal Type Labels

Use these in the `labels` array for tracking:
- `agent-update` — Prompt update to existing agent
- `new-skill` — New shared or product skill
- `new-agent` — New specialist agent proposal
- `skill-adoption` — Re-promotion of underused existing skill

### Skill Usage Tracking Expectations

Every proposal that creates or modifies a skill MUST include acceptance criteria that reference skill usage telemetry:

- **New skill**: "Skill `{name}` appears in `GET /api/skill-usage` with reads > 0 within 7 days of deployment"
- **Prompt update to use existing skill**: "Agent `{name}` appears in `byAgent` for skill `{skill-name}` within 7 days"
- **Agent update**: "Agent `{name}` success rate improves from {current}% to >{target}% within 14 days"

---

## Self-Assessment Memory

After each assessment, update your private memory with:
- Date and findings summary
- Which proposals were approved/rejected (and why)
- Trends: Are the same gaps recurring? Is the team improving?
- Domain knowledge discovered during assessment that should inform future reviews

This creates a longitudinal view of team capability evolution.

---

## Anti-Patterns (Do NOT Do These)

1. **Generic findings** — "We need better testing" is not a finding. "QA doesn't validate that will attestation clauses match the testator's capacity status" is a finding.
2. **Proposing agents for one-off problems** — If a gap appeared once, a prompt update is sufficient. New agents need recurring evidence.
3. **Ignoring approved proposals** — Track whether previous proposals were implemented and whether they resolved the gap. Phase 0 is mandatory.
4. **Domain-free assessment** — If your report could apply to any product, you haven't done your job. Every finding must name specific domain concepts.
5. **Over-proposing** — Maximum 5 proposals per assessment. Focus on highest-impact gaps.
6. **Skipping subtask creation** — Every proposal MUST generate a `[CREATE-SUBTASKS]` entry. Reports without actionable subtasks are just complaints.
7. **Ignoring skill telemetry** — If `/api/skill-usage` data is available, you must include it. Skills that exist but aren't used are as important a finding as missing skills.
8. **Proposing skills without adoption criteria** — Every new skill proposal must specify which agents should use it and measurable usage targets.
9. **Re-proposing without checking** — Before proposing something, check Jira for `labels = "pm-self-assess"` to avoid duplicating prior proposals that are still in progress.
