---
description: Run requirements gathering phase only using BA Agent
---

# Requirements Gathering

Gather and document requirements for: $ARGUMENTS

## Instructions

Use the **ba-agent** subagent to:

1. Analyze the request
2. Create problem statement
3. Document functional requirements (FRs)
4. Document non-functional requirements (NFRs)
5. Define acceptance criteria (Given/When/Then)

## Context

```
Request: $ARGUMENTS
Output: docs/sdlc/requirements/REQ-[timestamp].md
```

## Quality Gates

Before completing, ensure:
- [ ] Problem statement is specific and measurable
- [ ] All FRs have acceptance criteria in Given/When/Then format
- [ ] NFRs are quantified (not vague)
- [ ] Stakeholders identified
- [ ] Constraints and assumptions documented

## Output Format

Create file: `docs/sdlc/requirements/REQ-[YYYYMMDD-HHMM].md`

Include:
- Problem Statement
- Functional Requirements with Acceptance Criteria
- Non-Functional Requirements (quantified)
- Constraints & Assumptions
- Out of Scope

Begin requirements gathering now.
