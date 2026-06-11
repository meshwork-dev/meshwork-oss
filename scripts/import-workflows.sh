#!/usr/bin/env bash
#
# import-workflows.sh — batch-import N8N workflow templates via the REST API.
#
# Reads .env (without sourcing it), substitutes {{PLACEHOLDER}} tokens in each
# workflows/*.json with matching values from the environment or .env, and
# POSTs the result to the N8N REST API.
#
# Idempotent-ish: existing workflows (matched by name) are skipped unless
# --force is given, in which case they are updated in place.
#
# Usage:
#   ./scripts/import-workflows.sh [--force] [workflow.json ...]
#
# Options:
#   --force       Update workflows that already exist in N8N (default: skip)
#   -h, --help    Show this help
#
# Environment (or .env):
#   N8N_URL       N8N base URL (default: http://localhost:5678)
#   N8N_API_KEY   N8N REST API key (required — create under Settings → n8n API)
#   Any other KEY=value is available for {{KEY}} placeholder substitution,
#   e.g. RUNNER_INTERNAL_URL, N8N_PUBLIC_URL, DEFAULT_WORKING_DIR,
#   TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_BOT_TOKEN.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.env"
WORKFLOW_DIR="$ROOT_DIR/workflows"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'
info()    { printf "  %s\n" "$*"; }
success() { printf "${GREEN}  %s${RESET}\n" "$*"; }
warn()    { printf "${YELLOW}  %s${RESET}\n" "$*"; }
error()   { printf "${RED}  ERROR: %s${RESET}\n" "$*" >&2; }

usage() {
  sed -n '3,25p' "${BASH_SOURCE[0]}" | sed -e 's/^# \{0,1\}//'
  exit "${1:-0}"
}

FORCE=0
FILES=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage 0 ;;
    --force)   FORCE=1 ;;
    -*)        error "Unknown option: $arg"; usage 1 ;;
    *)         FILES+=("$arg") ;;
  esac
done

command -v jq   &>/dev/null || { error "jq is required";   exit 1; }
command -v curl &>/dev/null || { error "curl is required"; exit 1; }

# Read a value from the environment, falling back to .env via grep — never
# sourced, so secrets are not shell-evaluated (same approach as setup.sh).
env_get() {
  local key="$1"
  if [[ -n "${!key:-}" ]]; then
    printf '%s' "${!key}"
    return
  fi
  if [[ -f "$ENV_FILE" ]]; then
    grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true
  fi
}

N8N_URL="$(env_get N8N_URL)"
N8N_URL="${N8N_URL:-http://localhost:5678}"
N8N_URL="${N8N_URL%/}"
N8N_API_KEY="$(env_get N8N_API_KEY)"
if [[ -z "$N8N_API_KEY" ]]; then
  error "N8N_API_KEY is not set (export it or add it to .env)."
  error "Create one in the N8N UI under Settings → n8n API."
  exit 1
fi

if [[ ${#FILES[@]} -eq 0 ]]; then
  for f in "$WORKFLOW_DIR"/*.json; do
    [[ -e "$f" ]] && FILES+=("$f")
  done
fi
if [[ ${#FILES[@]} -eq 0 ]]; then
  error "No workflow JSON files found in $WORKFLOW_DIR"
  exit 1
fi

info "N8N: $N8N_URL  (${#FILES[@]} workflow file(s), force=$FORCE)"

# Fetch existing workflows once so re-runs can skip/update by name.
existing="$(curl -sf -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "$N8N_URL/api/v1/workflows?limit=250")" || {
  error "Could not list workflows at $N8N_URL/api/v1/workflows — is N8N up and the API key valid?"
  exit 1
}

imported=0 updated=0 skipped=0 failed=0

for file in "${FILES[@]}"; do
  base="$(basename "$file")"
  if ! jq -e . "$file" > /dev/null 2>&1; then
    error "$base: not valid JSON — skipping"
    failed=$((failed + 1))
    continue
  fi

  name="$(jq -r '.name // empty' "$file")"
  if [[ -z "$name" ]]; then
    error "$base: missing \"name\" field — skipping"
    failed=$((failed + 1))
    continue
  fi

  body="$(cat "$file")"

  # Substitute {{UPPER_SNAKE}} placeholders from env/.env. N8N's own
  # expressions ({{ $json.x }}) contain spaces/lowercase and are untouched.
  while IFS= read -r token; do
    [[ -n "$token" ]] || continue
    key="${token#'{{'}"
    key="${key%'}}'}"
    val="$(env_get "$key")"
    if [[ -n "$val" ]]; then
      body="${body//"$token"/"$val"}"
    else
      warn "$base: unresolved placeholder $token (set $key in .env to substitute)"
    fi
  done < <(grep -oE '\{\{[A-Z][A-Z0-9_]*\}\}' "$file" | sort -u)

  # The v1 API rejects extra export fields (id, active, tags, …): keep the
  # creatable subset only, and validate post-substitution JSON.
  payload="$(printf '%s' "$body" | jq '{name, nodes, connections, settings: (.settings // {})}' 2>/dev/null)" || {
    error "$base: JSON became invalid after placeholder substitution — skipping"
    failed=$((failed + 1))
    continue
  }

  existing_id="$(printf '%s' "$existing" | jq -r --arg n "$name" \
    '.data[]? | select(.name == $n) | .id' | head -1)"

  if [[ -n "$existing_id" && "$FORCE" -eq 0 ]]; then
    info "skip:    $name (already exists; use --force to update)"
    skipped=$((skipped + 1))
    continue
  fi

  if [[ -n "$existing_id" ]]; then
    if printf '%s' "$payload" | curl -sf -X PUT \
        -H "X-N8N-API-KEY: $N8N_API_KEY" \
        -H "Content-Type: application/json" \
        --data-binary @- \
        "$N8N_URL/api/v1/workflows/$existing_id" > /dev/null; then
      success "update:  $name"
      updated=$((updated + 1))
    else
      error "$base: update failed (HTTP error from $N8N_URL)"
      failed=$((failed + 1))
    fi
  else
    if printf '%s' "$payload" | curl -sf -X POST \
        -H "X-N8N-API-KEY: $N8N_API_KEY" \
        -H "Content-Type: application/json" \
        --data-binary @- \
        "$N8N_URL/api/v1/workflows" > /dev/null; then
      success "import:  $name"
      imported=$((imported + 1))
    else
      error "$base: import failed (HTTP error from $N8N_URL)"
      failed=$((failed + 1))
    fi
  fi
done

printf '\n'
info "Done: $imported imported, $updated updated, $skipped skipped, $failed failed."
info "Imported workflows are created inactive — review credentials in the N8N UI, then activate."
[[ "$failed" -eq 0 ]] || exit 1
