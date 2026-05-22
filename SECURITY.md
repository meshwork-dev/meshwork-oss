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
- Bind the runner and dashboard to `127.0.0.1` unless you trust your network
- Restrict `ALLOWED_ROOTS` to the directories you want agents to touch
- Don't commit `.env`, `.credentials.json`, N8N export bundles, or `products/<id>/product.json` if it contains tokens
- Treat agent-generated PRs the same way you'd treat a junior engineer's PR — review before merge

## Hall of Fame

Reporters who help improve Meshwork's security posture are listed here (with permission) once their advisory ships.

_None yet — be the first._
