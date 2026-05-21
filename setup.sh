#!/usr/bin/env bash
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

# ── Helper: yes/no prompt ─────────────────────────────────────────────────────
prompt_yn() {
  local question="$1"
  local default="${2:-n}"
  local prompt_str
  if [[ "$default" == "y" ]]; then
    prompt_str="[Y/n]"
  else
    prompt_str="[y/N]"
  fi
  printf "  ${BOLD}%s${RESET} %s: " "$question" "$prompt_str"
  read -r reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

# ── Helper: text input prompt ─────────────────────────────────────────────────
prompt_value() {
  local question="$1"
  local default="${2:-}"
  local value
  if [[ -n "$default" ]]; then
    printf "  ${BOLD}%s${RESET} [%s]: " "$question" "$default"
  else
    printf "  ${BOLD}%s${RESET}: " "$question"
  fi
  read -r value
  value="${value:-$default}"
  printf '%s' "$value"
}

# ── Helper: secret input (no echo) ────────────────────────────────────────────
prompt_secret() {
  local question="$1"
  local value
  printf "  ${BOLD}%s${RESET}: " "$question"
  read -rs value
  printf '\n'
  printf '%s' "$value"
}

# =============================================================================
# 1. Prerequisites Check
# =============================================================================
check_prerequisites() {
  header "Checking prerequisites"
  local missing=0

  if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
    success "Docker + Docker Compose found"
  else
    error "Docker with Compose plugin not found. Install from https://docs.docker.com/get-docker/"
    missing=1
  fi

  if command -v claude &>/dev/null; then
    success "Claude CLI found ($(claude --version 2>/dev/null | head -1))"
    if claude auth status &>/dev/null 2>&1; then
      success "Claude CLI authenticated"
    else
      error "Claude CLI not authenticated. Run: claude auth login"
      missing=1
    fi
  else
    error "Claude CLI not found. Install from https://claude.ai/code"
    missing=1
  fi

  if command -v jq &>/dev/null; then
    success "jq found"
  else
    error "jq not found. Install via: brew install jq  (macOS) or apt install jq (Linux)"
    missing=1
  fi

  if [[ "$missing" -eq 1 ]]; then
    printf "\n"
    error "Please install the missing prerequisites and re-run setup.sh"
    exit 1
  fi
}

# =============================================================================
# 2. Welcome Banner
# =============================================================================
print_banner() {
  printf "\n"
  printf "${BOLD}${CYAN}╔══════════════════════════════════════════════════════╗${RESET}\n"
  printf "${BOLD}${CYAN}║         CertPilot-AutoDev Setup                      ║${RESET}\n"
  printf "${BOLD}${CYAN}║    AI-Powered SDLC Automation with Claude Code       ║${RESET}\n"
  printf "${BOLD}${CYAN}╚══════════════════════════════════════════════════════╝${RESET}\n"
  printf "\n"
  info "This script will configure your environment, generate config files,"
  info "start Docker services, and set up your first product."
  info "Jira, Telegram, and ngrok are all optional — the platform works standalone."
  printf "\n"
}

# =============================================================================
# 3. Integration Prompts
# =============================================================================
gather_config() {
  # ── Jira ──────────────────────────────────────────────────────────────────
  header "Jira Cloud (optional)"
  JIRA_ENABLED=false
  JIRA_DOMAIN=""
  JIRA_EMAIL=""
  JIRA_API_TOKEN=""

  if prompt_yn "Do you have Jira Cloud?"; then
    JIRA_ENABLED=true
    JIRA_DOMAIN="$(prompt_value "Jira domain" "https://yourorg.atlassian.net")"
    JIRA_EMAIL="$(prompt_value "Jira email")"
    JIRA_API_TOKEN="$(prompt_secret "Jira API token")"
  fi

  # ── Telegram ──────────────────────────────────────────────────────────────
  header "Telegram (optional)"
  TELEGRAM_ENABLED=false
  TELEGRAM_BOT_TOKEN=""
  TELEGRAM_CHAT_NOTIFICATIONS=""

  if prompt_yn "Do you have a Telegram bot?"; then
    TELEGRAM_ENABLED=true
    TELEGRAM_BOT_TOKEN="$(prompt_secret "Bot token")"
    TELEGRAM_CHAT_NOTIFICATIONS="$(prompt_value "Notification chat ID")"
  fi

  # ── ngrok ─────────────────────────────────────────────────────────────────
  header "External Webhook Access (optional)"
  NGROK_ENABLED=false
  NGROK_AUTHTOKEN=""
  NGROK_HOSTNAME=""

  if prompt_yn "Do you need external webhook access (ngrok)?"; then
    NGROK_ENABLED=true
    NGROK_AUTHTOKEN="$(prompt_secret "ngrok authtoken")"
    NGROK_HOSTNAME="$(prompt_value "ngrok hostname (e.g. yourapp.ngrok.app)")"
  fi

  # ── Outgoing notifications ────────────────────────────────────────────────
  header "Outgoing Notifications (optional)"
  NOTIFICATION_WEBHOOK_URL="$(prompt_value "Outgoing webhook URL (Slack/Discord/Teams — leave blank to skip)")"

  # ── Derive flags ──────────────────────────────────────────────────────────
  N8N_ENABLED=false
  if [[ "$JIRA_ENABLED" == "true" ]] || [[ "$NGROK_ENABLED" == "true" ]]; then
    N8N_ENABLED=true
  fi

  # ── Auto-generate secrets ─────────────────────────────────────────────────
  RUNNER_SECRET="$(openssl rand -hex 24)"
  DASHBOARD_PASSWORD="$(openssl rand -hex 12)"
  RUNNER_DB_PASSWORD="$(openssl rand -hex 16)"

  success "Secrets generated."
}

# =============================================================================
# 4. Generate .env
# =============================================================================
generate_env() {
  header "Generating .env"

  if [[ ! -f "$SCRIPT_DIR/.env.example" ]]; then
    error ".env.example not found — cannot generate .env"
    exit 1
  fi

  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"

  sed_inplace() {
    if [[ "$(uname)" == "Darwin" ]]; then
      sed -i '' "$@"
    else
      sed -i "$@"
    fi
  }

  sed_inplace "s|^RUNNER_SECRET=.*|RUNNER_SECRET=${RUNNER_SECRET}|" "$SCRIPT_DIR/.env"
  sed_inplace "s|^DASHBOARD_PASSWORD=.*|DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD}|" "$SCRIPT_DIR/.env"
  sed_inplace "s|^RUNNER_DB_PASSWORD=.*|RUNNER_DB_PASSWORD=${RUNNER_DB_PASSWORD}|" "$SCRIPT_DIR/.env"

  if [[ "$JIRA_ENABLED" == "true" ]]; then
    sed_inplace "s|^# JIRA_DOMAIN=.*|JIRA_DOMAIN=${JIRA_DOMAIN}|" "$SCRIPT_DIR/.env"
    sed_inplace "s|^# JIRA_EMAIL=.*|JIRA_EMAIL=${JIRA_EMAIL}|" "$SCRIPT_DIR/.env"
    sed_inplace "s|^# JIRA_API_TOKEN=.*|JIRA_API_TOKEN=${JIRA_API_TOKEN}|" "$SCRIPT_DIR/.env"
  fi

  if [[ "$TELEGRAM_ENABLED" == "true" ]]; then
    sed_inplace "s|^# TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}|" "$SCRIPT_DIR/.env"
    sed_inplace "s|^# TELEGRAM_CHAT_NOTIFICATIONS=.*|TELEGRAM_CHAT_NOTIFICATIONS=${TELEGRAM_CHAT_NOTIFICATIONS}|" "$SCRIPT_DIR/.env"
  fi

  if [[ "$NGROK_ENABLED" == "true" ]]; then
    sed_inplace "s|^# NGROK_AUTHTOKEN=.*|NGROK_AUTHTOKEN=${NGROK_AUTHTOKEN}|" "$SCRIPT_DIR/.env"
    sed_inplace "s|^# NGROK_DOMAIN=.*|NGROK_DOMAIN=${NGROK_HOSTNAME}|" "$SCRIPT_DIR/.env"
  fi

  if [[ -n "$NOTIFICATION_WEBHOOK_URL" ]]; then
    sed_inplace "s|^# NOTIFICATION_WEBHOOK_URL=.*|NOTIFICATION_WEBHOOK_URL=${NOTIFICATION_WEBHOOK_URL}|" "$SCRIPT_DIR/.env"
  fi

  success ".env written"
}

# =============================================================================
# 5. Generate claude-runner/config.json (from config.template.json)
# =============================================================================
generate_config() {
  header "Generating runner config"

  local template="$SCRIPT_DIR/config.template.json"
  if [[ ! -f "$template" ]]; then
    warn "config.template.json not found — skipping config generation"
    return
  fi

  local callback_url=""
  if [[ "$NGROK_ENABLED" == "true" && -n "$NGROK_HOSTNAME" ]]; then
    callback_url="https://${NGROK_HOSTNAME}/webhook/runner/callback"
  fi

  local notification_webhook_json="null"
  if [[ -n "$NOTIFICATION_WEBHOOK_URL" ]]; then
    notification_webhook_json="\"${NOTIFICATION_WEBHOOK_URL}\""
  fi

  # Use jq for JSON-safe substitution of string fields, sed for booleans
  jq \
    --arg working_dir "${PRODUCT_DIR:-}" \
    --arg callback_url "$callback_url" \
    --arg jira_domain "${JIRA_DOMAIN:-}" \
    --arg jira_email "${JIRA_EMAIL:-}" \
    --argjson jira_enabled "$( [[ "$JIRA_ENABLED" == "true" ]] && echo true || echo false)" \
    --argjson telegram_enabled "$( [[ "$TELEGRAM_ENABLED" == "true" ]] && echo true || echo false)" \
    --argjson n8n_enabled "$( [[ "$N8N_ENABLED" == "true" ]] && echo true || echo false)" \
    --argjson notification_webhook "$notification_webhook_json" \
    --arg project_key "${PRODUCT_PREFIX:-PRJ}" \
    '
    walk(
      if type == "string" then
        if . == "__WORKING_DIR__"           then $working_dir
        elif . == "__CALLBACK_URL__"        then $callback_url
        elif . == "__JIRA_DOMAIN__"         then $jira_domain
        elif . == "__JIRA_EMAIL__"          then $jira_email
        elif . == "__JIRA_ENABLED__"        then "PLACEHOLDER_JIRA"
        elif . == "__TELEGRAM_ENABLED__"    then "PLACEHOLDER_TELEGRAM"
        elif . == "__N8N_ENABLED__"         then "PLACEHOLDER_N8N"
        elif . == "__NOTIFICATION_WEBHOOK_URL__" then "PLACEHOLDER_NOTIF"
        elif . == "__PROJECT_KEY__"         then $project_key
        else .
        end
      elif type == "object" then
        with_entries(
          if .value == "__JIRA_ENABLED__"     then .value = $jira_enabled
          elif .value == "__TELEGRAM_ENABLED__" then .value = $telegram_enabled
          elif .value == "__N8N_ENABLED__"    then .value = $n8n_enabled
          elif .value == "__NOTIFICATION_WEBHOOK_URL__" then .value = $notification_webhook
          else .
          end
        )
      else .
      end
    )
    ' "$template" > "$SCRIPT_DIR/claude-runner/config.json"

  # Write docker variant with /projects mount paths
  jq \
    --arg working_dir "${PRODUCT_DOCKER_DIR:-}" \
    --arg callback_url "$callback_url" \
    --arg jira_domain "${JIRA_DOMAIN:-}" \
    --arg jira_email "${JIRA_EMAIL:-}" \
    --argjson jira_enabled "$( [[ "$JIRA_ENABLED" == "true" ]] && echo true || echo false)" \
    --argjson telegram_enabled "$( [[ "$TELEGRAM_ENABLED" == "true" ]] && echo true || echo false)" \
    --argjson n8n_enabled "$( [[ "$N8N_ENABLED" == "true" ]] && echo true || echo false)" \
    --argjson notification_webhook "$notification_webhook_json" \
    --arg project_key "${PRODUCT_PREFIX:-PRJ}" \
    '
    walk(
      if type == "string" then
        if . == "__WORKING_DIR__"               then $working_dir
        elif . == "__CALLBACK_URL__"            then $callback_url
        elif . == "__JIRA_DOMAIN__"             then $jira_domain
        elif . == "__JIRA_EMAIL__"              then $jira_email
        elif . == "__PROJECT_KEY__"             then $project_key
        else .
        end
      elif type == "object" then
        with_entries(
          if .value == "__JIRA_ENABLED__"       then .value = $jira_enabled
          elif .value == "__TELEGRAM_ENABLED__" then .value = $telegram_enabled
          elif .value == "__N8N_ENABLED__"      then .value = $n8n_enabled
          elif .value == "__NOTIFICATION_WEBHOOK_URL__" then .value = $notification_webhook
          else .
          end
        )
      else .
      end
    )
    ' "$template" > "$SCRIPT_DIR/claude-runner/config.docker.json"

  success "claude-runner/config.json written"
  success "claude-runner/config.docker.json written"
}

# =============================================================================
# 6. Generate .mcp.json for standalone (no N8N) mode
# =============================================================================
generate_mcp_json() {
  local plugin_dir="$SCRIPT_DIR/${PRODUCT_PLUGIN_DIR}"
  local mcp_path="${plugin_dir}/.mcp.json"

  if [[ "$N8N_ENABLED" == "false" ]]; then
    info "N8N not enabled — writing standalone .mcp.json (built-in issue tracker)"
    cat > "$mcp_path" <<'EOF'
{
  "mcpServers": {
    "issues": {
      "command": "node",
      "args": ["claude-runner/mcp-issues.js"],
      "env": {
        "RUNNER_SECRET": "${RUNNER_SECRET}"
      }
    }
  }
}
EOF
    success ".mcp.json written (standalone mode)"
  else
    info "N8N enabled — configure .mcp.json to point to your N8N Jira MCP endpoint"
    info "See certpilot-plugin/.mcp.json for an example"
  fi
}

# =============================================================================
# 7. First Product Setup
# =============================================================================
setup_product() {
  header "First Product Setup"

  PRODUCT_NAME="$(prompt_value "Product name" "MyApp")"
  PRODUCT_PREFIX="$(prompt_value "Project prefix (2-4 uppercase letters)" "APP")"
  PRODUCT_PREFIX="${PRODUCT_PREFIX^^}"  # force uppercase
  PRODUCT_DIR="$(prompt_value "Codebase path (absolute path to your project)")"
  PRODUCT_TECH="$(prompt_value "Tech stack" "Next.js, Express, PostgreSQL")"

  # Derive ID: lowercase, hyphens
  local id
  id="$(printf '%s' "$PRODUCT_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')"

  PRODUCT_PLUGIN_DIR="${id}-plugin"
  PRODUCT_DOCKER_DIR="/projects/${id}"

  info "Creating product config at products/${id}/product.json"
  mkdir -p "$SCRIPT_DIR/products/${id}"

  cat > "$SCRIPT_DIR/products/${id}/product.json" <<EOF
{
  "id": "${id}",
  "name": "${PRODUCT_NAME}",
  "description": "${PRODUCT_NAME} — managed by CertPilot-AutoDev",
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

  info "Scaffolding plugin directory at ${PRODUCT_PLUGIN_DIR}/"
  mkdir -p "$SCRIPT_DIR/${PRODUCT_PLUGIN_DIR}/agents"
  mkdir -p "$SCRIPT_DIR/${PRODUCT_PLUGIN_DIR}/skills"
  mkdir -p "$SCRIPT_DIR/${PRODUCT_PLUGIN_DIR}/commands"

  # Write a minimal product brief for agents to reference
  cat > "$SCRIPT_DIR/${PRODUCT_PLUGIN_DIR}/PRODUCT.md" <<EOF
# ${PRODUCT_NAME}

**Tech Stack:** ${PRODUCT_TECH}
**Project Prefix:** ${PRODUCT_PREFIX}
**Codebase:** ${PRODUCT_DIR}

## Getting Started

Agents working on this product should read the codebase at the path above.
Refer to shared-skills/ for cross-cutting skills (security, QA, UX, BA, PM).
EOF

  success "Product '${PRODUCT_NAME}' (${id}) created"
}

# =============================================================================
# 8. Docker Compose Up
# =============================================================================
start_services() {
  header "Starting Docker services"

  # Export PROJECT_DIR so docker-compose can pick it up
  export PROJECT_DIR="${PRODUCT_DIR:-}"

  info "Building images..."
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" build

  info "Starting services..."
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d

  info "Waiting for runner health check (up to 60s)..."
  local attempts=0
  until curl -sf http://localhost:3210/health > /dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [[ "$attempts" -ge 30 ]]; then
      warn "Runner did not become healthy within 60s — check logs with: docker compose logs runner"
      return
    fi
    sleep 2
  done
  success "Runner is healthy!"
}

# =============================================================================
# 9. Print Summary
# =============================================================================
print_summary() {
  printf "\n"
  printf "${BOLD}${GREEN}╔══════════════════════════════════════════════════════╗${RESET}\n"
  printf "${BOLD}${GREEN}║  Setup Complete!                                     ║${RESET}\n"
  printf "${BOLD}${GREEN}╚══════════════════════════════════════════════════════╝${RESET}\n"
  printf "\n"
  printf "  ${BOLD}Dashboard:${RESET}     http://localhost:3100\n"
  printf "  ${BOLD}Runner API:${RESET}    http://localhost:3210\n"
  printf "  ${BOLD}Password:${RESET}      %s\n" "$DASHBOARD_PASSWORD"
  printf "\n"
  printf "  ${BOLD}Runner secret (keep this safe):${RESET}\n"
  printf "    %s\n" "$RUNNER_SECRET"
  printf "\n"
  printf "  ${BOLD}Next steps:${RESET}\n"
  printf "    - Open the Dashboard and log in\n"
  printf "    - Create your first issue at Issues -> New Issue\n"
  printf "    - Chat with agents at Chat -> New Conversation\n"
  printf "    - Run an agent:\n"
  printf "\n"
  printf "      curl -X POST http://localhost:3210/agent \\\\\n"
  printf "        -H 'x-runner-secret: %s' \\\\\n" "$RUNNER_SECRET"
  printf "        -H 'Content-Type: application/json' \\\\\n"
  printf "        -d '{\"agent\":\"engineer-planner\",\"prompt\":\"Plan the architecture\"}'\n"
  printf "\n"

  if [[ "$JIRA_ENABLED" == "true" ]]; then
    success "Jira integration active — issues sync from ${JIRA_DOMAIN}"
  fi
  if [[ "$TELEGRAM_ENABLED" == "true" ]]; then
    success "Telegram notifications active"
  fi
  if [[ "$N8N_ENABLED" == "true" ]]; then
    success "N8N workflows available at http://localhost:5678"
  fi

  printf "\n"
  info "Secrets are saved in .env — do not commit this file to git."
  printf "\n"
}

# =============================================================================
# Main
# =============================================================================
main() {
  print_banner
  check_prerequisites

  gather_config
  setup_product      # must run before generate_config (sets PRODUCT_DIR etc.)
  generate_env
  generate_config
  generate_mcp_json
  start_services
  print_summary
}

main "$@"
