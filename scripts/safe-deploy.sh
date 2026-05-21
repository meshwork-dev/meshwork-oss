#!/usr/bin/env bash
set -euo pipefail

# safe-deploy.sh — rebuild and recreate a docker compose service only when safe
# Usage: ./scripts/safe-deploy.sh [service]
#   service  — one of: runner, dashboard, n8n, ngrok (default: all services)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
RUNNER_URL="http://localhost:3210"

# ── helpers ────────────────────────────────────────────────────────────────────

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

die() { red "ERROR: $*"; exit 1; }

# ── args ───────────────────────────────────────────────────────────────────────

SERVICE="${1:-}"

if [[ -n "$SERVICE" ]]; then
  bold "Target service : $SERVICE"
else
  bold "Target service : ALL (runner, dashboard, n8n, ngrok)"
fi

# ── load RUNNER_SECRET ─────────────────────────────────────────────────────────

[[ -f "$ENV_FILE" ]] || die ".env not found at $ENV_FILE"

RUNNER_SECRET="$(grep -E '^RUNNER_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '[:space:]')"
[[ -n "$RUNNER_SECRET" ]] || die "RUNNER_SECRET not set in $ENV_FILE"

# ── check runner is reachable ──────────────────────────────────────────────────

printf '\nChecking runner at %s ...\n' "$RUNNER_URL"

if ! HEALTH_JSON="$(curl -sf --max-time 5 "$RUNNER_URL/health")"; then
  yellow "Runner is not reachable — skipping active-work checks."
  SKIP_CHECKS=1
else
  SKIP_CHECKS=0
fi

# ── inspect active work ────────────────────────────────────────────────────────

ACTIVE_JOBS=0
ACTIVE_MEETINGS=0
HAS_ACTIVE_WORK=0

if [[ "$SKIP_CHECKS" -eq 0 ]]; then

  # /health — running and queued counts (no auth required)
  RUNNING="$(printf '%s' "$HEALTH_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('running',0))")"
  QUEUED="$(printf '%s' "$HEALTH_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('queued',0))")"
  ACTIVE_JOBS=$(( RUNNING + QUEUED ))

  # /api/meetings — meetings whose status != "ended"
  if MEETINGS_JSON="$(curl -sf --max-time 5 \
        -H "x-runner-secret: $RUNNER_SECRET" \
        "$RUNNER_URL/api/meetings")"; then
    ACTIVE_MEETINGS="$(printf '%s' "$MEETINGS_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
meetings = data.get('meetings', [])
active = [m for m in meetings if m.get('status') != 'ended']
print(len(active))
")"
  else
    yellow "Could not reach /api/meetings — skipping meeting check."
  fi

  # ── print summary ────────────────────────────────────────────────────────────

  printf '\n'
  bold "Current runner state:"
  printf '  Running jobs : %s\n' "$RUNNING"
  printf '  Queued jobs  : %s\n' "$QUEUED"
  printf '  Active meetings: %s\n' "$ACTIVE_MEETINGS"

  # ── list active jobs if any ───────────────────────────────────────────────────

  if [[ "$ACTIVE_JOBS" -gt 0 ]]; then
    HAS_ACTIVE_WORK=1
    printf '\n'
    yellow "WARNING: There are $ACTIVE_JOBS active job(s) (running=$RUNNING queued=$QUEUED)."
    printf '\nActive jobs:\n'
    curl -sf --max-time 5 \
      -H "x-runner-secret: $RUNNER_SECRET" \
      "$RUNNER_URL/api/jobs" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
jobs = data.get('jobs', data) if isinstance(data, dict) else data
for j in jobs:
    status = j.get('status','?')
    if status in ('running','queued','retry-pending','quality-gate-retry'):
        print('  [{}] {} | agent={} | status={}'.format(
            j.get('jobId','?')[:12],
            j.get('issueKey') or j.get('mode','?'),
            j.get('agent','?'),
            status
        ))
" 2>/dev/null || printf '  (could not list individual jobs)\n'
  fi

  # ── list active meetings if any ───────────────────────────────────────────────

  if [[ "$ACTIVE_MEETINGS" -gt 0 ]]; then
    HAS_ACTIVE_WORK=1
    printf '\n'
    yellow "WARNING: There are $ACTIVE_MEETINGS active meeting(s)."
    printf '\nActive meetings:\n'
    printf '%s' "$MEETINGS_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data.get('meetings', []):
    if m.get('status') != 'ended':
        agents = ', '.join(m.get('agents', []))
        print('  [{}] \"{}\" | status={} | agents={} | started={}'.format(
            m.get('meetingId','?')[:12],
            m.get('topic','?'),
            m.get('status','?'),
            agents,
            m.get('createdAt','?')
        ))
"
  fi

fi  # end SKIP_CHECKS

# ── confirm if active work exists ─────────────────────────────────────────────

if [[ "$HAS_ACTIVE_WORK" -eq 1 ]]; then
  printf '\n'
  red "Active work is in progress. Rebuilding will interrupt running jobs and meetings."
  printf '\nDo you want to proceed anyway? [y/N] '
  read -r CONFIRM
  case "$CONFIRM" in
    [yY]|[yY][eE][sS]) ;;
    *) printf 'Aborted.\n'; exit 0 ;;
  esac
else
  if [[ "$SKIP_CHECKS" -eq 0 ]]; then
    printf '\n'
    green "No active work detected. Safe to deploy."
  fi
fi

# ── run docker compose rebuild ─────────────────────────────────────────────────

printf '\n'
bold "Building image(s)..."

if [[ -n "$SERVICE" ]]; then
  docker compose -f "$COMPOSE_FILE" build "$SERVICE"
else
  docker compose -f "$COMPOSE_FILE" build
fi

printf '\n'
bold "Recreating container(s)..."

if [[ -n "$SERVICE" ]]; then
  docker compose -f "$COMPOSE_FILE" up -d --force-recreate "$SERVICE"
else
  docker compose -f "$COMPOSE_FILE" up -d --force-recreate
fi

printf '\n'
green "Done. Container(s) are up."

if [[ -n "$SERVICE" ]]; then
  printf '\nContainer status:\n'
  docker compose -f "$COMPOSE_FILE" ps "$SERVICE"
else
  printf '\nContainer status:\n'
  docker compose -f "$COMPOSE_FILE" ps
fi
