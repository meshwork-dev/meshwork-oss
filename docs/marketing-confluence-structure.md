# Marketing Confluence Structure

This document defines the rigid structure for marketing content in Confluence. The marketing agent enforces this structure automatically.

## Space: MKTG (Marketing)

```
Marketing (MKTG)
│
├── 📁 Campaigns/
│   │   Overview page listing all campaigns with status
│   │
│   └── [Campaign Name]/
│       ├── Overview
│       │   - Brief, objectives, timeline, target audience
│       │   - Related Jira issues (linked)
│       │   - Campaign status: Planning | Active | Complete | Retired
│       │
│       ├── Social Media/
│       │   ├── LinkedIn Posts
│       │   │   - Individual posts as child pages
│       │   │   - Each post has: Content, Status, Scheduled Date, Performance
│       │   │
│       │   └── Twitter-X Posts
│       │       - Thread content as child pages
│       │       - Each thread has: Content, Status, Scheduled Date
│       │
│       ├── Email Sequences/
│       │   - Sequence overview (timing, segments)
│       │   - Individual emails as child pages
│       │   - Each email has: Subject, Body, Status, Send Date
│       │
│       ├── Blog Articles/
│       │   - Article drafts as child pages
│       │   - Each article has: Title, Content, SEO meta, Status
│       │
│       └── Website Copy/
│           - Landing pages, feature pages
│           - Each page has: Copy, SEO meta, Status, Related Jira story
│
├── 📁 Brand/
│   ├── Voice & Tone Guidelines
│   ├── Messaging Framework
│   ├── Competitor Positioning
│   └── Approved Imagery Library
│
├── 📁 SEO/
│   ├── Keyword Strategy
│   ├── Meta Descriptions Library
│   └── Content Performance Reports
│
├── 📁 Content Calendar/
│   ├── Monthly calendars
│   └── Publication schedule
│
└── 📁 Archive/
    └── Retired campaigns and content
```

## Content Lifecycle States

Every content item uses Confluence labels to track lifecycle state:

| State | Label | Description |
|-------|-------|-------------|
| **Draft** | `content-draft` | Initial creation, work in progress |
| **In Review** | `content-review` | Ready for stakeholder review |
| **Approved** | `content-approved` | Reviewed and approved for publication |
| **Scheduled** | `content-scheduled` | Approved and scheduled for publication |
| **Published** | `content-published` | Live/posted content |
| **Aging** | `content-aging` | Content older than 6 months, needs review |
| **Retired** | `content-retired` | No longer relevant, moved to Archive |

## Page Properties (Confluence Macros)

Every content page MUST have a Page Properties macro with:

```
| Property | Value |
|----------|-------|
| Status | Draft / In Review / Approved / Scheduled / Published / Aging / Retired |
| Created | YYYY-MM-DD |
| Last Reviewed | YYYY-MM-DD |
| Review Due | YYYY-MM-DD (6 months from last review) |
| Author | @username |
| Reviewer | @username |
| Jira Link | CER-XXX |
| Published Date | YYYY-MM-DD (if published) |
| Platform | LinkedIn / Twitter / Email / Blog / Website |
```

## Content Aging Rules

1. **6 months after publication**: Content automatically flagged as `content-aging`
2. **Aging review outcomes**:
   - **Refresh**: Update content, reset review clock
   - **Keep**: Still relevant, update "Last Reviewed" date
   - **Retire**: Move to Archive, add `content-retired` label

## Naming Conventions

### Campaign Folders
- Format: `YYYY-MM - Campaign Name`
- Example: `2026-01 - AI Enhancement Initiative`

### Content Pages
- LinkedIn: `LI - [Topic] - [Date YYYY-MM-DD]`
- Twitter: `TW - [Topic] - [Date YYYY-MM-DD]`
- Email: `EM - [Sequence Name] - [Email Number]`
- Blog: `BLOG - [Title]`
- Website: `WEB - [Page Name]`

## Workflow Integration

### Creating Content (Marketing Agent)

1. Check if campaign folder exists, create if not
2. Create content page with correct naming convention
3. Add Page Properties macro with initial values
4. Add `content-draft` label
5. Link to source Jira issue

### Review Process

1. Author updates status to "In Review", adds `content-review` label
2. Notification sent to reviewer (via Jira comment or Slack)
3. Reviewer approves → status to "Approved", add `content-approved` label
4. Content scheduled → status to "Scheduled", add `content-scheduled` label

### Publication

1. Content posted to platform (manual or future automation)
2. Update status to "Published", add `content-published` label
3. Record Published Date in Page Properties
4. Set Review Due date (6 months out)

### Aging Check (Weekly Scheduled Job)

1. Query Confluence for pages with `content-published` label
2. Check Review Due date
3. If past due: add `content-aging` label, create Jira task for review
4. Notify marketing team via Slack

## Jira Integration

### Marketing Task Creates Content
- Marketing agent creates Confluence pages
- Links back to Jira issue in Page Properties
- Posts `[AUTO-MARKETING]` comment with Confluence links

### Website Changes Need Development
- Marketing agent creates Jira Story: `[Website] <description>`
- Story links to Confluence page with copy
- Story transitioned to "In Progress" for engineer pickup

### Content Review Tasks
- Aging content creates Jira task: `[Content Review] <page title>`
- Assigned to marketing team
- Links to Confluence page needing review

## Access Control

| Role | Permissions |
|------|-------------|
| Marketing Team | Edit all content |
| Stakeholders | Comment, suggest changes |
| Engineers | View website copy pages |
| Marketing Agent | Create, edit content pages |

## Initial Setup Checklist

- [ ] Create MKTG space in Confluence
- [ ] Create top-level folder pages (Campaigns, Brand, SEO, Content Calendar, Archive)
- [ ] Set up Page Properties Report macro on Campaigns overview
- [ ] Configure space permissions
- [ ] Test marketing agent can create pages
- [ ] Set up aging check scheduled workflow
