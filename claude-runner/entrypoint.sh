#!/bin/sh
# Copy .claude.json from the staged mount to the actual location.
# This avoids corruption from the host rewriting the bind-mounted file
# while the container is reading it.
if [ -f /home/node/.claude.json.host ]; then
  cp /home/node/.claude.json.host /home/node/.claude.json
fi

# Wire GITHUB_TOKEN into git so `git push` authenticates over HTTPS without prompting.
if [ -n "${GITHUB_TOKEN}" ]; then
  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
  git config --global credential.helper ""
  # Required when committing inside worktrees.
  git config --global user.email "${GIT_AUTHOR_EMAIL:-runner@local.invalid}"
  git config --global user.name "${GIT_AUTHOR_NAME:-CertPilot Runner}"
  # Trust mounted worktree paths owned by other UIDs.
  git config --global --add safe.directory '*'
fi

exec "$@"
