---
description: Check status of all SDLC work items. Shows progress, blockers, and metrics.
---

# AI-SDLC Status Check

Generate a comprehensive status report of all SDLC activities.

## Instructions

1. **Scan for tracking files** in `docs/sdlc/tracking/SDLC-*.md`
2. **Read each tracking file** to extract:
   - Work item ID
   - Feature name
   - Current phase
   - Status
   - Start date
3. **Identify blockers** - any items marked as blocked or stalled
4. **Calculate metrics** - cycle times, completion rates

## Generate Report

Use the **tracker-agent** subagent to generate a full status report:

```
Generate SDLC status report.
Scan: docs/sdlc/tracking/
Include: All active and recently completed items
Format: Status report with metrics
```

## Quick Status Format

If no tracker-agent needed, generate this summary:

```markdown
# SDLC Status Report

**Generated**: [timestamp]

## Active Work Items
| ID | Feature | Phase | Status | Age |
|----|---------|-------|--------|-----|
| SDLC-XXX | [Name] | [Phase] | 🔄/⏳/✅/❌ | [Days] |

## Blockers
[List any blocked items with reasons]

## Recent Completions
[Items completed in last 7 days]

## Metrics
- Active items: [N]
- Blocked: [N]
- Avg cycle time: [X] days
```

Generate the status report now.
