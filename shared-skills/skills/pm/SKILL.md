---
name: pm
description: Product management frameworks — RICE/ICE scoring, roadmap planning, stakeholder management, sprint planning, release management. Use for prioritization, roadmap creation, feature discovery, product strategy, or sprint planning decisions.
last_updated: 2026-03-29
---

# Product Management Frameworks

## Prioritization

### RICE Scoring
| Factor | Definition | Scale |
|--------|-----------|-------|
| **R**each | How many users affected per quarter? | Actual count |
| **I**mpact | How much does it move the needle? | 3=massive, 2=high, 1=medium, 0.5=low, 0.25=minimal |
| **C**onfidence | How sure are we about estimates? | 100%=high, 80%=medium, 50%=low |
| **E**ffort | Person-months to deliver | Actual estimate |

**Formula**: `RICE = (Reach × Impact × Confidence) / Effort`

### ICE Scoring (Simpler)
| Factor | Scale | Description |
|--------|-------|-------------|
| **I**mpact | 1-10 | Business value if successful |
| **C**onfidence | 1-10 | Certainty of impact + feasibility |
| **E**ase | 1-10 | 10 = trivial, 1 = extremely hard |

**Formula**: `ICE = Impact × Confidence × Ease`

### Value vs Effort Matrix
```
High Value, Low Effort  → DO FIRST (Quick Wins)
High Value, High Effort → PLAN CAREFULLY (Big Bets)
Low Value, Low Effort   → FILL IN (Nice to Have)
Low Value, High Effort  → DON'T DO (Money Pit)
```

## Roadmap Patterns

### Now / Next / Later
| Horizon | Timeframe | Certainty | Detail Level |
|---------|-----------|-----------|--------------|
| **Now** | This sprint/month | High (committed) | User stories, acceptance criteria |
| **Next** | Next 1-3 months | Medium (planned) | Features, rough estimates |
| **Later** | 3-6 months | Low (exploratory) | Themes, opportunity areas |

### Theme-Based Roadmap
Group features by strategic theme rather than timeline:
- **Growth**: Features that acquire new users
- **Retention**: Features that keep existing users
- **Revenue**: Features that increase ARPU
- **Platform**: Technical foundations enabling future features

### Release Planning
| Phase | Activities | Output |
|-------|-----------|--------|
| Discovery | User research, competitor analysis, data review | Problem statements |
| Definition | Solution design, acceptance criteria, estimation | Refined backlog |
| Delivery | Sprint execution, testing, staging validation | Working software |
| Launch | Release notes, communications, monitoring | Live feature |
| Review | Metrics analysis, user feedback, retrospective | Learnings |

## Sprint Planning

### Velocity-Based Planning
1. Calculate average velocity (last 3-5 sprints)
2. Prioritize backlog items
3. Pull items up to velocity capacity
4. Leave 20% buffer for unplanned work / bugs
5. Commit as a team

### Sprint Health Metrics
| Metric | Formula | Healthy Range |
|--------|---------|---------------|
| Velocity | Story points completed per sprint | Stable ±20% |
| Carry-over rate | Carried items / Committed items | <15% |
| Bug rate | Bugs found / Stories shipped | <10% |
| Cycle time | Days from In Progress to Done | <Sprint length |
| Scope change | Added items / Original commitment | <10% |

## Stakeholder Management

### RACI Matrix
| Role | Definition | Communication |
|------|-----------|---------------|
| **R**esponsible | Does the work | Daily standups, task updates |
| **A**ccountable | Final decision-maker | Sprint reviews, key decisions |
| **C**onsulted | Provides input | Design reviews, requirements |
| **I**nformed | Kept updated | Release notes, status reports |

### Communication Cadence
| Audience | Format | Frequency | Content |
|----------|--------|-----------|---------|
| Engineering team | Standup | Daily | Blockers, progress |
| Product team | Sprint review | Per sprint | Demos, metrics |
| Leadership | Status report | Weekly/bi-weekly | KPIs, risks, decisions needed |
| Users | Release notes | Per release | New features, fixes |

## Feature Discovery

### Opportunity Assessment
Before building anything, answer:
1. **Who** has this problem? (persona, segment, count)
2. **What** problem are they solving today? (current behavior)
3. **Why** is the current solution inadequate? (pain points)
4. **How** will we know this feature succeeds? (metrics)
5. **What's the smallest version** we can ship to learn? (MVP)

### User Research Methods
| Method | When | Sample Size | Output |
|--------|------|-------------|--------|
| User interviews | Discovery | 5-8 | Pain points, quotes |
| Surveys | Validation | 50+ | Quantitative signals |
| Analytics review | Always | N/A | Behavior patterns |
| Usability testing | Design | 5 | UI/UX issues |
| A/B testing | Post-launch | 100+ per variant | Statistical significance |
| Support ticket analysis | Ongoing | N/A | Bug/feature request patterns |

## Release Notes Template
```markdown
## {Product Name} — {Version / Date}

### New
- **{Feature name}** — {one-line description}. {Why it matters to user}.

### Improved
- **{Area}** — {what changed}. {benefit}.

### Fixed
- **{Bug description}** — {what was happening, what happens now}.

### Known Issues
- {issue description} — {workaround if available}
```

## Product Metrics

### AARRR (Pirate Metrics)
| Stage | Question | Example Metric |
|-------|----------|----------------|
| **A**cquisition | How do users find us? | Signups, landing page visits |
| **A**ctivation | Do users have a good first experience? | Onboarding completion, time-to-value |
| **R**etention | Do users come back? | DAU/MAU, churn rate |
| **R**evenue | How do we make money? | MRR, ARPU, LTV |
| **R**eferral | Do users tell others? | NPS, referral rate |

### North Star Metric
One metric that best captures the core value your product delivers:
- **Consumption product**: Daily active users
- **Attention product**: Time spent
- **Transaction product**: Number of transactions
- **Productivity product**: Tasks completed
- **SaaS platform**: Weekly active teams
