---
name: architecture
description: Software architecture patterns — ADR templates, decision frameworks, pattern catalog, system design principles. Use for architecture reviews, technology selection, ADR creation, system design, or when evaluating trade-offs between approaches.
last_updated: 2026-03-29
---

# Architecture Patterns & Decision Frameworks

## Architecture Decision Record (ADR) Template

```markdown
# ADR-{number}: {Title}

## Status
{Proposed | Accepted | Deprecated | Superseded by ADR-XXX}

## Context
What is the issue that we're seeing that is motivating this decision?

## Decision Drivers
- {driver 1}
- {driver 2}
- {driver 3}

## Considered Options
1. {Option A}
2. {Option B}
3. {Option C}

## Decision
We will use {Option X} because {rationale}.

## Consequences

### Positive
- {benefit 1}
- {benefit 2}

### Negative
- {trade-off 1}
- {trade-off 2}

### Risks
- {risk 1} — mitigated by {mitigation}

## References
- {link to RFC, issue, or prior ADR}
```

### ADR Naming Convention
`docs/adrs/ADR-YYYYMMDD-NNNN-short-title.md`

## Decision Frameworks

### Build vs Buy
| Factor | Build | Buy | Weight |
|--------|-------|-----|--------|
| Time to market | Slower | Faster | High |
| Customization | Full control | Limited | Medium |
| Maintenance burden | On you | On vendor | High |
| Cost (3-year TCO) | Dev time + hosting | License + integration | High |
| Data sovereignty | Full control | Depends on vendor | Varies |
| Vendor lock-in risk | None | High | Medium |

**Rule of thumb**: Buy commodity, build differentiator.

### Technology Selection Criteria
1. **Maturity**: Production-proven? Active community? >3 years old?
2. **Fit**: Solves the actual problem (not the most interesting one)?
3. **Team capability**: Can the team learn/maintain it?
4. **Ecosystem**: Libraries, tools, hiring pool available?
5. **Operational cost**: Hosting, monitoring, debugging difficulty?
6. **Exit cost**: How hard to migrate away?

## Pattern Catalog

### API Patterns
| Pattern | When | Trade-off |
|---------|------|-----------|
| REST | CRUD-heavy, public APIs | Simple but verbose for complex queries |
| GraphQL | Multiple clients, varied data needs | Flexible but complex caching, N+1 risk |
| tRPC | Monorepo, TypeScript full-stack | End-to-end types but coupled to TS |
| gRPC | Service-to-service, high throughput | Fast but poor browser support |
| Event-driven | Async workflows, decoupled services | Eventual consistency complexity |

### Data Patterns
| Pattern | When | Trade-off |
|---------|------|-----------|
| CQRS | Different read/write models | Powerful but eventual consistency |
| Event Sourcing | Audit trail, temporal queries | Full history but complex queries |
| Repository | Domain logic isolation | Clean but extra abstraction layer |
| Active Record | Simple CRUD | Fast but couples domain to DB |

### Resilience Patterns
| Pattern | Purpose | Implementation |
|---------|---------|---------------|
| Circuit Breaker | Prevent cascade failures | Closed → Open → Half-Open states |
| Retry with Backoff | Transient failure recovery | Exponential backoff + jitter |
| Bulkhead | Isolate failure domains | Separate thread pools / rate limits |
| Timeout | Prevent indefinite waits | Aggressive timeouts + fallback |
| Dead Letter Queue | Handle poison messages | DLQ + alerting + manual replay |

### Scaling Patterns
| Pattern | When | Notes |
|---------|------|-------|
| Horizontal scaling | Stateless services | Add instances behind load balancer |
| Vertical scaling | Database, single-threaded | Bigger box, simpler ops |
| Read replicas | Read-heavy workloads | Eventual consistency acceptable |
| Sharding | Single DB bottleneck | Complex routing, cross-shard queries |
| CDN | Static assets, global users | Cache invalidation complexity |
| Queue-based | Spiky workloads | Smooth load, add latency |

## System Design Checklist

### Before Designing
- [ ] What are the functional requirements? (what must it do)
- [ ] What are the non-functional requirements? (performance, scale, availability)
- [ ] What are the constraints? (budget, timeline, team size, existing tech)
- [ ] What does success look like? (metrics, SLAs)
- [ ] What's the expected scale? (users, requests/sec, data volume)

### During Design
- [ ] Data model defined (entities, relationships, access patterns)
- [ ] API contract defined (endpoints, payloads, errors)
- [ ] Authentication & authorization strategy
- [ ] Error handling & resilience patterns
- [ ] Observability (logging, metrics, tracing)
- [ ] Deployment strategy (blue/green, canary, rolling)
- [ ] Data migration plan (if applicable)
- [ ] Rollback plan

### Principles
1. **Start simple** — avoid premature optimization and over-engineering
2. **Design for failure** — everything fails; plan for it
3. **Prefer boring technology** — proven > cutting-edge for production
4. **Make it observable** — if you can't measure it, you can't manage it
5. **Decouple what changes independently** — but don't decouple speculatively
6. **Data outlives code** — schema decisions are harder to change than code
7. **Security by default** — not bolted on after

## Diagramming Standards

### C4 Model Levels
1. **Context** — System + external actors (who uses what)
2. **Container** — Applications, databases, message queues
3. **Component** — Major building blocks within a container
4. **Code** — Class/module level (only when needed)

### Sequence Diagram Conventions
- Show the happy path first
- Add error paths as separate diagrams
- Include timeouts and retries explicitly
- Name messages after the action (verb), not the endpoint
