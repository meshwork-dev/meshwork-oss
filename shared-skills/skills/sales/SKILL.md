---
name: sales
description: Sales playbook — ICP definition, outreach templates, CRM patterns, objection handling, pipeline management. Use for any sales-related task including prospecting, lead qualification, email sequences, LinkedIn outreach, pipeline reporting, or CRM updates.
last_updated: 2026-03-29
---

# Sales Playbook

## Ideal Customer Profile (ICP)

### Framework
Define ICP using these dimensions:
- **Firmographics**: Industry, company size (employees + revenue), geography, growth stage
- **Technographics**: Current tools, tech maturity, integration needs
- **Pain signals**: Compliance gaps, audit failures, manual processes, recent incidents
- **Buying signals**: Job postings (compliance roles), vendor reviews, RFP activity, funding rounds
- **Disqualifiers**: Too small (no budget), too large (enterprise sales cycle), wrong industry

### Qualification: BANT + MEDDIC Hybrid

| Criterion | Question |
|-----------|----------|
| **Budget** | Is there allocated budget or a triggering event? |
| **Authority** | Who signs? Who influences? Who blocks? |
| **Need** | What's the pain? What happens if they do nothing? |
| **Timeline** | Is there a deadline (audit, contract, regulation)? |
| **Metrics** | What does success look like quantitatively? |
| **Champion** | Who internally will push this forward? |

### Lead Scoring

| Signal | Points | Decay |
|--------|--------|-------|
| Visited pricing page | +15 | 7 days |
| Downloaded whitepaper | +10 | 14 days |
| Job posting (compliance role) | +20 | 30 days |
| Opened 3+ emails | +10 | 7 days |
| Replied to outreach | +25 | — |
| Attended webinar | +15 | 14 days |
| MQL threshold | 50+ | — |

## Outreach Templates

### Cold Email — Problem-Led
```
Subject: {pain_signal} at {company}

Hi {first_name},

Noticed {company} recently {trigger_event}. Most {industry} teams we talk to
are spending {X hours/week} on {pain_activity} — and it's only getting harder
with {regulation/trend}.

We helped {similar_company} cut that from {X} to {Y} in {timeframe}.

Worth a 15-min call to see if we can do the same for {company}?

{signature}
```

### Follow-Up Sequence
| Day | Action | Channel |
|-----|--------|---------|
| 0 | Cold email (problem-led) | Email |
| 2 | LinkedIn connection + note | LinkedIn |
| 4 | Follow-up email (case study) | Email |
| 7 | LinkedIn comment on their post | LinkedIn |
| 10 | Breakup email | Email |
| 14 | LinkedIn voice note (if connected) | LinkedIn |

### LinkedIn Message — Connection Request
```
Hi {first_name} — saw your post about {topic}. We're working on similar
challenges in {industry}. Would love to connect and exchange notes.
```

### Objection Handling

| Objection | Response Framework |
|-----------|--------------------|
| "Too expensive" | Reframe to cost of inaction: "What's the cost of a failed audit / data breach / manual process per year?" |
| "We already have a solution" | "How much time does your team spend on {specific pain}? Most teams using {competitor} tell us..." |
| "Not a priority right now" | Anchor to timeline: "When is your next audit/renewal? Most teams need {X weeks} to prepare." |
| "Need to talk to my boss" | Enable the champion: "Happy to send a one-pager your {title} can review. What matters most to them?" |
| "Send me more info" | Qualify intent: "Of course — to send the most relevant info, what's your biggest challenge with {area}?" |

## CRM Patterns

### Pipeline Stages
| Stage | Exit Criteria | Probability |
|-------|---------------|-------------|
| Prospect | ICP match confirmed | 5% |
| Qualified | BANT criteria met | 15% |
| Discovery | Pain + timeline confirmed | 30% |
| Demo/POC | Technical validation done | 50% |
| Proposal | Pricing + terms sent | 70% |
| Negotiation | Legal/procurement engaged | 85% |
| Closed Won | Signed | 100% |
| Closed Lost | Reason logged | 0% |

### CRM Hygiene Rules
1. **Every contact gets a next action** — no orphaned leads
2. **Log every interaction** — calls, emails, LinkedIn touches
3. **Update stage within 24h** of a qualifying event
4. **Lost reasons are mandatory** — track patterns (price, timing, competitor, no decision)
5. **Weekly pipeline review** — stale deals (>30 days same stage) get re-qualified or closed

### Reporting Metrics
| Metric | Formula | Target |
|--------|---------|--------|
| Pipeline velocity | Opportunities × Win Rate × ACV / Sales Cycle | — |
| Lead-to-MQL | MQLs / Total Leads | >15% |
| MQL-to-SQL | SQLs / MQLs | >30% |
| SQL-to-Close | Closed Won / SQLs | >20% |
| Average deal size | Total Revenue / Deals Closed | — |
| Sales cycle length | Avg days from first touch to close | — |

## Email Best Practices
- **Subject lines**: Under 50 chars, no ALL CAPS, personalized
- **Body**: Under 150 words, one clear CTA, mobile-friendly
- **Timing**: Tuesday-Thursday, 8-10am or 2-4pm recipient timezone
- **Personalization**: Reference specific trigger (not just {company} merge field)
- **Signature**: Name, title, phone, calendar link — no banners or quotes
