#!/usr/bin/env bash
#
# Meshwork-AutoDev setup — idempotent. Safe to re-run.
#
# First run  : full guided configuration.
# Re-run     : detects existing .env and offers to reconfigure / keep / add product.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { printf "${CYAN}  %s${RESET}\n" "$*"; }
success() { printf "${GREEN}  %s${RESET}\n" "$*"; }
warn()    { printf "${YELLOW}  %s${RESET}\n" "$*"; }
error()   { printf "${RED}  ERROR: %s${RESET}\n" "$*" >&2; }
header()  { printf "\n${BOLD}${CYAN}── %s ${RESET}\n" "$*"; }

prompt_yn() {
  local question="$1" default="${2:-n}" reply prompt_str
  [[ "$default" == "y" ]] && prompt_str="[Y/n]" || prompt_str="[y/N]"
  printf "  ${BOLD}%s${RESET} %s: " "$question" "$prompt_str"
  read -r reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

prompt_value() {
  local question="$1" default="${2:-}" value
  if [[ -n "$default" ]]; then
    printf "  ${BOLD}%s${RESET} [%s]: " "$question" "$default" >&2
  else
    printf "  ${BOLD}%s${RESET}: " "$question" >&2
  fi
  read -r value
  value="${value:-$default}"
  printf '%s' "$value"
}

prompt_secret() {
  local question="$1" value
  printf "  ${BOLD}%s${RESET}: " "$question" >&2
  read -rs value
  printf '\n' >&2
  printf '%s' "$value"
}

sed_inplace() {
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# Read a value from .env without sourcing it (avoids shell-evaluating secrets).
env_get() {
  local key="$1"
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    grep -E "^${key}=" "$SCRIPT_DIR/.env" | tail -1 | cut -d= -f2- || true
  fi
}

# Idempotent in-place upsert: replace `KEY=...` if present, otherwise append.
env_set() {
  local key="$1" value="$2" file="$SCRIPT_DIR/.env"
  local escaped
  escaped=$(printf '%s' "$value" | sed -e 's/[\/&|]/\\&/g')
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    sed_inplace "s|^${key}=.*|${key}=${escaped}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# =============================================================================
# 1. Prerequisites
# =============================================================================
check_prerequisites() {
  header "Checking prerequisites"
  local missing=0

  if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
    success "Docker + Docker Compose found"
  else
    error "Docker with Compose plugin not found. https://docs.docker.com/get-docker/"
    missing=1
  fi

  if command -v claude &>/dev/null; then
    success "Claude CLI found"
  else
    warn "Claude CLI not found. Install from https://claude.ai/code (required at runtime)."
  fi

  if command -v jq &>/dev/null; then
    success "jq found"
  else
    error "jq not found. Install: brew install jq  (macOS) or apt install jq (Linux)"
    missing=1
  fi

  if [[ "$missing" -eq 1 ]]; then
    printf "\n"
    error "Please install the missing prerequisites and re-run setup.sh"
    exit 1
  fi
}

# =============================================================================
# 2. Idempotency Gate
# =============================================================================
SETUP_MODE="first-run"
choose_mode() {
  if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
    SETUP_MODE="first-run"
    return
  fi

  header "Existing installation detected"
  info "Found existing .env — this looks like a previous setup."
  info ""
  info "  1) Keep current config, restart services         (default)"
  info "  2) Upgrade (git pull + rebuild + restart)"
  info "  3) Reconfigure (re-prompt for everything)"
  info "  4) Add another product"
  info "  5) Exit"
  printf "\n  ${BOLD}Choose [1/2/3/4/5]:${RESET} "
  read -r choice
  case "${choice:-1}" in
    2) SETUP_MODE="upgrade" ;;
    3) SETUP_MODE="reconfigure" ;;
    4) SETUP_MODE="add-product" ;;
    5) info "Bye."; exit 0 ;;
    *) SETUP_MODE="restart" ;;
  esac
}

# =============================================================================
# 3. Welcome
# =============================================================================
print_banner() {
  printf "\n"
  printf "${BOLD}${CYAN}╔══════════════════════════════════════════════════════╗${RESET}\n"
  printf "${BOLD}${CYAN}║         Meshwork-AutoDev Setup                      ║${RESET}\n"
  printf "${BOLD}${CYAN}║    AI-Powered SDLC Automation with Claude Code       ║${RESET}\n"
  printf "${BOLD}${CYAN}╚══════════════════════════════════════════════════════╝${RESET}\n"
  printf "\n"
}

# =============================================================================
# 4. Integration Prompts
# =============================================================================
gather_config() {
  header "Database (PostgreSQL is required)"
  POSTGRES_MODE="bundled"
  if prompt_yn "Use the bundled Postgres container?" "y"; then
    POSTGRES_MODE="bundled"
    RUNNER_DB_HOST="postgres"
    RUNNER_DB_PORT="5432"
    RUNNER_DB_NAME="runner"
    RUNNER_DB_USER="runner"
    RUNNER_DB_PASSWORD="$(openssl rand -hex 16)"
  else
    POSTGRES_MODE="external"
    info "Provide connection details for your external Postgres instance."
    RUNNER_DB_HOST="$(prompt_value "DB host" "localhost")"
    RUNNER_DB_PORT="$(prompt_value "DB port" "5432")"
    RUNNER_DB_NAME="$(prompt_value "DB name" "runner")"
    RUNNER_DB_USER="$(prompt_value "DB user" "runner")"
    RUNNER_DB_PASSWORD="$(prompt_secret "DB password")"
  fi

  header "Jira Cloud (optional)"
  JIRA_ENABLED=false
  JIRA_DOMAIN="" JIRA_EMAIL="" JIRA_API_TOKEN=""
  if prompt_yn "Do you have Jira Cloud?"; then
    JIRA_ENABLED=true
    JIRA_DOMAIN="$(prompt_value "Jira domain" "https://yourorg.atlassian.net")"
    JIRA_EMAIL="$(prompt_value "Jira email")"
    JIRA_API_TOKEN="$(prompt_secret "Jira API token")"
  fi

  header "Telegram (optional)"
  TELEGRAM_ENABLED=false
  TELEGRAM_BOT_TOKEN="" TELEGRAM_CHAT_NOTIFICATIONS=""
  if prompt_yn "Do you have a Telegram bot?"; then
    TELEGRAM_ENABLED=true
    TELEGRAM_BOT_TOKEN="$(prompt_secret "Bot token")"
    TELEGRAM_CHAT_NOTIFICATIONS="$(prompt_value "Notification chat ID")"
  fi

  header "External Webhook Access (optional)"
  NGROK_ENABLED=false NGROK_AUTHTOKEN="" NGROK_DOMAIN=""
  if prompt_yn "Expose N8N webhooks publicly via ngrok?"; then
    NGROK_ENABLED=true
    NGROK_AUTHTOKEN="$(prompt_secret "ngrok authtoken")"
    NGROK_DOMAIN="$(prompt_value "ngrok domain (e.g. yourapp.ngrok.app)")"
  fi

  header "Outgoing Notifications (optional)"
  NOTIFICATION_WEBHOOK_URL="$(prompt_value "Outgoing webhook URL (Slack/Discord/Teams; blank to skip)")"

  header "Ports"
  RUNNER_PORT="$(prompt_value "Runner API port" "3210")"
  DASHBOARD_PORT="$(prompt_value "Dashboard port" "3100")"
  N8N_PORT="$(prompt_value "N8N port" "5678")"

  N8N_ENABLED=false
  if [[ "$JIRA_ENABLED" == "true" ]] || [[ "$NGROK_ENABLED" == "true" ]]; then
    N8N_ENABLED=true
  fi

  RUNNER_SECRET="$(openssl rand -hex 24)"
  DASHBOARD_PASSWORD="$(openssl rand -hex 12)"
  success "Secrets generated."
}

# Load existing config from .env so re-runs can preserve secrets when needed.
load_existing_config() {
  RUNNER_SECRET="$(env_get RUNNER_SECRET)"
  DASHBOARD_PASSWORD="$(env_get DASHBOARD_PASSWORD)"
  RUNNER_DB_PASSWORD="$(env_get RUNNER_DB_PASSWORD)"
  RUNNER_DB_HOST="$(env_get RUNNER_DB_HOST)"
  RUNNER_DB_PORT="$(env_get RUNNER_DB_PORT)"
  RUNNER_DB_NAME="$(env_get RUNNER_DB_NAME)"
  RUNNER_DB_USER="$(env_get RUNNER_DB_USER)"
  JIRA_DOMAIN="$(env_get JIRA_DOMAIN)"
  JIRA_EMAIL="$(env_get JIRA_EMAIL)"
  JIRA_API_TOKEN="$(env_get JIRA_API_TOKEN)"
  TELEGRAM_BOT_TOKEN="$(env_get TELEGRAM_BOT_TOKEN)"
  TELEGRAM_CHAT_NOTIFICATIONS="$(env_get TELEGRAM_CHAT_NOTIFICATIONS)"
  NGROK_DOMAIN="$(env_get NGROK_DOMAIN)"
  POSTGRES_MODE="$(env_get POSTGRES_MODE)"
  POSTGRES_MODE="${POSTGRES_MODE:-bundled}"
  PROJECT_DIR="$(env_get PROJECT_DIR)"
  RUNNER_PORT="$(env_get RUNNER_PORT)"; RUNNER_PORT="${RUNNER_PORT:-3210}"
  DASHBOARD_PORT="$(env_get DASHBOARD_PORT)"; DASHBOARD_PORT="${DASHBOARD_PORT:-3100}"
  N8N_PORT="$(env_get N8N_PORT)"; N8N_PORT="${N8N_PORT:-5678}"
  JIRA_ENABLED=false; [[ -n "$JIRA_DOMAIN" ]] && JIRA_ENABLED=true
  TELEGRAM_ENABLED=false; [[ -n "$TELEGRAM_BOT_TOKEN" ]] && TELEGRAM_ENABLED=true
  NGROK_ENABLED=false; [[ -n "$NGROK_DOMAIN" ]] && NGROK_ENABLED=true
  N8N_ENABLED=false
  if [[ "$JIRA_ENABLED" == "true" ]] || [[ "$NGROK_ENABLED" == "true" ]]; then
    N8N_ENABLED=true
  fi
}

# =============================================================================
# 5. .env generation (idempotent)
# =============================================================================
generate_env() {
  header "Writing .env"

  if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
    if [[ ! -f "$SCRIPT_DIR/.env.example" ]]; then
      error ".env.example not found — cannot generate .env"
      exit 1
    fi
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  fi

  env_set RUNNER_SECRET           "$RUNNER_SECRET"
  env_set DASHBOARD_PASSWORD      "$DASHBOARD_PASSWORD"
  env_set RUNNER_PORT             "$RUNNER_PORT"
  env_set DASHBOARD_PORT          "$DASHBOARD_PORT"
  env_set N8N_PORT                "$N8N_PORT"
  env_set POSTGRES_MODE           "$POSTGRES_MODE"
  env_set RUNNER_DB_HOST          "$RUNNER_DB_HOST"
  env_set RUNNER_DB_PORT          "$RUNNER_DB_PORT"
  env_set RUNNER_DB_NAME          "$RUNNER_DB_NAME"
  env_set RUNNER_DB_USER          "$RUNNER_DB_USER"
  env_set RUNNER_DB_PASSWORD      "$RUNNER_DB_PASSWORD"
  env_set PROJECT_DIR             "${PRODUCT_DIR:-${PROJECT_DIR:-}}"

  # Encryption key for stored API keys (BYOK) — generated once, 32 bytes = 64 hex chars
  if [[ -z "$(env_get RUNNER_ENCRYPTION_KEY)" ]]; then
    env_set RUNNER_ENCRYPTION_KEY "$(openssl rand -hex 32)"
  fi

  # N8N secrets — generated once, preserved on re-runs (idempotent).
  if [[ -z "$(env_get N8N_BASIC_AUTH_PASSWORD)" ]]; then
    env_set N8N_BASIC_AUTH_PASSWORD "$(openssl rand -hex 16)"
  fi
  if [[ -z "$(env_get N8N_DB_PASSWORD)" ]]; then
    env_set N8N_DB_PASSWORD "$(openssl rand -hex 16)"
  fi

  # Webhook verification — token generated once; enforcement starts disabled
  # so existing callers keep working until the operator adds ?token=... to
  # Jira webhook URLs and flips WEBHOOK_VERIFICATION_ENFORCE=true.
  if [[ -z "$(env_get WEBHOOK_SHARED_TOKEN)" ]]; then
    env_set WEBHOOK_SHARED_TOKEN "$(openssl rand -hex 24)"
  fi
  if [[ -z "$(env_get WEBHOOK_VERIFICATION_ENFORCE)" ]]; then
    env_set WEBHOOK_VERIFICATION_ENFORCE "false"
  fi

  # Bearer token for the n8n Jira MCP trigger (referenced by
  # shared-skills/.mcp.json). Generated once even when Jira is disabled —
  # the entry is inert until the Jira_Actuator workflow is activated.
  if [[ -z "$(env_get N8N_MCP_AUTH_TOKEN)" ]]; then
    env_set N8N_MCP_AUTH_TOKEN "$(openssl rand -hex 24)"
  fi

  # Per-product agent memory graphs live here (bind-mounted into the runner).
  mkdir -p "$HOME/.claude/memory"

  [[ -n "${JIRA_DOMAIN:-}" ]]                && env_set JIRA_DOMAIN                "$JIRA_DOMAIN"
  [[ -n "${JIRA_EMAIL:-}" ]]                 && env_set JIRA_EMAIL                 "$JIRA_EMAIL"
  [[ -n "${JIRA_API_TOKEN:-}" ]]             && env_set JIRA_API_TOKEN             "$JIRA_API_TOKEN"
  [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]         && env_set TELEGRAM_BOT_TOKEN         "$TELEGRAM_BOT_TOKEN"
  [[ -n "${TELEGRAM_CHAT_NOTIFICATIONS:-}" ]]&& env_set TELEGRAM_CHAT_NOTIFICATIONS "$TELEGRAM_CHAT_NOTIFICATIONS"
  [[ -n "${NGROK_AUTHTOKEN:-}" ]]            && env_set NGROK_AUTHTOKEN            "$NGROK_AUTHTOKEN"
  [[ -n "${NGROK_DOMAIN:-}" ]]               && env_set NGROK_DOMAIN               "$NGROK_DOMAIN"
  [[ -n "${NOTIFICATION_WEBHOOK_URL:-}" ]]   && env_set NOTIFICATION_WEBHOOK_URL   "$NOTIFICATION_WEBHOOK_URL"

  success ".env written"
}

# =============================================================================
# 6. runner config.json (from template, idempotent — overwrites)
# =============================================================================
generate_config() {
  header "Generating runner config"
  local template="$SCRIPT_DIR/config.template.json"
  local docker_template="$SCRIPT_DIR/config.docker.template.json"

  if [[ ! -f "$template" ]]; then
    warn "config.template.json not found — skipping"
    return
  fi

  local callback_url=""
  if [[ "$NGROK_ENABLED" == "true" && -n "$NGROK_DOMAIN" ]]; then
    callback_url="https://${NGROK_DOMAIN}/webhook/runner/callback"
  fi

  jq \
    --arg working_dir "${PRODUCT_DIR:-${PROJECT_DIR:-}}" \
    --arg callback_url "$callback_url" \
    --arg jira_host "${JIRA_DOMAIN#https://}" \
    --arg project_key "${PRODUCT_PREFIX:-PRJ}" \
    --arg n8n_url "${NGROK_DOMAIN:+https://${NGROK_DOMAIN}}" \
    --arg runner_port "${RUNNER_PORT:-3210}" \
    --arg dashboard_port "${DASHBOARD_PORT:-3100}" \
    '
    walk(
      if type == "string" then
        if . == "__WORKING_DIR__"          then $working_dir
        elif . == "__CALLBACK_URL__"       then $callback_url
        elif . == "__JIRA_HOST__"          then $jira_host
        elif . == "__JIRA_PROJECT_KEY__"   then $project_key
        elif . == "__N8N_PUBLIC_URL__"     then $n8n_url
        elif . == "__PLUGIN_DIR__"         then "shared-skills"
        elif . == "__PLATFORM_DIR__"       then "."
        elif . == "__RUNNER_PORT__"        then ($runner_port | tonumber)
        elif . == "__TELEGRAM_ADMIN_CHAT_ID__" then ($ENV.TELEGRAM_CHAT_NOTIFICATIONS // "")
        elif . == "__TEAM_EMAIL__"         then ($ENV.TEAM_EMAIL // "")
        elif . == "__ADMIN_EMAIL__"        then ($ENV.ADMIN_EMAIL // "")
        else gsub("__DASHBOARD_PORT__"; $dashboard_port)
        end
      else .
      end
    )
    ' "$template" > "$SCRIPT_DIR/claude-runner/config.json"

  if [[ -f "$docker_template" ]]; then
    jq \
      --arg working_dir "/projects/$(printf '%s' "${PRODUCT_NAME:-default}" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')" \
      --arg callback_url "$callback_url" \
      --arg jira_host "${JIRA_DOMAIN#https://}" \
      --arg project_key "${PRODUCT_PREFIX:-PRJ}" \
      --arg n8n_url "${NGROK_DOMAIN:+https://${NGROK_DOMAIN}}" \
      --arg runner_port "${RUNNER_PORT:-3210}" \
      --arg dashboard_port "${DASHBOARD_PORT:-3100}" \
      '
      walk(
        if type == "string" then
          if . == "__WORKING_DIR__"          then $working_dir
          elif . == "__CALLBACK_URL__"       then $callback_url
          elif . == "__JIRA_HOST__"          then $jira_host
          elif . == "__JIRA_PROJECT_KEY__"   then $project_key
          elif . == "__N8N_PUBLIC_URL__"     then $n8n_url
          elif . == "__PLUGIN_DIR__"         then "/shared-skills"
          elif . == "__PLATFORM_DIR__"       then "/app"
          elif . == "__RUNNER_PORT__"        then ($runner_port | tonumber)
          elif . == "__TELEGRAM_ADMIN_CHAT_ID__" then ($ENV.TELEGRAM_CHAT_NOTIFICATIONS // "")
          elif . == "__TEAM_EMAIL__"         then ($ENV.TEAM_EMAIL // "")
          elif . == "__ADMIN_EMAIL__"        then ($ENV.ADMIN_EMAIL // "")
          else gsub("__DASHBOARD_PORT__"; $dashboard_port)
          end
        else .
        end
      )
      ' "$docker_template" > "$SCRIPT_DIR/claude-runner/config.docker.json"
  fi

  success "claude-runner/config.json written"
}

# =============================================================================
# 7. docker-compose.yml from template (Postgres profile aware)
# =============================================================================
generate_compose() {
  header "Generating docker-compose.yml"
  if [[ ! -f "$SCRIPT_DIR/docker-compose.template.yml" ]]; then
    warn "docker-compose.template.yml missing — skipping"
    return
  fi
  cp "$SCRIPT_DIR/docker-compose.template.yml" "$SCRIPT_DIR/docker-compose.yml"
  success "docker-compose.yml written (Postgres profile: ${POSTGRES_MODE})"
}

# =============================================================================
# 8. Product setup (idempotent: skip if products/<id>/product.json exists)
# =============================================================================
setup_product() {
  header "Product setup"

  PRODUCT_NAME="$(prompt_value "Product name" "MyApp")"
  PRODUCT_PREFIX="$(prompt_value "Project prefix (2-4 uppercase letters)" "APP")"
  PRODUCT_PREFIX="$(printf '%s' "$PRODUCT_PREFIX" | tr '[:lower:]' '[:upper:]')"
  PRODUCT_DIR="$(prompt_value "Codebase path (absolute path to your project)")"
  PRODUCT_TECH="$(prompt_value "Tech stack" "Next.js, Express, PostgreSQL")"
  PRODUCT_DESC="$(prompt_value "One-line product description" "${PRODUCT_NAME} — managed by Meshwork-AutoDev")"

  local id
  id="$(printf '%s' "$PRODUCT_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')"
  PRODUCT_PLUGIN_DIR="${id}-plugin"

  local product_file="$SCRIPT_DIR/products/${id}/product.json"
  if [[ -f "$product_file" ]]; then
    if ! prompt_yn "Product '${id}' already exists — overwrite product.json?" "n"; then
      info "Keeping existing product.json"
      return
    fi
  fi

  mkdir -p "$SCRIPT_DIR/products/${id}"
  cat > "$product_file" <<EOF
{
  "id": "${id}",
  "name": "${PRODUCT_NAME}",
  "description": "${PRODUCT_NAME} — managed by Meshwork-AutoDev",
  "workingDir": "${PRODUCT_DIR}",
  "pluginDir": "${PRODUCT_PLUGIN_DIR}",
  "jira": {
    "domain": "${JIRA_DOMAIN:-}",
    "projectKey": "${PRODUCT_PREFIX}",
    "projectName": "${PRODUCT_NAME}"
  },
  "techStack": {
    "description": "${PRODUCT_TECH}"
  },
  "sprint": {
    "enabled": false,
    "projectKey": "${PRODUCT_PREFIX}"
  }
}
EOF

  if [[ ! -d "$SCRIPT_DIR/${PRODUCT_PLUGIN_DIR}" ]]; then
    mkdir -p "$SCRIPT_DIR/${PRODUCT_PLUGIN_DIR}"/{agents,skills,commands}
    cat > "$SCRIPT_DIR/${PRODUCT_PLUGIN_DIR}/PRODUCT.md" <<EOF
# ${PRODUCT_NAME}

**Tech Stack:** ${PRODUCT_TECH}
**Project Prefix:** ${PRODUCT_PREFIX}
**Codebase:** ${PRODUCT_DIR}

Refer to shared-skills/ for cross-cutting skills (security, QA, UX, BA, PM).
EOF
  fi

  # Copy agent templates into <product>-plugin/agents/ with placeholder substitution.
  # Only copies templates that don't already exist (idempotent — protects local edits).
  local templates_dir="$SCRIPT_DIR/templates/agents"
  local target_agents_dir="$SCRIPT_DIR/${PRODUCT_PLUGIN_DIR}/agents"
  if [[ -d "$templates_dir" ]]; then
    local copied=0
    local skipped=0
    for tpl in "$templates_dir"/*.md; do
      [[ -e "$tpl" ]] || continue
      local fname
      fname="$(basename "$tpl")"
      local target="$target_agents_dir/$fname"
      if [[ -e "$target" ]]; then
        skipped=$((skipped + 1))
        continue
      fi
      # sed substitution. Use a non-`/` delimiter so paths with `/` are safe.
      # NB: macOS sed requires `-i ''`; gnu sed accepts `-i`. We use a portable form
      # by writing to a temp file then moving.
      sed \
        -e "s|__PRODUCT_NAME__|${PRODUCT_NAME}|g" \
        -e "s|__PRODUCT_ID__|${id}|g" \
        -e "s|__PRODUCT_DESCRIPTION__|${PRODUCT_DESC}|g" \
        -e "s|__TECH_STACK__|${PRODUCT_TECH}|g" \
        -e "s|__JIRA_PROJECT_KEY__|${PRODUCT_PREFIX}|g" \
        -e "s|__WORKING_DIR__|${PRODUCT_DIR}|g" \
        "$tpl" > "$target"
      copied=$((copied + 1))
    done
    info "Agent templates: ${copied} copied, ${skipped} skipped (already exist) into ${PRODUCT_PLUGIN_DIR}/agents/"
  else
    warn "templates/agents/ not found — skipping agent scaffolding"
  fi

  success "Product '${PRODUCT_NAME}' (${id}) ready"
}

# =============================================================================
# 9. Destroy deployment
# =============================================================================
destroy_deployment() {
  header "Destroy deployment"
  warn "This will stop and remove all containers, networks, and volumes."
  warn "Config files (.env, config.json) will NOT be deleted."
  if ! prompt_yn "Are you sure you want to destroy the deployment?" "n"; then
    info "Aborted."
    exit 0
  fi

  if [[ ! -f "$SCRIPT_DIR/docker-compose.yml" ]]; then
    error "docker-compose.yml not found — nothing to destroy."
    exit 1
  fi

  load_existing_config 2>/dev/null || true

  local profiles=()
  [[ "${POSTGRES_MODE:-bundled}" == "bundled" ]] && profiles+=(--profile bundled-db)
  [[ "${NGROK_ENABLED:-false}"   == "true"    ]] && profiles+=(--profile tunnel)

  docker compose -f "$SCRIPT_DIR/docker-compose.yml" "${profiles[@]}" down -v --remove-orphans
  success "Deployment destroyed."
  info "Re-run ./setup.sh to start fresh."
}

# =============================================================================
# 10. Start services with profile selection
# =============================================================================
start_services() {
  header "Starting Docker services"
  export PROJECT_DIR="${PRODUCT_DIR:-${PROJECT_DIR:-}}"

  local profiles=()
  [[ "$POSTGRES_MODE" == "bundled" ]] && profiles+=(--profile bundled-db)
  [[ "$NGROK_ENABLED" == "true" ]]    && profiles+=(--profile tunnel)

  info "Building images..."
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" "${profiles[@]}" build

  info "Starting services..."
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" "${profiles[@]}" up -d

  info "Waiting for runner health check (up to 60s)..."
  local attempts=0
  until curl -sf "http://localhost:${RUNNER_PORT:-3210}/health" > /dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [[ "$attempts" -ge 30 ]]; then
      warn "Runner did not become healthy within 60s — check: docker compose logs runner"
      return
    fi
    sleep 2
  done
  success "Runner is healthy"
}

# =============================================================================
# 11. Summary
# =============================================================================
print_summary() {
  printf "\n"
  printf "${BOLD}${GREEN}╔══════════════════════════════════════════════════════╗${RESET}\n"
  printf "${BOLD}${GREEN}║  Setup complete                                      ║${RESET}\n"
  printf "${BOLD}${GREEN}╚══════════════════════════════════════════════════════╝${RESET}\n"
  printf "\n"
  printf "  ${BOLD}Dashboard:${RESET}     http://localhost:${DASHBOARD_PORT:-3100}\n"
  printf "  ${BOLD}Runner API:${RESET}    http://localhost:${RUNNER_PORT:-3210}\n"
  printf "  ${BOLD}Dashboard password:${RESET} %s\n" "$DASHBOARD_PASSWORD"
  printf "\n"
  printf "  ${BOLD}Runner secret (keep safe):${RESET} %s\n" "$RUNNER_SECRET"
  printf "\n"
  printf "  ${BOLD}Postgres mode:${RESET} %s\n" "$POSTGRES_MODE"
  [[ "$JIRA_ENABLED"     == "true" ]] && success "Jira integration active (${JIRA_DOMAIN})"
  [[ "$TELEGRAM_ENABLED" == "true" ]] && success "Telegram notifications active"
  [[ "$N8N_ENABLED"      == "true" ]] && success "N8N workflows: http://localhost:${N8N_PORT:-5678}"
  if [[ "$JIRA_ENABLED" == "true" ]]; then
    printf "\n"
    printf "  ${BOLD}Jira MCP — finish in the N8N UI (one-time):${RESET}\n"
    printf "    1. ./scripts/import-workflows.sh workflows/Jira_Actuator.json\n"
    printf "    2. Create credential \"Jira MCP Bearer\" (HTTP Bearer Auth) with N8N_MCP_AUTH_TOKEN from .env\n"
    printf "    3. Create credential \"Jira SW Cloud\" (JIRA_EMAIL + JIRA_API_TOKEN, domain JIRA_DOMAIN)\n"
    printf "    4. Bind: MCP Server Trigger -> Jira MCP Bearer; Jira/Confluence tool nodes -> Jira SW Cloud\n"
    printf "    5. Activate the Jira Actuator workflow\n"
    printf "    Docs: docs/claude/integrations.md (Jira MCP section)\n"
  fi
  printf "\n"
  info "Re-run ./setup.sh anytime to reconfigure or add another product."
  printf "\n"
}

# =============================================================================
# Main
# =============================================================================
do_upgrade() {
  header "Upgrading Meshwork"

  if [[ ! -d "$SCRIPT_DIR/.git" ]]; then
    warn "No .git directory found — cannot run git pull."
    warn "If you installed from a zip/tarball, manually copy the new files and re-run ./setup.sh."
    return 1
  fi

  info "Pulling latest code..."
  git -C "$SCRIPT_DIR" pull || { warn "git pull failed — check network/credentials and retry."; return 1; }
  success "Code updated."

  info "Regenerating Compose config..."
  load_existing_config
  generate_compose

  info "Rebuilding images and restarting services..."
  start_services
  print_summary
}

main() {
  if [[ "${1:-}" == "--destroy" ]]; then
    destroy_deployment
    exit 0
  fi

  if [[ "${1:-}" == "--upgrade" ]]; then
    print_banner
    check_prerequisites
    do_upgrade
    exit 0
  fi

  print_banner
  check_prerequisites
  choose_mode

  case "$SETUP_MODE" in
    first-run)
      gather_config
      setup_product
      generate_env
      generate_config
      generate_compose
      start_services
      print_summary
      ;;
    reconfigure)
      load_existing_config
      gather_config
      generate_env
      generate_config
      generate_compose
      start_services
      print_summary
      ;;
    add-product)
      load_existing_config
      setup_product
      generate_env
      generate_config
      info "Restart services to pick up new product mounts:"
      info "  docker compose restart runner"
      ;;
    restart)
      load_existing_config
      generate_compose
      start_services
      print_summary
      ;;
    upgrade)
      do_upgrade
      ;;
  esac
}

main "$@"
