# Getting Started with Meshwork

This walkthrough gets you from a fresh clone to running your first agent in about five minutes.

## What you'll have at the end

- The runner (`:3210`) and dashboard (`:3100`) running locally in Docker
- A product registered (your own codebase, or the bundled `hello-world` example)
- One agent run completed end-to-end, with output visible in the dashboard

## Before you start

You need:

- **Docker Desktop** (with Compose v2)
- **Claude CLI**, authenticated. Test with `claude` — it should drop you into a session.
- **`jq`** — `brew install jq` (macOS) or `apt install jq` (Linux)

You **don't** need: Jira, GitHub, Telegram, N8N, or any external services. Meshwork is standalone by default.

## 1. Clone

```bash
git clone https://github.com/meshwork-dev/meshwork.git
cd meshwork
```

## 2. Run setup

```bash
./setup.sh
```

The wizard will ask you ~10 questions. Sensible answers for a first run:

| Question | Suggested answer |
|---|---|
| Use the bundled Postgres container? | **Y** (no external DB needed) |
| Do you have Jira Cloud? | **N** (you can add it later) |
| Do you have a Telegram bot? | **N** |
| Expose N8N webhooks via ngrok? | **N** |
| Outgoing webhook URL | _(blank — skip)_ |
| Product name | Try `Demo` for your first run |
| Project prefix | `DEMO` |
| Codebase path | Absolute path to **any project you have**, e.g. `~/code/my-project`. This is where agents will read/write code. |
| Tech stack | One line, e.g. `Next.js, TypeScript, PostgreSQL` |

When it finishes, `setup.sh` prints:

```
Dashboard:          http://localhost:3100
Runner API:         http://localhost:3210
Dashboard password: <generated>
Runner secret:      <generated — save this>
```

**Copy the runner secret somewhere safe.** You'll need it for API calls. (It's also persisted to `.env`.)

## 3. Verify

```bash
curl http://localhost:3210/health
# → {"ok":true,...}
```

Open <http://localhost:3100> and log in with the dashboard password.

You should see:
- **Issues** — empty board
- **Chat** — empty
- **Agents** — list of ~14 agents loaded from `shared-skills/agents/` and `<product>-plugin/agents/`
- **Jobs** — empty

## 4. Run your first agent

The simplest agent to test is `codebase-locator` — it just searches your code and reports back. It doesn't write anything.

```bash
export RUNNER_SECRET="<the secret from step 2>"

curl -X POST http://localhost:3210/agent \
  -H "x-runner-secret: $RUNNER_SECRET" \
  -H "content-type: application/json" \
  -d '{
    "agent": "codebase-locator",
    "prompt": "Where are the API route definitions in this codebase?"
  }'
```

You'll get back a `jobId`. Watch it in the dashboard at <http://localhost:3100/jobs>, or stream the output:

```bash
curl -N "http://localhost:3210/jobs/<jobId>/stream-events" \
  -H "x-runner-secret: $RUNNER_SECRET"
```

In ~30–90 seconds, the agent finishes and the dashboard shows the structured result.

## 5. Try a delivery job

`codebase-locator` is read-only. For something that touches code, the simplest end-to-end test is to ask `engineer-planner` to plan a small change:

```bash
curl -X POST http://localhost:3210/agent \
  -H "x-runner-secret: $RUNNER_SECRET" \
  -H "content-type: application/json" \
  -d '{
    "agent": "engineer-planner",
    "prompt": "Plan how to add a /version endpoint that returns the package version."
  }'
```

You'll get a structured plan back. No code is written — the planner's job is to break the work down.

## What's next

- **[Add a product](./onboarding.md)** — register another codebase. Run `./setup.sh` again and choose "Add product".
- **[Write your own agent](./agents.md)** — drop a Markdown file in `shared-skills/agents/` or your product plugin.
- **[Wire up Jira](./integrations.md#jira)** — turn issue webhooks into agent runs.
- **[Pipelines](./pipelines.md)** — chain agents into multi-phase SDLC flows (plan → implement → review → QA → UAT).

## Troubleshooting

### Runner doesn't become healthy

```bash
docker compose logs runner --tail=100
```

The most common causes:
- **Claude CLI not authenticated.** Run `claude` from a terminal and `/login`.
- **`.credentials.json` missing.** The runner reads this via a volume mount. Verify `~/.claude/.credentials.json` exists.
- **Port 3210 already in use.** Set `RUNNER_PORT=3211` in `.env` and re-run setup.

### "permission denied" for the working directory

The Docker container needs to read your codebase. Make sure the absolute path you gave is something Docker Desktop has access to (System Settings → File Sharing on macOS).

### Agent returns "unknown agent"

Either:
- The agent doesn't exist — list them: `curl http://localhost:3210/agents -H "x-runner-secret: $RUNNER_SECRET"`
- You're using the product plugin's variant — pass `product` or `workingDir` in the request body so the runner loads the right plugin.

### Re-running setup

`setup.sh` is idempotent. Re-run it any time to reconfigure, add a product, or just restart the stack.

```bash
./setup.sh
# → "Keep current config, restart services" (default)
```

## Reference

- [README](../README.md) — quick overview
- [CONTRIBUTING](../CONTRIBUTING.md) — dev setup, branch policy, coding style
- [Agents](./agents.md) — full agent roster, delegation, writing your own
- [API](./api.md) — every endpoint
- [Examples](../examples/) — `hello-world` product for reference
