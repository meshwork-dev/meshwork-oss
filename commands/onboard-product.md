---
description: Onboard a new application to the Meshwork-AutoDev platform as a multi-product setup
---

# Product Onboarding Wizard

You are running an interactive product onboarding workflow. Your goal is to gather everything needed to create a `products/<id>/product.json` for a new application.

Ask questions one section at a time. Wait for answers before proceeding. Be conversational — this is a guided setup, not a form.

---

## How This Works

Tell the user upfront:

"Welcome to the product onboarding wizard. I'll ask you a few questions about your application in 6 short sections. At the end I'll generate a product config file and add your project to the runner.

Most questions are optional — press Enter to skip anything that doesn't apply yet. Let's start."

---

## Step 1: Basic Info

Ask these questions together (they're quick):

1. What is the **product name**? (e.g. "AcmePay", "FleetTracker")
2. One-line **description** of what it does?
3. Where is the **codebase** on this machine? (absolute path, e.g. `/srv/projects/acmepay`)
4. What **industry or domain** does it serve? (e.g. fintech, healthcare, logistics, SaaS)
5. **Target market** — geography and company size? (e.g. "UK SMEs, 10-100 employees")

Derive a short `id` from the product name (lowercase, hyphens, no spaces). Show it to the user and ask if it looks right: "I'll use `acmepay` as the product ID — does that work?"

---

## Step 2: Project Management

Ask:

1. **Jira project key**? (e.g. `ACM`, `FLT`) — leave blank if not using Jira
2. **Jira project name**? (e.g. "AcmePay Dev")
3. **Jira board ID**? (the number in the board URL — used for sprint tracking)
4. **Confluence space key** for engineering docs? (e.g. `ACM`, `CE`)
5. Do you have a **separate marketing Confluence space**? If so, what's the key?
6. **Jira domain**? (e.g. `https://mycompany.atlassian.net`) — press Enter to use the Meshwork default
7. Do you want **automatic sprint execution**? (y/n) — The sprint runner picks up "To Do" issues from active sprints and dispatches them to agents automatically every 10 minutes.
   - If yes and boardId was provided: "Maximum issues to dispatch per cycle?" (default 5)

---

## Step 3: Tech Stack

Ask:

1. **Frontend framework**? (Next.js, React, Vue, Angular, other — or "none/backend only")
2. **Backend framework**? (tRPC, Express, FastAPI, Django, Rails, other)
3. **Database**? (PostgreSQL, MySQL, MongoDB, SQLite, other)
4. **ORM / query layer**? (Prisma, Drizzle, TypeORM, SQLAlchemy, ActiveRecord, other — or "none")
5. **Auth provider**? (Clerk, Auth0, NextAuth, Supabase, custom — or "none")
6. **Package manager**? (pnpm, npm, yarn, bun)
7. Key **dev/build commands** — what do you run for:
   - Start dev server?
   - Build?
   - Run tests?
   - Lint?
   - Type check? (press Enter to skip if not applicable)

Tell the user: "These commands become the product's quality-gate checks — the runner executes them after every implementation job — and are referenced by the acceptance agents."

These answers feed **two** places in the generated `product.json`: `techStack.commands` (agent reference) and `qualityGate.checks` (runner enforcement). Use the exact commands the user gives — never normalise script names (`type-check` stays `type-check`, not `typecheck`).

---

## Step 4: Branding (optional)

Tell the user: "This section is optional but helps the marketing and sales agents produce on-brand content."

Ask:

1. **Company name** (if different from product name)?
2. **Website URL**?
3. **Team email** for newsletters/signups? (e.g. `hello@acmepay.io`)
4. **Primary brand colour**? (hex code, e.g. `#0D9488`)
5. **Brand tone/voice**? (e.g. "Professional and approachable", "Bold and technical", "Friendly and simple")
6. **UK or US English**? (affects marketing content)

Press Enter to skip the whole section if it doesn't apply yet.

---

## Step 5: Sales and Marketing (optional)

Tell the user: "Skip this section if you don't need automated sales pipeline or marketing content generation."

Ask:

1. Do you need **sales pipeline automation**? (y/n)
   - If yes: Which **CRM**? (Attio, HubSpot, Salesforce, Pipedrive, none)
2. Do you need **LinkedIn monitoring and post drafting**? (y/n)
3. **Key competitors**? (comma-separated names — used for competitive intel monitoring)
4. Do you need **marketing content automation** in Confluence? (y/n)

---

## Step 6: Domain Expertise (CRITICAL — This Shapes Your PM)

Tell the user: "This is the most important section. The answers here determine how deeply your PM agent understands your domain. A generic PM manages tickets. A domain-specialist PM catches business logic errors before they ship, prioritises by regulatory urgency, and grows the agent team based on real expertise gaps."

"I'll ask about your domain in depth. The more you share, the smarter your PM will be from day one. You can always refine later."

### 6a. Industry & Regulatory Landscape

Ask:

1. What **industry or domain** does this product operate in? (Be specific — not just "legal" but "estate planning and probate" or "supply chain food safety certification")
2. What **regulatory bodies or standards organisations** govern this domain? (e.g. SRA, OPG, BRCGS, ISO, HMRC, FDA — list all that apply)
3. For each regulator, what are the **key requirements** that affect your product? (e.g. "SRA requires client identification and conflict checks", "OPG mandates LPA signing order")
4. Any **compliance deadlines or reporting cycles**? (e.g. "HMRC TRS registration within 90 days", "annual audit window")

### 6b. Core Domain Processes

Ask:

1. What are the **key workflows or processes** your product supports? (e.g. "will drafting → execution → registration", "certificate application → audit → issuance")
2. For each key workflow, are there **legally mandated sequences** that must be enforced? (e.g. "certificate provider must sign before attorneys", "two witnesses must be present simultaneously")
3. What are the **common edge cases** that trip people up? (e.g. "estates can have 2-4 executors with different permission levels", "mirror wills are separate documents that must be linked")
4. What are the **key user personas** and their domain expertise level? (e.g. "solicitors who know the law deeply", "SME owners who need hand-holding through compliance")

### 6c. Domain Terminology

Ask:

1. Are there **domain-specific terms** that must be used correctly? (e.g. "testator not user", "grant of probate not probate certificate", "non-conformance not defect")
2. Any terms that are **commonly confused** even by practitioners? (List pairs or groups)
3. Is there a **glossary or style guide** you follow? (UK English legal terms, industry-specific jargon, etc.)

### 6d. Known Pitfalls

Ask:

1. What are the **top 5-10 domain mistakes** a non-expert would make when building features for this product? (These become the PM's "Common Domain Pitfalls" section — the errors it catches that engineers would miss)
2. Are there areas where **the law or regulation is counter-intuitive**? (e.g. "marriage automatically revokes a will", "divorce doesn't revoke a will but treats ex-spouse as predeceased")

### 6e. Product Areas

Ask:

1. What are the **key product areas or modules**? (e.g. Dashboard, Client Records, Will Drafting, Evidence Management — brief list with one-line descriptions)

Tell the user: "These become your Jira Epics structure and the lens through which your PM analyses bugs and feature gaps."

### 6f. Competitive Landscape (optional)

Ask:

1. Who are your **key competitors**? (names and URLs if known)
2. What is your **differentiation**? (What do you do that they don't?)
3. Any **industry trends** that affect product direction? (e.g. "shift to digital LPAs", "AI-assisted evidence collection")

---

## Generation

Once you have the answers, do the following in order:

### 1. Build the product.json

Construct a JSON object using the schema below. Use `null` or omit fields where the user didn't provide values — do not invent values.

```json
{
  "id": "<derived-id>",
  "name": "<Product Name>",
  "description": "<one-line description>",
  "workingDir": "<absolute path>",
  "pluginDir": "<id>-plugin",

  "domain": {
    "industry": "<specific industry from Step 6a>",
    "geography": "<geography>",
    "targetMarket": "<target market>",
    "frameworks": ["<framework1>", "<framework2>"],
    "competitors": [{ "name": "<name>", "url": "<url or null>" }],
    "regulators": [
      { "name": "<regulator name>", "relevance": "<why it matters>", "keyRequirements": "<brief>" }
    ],
    "keyProcesses": [
      { "name": "<process name>", "mandatedSequence": "<true/false>", "description": "<brief>" }
    ],
    "terminology": [
      { "term": "<correct term>", "meaning": "<definition>", "commonMistake": "<what people get wrong>" }
    ],
    "domainPitfalls": [
      "<pitfall description from Step 6d>"
    ]
  },

  "branding": {
    "companyName": "<company name>",
    "website": "<url or null>",
    "email": "<team email or null>",
    "tone": "<tone description>",
    "spelling": "<UK English or US English>",
    "colors": {
      "primary": "<hex or null>"
    }
  },

  "jira": {
    "domain": "<jira domain>",
    "projectKey": "<key or null>",
    "projectName": "<name or null>",
    "boardId": "<id or null>"
  },

  "confluence": {
    "space": "<space key or null>",
    "marketingSpace": "<marketing space key or null>"
  },

  "crm": {
    "platform": "<platform or null>"
  },

  "techStack": {
    "frontend": "<framework or null>",
    "backend": "<framework or null>",
    "database": "<database or null>",
    "orm": "<orm or null>",
    "auth": "<provider or null>",
    "packageManager": "<manager>",
    "commands": {
      "dev": "<command>",
      "build": "<command>",
      "test": "<command>",
      "lint": "<command>",
      "typeCheck": "<command or null>"
    }
  },

  "qualityGate": {
    "_comment": "Executed by the runner after every implementation job. Build from the Step 3 commands verbatim — omit entries the user skipped. Without this block the runner falls back to techStack.commands, then to the global npm defaults.",
    "checks": [
      { "name": "type-check", "cmd": "<typeCheck command from Step 3>", "required": true },
      { "name": "lint", "cmd": "<lint command from Step 3>", "required": true },
      { "name": "test", "cmd": "<test command from Step 3>", "required": true }
    ]
  },

  "worktreeSetup": {
    "_comment": "Commands run once after a fresh git worktree is created. Must produce a buildable tree (install deps + generate code clients). If omitted, runner auto-detects package.json + prisma.",
    "commands": [
      "<install command e.g. pnpm install --frozen-lockfile>",
      "<optional codegen e.g. pnpm exec prisma generate>"
    ]
  },

  "mergeBranch": "dev",
  "_mergeBranch_comment": "The runner merges feature branches into this integration branch and pushes it. A human opens a PR `<mergeBranch>` -> `main` for deployment. Defaults to 'dev' when omitted.",

  "marketing": {
    "linkedin": {
      "enabled": <true or false>,
      "competitors": ["<name1>"]
    }
  },

  "sprint": {
    "enabled": <true or false>,
    "boardId": "<boardId from jira section, or null>",
    "projectKey": "<projectKey from jira section, or null>"
  },

  "sales": {
    "crm": "<platform or null>",
    "enabled": <true or false>
  },

  "videoConfig": {
    "enabled": false,
    "tts": { "provider": "edge", "voice": "en-GB-RyanNeural" },
    "branding": { "introTitle": "<Product Name> Tutorial", "fontFamily": "Inter" },
    "output": { "resolution": "1080p", "fps": 30, "format": "mp4" }
  },

  "productAreas": [
    { "name": "<area>", "description": "<brief>" }
  ]
}
```

### 2. Write the file

Use the Write tool to create:

```
products/<id>/product.json
```

(Relative to the Meshwork-AutoDev project root.)

### 3. Generate the plugin scaffold

Create the `<id>-plugin/` directory with the following structure:

```
<id>-plugin/
  .claude-plugin/
    marketplace.json
    plugin.json
  agents/
  skills/
  commands/
  hooks/
  company-brief.md
  .mcp.json
```

**Agent selection**: Ask the user which agent capabilities they need. Present these groups:

- **Core** (always included): `engineer-planner`, `engineer-implementer`, `engineer-reviewer`, `bug-triage`, `product-manager`, `sprint-reporter`, `security-agent`
- **UI** (if frontend): `ui-engineer`
- **Sales** (if enabled in Step 5): `sales-development`, `sales-researcher`, `sales-outreach`
- **Marketing** (if enabled in Step 5): `marketing`, `creative-assets`
- **Advanced** (optional): `ba-agent`, `architect`, `ux-agent`, `qa-agent`, `ask-dave-agent`, `e2e-builder`, `uat-agent`
- **Documentation** (optional): `user-guide-agent`, `video-renderer` — navigates the live app to produce screenshot-based user guides and tutorial videos

For each selected agent, read the template from `templates/agents/<agent>.md` as a reference. Generate a product-specific version by substituting:

- Product name, description, positioning (from product.json)
- Jira project key and board ID
- Confluence space keys
- Brand colors, tone, terminology
- Tech stack, frameworks, dev commands
- Skill file references — `meshwork-*` → `<id>-*` in the body, and `__PRODUCT_ID__-*` entries in the `skills:` frontmatter → `<id>-*`. Remove `skills:` entries for skills that were not generated (e.g. backend/frontend skills in a large monorepo)
- CRM workspace and fields
- UAT paths and regression journeys

Write each generated agent to `<id>-plugin/agents/<agent>.md`.

#### CRITICAL: Domain-Specialist Product Manager

The `product-manager` agent gets **special treatment**. Do NOT just substitute product names into the generic `templates/agents/product-manager.md`. Instead, use `templates/agents/product-manager-domain-specialist.md` as the **structural reference** (it's the domain-specialist reference implementation — the `<!-- ONBOARDING: ... -->` comments mark where Step 6 answers go) and generate a PM with:

1. **Domain expertise header** — "You are a domain-specialist product manager for {Product}. You think, reason, and make decisions as someone with deep expertise in {domain from Step 6a}."

2. **Team Lead role** — PM leads BA, UX, QA as teammates. Team composition is domain-driven (from Step 6b).

3. **Domain Expertise section** — Built from Step 6 answers:
   - **Practice Areas & Key Processes** — From Step 6b (core workflows, legally mandated sequences, edge cases)
   - **Regulatory Framework** — From Step 6a (regulators, key requirements, compliance deadlines)
   - **Domain Terminology** — From Step 6c (correct terms, common confusions)
   - **Common Domain Pitfalls** — From Step 6d (numbered list of mistakes a non-expert would make)

4. **Self-Assessment capability** — Reference `skills/pm-self-assess/SKILL.md` (shared skill). Include domain-specific signals to watch for, derived from the pitfalls in Step 6d.

5. **Domain-specific acceptance checks** — Beyond standard AC verification, the PM checks regulatory compliance, process sequence enforcement, multi-party handling, terminology correctness, and data sensitivity — all grounded in the domain knowledge from Step 6.

6. **Release notes voice** — Written from the perspective of a domain practitioner, not a generic PM. Include example transformations from technical language to domain-user language.

7. **Self-check includes domain validation** — "If your output could apply to any product (not just {domain}), you haven't gone deep enough."

If the user provided minimal domain info in Step 6, generate a PM with placeholder sections marked `<!-- TODO: Fill in domain knowledge -->` and tell the user: "Your PM agent has placeholder sections for domain expertise. The more domain knowledge you add to these sections, the more value the PM provides. Run the self-assessment skill periodically — it will identify what's missing."

**`company-brief.md`**: Generate from product.json values — company overview, product description, target market, brand voice, tech stack, team structure.

**`.mcp.json`**: Generate based on the integrations the user selected (CRM tools if sales enabled, etc.). Use `shared-skills/.mcp.json` as a reference for server entry shapes, and `docs/claude/integrations.md` for integration-specific setup. The `n8n-jira-mcp` entry already ships platform-wide in `shared-skills/.mcp.json` — do not duplicate it here.

Always add a `memory` entry to the plugin `.mcp.json` using the container path:

```json
"memory": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-memory"],
  "env": { "MEMORY_FILE_PATH": "/home/node/.claude/memory/<id>.json" }
}
```

(Replace `<id>` with the product ID.) This is the **only** place the memory
server is provisioned — there is deliberately no platform-wide memory graph,
so each product's observations stay isolated in its own file.

**`.claude-plugin/marketplace.json`**: Product name, description, owner.

**`.claude-plugin/plugin.json`**: Plugin descriptor with name and version.

**`hooks/`**: Copy the safety hooks from `shared-skills/hooks/` (these are product-agnostic).

**`skills/`** and **`commands/`**: Create empty directories. Tell the user they can add product-specific skills later.

### 4. Generate the working-dir `.mcp.json` and update `~/.zprofile`

#### 4a. Create the working-dir `.mcp.json`

Create a `.mcp.json` file at `<workingDir>/.mcp.json` (the product's codebase root on the host machine).

This file merges two sources:

1. **Platform MCPs** — take every server from `$AUTODEV_DIR/shared-skills/.mcp.json`. Adapt container URLs (`http://n8n:5678`, `http://runner:3210`) to `localhost` equivalents and preserve env-var refs like `${RUNNER_SECRET}` / `${N8N_MCP_AUTH_TOKEN}`, `alwaysLoad` flags, and `Authorization` headers.

2. **Product plugin MCPs** — take every server from the plugin `.mcp.json` you just generated (`<id>-plugin/.mcp.json`). Adapt container URLs to host-accessible equivalents:
   - `http://n8n:5678` → `http://localhost:5678`
   - `http://runner:3210` → `http://localhost:3210`
   - Leave `https://` and `ngrok.app` URLs unchanged.
   - Preserve all other fields: `Authorization` headers, env-var refs, `alwaysLoad`, etc.

3. **Override the `memory` entry** with the host path instead of the container path:
   ```json
   "memory": {
     "command": "npx",
     "args": ["-y", "@modelcontextprotocol/server-memory"],
     "env": { "MEMORY_FILE_PATH": "$HOME/.claude/memory/<id>.json" }
   }
   ```
   (Memory is strictly per-product — the platform defines no memory server, so this entry is the product's only graph.)

If a server key appears in both sources, the plugin version wins (it's more specific). Do not include duplicate keys.

Also ensure the memory directory exists:
```bash
mkdir -p $HOME/.claude/memory
```

Inform the user: "Created `<workingDir>/.mcp.json` — Claude Code will use this when launched from your codebase."

#### 4b. Append to `~/.zprofile`

The `claude()` shell function in `~/.zprofile` maintains two parallel arrays: `working_dirs` and `plugin_dirs`. Add one entry to each.

Read `~/.zprofile`, locate the `working_dirs=(` and `plugin_dirs=(` arrays inside the `claude()` function, and insert before the closing `)` of each:

- In `working_dirs`: add `"<workingDir>"` (the absolute path to the product's codebase)
- In `plugin_dirs`: add `"<id>-plugin"` (the plugin directory name, not the full path)

The entries must be at the same index in both arrays — append to the end of each list.

After writing, tell the user: "Added `<workingDir>` and `<id>-plugin` to `~/.zprofile`. Run `source ~/.zprofile` (or open a new terminal) for the change to take effect."

### 5. Add the workingDir to allowedRoots (if needed)

Read `$AUTODEV_DIR/claude-runner/config.json`.

If the product's `workingDir` is not already in the `allowedRoots` array, add it and write the file back.

Inform the user: "Added `<workingDir>` to `allowedRoots` in config.json."

If `allowedRoots` is empty (no restriction), skip this step and say so.

### 6. Validate the generated plugin

Run the agent linter from the Meshwork-AutoDev root (it auto-discovers `<id>-plugin/agents/`):

```bash
node scripts/lint-agents.mjs
```

Fix any reported errors in the generated agents before continuing (frontmatter shape, model values, tool references).

Then verify skill references resolve: for every entry under `skills:` in each generated agent's frontmatter, confirm a matching directory exists in `<id>-plugin/skills/` or `shared-skills/skills/`. Remove entries that do not resolve — a dangling reference silently degrades the runner's per-agent context optimisation.

Report the validation result to the user (files checked, errors fixed, dangling references removed).

### 7. Print next steps

Tell the user:

---

**Product `<id>` onboarded.**

Config written to `products/<id>/product.json`.
Plugin scaffold created at `<id>-plugin/`.

**Next steps:**

1. **Review generated agents** in `<id>-plugin/agents/` — customize domain-specific details for your product.

2. **Review the config** — open `products/<id>/product.json` and fill in any fields you left blank.

3. **Jira setup** — if you provided a Jira key, make sure the project exists at your Jira domain. The agents will reference it for issue tracking.

4. **Confluence setup** — if you provided a Confluence space key, make sure the space exists. The agents will store documentation there.

5. **Create product-specific skills** — add skills in `<id>-plugin/skills/<id>-<skill>/SKILL.md` to give agents deep knowledge of your product.

6. **Test it** — run a job against your product by sending a request to the runner with `"workingDir": "<workingDir>"`. The plugin is loaded automatically when jobs target your product's workingDir.

7. **Sprint execution** — if sprint execution is enabled, issues in "To Do" status within an active sprint on board {boardId} will be auto-dispatched every 10 minutes. Add "Blocks" issue links for dependency ordering.

7b. **Pipeline choice** — the default `new-feature` pipeline is lean (implement → review → verify). If you declared regulators in Step 6, consider dispatching work through `new-feature-enterprise` instead (plan → implement → review → security-review → verify → PM acceptance) by passing `"pipelineType": "new-feature-enterprise"` to `POST /pipeline`.

8. **Optional: N8N routing** — if your Jira project key does not yet have a routing rule in the `Jira_Webhook_Listener` N8N workflow, add one so issues from your project get dispatched to the runner.

9. **Reload without restart** — once the runner is running, you can hot-reload this config:
   ```bash
   curl -X POST http://localhost:3210/api/products/<id>/reload \
     -H "x-runner-secret: $RUNNER_SECRET"
   ```

---

If the user skipped the sales/marketing section entirely, omit the steps about Confluence marketing spaces and LinkedIn.

If the user skipped Jira, omit the Jira and N8N routing steps.

Keep the tone helpful and to the point — this is the end of the wizard, not a wall of documentation.
