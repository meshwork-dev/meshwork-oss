# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| `main`  | Yes       |
| `dev`   | Yes (pre-release) |
| Older   | No        |

We patch security issues on `main` only. If you're running an older snapshot, the fix is to pull `main`.

## Reporting a Vulnerability

**Please do not open a public GitHub issue.** Public disclosure before a patch is available puts every Meshwork operator at risk.

Report privately one of two ways:

1. **GitHub Security Advisory** (preferred) — open a draft at
   <https://github.com/meshwork-dev/meshwork/security/advisories/new>
2. **Email** — <security@meshwork.dev> (PGP key on request)

Include, at minimum:

- Affected component (`runner`, `dashboard`, an agent, a workflow, etc.)
- Version / commit SHA you're running
- Reproduction steps or a minimal proof of concept
- Impact assessment (what an attacker can do)
- Any suggested mitigation

## What to Expect

| Step | Target time |
|------|-------------|
| Acknowledgement of your report | 48 hours |
| Initial triage & severity rating | 5 business days |
| Patch in `main` for high/critical | 14 days |
| Coordinated public disclosure | After patch ships |

We credit reporters in the advisory and CHANGELOG unless you ask to remain anonymous.

## Scope

In scope:

- The Meshwork runner (`claude-runner/`)
- The Meshwork dashboard (`dashboard/`)
- First-party agents under `shared-skills/agents/` and `templates/agents/`
- N8N workflow JSON shipped in this repo
- The `setup.sh` installer

Out of scope:

- Bugs in third-party dependencies — please report upstream
- Vulnerabilities requiring physical or local-network attacker access to your own machine
- Issues that depend on running with `--dangerously-skip-permissions` outside an isolated environment (this flag is documented as opt-in trust)
- Social-engineering attacks against operators

## Hardening Tips for Operators

Even with no known vulnerabilities, Meshwork executes Claude Code with broad permissions inside the working directory you point it at. Reduce blast radius:

- Keep `RUNNER_SECRET` and `DASHBOARD_PASSWORD` private; rotate if leaked
- Ports bind to `127.0.0.1` by default (`BIND_ADDRESS` in `.env`). Only set
  `BIND_ADDRESS=0.0.0.0` behind a TLS-terminating reverse proxy with ACLs
- Restrict `ALLOWED_ROOTS` to the directories you want agents to touch
- Don't commit `.env`, `.credentials.json`, N8N export bundles, or `products/<id>/product.json` if it contains tokens
- Treat agent-generated PRs the same way you'd treat a junior engineer's PR — review before merge
- **Enable webhook verification.** Every webhook workflow ships with a
  "Verify caller" node that accepts either the runner's HMAC signature
  (`x-meshwork-signature`, sent automatically on all runner callbacks) or the
  shared token from `WEBHOOK_SHARED_TOKEN`. Add `?token=<WEBHOOK_SHARED_TOKEN>`
  to your Jira webhook URLs, then set `WEBHOOK_VERIFICATION_ENFORCE=true` in
  `.env` and re-import workflows (`./scripts/import-workflows.sh --force`).
  Until enforcement is on, unauthenticated POSTs to exposed webhook paths can
  trigger agent execution.
- **Agent network egress is filtered.** `shared-skills/hooks/guard_bash.py`
  blocks `curl`/`wget` to hosts outside an allowlist (package registries,
  GitHub, Atlassian, the local stack). Extend with `MESHWORK_EGRESS_ALLOWLIST`
  rather than disabling (`MESHWORK_EGRESS_ENFORCE=0`) — the filter is the main
  brake on prompt-injection exfiltration.
- **Untrusted input is fenced, not sanitised.** Issue summaries/descriptions
  and chat messages are wrapped in `<untrusted-data>` markers in agent prompts.
  This raises the bar for prompt injection but is a soft mitigation — keep
  restricting who can write to your issue tracker and chat channels.
- **Back up Postgres** (`./scripts/backup-postgres.sh`, cron-able) — it holds
  all job history, pipeline state, and conversations.

## Trust Model & Deployment Guidance

Meshwork is an automation platform that hands real shell access to an AI agent. Understand what you're trusting before you deploy it:

- **Issue and chat input is code execution.** The runner spawns Claude Code with `--dangerously-skip-permissions`, so anyone who can create issues, send chat messages, or otherwise get content in front of an agent can effectively cause command execution inside the working directories. Treat every input source (Jira projects, Telegram/Slack/Discord channels, webhooks) as a *trusted* channel — restrict who can write to them as carefully as you'd restrict commit access.
- **`ALLOWED_ROOTS` is a guardrail, not a sandbox.** It limits which directories jobs may run in, but it does not contain a compromised or misbehaving agent. Run the runner in a container with least-privilege mounts: mount only the project directories agents actually need, read-only wherever possible.
- **Never expose ports 3210 (runner), 3100 (dashboard), or 5678 (N8N) to the public internet** without a TLS-terminating reverse proxy and network ACLs in front of them. The bundled basic-auth and shared-secret checks are not designed to withstand direct internet exposure.
- **The runner holds your Claude identity.** The host's `~/.claude` OAuth credentials are bind-mounted into the runner container. Anyone with control of the runner (or its container) can act as that Claude account. Use a dedicated account where practical and audit who can reach the container.
- **`RUNNER_SECRET` grants full API control** — job dispatch, agent invocation, pipeline control. Store it like a production credential and rotate it immediately if it is ever exposed (update `.env` and restart the stack).

## Hall of Fame

Reporters who help improve Meshwork's security posture are listed here (with permission) once their advisory ships.

_None yet — be the first._
