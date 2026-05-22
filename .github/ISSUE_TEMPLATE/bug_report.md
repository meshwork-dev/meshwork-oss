---
name: Bug report
about: Something is broken in the runner, dashboard, an agent, or a workflow
title: "[bug] "
labels: ["bug", "needs-triage"]
assignees: []
---

## What happened

A clear, one-paragraph description of the bug.

## What you expected to happen

What did you think *would* happen instead?

## Reproduction

Minimal steps. The shorter, the more likely it gets fixed.

1. ...
2. ...
3. ...

## Environment

- Meshwork commit: `git rev-parse HEAD`
- OS:
- Docker version: `docker --version`
- Postgres mode: bundled / external
- Integrations enabled (Jira / Telegram / N8N / ngrok):
- Affected agent (if any):

## Logs

```
# docker compose logs runner --tail=200
# paste here
```

Dashboard console errors (browser DevTools → Console), if relevant:

```
paste here
```

## Anything else

Screenshots, related issues, workarounds you've tried.
