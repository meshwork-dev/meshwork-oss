# Integrations Reference
> Referenced from CLAUDE.md. This file contains detailed documentation for Attio CRM, Sales Pipeline, Marketing Content Management, LinkedIn Engagement, UI Engineering, and Shared Team Email.

## Attio CRM Integration

Sales agents use the **Attio MCP server** (stdio-based, `attio-mcp` npm package) for full CRM access. Configured in `certpilot-plugin/.mcp.json`.

**Environment**: Set `ATTIO_API_KEY` in `.env` file.

**Available MCP tools** (14 universal operations):
| Tool | Purpose |
|------|---------|
| `search_records` | Text-based discovery across all objects |
| `search_records_advanced` | Multi-criteria filtering (AND/OR) |
| `search_records_by_relationship` | Navigate company/person/deal links |
| `search_records_by_content` | Find by notes/tasks/list membership |
| `search_records_by_timeframe` | Activity tracking by date range |
| `get_record_info` | Full record details |
| `create_records` | Add new records (companies, people, etc.) |
| `update_records` | Modify existing records |
| `delete_records` | Remove records |
| `batch_records` | Bulk create/update/delete |
| `filter_list_entries` | Filter list entries (4 operational modes) |
| `manage_list_entry` | Add/remove/update list memberships |
| `get_list_entries` | Retrieve list contents |
| `get_record_list_memberships` | Find which lists a record belongs to |

**Agent access levels:**
| Agent | Access |
|-------|--------|
| `sales-development` | Full CRM access (all 14 tools) |
| `sales-researcher` | Read + create + update (7 tools) |
| `sales-outreach` | Read-only (3 tools) |

## Sales Pipeline Automation

### Weekly Schedule
| Day | Time | Workflow | Purpose |
|-----|------|----------|---------|
| Monday | 10:00 AM | `Sales_Prospecting_Schedule` | Find new prospects from Contracts Finder, ADS Group |
| Wednesday | 10:00 AM | `Sales_Enrichment_Schedule` | Enrich high-priority prospects with missing data |
| Thursday | 10:00 AM | `Sales_Outreach_Schedule` | Draft outreach for hot/warm prospects |
| Friday | 4:00 PM | `Sales_Pipeline_Report` | Weekly pipeline summary to Confluence + Slack |

### Dashboard Visibility
The Operations page includes a **Sales Pipeline** tab showing:
- Sales agent job summary (total, succeeded, failed, running)
- Agent breakdown (sales-development, sales-researcher, sales-outreach)
- Weekly schedule overview
- Recent sales job history

## Marketing Content Management

### Routing
Issues with `[Marketing]` prefix in summary are automatically routed to the `marketing` agent (no event type header needed). Routing logic is in `Jira_Webhook_Licstener.json`.

### Confluence Structure (MKTG Space)
```
Marketing (MKTG)
├── Campaigns/
│   └── [YYYY-MM - Campaign Name]/
│       ├── Overview
│       ├── Social Media/ (LinkedIn, Twitter)
│       ├── Email Sequences/
│       ├── Blog Articles/
│       └── Website Copy/
├── Brand/
├── SEO/
├── Content Calendar/
└── Archive/
```

See `docs/marketing-confluence-structure.md` for full specification.

### Content Lifecycle Labels
| Label | State |
|-------|-------|
| `content-draft` | Initial creation |
| `content-review` | Ready for review |
| `content-approved` | Approved for publication |
| `content-scheduled` | Scheduled for publication |
| `content-published` | Live content |
| `content-aging` | Older than 6 months, needs review |
| `content-retired` | Archived, no longer relevant |

### Marketing Agent Actions
1. **Creates Confluence pages** with proper structure and labels
2. **Creates Jira stories** for website changes: `[Website] <description>`
3. **Transitions dev stories** to In Progress for engineer pickup
4. **Posts summary** to source Jira issue with Confluence links
5. **LinkedIn post generation** — creates 3 post options per posting day (insight/educational/engagement), stored in Confluence for human copy-paste
6. **LinkedIn comment drafting** — monitors authority accounts and drafts contextual comments from RSS feeds, urgency-tagged and source-linked
7. **LinkedIn monitoring** — checks RSS/Atom feeds twice daily and surfaces engagement opportunities with ready-to-post comment drafts via Slack

### Content Aging
Weekly scheduled job (`Marketing_Content_Aging_Check.json`) checks for `content-published` pages older than 6 months, adds `content-aging` label, creates `[Content Review]` Jira tasks.

## LinkedIn Engagement

### Strategy
- **Posting**: 3x/week (Mon/Wed/Fri) with rotating post types (insight, educational, engagement)
- **Commenting**: Monitor IASME, NCSC, ICO, MOD Digital, Def Stan, ADS Group for new content via RSS/Atom feeds
- **Queue**: All content staged in Confluence MKTG/Social Media/LinkedIn Queue for human review and copy-paste posting
- **No automation of actual posting** — human copies from Confluence and posts manually on LinkedIn

### Monitored Accounts

| Account | Primary Topics | Signal Source |
|---------|---------------|---------------|
| IASME | Cyber Essentials, CE Plus, IASME Governance | RSS: iasme.co.uk/feed/ |
| NCSC | Cyber threats, guidance, supply chain security | RSS: ncsc.gov.uk RSS feed |
| ICO | Data protection, GDPR, enforcement | RSS: ico.org.uk news RSS |
| MOD Digital | Digital transformation, DEFCON 658 | LinkedIn (manual check) |
| Def Stan | Defence standards, Def Stan 05-138 | GOV.UK Atom feed |
| ADS Group | Aerospace, defence, security industry | RSS: adsgroup.org.uk/feed/ |

### Content Queue Structure

```
MKTG (Confluence)
└── Social Media/
    └── LinkedIn Queue/
        ├── Post Drafts     (3 options per posting day, LI-POST - YYYY-MM-DD - 3 Options)
        └── Comment Drafts  (urgency-tagged, source-linked, LI-MONITOR - YYYY-MM-DD - AM|PM)
```

### Post Type Rotation

| Day | Post Type | Description |
|-----|-----------|-------------|
| Monday | Insight | Industry commentary or opinion on compliance/cyber trend |
| Wednesday | Educational | How-to or explainer about CE/DCC/Def Stan process |
| Friday | Engagement | Question, discussion prompt, or defence supply chain challenge |

### Comment Style Rules

- Under 300 characters for punchy visibility; 500-1000 for thought leadership
- Ends with a question or invitation to discuss
- Reflects practitioner experience, NOT vendor marketing
- Never opens with: "Great post!", "Interesting!", "Thanks for sharing!", "Couldn't agree more!"
- Urgency tagging: High (< 2 hrs old), Medium (2-6 hrs), Low (> 6 hrs)

### Idempotency Keys

| Workflow | Key Format |
|----------|-----------|
| Content Schedule | `linkedin-post:{YYYY-MM-DD}` |
| Monitor (AM) | `linkedin-monitor:{YYYY-MM-DD}:am` |
| Monitor (PM) | `linkedin-monitor:{YYYY-MM-DD}:pm` |

## UI Engineering

### Routing
Issues with `[UI]` prefix in summary or `needs-ui-work` label are automatically routed to the `ui-engineer` agent. The `ui-engineer` is also available as a teammate of `engineer-planner` via Agent Teams for brand-heavy frontend work.

### ui-engineer Agent
- Runs on Claude (Sonnet 4.6) as part of the planner's Agent Team
- Implements frontend UI with brand guidelines
- Reads `skills/certpilot-brand/SKILL.md` before any work
- Uses brand colours: Deep Teal #0D9488, Success #10B981, Warning #F59E0B, Error #EF4444
- Runs quality gate (type-check, lint, build)
- Comment prefix: `[AUTO-UI-IMPLEMENT]`

### creative-assets Agent
- Generates images (CogView-4) and videos (CogVideoX-3)
- Uses Z.ai's dedicated generation APIs via N8N MCP (`Zai_Creative_MCP.json`)
- Stores assets in Confluence with marketing content
- Comment prefix: `[AUTO-CREATIVE-ASSETS]`

**MCP Setup for creative-assets**:
1. Import `workflows/Zai_Creative_MCP.json` into N8N
2. Create credential "Z.ai API Key" (HTTP Header Auth):
   - Header Name: `Authorization`
   - Header Value: `Bearer <your-zai-api-key>`
3. Create credential "ZaiMcp" (HTTP Bearer Auth) for MCP endpoint auth
4. Activate the workflow
5. Add MCP endpoint to Claude Code settings:
   ```json
   {
     "mcpServers": {
       "n8n-zai-mcp": {
         "url": "https://your-n8n-host/webhook/zai-creative-mcp",
         "auth": { "type": "bearer", "token": "<mcp-auth-token>" }
       }
     }
   }
   ```

**Available MCP tools**:
- `mcp__n8n-zai-mcp__generate_image` - Generate images with CogView-4
- `mcp__n8n-zai-mcp__generate_video` - Generate videos with CogVideoX-3
- `mcp__n8n-zai-mcp__get_generation_result` - Poll async generation status

### Handoff Patterns (Subtask-Based)

**From engineer-implementer to ui-engineer**:
```markdown
[CREATE-SUBTASKS parent=CER-XXX]
- summary: Build dashboard UI components
  agent: ui
  description: |
    Create React components for dashboard.
    Follow CertPilot brand guidelines.
  files: [src/components/Dashboard/]
[/CREATE-SUBTASKS]
```

**From ui-engineer to creative-assets**:
```markdown
[CREATE-SUBTASKS parent=CER-XXX]
- summary: Generate hero background illustration
  agent: creative-assets
  description: |
    Create abstract security-themed illustration.
    Style: Modern, gradient, brand colours.
    Dimensions: 1920x1080px, SVG preferred.
[/CREATE-SUBTASKS]
```

**From marketing to creative-assets**:
```markdown
[CREATE-SUBTASKS parent=CER-XXX]
- summary: Generate hero image for blog post
  agent: creative-assets
  description: |
    Create hero image for blog: "Getting Started with DCC"
    Style: Professional, brand-aligned
    Dimensions: 1200x630px
[/CREATE-SUBTASKS]
```

**From bug-triage to planner**:
```markdown
[CREATE-SUBTASKS parent=CER-XXX]
- summary: Plan fix for authentication bypass
  agent: planner
  priority: high
  description: |
    Triage Analysis:
    - Severity: High
    - Root cause: Missing auth check in /api/admin
    - Files: src/api/admin.ts

    Create implementation plan to fix.
[/CREATE-SUBTASKS]
```

## Shared Team Email

**Email**: `{{TEAM_EMAIL}}` — shared inbox (e.g. Google Workspace) monitored by your AI team. Configure via `TEAM_EMAIL` in `.env` and reference it from agent prompts.

All agents are encouraged to proactively sign up for relevant newsletters, mailing lists, and alert feeds using this email. Incoming emails are polled by the N8N Gmail Trigger workflow, classified by sender/subject, and routed to the appropriate agent.

**Classification routing:**

| Source Pattern | Category | Routed To |
|---------------|----------|-----------|
| NCSC, security advisories | `security-advisory` | `security-agent` (High) |
| IASME, Cyber Essentials | `ce-update` | `marketing` (Medium) |
| ICO, GDPR | `data-protection` | `marketing` (Medium) |
| MOD, Def Stan, defence | `defence-update` | `marketing` (Medium) |
| Contracts Finder, tenders | `procurement` | `sales-researcher` (High) |
| ADS Group, aerospace | `industry` | `marketing` (Low) |
| Newsletters, digests | `newsletter` | `marketing` (Low) |
| Events, webinars | `event` | `product-manager` (Low) |

**Agents with sign-up permissions**: `marketing`, `security-agent`, `sales-researcher`, `sales-development`, `product-manager`

**Rules**: Always use the `{{TEAM_EMAIL}}` shared inbox configured for the deployment. Prefer double opt-in. Tailor source focus (compliance, security, vertical newsletters) to your product's domain.
