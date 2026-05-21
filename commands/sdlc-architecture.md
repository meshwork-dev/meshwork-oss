---
description: Run architecture design phase only using Architect Agent (Jets)
---

# Architecture Design

Design architecture for: $ARGUMENTS

## Instructions

Use the **architect-jets** subagent to:

1. Analyze requirements (if available in docs/sdlc/requirements/)
2. Design system architecture following layered pattern
3. Create Architecture Decision Records (ADRs)
4. Identify AI/ML integration opportunities
5. Document technology stack with rationale

## Context

```
Request: $ARGUMENTS
Requirements: docs/sdlc/requirements/ (if available)
Output: docs/sdlc/architecture/
```

## Architecture Pattern (Mandatory)

```
┌─────────────────────────────────────────┐
│           PRESENTATION LAYER            │
│  API Gateway, Controllers, DTOs         │
├─────────────────────────────────────────┤
│           APPLICATION LAYER             │
│  Use Cases, Services, Orchestration     │
├─────────────────────────────────────────┤
│             DOMAIN LAYER                │
│  Entities, Business Logic (NO EXT DEPS) │
├─────────────────────────────────────────┤
│          INFRASTRUCTURE LAYER           │
│  Repositories, External APIs, DB        │
└─────────────────────────────────────────┘
```

## Quality Gates

Before completing, ensure:
- [ ] Component diagram created (Mermaid)
- [ ] ADR for each significant decision
- [ ] Technology stack with rationale
- [ ] Security architecture defined
- [ ] AI integration opportunities evaluated
- [ ] Scalability strategy documented

## Outputs

1. `docs/sdlc/architecture/ARCH-[ID].md` - Main architecture document
2. `docs/sdlc/architecture/ADR-[NNN]-[title].md` - Decision records

Begin architecture design now.
