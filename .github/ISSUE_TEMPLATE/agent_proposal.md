---
name: Agent proposal
about: Propose a new agent (or significant rework of an existing one)
title: "[agent] "
labels: ["agent", "needs-triage"]
assignees: []
---

## Agent name

Lowercase-kebab. Example: `release-manager`.

## What it does, in one sentence

> "A release manager that drafts release notes from merged PRs and posts them to Slack."

## Why it's separate from existing agents

What gap does this fill that `engineer-planner`, `engineer-implementer`, `product-manager`, etc. don't already cover?

## Inputs

What does it expect? Issue key? Free-form prompt? A file path? Tool output from another agent?

## Outputs

What does it produce? A PR? A comment? A file? A subtask block?

## Tools required

Which runner tools does it need? (`Read`, `Write`, `Bash`, `Grep`, `Glob`, MCP servers, etc.) Be specific — overly broad tool grants are a security concern.

## Model

Sonnet (default) / Opus / Haiku — and why.

## Automation contract

Is it autonomous (no "would you like me to…" prompts), or interactive?
What comment prefix does it use, if any?

## Example invocations

```
# Direct
curl -X POST $RUNNER/agent -d '{"agent":"...","prompt":"..."}'

# Via subtask routing
[CREATE-SUBTASKS]
- agent: my-new-agent
  description: ...
```

## Open questions

Anything you're unsure about that should be discussed before someone writes the prompt.
