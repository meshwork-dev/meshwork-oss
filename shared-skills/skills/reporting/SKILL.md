---
name: reporting
description: Sprint and project reporting patterns — velocity charts, standup summaries, KPI frameworks, retrospective formats, status report templates. Use for sprint reports, daily standups, KPI dashboards, retrospectives, or stakeholder updates.
last_updated: 2026-03-29
---

# Reporting Patterns

## Daily Standup Summary

### Template
```markdown
## Daily Standup — {Date}

### Highlights
- {Most important thing that happened}
- {Second most important}

### By Team Member / Agent
**{Name}**
- Yesterday: {what was completed}
- Today: {what's planned}
- Blockers: {any blockers or none}

### Blockers
| Blocker | Owner | Since | Action |
|---------|-------|-------|--------|
| {description} | {who} | {date} | {what to do} |

### Sprint Progress
- Committed: {X} points
- Completed: {Y} points ({Y/X}%)
- Remaining: {Z} points
- On track: {Yes/No/At Risk}
```

## Sprint Report

### Template
```markdown
## Sprint Report — Sprint {N} ({start} → {end})

### Summary
| Metric | Value |
|--------|-------|
| Committed | {X} stories ({Y} points) |
| Completed | {A} stories ({B} points) |
| Carry-over | {C} stories ({D} points) |
| Velocity | {B} points |
| Completion rate | {B/Y}% |

### Completed Work
| Key | Summary | Points | Agent/Owner |
|-----|---------|--------|-------------|
| {PROJ-123} | {title} | {pts} | {who} |

### Carried Over
| Key | Summary | Points | Reason |
|-----|---------|--------|--------|
| {PROJ-456} | {title} | {pts} | {why not done} |

### Velocity Trend
| Sprint | Committed | Completed | Rate |
|--------|-----------|-----------|------|
| {N-4} | {X} | {Y} | {%} |
| {N-3} | {X} | {Y} | {%} |
| {N-2} | {X} | {Y} | {%} |
| {N-1} | {X} | {Y} | {%} |
| {N}   | {X} | {Y} | {%} |

### Key Observations
- {pattern or insight from the sprint}
- {risks or opportunities}

### Recommendations
- {action to improve next sprint}
```

## KPI Framework

### 3-Tier Metrics Model

#### Tier 1: Business Metrics
| Metric | Definition | Source |
|--------|-----------|--------|
| Active users | DAU / WAU / MAU | Analytics |
| Revenue | MRR, ARPU, churn | Billing |
| NPS | Net Promoter Score | Survey |
| Conversion | Free → Paid rate | Funnel |

#### Tier 2: Operational Metrics
| Metric | Definition | Source |
|--------|-----------|--------|
| Velocity | Story points per sprint | Jira |
| Cycle time | In Progress → Done (avg days) | Jira |
| Bug rate | Bugs opened / Stories shipped | Jira |
| Deploy frequency | Deploys per week | CI/CD |
| Lead time | Idea → Production (avg days) | Jira |
| Carry-over rate | Carried stories / Committed | Jira |

#### Tier 3: Cost Metrics
| Metric | Definition | Source |
|--------|-----------|--------|
| Cost per story point | AI spend / Points delivered | Runner logs |
| Infrastructure cost | Monthly cloud spend | Cloud billing |
| Agent utilization | Active time / Available time | Runner metrics |
| Error rate | Failed jobs / Total jobs | Runner logs |

### DORA Metrics
| Metric | Elite | High | Medium | Low |
|--------|-------|------|--------|-----|
| Deploy frequency | On demand | Daily-weekly | Weekly-monthly | Monthly+ |
| Lead time | <1 hour | 1 day-1 week | 1 week-1 month | 1-6 months |
| Change failure rate | 0-15% | 16-30% | 31-45% | 46-60% |
| MTTR | <1 hour | <1 day | <1 week | 1 week+ |

## Retrospective Formats

### Start / Stop / Continue
```markdown
## Retrospective — Sprint {N}

### Start (new things to try)
- {suggestion}

### Stop (things that aren't working)
- {suggestion}

### Continue (things that are working)
- {suggestion}

### Action Items
| Action | Owner | Due |
|--------|-------|-----|
| {what} | {who} | {when} |
```

### 4Ls (Liked / Learned / Lacked / Longed For)
```markdown
### Liked (positive experiences)
- {what went well}

### Learned (new knowledge)
- {what we discovered}

### Lacked (missing things)
- {what we needed but didn't have}

### Longed For (wishes)
- {what we wish we had}
```

## Status Report Template

### Weekly Status (for leadership)
```markdown
## Weekly Status — {Date}

### Executive Summary
{2-3 sentences: overall health, key achievement, key risk}

### RAG Status
| Area | Status | Notes |
|------|--------|-------|
| Delivery | 🟢/🟡/🔴 | {context} |
| Quality | 🟢/🟡/🔴 | {context} |
| Budget | 🟢/🟡/🔴 | {context} |
| Risk | 🟢/🟡/🔴 | {context} |

### Key Achievements This Week
1. {achievement + impact}
2. {achievement + impact}

### Planned Next Week
1. {plan}
2. {plan}

### Risks & Blockers
| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| {risk} | H/M/L | H/M/L | {action} |

### Decisions Needed
- {decision description} — by {date}
```

## Dashboard Design Principles

1. **Lead with the answer** — headline metric at top, details below
2. **Trend over snapshot** — show direction of change, not just current value
3. **Comparison is king** — vs target, vs last period, vs benchmark
4. **Drill-down path** — summary → details → raw data
5. **Consistent timeframes** — same period across all widgets
6. **Colour = meaning** — green/amber/red consistently, not decoratively
