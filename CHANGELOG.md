# Changelog

All notable changes to Meshwork are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Eight new agent templates so every `/onboard-product` selection group is backed
  by a real template: `product-manager-domain-specialist` (structural reference
  for the wizard's domain-specialist PM generation), `marketing`,
  `creative-assets`, `sales-development`, `sales-researcher`, `sales-outreach`,
  `user-guide-agent`, `video-renderer`
- `new-feature-enterprise` pipeline (plan → implement → code-review →
  security-review → verify → PM acceptance) for regulated/high-stakes products
- Quality gate now derives per-product checks from `product.json`
  `qualityGate.checks`, falling back to `techStack.commands` collected at
  onboarding — products no longer silently run the global `npm` defaults
- Quality gate parses test-runner summaries (Jest/Vitest/Playwright/pytest/
  Mocha/TAP) so a green exit code can't hide failing tests
  (`parseTestSummary` in `lib/protocol.js`, with unit tests)
- `/onboard-product` post-generation validation step: runs
  `scripts/lint-agents.mjs` and verifies `skills:` references resolve
- `skills:`/`context:` frontmatter declarations on core agent templates so the
  runner's per-agent context optimisation engages for generated plugins
- Initial OSS hygiene: `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `ROADMAP.md`
- GitHub issue templates (bug, feature, agent proposal) and pull-request template
- CI workflow that lints agent YAML frontmatter on every PR
- `examples/hello-world/` — reference product showing post-substitution plugin layout
- `docs/getting-started.md` — 5-minute walkthrough from clone to first agent run
- Four new agent templates ported from production:
  - `uat-agent` — Playwright-based User Acceptance Testing
  - `codebase-locator` — file/directory discovery utility
  - `codebase-analyzer` — implementation analysis with file:line references
  - `codebase-pattern-finder` — example/pattern catalog

### Changed
- 10 per-product agent templates promoted from stubs to production-ready
  (`ba-agent`, `architect`, `ux-agent`, `ui-engineer`, `sprint-reporter`,
  `engineer-implementer`, `product-manager`, `qa-agent`, `security-agent`,
  `e2e-builder`)
- `setup.sh` now copies `templates/agents/*.md` into `<product>-plugin/agents/`
  with substitution of `__PRODUCT_NAME__`, `__PRODUCT_ID__`,
  `__PRODUCT_DESCRIPTION__`, `__TECH_STACK__`, `__JIRA_PROJECT_KEY__`,
  `__WORKING_DIR__`

### Fixed
- Removed exposed Telegram bot token from `workflows/` and git history
- Scrubbed `lebc-client/` brand leak from `shared-skills/agents/skill-auditor.md`
- `/onboard-product` pointed at a non-existent `estateos-plugin` PM reference
  and a hardcoded `CER` Jira key; the product-onboarding skill's worked example
  mixed `myproduct` inputs with `estateos` outputs

### Security
- Rotated and force-pushed history to purge the leaked token
- Added private vulnerability disclosure flow (see `SECURITY.md`)

---

Older history lives in git. Tagged releases will populate this file from `v0.1.0` onward.
