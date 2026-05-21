---
name: product-onboarding
description: Scan a target repo and generate product-specific skills (<id>-engineer, <id>-backend, <id>-frontend, <id>-infra, <id>-brand) + detect quality-gate commands, UAT paths, and tech stack. Used by the /onboard-product wizard to bootstrap new product plugins with real, working agent grounding.
last_updated: 2026-04-18
---

# Product Onboarding — Repo Scan and Skill Generation

## 1. When to Load This Skill

Load this skill when the `/onboard-product` wizard has collected basic product info (Steps 1–6) and the user has confirmed a `workingDir`. It provides the precise recipes for scanning the target repository and generating the five product-specific engineering skills. It is not a general-purpose skill — do not load it outside the onboarding context.

---

## 2. Inputs Expected

The following values must be available before executing any recipe. They come from the wizard's collected answers.

| Input | Example | Required |
|-------|---------|----------|
| `productId` | `myproduct` | Yes |
| `productName` | `MyProduct` | Yes |
| `workingDir` | `/srv/projects/myproduct` | Yes |
| `pluginDir` | `/srv/orchestracode-autodev/myproduct-plugin/skills` | Yes |
| `branding` | Colours, tone, voice, spelling, website, email (from Step 4) | Optional |
| `domain` | Industry, frameworks, regulators (from Step 6) | Optional |

If `workingDir` does not exist, abort immediately. Do not generate any skill files. Return: "Cannot generate skills — `<workingDir>` does not exist. Verify the path and re-run the wizard."

---

## 3. Repo Scan Recipe

Execute each step in order. Record all findings in a working object called `scan`. Reference it throughout Section 4 when writing skill files.

### 3.1 Detect Monorepo Structure

1. Read `<workingDir>/package.json`. If absent, set `scan.hasPackageJson = false` and skip to step 3.2 (limited detection only).
2. Check for `<workingDir>/pnpm-workspace.yaml`. If present, set `scan.packageManager = "pnpm"` and `scan.isMonorepo = true`.
3. Otherwise check for `<workingDir>/yarn.lock` → `packageManager = "yarn"`. Then `<workingDir>/package-lock.json` → `packageManager = "npm"`. Default to `"npm"` if none found.
4. If the root `package.json` has a `"workspaces"` key, set `scan.isMonorepo = true`.
5. If `scan.isMonorepo`, glob the following patterns (excluding `node_modules`, `dist`, `.next`):
   - `<workingDir>/apps/*/package.json`
   - `<workingDir>/packages/*/package.json`
6. Record each found path as `scan.workspaces[]` with `{ path, name }` where `name` is the `name` field from that `package.json`.
7. If 10 or more workspaces are found, set `scan.largMonorepo = true`. The generation recipe in Section 4 will handle this differently.

### 3.2 Detect Framework Stack

Collect all `dependencies` and `devDependencies` keys from every `package.json` in `scan.workspaces[]` plus the root. Build a flat set of all package names. Then apply the following detection rules in order. Record results as `scan.stack`.

**Backend framework** (`scan.stack.backend`):
- `fastify` present → `"Fastify"`. Also read its version from the nearest `package.json` that declares it and record as `scan.stack.backendVersion`.
- `@nestjs/core` present → `"NestJS"`
- `@trpc/server` present → `"tRPC"`
- `express` present → `"Express"`
- `koa` present → `"Koa"`
- None matched → `null`

**Frontend framework** (`scan.stack.frontend`):
- `next` present → `"Next.js"`. Read version → `scan.stack.frontendVersion`.
- `vue` present and `nuxt` absent → `"Vue"`
- `nuxt` present → `"Nuxt"`
- `react` present and `next` absent → `"React"`
- None matched → `null`

**ORM** (`scan.stack.orm`):
- `@prisma/client` → `"Prisma"`. Read version.
- `drizzle-orm` → `"Drizzle"`
- `typeorm` → `"TypeORM"`
- None → `null`

**Auth** (`scan.stack.auth`):
- `@clerk/nextjs` or `@clerk/clerk-sdk-node` → `"Clerk"`
- `next-auth` → `"NextAuth"`
- `argon2` and `otplib` both present → `"Custom (argon2 + otplib TOTP)"`
- None → `null`

**Test runners** (`scan.stack.testRunner`):
- `vitest` → `"Vitest"`
- `jest` → `"Jest"`
- None → `null`

**E2E** (`scan.stack.e2e`):
- `@playwright/test` or `playwright` → `"Playwright"`
- `cypress` → `"Cypress"`
- None → `null`

**Styling** (`scan.stack.styling`):
- `tailwindcss` present:
  - Check for `<workingDir>/tailwind.config.ts` or `tailwind.config.js` → Tailwind v3.
  - Check for `@theme` directive in any `*.css` file in `apps/*/src/` → Tailwind v4.
  - Record as `"Tailwind CSS v3"` or `"Tailwind CSS v4"` accordingly.
- None → `null`

### 3.3 Detect Commands

From the root `package.json` `"scripts"` object, extract verbatim script names for the following canonical purposes. Use the EXACT key as it exists — do not rename or normalise.

| Purpose | Keys to check (in priority order) |
|---------|----------------------------------|
| Dev server | `dev`, `start:dev`, `develop` |
| Build | `build` |
| Tests | `test`, `test:run` |
| Lint | `lint`, `lint:fix` |
| Type check | `type-check`, `typecheck`, `tsc` |

Record as `scan.scripts.dev`, `scan.scripts.build`, `scan.scripts.test`, `scan.scripts.lint`, `scan.scripts.typeCheck`.

If a monorepo, also record per-workspace scripts from `apps/*/package.json` as `scan.workspaceScripts[appName]`. Include `dev` and `build` at minimum.

If a script key is absent from the root, set its scan value to `null` — do not invent a command.

### 3.4 Detect Playwright / E2E Layout

1. Glob `<workingDir>/**/playwright.config.{ts,js,mjs}` excluding `node_modules`, `dist`, `.next`.
2. For each config found: read the file and extract:
   - `testDir` value
   - `baseURL` value (check `use.baseURL`)
   - `projects[].name` values (if defined)
3. Record as `scan.e2e.configPaths[]`, `scan.e2e.primaryConfig` (first found), `scan.e2e.testDir`, `scan.e2e.baseURL`, `scan.e2e.projectNames[]`.
4. If no config found: set `scan.e2e.present = false`.

Multiple configs are common in monorepos (e.g., EstateOS has `apps/web/e2e/feature/playwright-feature.config.ts` and `apps/web/e2e/playwright.config.ts` as separate configs for separate test layers). Record all of them.

### 3.5 Detect DB and Schema

Check the following paths in order and record the first match as `scan.db.schemaPath`:

1. `<workingDir>/prisma/schema.prisma`
2. `<workingDir>/packages/database/prisma/schema.prisma`
3. `<workingDir>/apps/*/prisma/schema.prisma` (glob)
4. `<workingDir>/drizzle.config.ts`
5. `<workingDir>/drizzle.config.js`

Also glob `<workingDir>/**/migrations/` (excluding `node_modules`) and record as `scan.db.migrationsPath` if found.

If schema found and ORM is Prisma: read the schema file and extract all `model` names. Record as `scan.db.models[]` (top 20 only if more than 20 exist).

### 3.6 Detect Infrastructure

Check for the following and record each as present/absent in `scan.infra`:

| Key | Check |
|-----|-------|
| `terraform` | Glob `<workingDir>/infra/**/*.tf` or `<workingDir>/terraform/**/*.tf` |
| `copilot` | Directory `<workingDir>/copilot/` exists |
| `githubActions` | Glob `<workingDir>/.github/workflows/*.yml` |
| `dockerfile` | File `<workingDir>/Dockerfile` exists |
| `dockerCompose` | File `<workingDir>/docker-compose.yml` or `docker-compose.yaml` exists |
| `kubernetes` | Directory `<workingDir>/k8s/` or `<workingDir>/helm/` exists |
| `ecs` | File `<workingDir>/deploy/ecs-task-definition.json` exists |

Record the specific paths found, not just booleans, so the infra skill can reference them precisely.

### 3.7 Detect App Entry Points and Route Patterns

For each backend workspace:

1. Look for `src/index.ts`, `src/app.ts`, `src/server.ts`, or `src/main.ts`. Read the first found (up to 200 lines).
2. Scan `src/routes/` or `src/controllers/` for directory names. Record top-level route directories as `scan.backend.routeDirs[]`.

For each frontend workspace:

1. If Next.js: scan `src/app/` directory structure (one level deep). Record route group names and top-level page directories as `scan.frontend.routes[]` (limit to 20).
2. If React without Next.js: look for `src/routes/`, `src/pages/`, or a router config file.

---

## 4. Skill Generation Recipes

After the scan is complete, generate the following five skill files into `<pluginDir>/<productId>-<name>/SKILL.md`. If `scan.largeMonorepo = true`, skip generating separate backend and frontend skills — include essential summaries from both in the engineer skill only, and note the limitation clearly.

### Content Rules (Apply to All Five Skills)

- Use only facts verified from the scan. Do NOT invent framework versions, route paths, dependency names, or command names.
- If a section cannot be filled because the scan did not reveal the data, insert the following marker rather than inventing content: `> **Note**: Not yet documented — update when <specific trigger, e.g. "first backend feature is implemented">.`
- Do not copy-paste large blocks of source code from the repo. Reference paths and patterns; quote short illustrative snippets only where the exact syntax matters.
- Target length per skill: 150–500 lines. Shorter is better if the content is accurate.
- Frontmatter must be present on every skill file.

---

### 4.1 `<productId>-engineer/SKILL.md` — Umbrella Engineering Skill

**Frontmatter:**
```
---
name: <productId>-engineer
description: Umbrella engineering reference for the <productName> <monorepo/repo> — structure, <packageManager> workspaces, top-level scripts, quality gate order, and the <N> testing layers. Load for any engineering task before loading a layer-specific skill.
last_updated: <today's date>
---
```

**Required sections:**

1. **Cross-reference header** — State which other skills to load for API work, frontend work, infra work. One line per.
2. **Monorepo Layout** (if `scan.isMonorepo`) or **Repo Layout** (if not) — Render as an annotated directory tree showing `apps/`, `packages/`, key config files, and the workspaces detected. Include port numbers for `dev` commands if detectable.
3. **Package Manager and Workspaces** — The package manager, workspace config file, workspace names and their `@scope/name` identifiers, and the cross-package import protocol (workspace:\*).
4. **Top-Level Scripts** — Table of commands, what each does, and any notes. Use the verbatim names from `scan.scripts`. If `scan.scripts.typeCheck` is `type-check`, write `type-check` — never `typecheck`.
5. **Git Hygiene** — Generated artefacts to never commit: build outputs, tsbuildinfo, node_modules, any detected `.next/` or `dist/` directories. State the rule: always use explicit paths when staging.
6. **Commit Style** — State whatever standard is detected (look for `.commitlintrc.*` or a `commitlint` dev dependency). If none detected, recommend Conventional Commits with a subject example that includes the Jira project key pattern.
7. **Quality Gate Order** — Numbered list using the verbatim script names from `scan.scripts`. If `typeCheck` is present, put it first. Then lint, then test. Note which are required vs advisory.
8. **Testing Layers** — One subsection per detected test runner/config. For each: location, config path (from `scan.e2e` or vitest config detection), environment (Node/jsdom/browser), and how to run. If Playwright is present, reference the exact config paths from `scan.e2e.configPaths[]` — never guess.
9. **TypeScript Configuration** — If `tsconfig.json` present: note whether it uses project references (`"references"` key), strict mode, target, and module format. Quote only the `references` array if present.
10. **Active Packages** — Table of workspace packages with status (Active/Present — verify before importing) and one-line description. Mark any packages whose names suggest scaffolding artefacts.

**Target length**: 200–400 lines.

---

**Good example (from EstateOS `estateos-engineer`):**

```markdown
## Top-Level Scripts

| Command | What it does | Notes |
|---------|-------------|-------|
| `pnpm build` | `tsc -b` — composite TypeScript build | Builds all `references` entries in root `tsconfig.json` |
| `pnpm type-check` | `tsc -b` — same as build, validates types | **Note the hyphen**: it is `type-check`, not `typecheck` |
| `pnpm lint` | `eslint apps/api/src --fix` | Currently targets API only |
| `pnpm test` | `vitest run` — runs all Vitest suites | Workspace includes `apps/api`, `apps/web`, `packages/utils` |
```

This is good because: the script name is verbatim from `package.json`, the note about the hyphen prevents a common agent mistake, and the scope of `lint` is accurately qualified.

**Bad example (what to avoid):**

```markdown
## Top-Level Scripts

Run `pnpm typecheck` to validate TypeScript types, or `npm run type:check`.
Use `pnpm run test:unit` for unit tests and `pnpm run test:e2e` for E2E tests.
```

This is bad because: the script names are invented, not verified from `package.json`. An agent that runs `pnpm typecheck` on EstateOS will get `command not found`.

---

### 4.2 `<productId>-backend/SKILL.md` — Backend Skill

**Frontmatter:**
```
---
name: <productId>-backend
description: <Detected framework> API patterns for <productName> — <brief description of what the scan found: route structure, auth, DB, key patterns>. Load for any API work.
last_updated: <today's date>
---
```

**Required sections:**

1. **Cross-reference header** — Load `<productId>-engineer` for monorepo rules. Reference `<productId>-frontend` for API consumers.
2. **Server Entry Point** — Source path, port, dev command, build output, production start command. All from `scan.workspaceScripts` and detected entry files.
3. **Framework Version and Key Config** — Version from `scan.stack.backendVersion`, any notable config options found in the entry file (body limit, logging redaction, etc.).
4. **Route Structure** — Directory tree of `src/routes/` or equivalent from `scan.backend.routeDirs[]`. Note the URL prefix pattern. If the scan found fewer than 3 route directories, add a Note marker.
5. **Route Handler Pattern** — A short representative example from the codebase (read one actual route file). Show the real pattern: schema definition, registration, handler, service call. Do not invent a pattern.
6. **Authentication** — From `scan.stack.auth`: which auth library/strategy, where the middleware is registered, how it is applied to routes. If custom auth is detected (`argon2 + otplib`), describe the token types, storage, and how the authenticate decorator is used.
7. **DB / ORM Patterns** — From `scan.db.schemaPath` and `scan.stack.orm`: schema location, how to obtain a client, any multi-tenancy or extension patterns found (read the entry file and tenant-context plugin if Fastify). List key model names from `scan.db.models[]` if Prisma detected.
8. **Error Handling** — From reading the error handler plugin or equivalent: the error response shape, common factory methods.
9. **Key Dependencies** — Table of the most significant detected runtime dependencies with versions.
10. **Environment Variables** — From the ECS task definition, copilot manifest, or `.env.example` if present. If none found, add a Note marker.

**Target length**: 200–500 lines.

---

**Good example (from EstateOS `estateos-backend`):**

```markdown
## Authentication and Token Pattern

Authentication uses **custom JWT** (via the `jose` library), **not** a third-party auth provider.

| Token | Storage | Lifetime | Purpose |
|-------|---------|---------|---------|
| `access_token` | Memory (client) | Short-lived | API authorisation; carries `sub`, `org_id`, `role`, `jti` |
| `refresh_token` | httpOnly cookie | 7 days | Silent access token renewal |
```

This is good because: the auth type is verified from `package.json` (`jose`, `argon2`, `otplib` — not a third-party provider), the token types come from reading the actual `authentication.ts` plugin, and the cookie settings are accurate.

**Bad example (what to avoid):**

```markdown
## Authentication

This application uses JWT-based authentication with standard middleware. Tokens are stored in localStorage and expire after a configurable period. Consider using a library like Passport.js for production use.
```

This is bad because: it does not reflect the actual auth implementation, it recommends Passport.js when the repo uses `jose`, and it states localStorage when the repo uses httpOnly cookies.

---

### 4.3 `<productId>-frontend/SKILL.md` — Frontend Skill

**Frontmatter:**
```
---
name: <productId>-frontend
description: <Detected framework> patterns for <productName> — route structure, <styling approach>, <state/data pattern>, and e2e test configuration. Load for any frontend work.
last_updated: <today's date>
---
```

**Required sections:**

1. **Cross-reference header** — Load `<productId>-engineer` for monorepo rules. Reference `<productId>-backend` for API endpoints.
2. **App / Page Structure** — Directory tree from `scan.frontend.routes[]`. For Next.js: show the `src/app/` structure with route groups. For React SPA: show the routes config or pages directory.
3. **Design System and Styling** — From `scan.stack.styling`: Tailwind version, config file location, any design token patterns (CSS custom properties, theme tokens). If none detected, add a Note marker.
4. **Component Organisation** — Where UI components live (`src/components/`, `src/ui/`, etc.) — from a glob of those directories. Note any co-location patterns.
5. **State Management and Data Fetching** — Detect `@tanstack/react-query`, `swr`, `zustand`, `jotai`, `redux` from dependencies. Describe the detected approach. If none detected, add a Note marker.
6. **Authentication Flow** — How the frontend handles auth. Reference `scan.stack.auth`. Describe the route protection pattern (middleware, layout guard, etc.) found in the app directory.
7. **Forms Pattern** — Detect `react-hook-form`, `formik`. Describe the detected approach with a brief example of how forms are structured.
8. **E2E Test Configuration** — Reference all entries from `scan.e2e.configPaths[]`. For each: location, `testDir`, `baseURL`, how to run, what it covers. Use exact paths — never substitute `e2e/uat/` if the scan found `e2e/feature/`.
9. **Key Dependencies** — Table of significant frontend dependencies with versions.
10. **Dev and Build Commands** — From `scan.workspaceScripts[webAppName]`.

**Target length**: 150–350 lines.

---

**Good example (from EstateOS `estateos-frontend`):**

```markdown
### Layer 2 — Feature UAT Tests (Playwright)

- **Location**: `apps/web/e2e/feature/`
- **Config**: `apps/web/e2e/feature/playwright-feature.config.ts`
- **Base URL**: `process.env["UAT_BASE_URL"] ?? "http://localhost:3001"` (note: targets port 3001, not 3000)
- **Pattern**: one file per Jira issue (`feature-EOS-NNN.spec.ts`)
```

This is good because: the config path is exact (from the scan), the base URL is quoted verbatim from the config file (including the unusual port 3001), and the file naming convention is stated.

**Bad example (what to avoid):**

```markdown
### E2E Tests

Playwright tests are located in `e2e/uat/` and use the default configuration. Run with `npx playwright test`.
```

This is bad because: the path `e2e/uat/` does not exist in EstateOS (tests are in `e2e/feature/` and `e2e/ux-validation/`), and the run command ignores the custom config file.

---

### 4.4 `<productId>-infra/SKILL.md` — Infrastructure Skill

**Frontmatter:**
```
---
name: <productId>-infra
description: Infrastructure for <productName> — <list detected IaC tools and deployment targets>. Load for infrastructure, deployment, or DevOps work.
last_updated: <today's date>
---
```

**Required sections:**

1. **Cross-reference header** — Load `<productId>-engineer` for repo structure.
2. **Overview Table** — Rows for each detected infra element from `scan.infra`. Columns: Area, Technology, Location. If a common area (CI/CD, containerisation, IaC) is absent, include a row stating "Not detected" — do not omit it.
3. **IaC Detail** — If Terraform detected: read the `.tf` files and describe resources created, provider version, variable names. If Copilot detected: read `copilot/*/manifest.yml` and describe services and environment.
4. **Deployment Topology** — How the app is deployed. If ECS: read `deploy/ecs-task-definition.json`. If Docker Compose only: describe the compose services.
5. **Secrets Management** — How secrets are injected. Look for `AWS Secrets Manager`, `Parameter Store`, `.env` files, or Copilot secret declarations.
6. **CI/CD** — If `.github/workflows/` detected: read the workflow files and describe the pipeline steps.
7. **What is Not Present** — Explicitly list any missing infra that would be expected for a production service of this type. Examples: "No database migration CI step detected", "No staging environment manifest". Being honest about gaps is more useful than leaving them implicit.

**Target length**: 100–250 lines.

---

**Good example (from EstateOS `estateos-infra`):**

```markdown
## What is Not Present

The following infrastructure components are not present in the current repo state:

- No staging Copilot environment (only `prod` is defined)
- No database backup automation
- No CDN configuration
- CI/CD workflow files exist in `.github/workflows/` but are incomplete stubs
```

This is good because: it gives the infra engineer an honest inventory of gaps, helping them avoid assuming something is handled when it is not.

**Bad example (what to avoid):**

```markdown
## Infrastructure Overview

The application is deployed to AWS using industry-standard practices including auto-scaling, load balancing, and blue-green deployments. Secrets are managed securely.
```

This is bad because: none of these claims are verified from the scan. EstateOS has ECS Fargate but the scan does not reveal auto-scaling config or blue-green deployments. Stating them as fact would mislead the infra agent.

---

### 4.5 `<productId>-brand/SKILL.md` — Brand Skill

**Frontmatter:**
```
---
name: <productId>-brand
description: Brand, voice, and design language for <productName> — colours, typography, tone, spelling convention, and writing anti-patterns. Load for any marketing, UI, or content task.
last_updated: <today's date>
---
```

**Required sections:**

1. **Colour Palette** — Use the exact hex values the user provided in Step 4. For each colour: hex value, name/role (primary, secondary, accent, etc.), and the closest Tailwind CSS class equivalent if Tailwind is detected (e.g., `bg-blue-900` for `#1E3A8A`). If the user provided no colours, add a Note marker.
2. **Typography** — If the user provided font information, state it. Otherwise: detect any Google Fonts or font imports in the frontend source, or add a Note marker.
3. **Voice and Tone Principles** — From the wizard's Step 4 answer. Present as a bulleted list of principles. Use the user's words, not paraphrases.
4. **Spelling Convention** — UK English or US English, as stated by the user. List common words where they differ (colour/color, organise/organize, programme/program, licence/license).
5. **Writing Style Rules** — From the user's tone answer: active or passive voice preference, sentence length guidance, whether technical jargon is permitted.
6. **Anti-patterns** — What not to do. Derive from the tone statement (e.g., if tone is "professional and reassuring", anti-patterns include hype language, exclamation marks, casual contractions). Add 3–5 explicit anti-patterns.
7. **Worked Examples** — One "before and after" example showing a generic sentence transformed to match the brand voice. Use language relevant to the product domain.
8. **UI Application** — How the colour palette should be applied to UI components: primary for CTAs, secondary for navigation highlights, accent for badges/alerts. Reference Tailwind classes if detected.

This skill is read by `marketing`, `ui-engineer`, and `ux-agent`. Write it so a non-designer can apply the brand without ambiguity.

**Target length**: 100–200 lines.

---

## 5. Post-Generation Validation

After writing all skill files, run the following checklist. Report any failures to the caller.

```
[ ] All five skill files exist:
    - <pluginDir>/<productId>-engineer/SKILL.md
    - <pluginDir>/<productId>-backend/SKILL.md
    - <pluginDir>/<productId>-frontend/SKILL.md
    - <pluginDir>/<productId>-infra/SKILL.md
    - <pluginDir>/<productId>-brand/SKILL.md

[ ] Each skill file has valid frontmatter:
    - `name` field present and matches directory name
    - `description` field present and non-empty
    - `last_updated` field present

[ ] No invented script names:
    - Zero occurrences of `typecheck` (without hyphen) in any skill file,
      unless `scan.scripts.typeCheck` is literally `typecheck`
    - Zero occurrences of `test:unit` or `test:e2e` unless those exact keys
      exist in scan.scripts or scan.workspaceScripts

[ ] No phantom tool names:
    - Zero occurrences of ` Exec,` or ` Browser,` in any skill file
      (these are invalid MCP tool names that occasionally appear in generated content)

[ ] E2E paths are accurate:
    - The Playwright config path(s) in <productId>-frontend match scan.e2e.configPaths[]
    - No occurrence of `e2e/uat/` in any skill unless scan.e2e.configPaths contains that path

[ ] Brand colours match user input:
    - The hex values in <productId>-brand match exactly what the user provided in Step 4
    - No rounding or substitution of similar-looking values

[ ] Frontmatter description in <productId>-backend references the detected
    framework (e.g. "Fastify 5 API" not "Node.js API")

[ ] If scan.hasPackageJson = false:
    - <productId>-engineer contains a visible "stub" banner near the top
```

If any check fails, correct the skill file before returning to the wizard.

---

## 6. Failure Modes and Fallbacks

### `workingDir` does not exist

Abort. Return: "Cannot generate skills — `<workingDir>` does not exist or is not readable. Verify the path and re-run the wizard." Do not create any files.

### `package.json` is absent

Generate a minimal engineer skill containing:
- A banner: `> **Stub** — target repo has no \`package.json\`. Fill in the sections below manually once the repo structure is established.`
- Sections with Note markers for: monorepo layout, scripts, testing layers, quality gate.
- Set `scan.stack` to all nulls.
- Do not generate backend or frontend skills (there is insufficient data). Generate the infra and brand skills if the scan found any infra artefacts or the user provided branding.

### No Playwright config found

Do not generate a "UAT" or "E2E" section in `<productId>-frontend`. Instead, include a banner:

```markdown
## E2E Tests

> **Requires setup** — No Playwright configuration was detected in this repository.
> To add Playwright: `pnpm create playwright` (or equivalent for your package manager).
> Once configured, update this skill with the config path, testDir, and baseURL.
```

Do not reference `e2e/uat/` as a guess. Omit any UAT path references in generated agent files.

### Monorepo with 10 or more packages (`scan.largeMonorepo = true`)

Generate a single `<productId>-engineer` skill that:
- Lists all workspaces in a table.
- Notes at the top: `> **Large monorepo** — this skill covers the full workspace list. Backend and frontend skills were not generated individually due to workspace count. Add per-service skills as the team focuses on specific services.`

Do not generate separate backend and frontend skills. Generate infra and brand as normal.

### Scan finds a workspace with the same name as the product ID

This is expected (e.g., `packages/estateos-backend` in EstateOS). Log it in the engineer skill's "Active Packages" section. Do not confuse these legacy scaffold packages with the authoritative backend or frontend apps.

---

## 7. Example Invocation

The following describes how the wizard uses this skill, step by step:

**User invokes the wizard and provides:**
- `workingDir = /srv/projects/myproduct`
- `productId = myproduct`
- Step 4 branding: primary `#1E3A8A`, tone "Professional, reassuring, and precise", UK English
- Step 6 domain: UK estate planning, Fastify backend, Next.js frontend

**Wizard runs scan recipe (Section 3):**
- 3.1: Detects `pnpm-workspace.yaml` → `isMonorepo = true`, `packageManager = pnpm`. Finds `apps/api`, `apps/web`, `packages/database`, `packages/types`, `packages/utils`, `packages/scan-worker`.
- 3.2: Detects `fastify ^5.1.0` in `apps/api/package.json`, `next ^15.1.0` in `apps/web/package.json`, `@prisma/client ^6.1.0` in `packages/database/package.json`, `argon2` + `otplib` in `apps/api/package.json` → auth = "Custom".
- 3.3: Finds `type-check` (with hyphen) in root `package.json` scripts. Records `scan.scripts.typeCheck = "type-check"`.
- 3.4: Finds two Playwright configs at `apps/web/e2e/feature/playwright-feature.config.ts` and `apps/web/e2e/playwright.config.ts`. Records both.
- 3.5: Finds `packages/database/prisma/schema.prisma`. Records 20 model names.
- 3.6: Finds `infra/s3/`, `copilot/`, `deploy/ecs-task-definition.json`. No `k8s/`.

**Wizard writes skill files (Section 4):**
- Generates `estateos-engineer/SKILL.md` with pnpm workspace table, verbatim `type-check` script name, two-layer Playwright testing summary, and TypeScript project references.
- Generates `estateos-backend/SKILL.md` with Fastify 5 plugin order (read from `apps/api/src/app.ts`), custom JWT token types (read from `apps/api/src/plugins/authentication.ts`), Prisma extension chain (`forOrganisation` + `withEncryption`), and route directory tree.
- Generates `estateos-frontend/SKILL.md` with Next.js app-router structure, both Playwright config paths with exact `baseURL` values, and TanStack Query data fetching pattern.
- Generates `estateos-infra/SKILL.md` covering Terraform S3/KMS, AWS Copilot ECS Fargate, and an explicit "What is Not Present" section for staging environment and database backup automation.
- Generates `estateos-brand/SKILL.md` with the three hex values from Step 4, Tailwind class equivalents (`blue-900`, `teal-700`, `amber-400`), "Professional, reassuring, and precise" tone principles, UK English spelling list, and anti-pattern examples.

**Wizard runs validation (Section 5):**
- Confirms all five files exist, frontmatter is valid, `type-check` (with hyphen) is used throughout, Playwright paths match scan results, and brand hex values match user input exactly.

**Wizard returns to the onboarding flow** and informs the user that product skills have been generated and are ready for review in `estateos-plugin/skills/`.
