# Roadmap

A living document. Order is rough priority, not commitment. Open a [discussion](https://github.com/meshwork-dev/meshwork/discussions) if you want to change the order or argue for something missing.

## Now — `v0.1` (initial public release)

- [x] Idempotent `setup.sh` with Postgres profile selection
- [x] Agent template substitution wired into onboarding
- [x] Production-ready templates for all 14 first-party agents
- [x] OSS hygiene (LICENSE, CONTRIBUTING, SECURITY, COC)
- [x] CI lint for agent frontmatter
- [x] `examples/hello-world/` reference product
- [ ] First clean install verified by an external contributor
- [ ] Demo video (clone → setup → first agent run, < 5 min)

## Next — `v0.2`

- [ ] **One-click integrations.** OAuth setup wizards for Jira, GitHub, Telegram instead of token paste
- [ ] **Dashboard onboarding tour.** First-run overlay walking through issues / chat / pipelines / agents
- [ ] **Agent marketplace.** `meshwork install <agent-name>` to add community agents without forking
- [ ] **Stable plugin schema.** `<product>-plugin/plugin.json` describing supported runner versions
- [ ] **Per-agent retry budgets.** Stop agents from burning context on the same failing task

## Later — `v0.3` and beyond

- [ ] **Multi-tenant runner.** Single deployment serving multiple teams with isolated workspaces
- [ ] **Bring-your-own LLM.** Routing layer so non-Claude models can serve specific agents
- [ ] **Skill marketplace.** Same idea as agents but for `shared-skills/`
- [ ] **Pipeline visualisation.** Live graph view of in-flight pipelines in the dashboard
- [ ] **SSO.** SAML / OIDC for dashboard login
- [ ] **Hosted Meshwork Cloud.** Optional — local stays first-class

## Considered, deferred

These came up, they're not bad ideas, just not next:

- A first-party RAG layer — too project-specific; defer to the working directory and let agents read.
- Custom training / fine-tuning per product — solved better by prompts + memory.
- IDE plugin — Claude Code already covers this; we orchestrate Claude Code, we don't replace it.

## Out of scope

- Hosted SaaS as the primary mode — Meshwork is self-hosted by design.
- Replacing GitHub / Jira / Slack — we integrate, we don't compete.
- A general-purpose chatbot — we orchestrate specialised agents, not a single generalist.

## How to influence the roadmap

1. Comment on an existing roadmap discussion: <https://github.com/meshwork-dev/meshwork/discussions/categories/ideas>
2. Open a new RFC discussion for anything not listed
3. Send a PR that moves the conversation forward — code beats specs

We try to keep this file in sync with the real direction. If something here feels stale, it probably is — please flag it.
