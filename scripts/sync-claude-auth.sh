#!/bin/bash
# sync-claude-auth.sh — Syncs Claude OAuth credentials from macOS Keychain to a file
# that Docker containers can read via bind mount.
#
# Claude v2.x stores OAuth tokens in macOS Keychain ("Claude Code-credentials").
# Docker containers can't access Keychain, so we extract and write to .credentials.json.
#
# Usage:
#   ./scripts/sync-claude-auth.sh          # One-shot sync
#   ./scripts/sync-claude-auth.sh --watch  # Sync every 5 minutes
#
# The runner's getOAuthEnvVars() reads this file and injects tokens into Claude CLI processes.

set -euo pipefail

CRED_FILE="$HOME/.claude/.credentials.json"
KEYCHAIN_SERVICE="Claude Code-credentials"

sync_once() {
  local cred
  cred=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null) || {
    echo "[$(date -Iseconds)] No Keychain entry found for '$KEYCHAIN_SERVICE' — skipping"
    return 1
  }

  # Validate it's valid JSON with the expected structure
  echo "$cred" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert 'claudeAiOauth' in d and d['claudeAiOauth'].get('accessToken'), 'Missing OAuth token'
" 2>/dev/null || {
    echo "[$(date -Iseconds)] Keychain entry is invalid or missing OAuth token — skipping"
    return 1
  }

  # Atomic write: write to temp then move
  local tmp="${CRED_FILE}.tmp.$$"
  echo "$cred" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$CRED_FILE"
  echo "[$(date -Iseconds)] Synced Keychain → $CRED_FILE ($(wc -c < "$CRED_FILE" | tr -d ' ') bytes)"
}

if [[ "${1:-}" == "--watch" ]]; then
  echo "Watching Keychain for Claude credentials (every 300s)..."
  while true; do
    sync_once || true
    sleep 300
  done
else
  sync_once
fi
