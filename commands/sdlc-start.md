---
description: Start full autonomous SDLC workflow with 8 specialized agents
---

# Start SDLC Workflow

Begin autonomous software development lifecycle for: $ARGUMENTS

## Workflow Overview

```
You → Conductor → BA → Architect → Engineer → Security → QA → DevOps/SRE → Customer → ✅
```

## Instructions

Use the **conductor** subagent to orchestrate the complete SDLC workflow.

**Request**: $ARGUMENTS

## Phase Sequence

| # | Phase | Agent | Focus |
|---|-------|-------|-------|
| 1 | Requirements | BA Agent | Problem, FRs, NFRs, acceptance criteria |
| 2 | Architecture | Architect (Jets) | Design, ADRs, tech stack |
| 3 | Development | Software Engineer | Implementation, tests |
| 4 | Security Review | Security Agent | SAST, deps, compliance |
| 5 | Testing | QA Agent | Integration, E2E, performance |
| 6 | Deployment | DevOps/SRE Agent | Deploy to staging/prod |
| 7 | Acceptance | Customer Agent | Post-deploy UAT |

## Expected Outputs

```
docs/sdlc/
├── requirements/REQ-*.md        # Requirements document
├── architecture/ARCH-*.md       # Architecture design
├── architecture/ADR-*.md        # Decision records
├── security/SECURITY-REVIEW-*.md # Security report
├── testing/TEST-REPORT-*.md     # Test results
├── deployments/DEPLOY-*.md      # Deployment record
├── acceptance/UAT-*.md          # Acceptance report
└── tracking/SDLC-*.md           # Progress tracking

src/                             # Implementation
tests/                           # Test suite
```

## Quality Gates

Each phase has mandatory gates:

- **Security**: 0 critical/high vulnerabilities → can BLOCK
- **QA**: All tests pass, SLAs met → can FAIL build
- **Customer**: Acceptance criteria validated → can REJECT release

## Begin

Invoke the conductor agent now to start the workflow.
