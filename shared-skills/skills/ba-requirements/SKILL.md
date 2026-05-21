---
name: ba-requirements
description: Business analysis and requirements engineering — INVEST criteria, acceptance criteria patterns, user story templates, elicitation techniques, requirements traceability. Use for writing user stories, enriching Jira issues, gathering requirements, or validating acceptance criteria.
last_updated: 2026-03-29
---

# Requirements Engineering

## User Story Template

```
As a {persona/role},
I want to {action/capability},
So that {business value/benefit}.
```

### INVEST Criteria
Every story must be:

| Criterion | Definition | Red Flag |
|-----------|-----------|----------|
| **I**ndependent | Can be developed without other stories | "This depends on story X being done first" |
| **N**egotiable | Details can flex during implementation | Overly prescriptive technical specs |
| **V**aluable | Delivers value to user or business | "Refactor database" (tech task, not story) |
| **E**stimable | Team can size it | Unclear scope, too many unknowns |
| **S**mall | Fits in a sprint | Multi-sprint epic disguised as a story |
| **T**estable | Clear pass/fail criteria | "System should be fast" |

### Story Sizing (Fibonacci)
| Points | Meaning | Example |
|--------|---------|---------|
| 1 | Trivial, <1 hour | Fix typo, update config |
| 2 | Simple, known pattern | Add new field to form |
| 3 | Moderate, some unknowns | New API endpoint with validation |
| 5 | Complex, multiple components | New feature with UI + API + DB |
| 8 | Very complex, significant unknowns | Integration with external system |
| 13 | Epic-level, should be split | Full new module or workflow |

## Acceptance Criteria Patterns

### Given-When-Then (Gherkin)
```gherkin
Scenario: {scenario name}
  Given {precondition / initial state}
  And {additional precondition}
  When {action / trigger}
  Then {expected outcome}
  And {additional outcome}
```

### Rule-Based
```markdown
**Rules:**
- Email addresses must be valid format (RFC 5322)
- Password must be at least 12 characters
- Failed login attempts are limited to 5 per 15 minutes
- Account locks after 5 failed attempts for 30 minutes
```

### Checklist Style
```markdown
**Acceptance Criteria:**
- [ ] User can upload files up to 25MB
- [ ] Supported formats: PDF, PNG, JPG, DOCX
- [ ] Upload progress indicator shows percentage
- [ ] Error message displayed for unsupported formats
- [ ] Uploaded files appear in the evidence list immediately
```

### Edge Cases to Always Consider
| Category | Questions |
|----------|-----------|
| Empty state | What if there's no data? First-time user experience? |
| Permissions | Who can see/do this? What if unauthorized? |
| Concurrency | What if two users do this simultaneously? |
| Performance | What if there are 10,000 items? |
| Error | What if the API fails? Network drops? |
| Undo | Can the user reverse this action? |
| Notification | Should anyone be notified when this happens? |
| Audit | Do we need to track who did this and when? |

## Requirements Elicitation Techniques

### Structured Interview
1. **Context**: What's the current process? What tools do you use?
2. **Pain**: What's frustrating? What takes too long? What goes wrong?
3. **Impact**: How often? How much does it cost (time/money/risk)?
4. **Vision**: In an ideal world, how would this work?
5. **Constraints**: Budget, timeline, compliance, technical limitations?
6. **Priority**: If you could only fix one thing, what would it be?

### Requirements Classification
| Type | Description | Example |
|------|-------------|---------|
| Functional | What the system must do | "User can filter results by date" |
| Non-functional | How the system must perform | "Page loads in <2 seconds" |
| Business rule | Domain logic | "Orders over £10k need manager approval" |
| Constraint | Limitation | "Must work on IE11" / "GDPR compliant" |
| Interface | External system interactions | "Syncs with Xero nightly" |

### MoSCoW Prioritization
| Priority | Definition | Sprint Inclusion |
|----------|-----------|-----------------|
| **Must** | Required for delivery — without it, release fails | Always included |
| **Should** | Important — workaround exists if omitted | Included if capacity |
| **Could** | Nice to have — low impact if omitted | Only if easy wins |
| **Won't** | Explicitly out of scope for this iteration | Backlogged |

## Jira Story Enrichment Process

When enriching a Jira story:

1. **Read the summary and description** — understand the intent
2. **Identify the persona** — who benefits from this?
3. **Write/refine the user story** — As a / I want / So that
4. **Define acceptance criteria** — Given/When/Then or checklist
5. **Identify edge cases** — use the edge case table above
6. **Estimate complexity** — Fibonacci story points
7. **Add technical notes** — implementation hints for engineers (optional)
8. **Link dependencies** — related stories, epics, blockers
9. **Set labels** — `needs-design`, `needs-api`, `needs-review` as appropriate

### Story Quality Checklist
```
[ ] Has a clear user story (As a / I want / So that)
[ ] Acceptance criteria are testable and specific
[ ] Edge cases identified and handled
[ ] Story is INVEST compliant
[ ] Story points assigned (Fibonacci)
[ ] Linked to parent epic
[ ] Labels applied for routing
[ ] No implementation details in acceptance criteria (what, not how)
```

## Requirements Traceability

### Traceability Matrix
| Requirement ID | User Story | Test Case | Status |
|---------------|------------|-----------|--------|
| REQ-001 | PROJ-123 | TC-001, TC-002 | Implemented |
| REQ-002 | PROJ-124 | TC-003 | In Progress |

### Definition of Ready (DoR)
A story is ready for development when:
- [ ] User story format complete
- [ ] Acceptance criteria defined
- [ ] Dependencies identified
- [ ] Story estimated
- [ ] Design available (if UI)
- [ ] API contract defined (if integration)
- [ ] No open questions or blockers

### Definition of Done (DoD)
A story is done when:
- [ ] Code implemented and committed
- [ ] Tests written and passing
- [ ] Code reviewed
- [ ] Acceptance criteria validated
- [ ] Documentation updated (if applicable)
- [ ] Jira updated with summary
- [ ] Jira transitioned to Done
