#!/usr/bin/env bash
#
# backup-postgres.sh — dump the Meshwork Postgres databases (runner + n8n)
# to compressed SQL files with rotation.
#
# Postgres holds all job history, pipelines, conversations, and N8N state;
# without backups a disk failure erases the platform's operational memory.
#
# Usage:
#   ./scripts/backup-postgres.sh [backup-dir]
#
# Defaults to ./backups. Designed for cron, e.g. nightly at 03:00:
#   0 3 * * * cd /path/to/meshwork && ./scripts/backup-postgres.sh >> ~/meshwork-backup.log 2>&1
#
# Restore (see docs/claude/reliability.md for the full runbook):
#   gunzip -c backups/runner-YYYYMMDD-HHMMSS.sql.gz | \
#     docker compose exec -T postgres psql -U runner -d runner
#
set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="${1:-./backups}"
RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-14}"
CONTAINER="${POSTGRES_CONTAINER:-meshwork-postgres}"
STAMP="$(date +%Y%m%d-%H%M%S)"

# Pull connection details from .env when present
env_get() {
  grep -E "^${1}=" .env 2>/dev/null | head -1 | cut -d= -f2- || true
}

RUNNER_DB_USER="$(env_get RUNNER_DB_USER)"; RUNNER_DB_USER="${RUNNER_DB_USER:-runner}"
RUNNER_DB_NAME="$(env_get RUNNER_DB_NAME)"; RUNNER_DB_NAME="${RUNNER_DB_NAME:-runner}"
N8N_DB_USER="$(env_get POSTGRES_USER)"; N8N_DB_USER="${N8N_DB_USER:-n8n}"
N8N_DB_NAME="$(env_get POSTGRES_DB)"; N8N_DB_NAME="${N8N_DB_NAME:-n8n}"

mkdir -p "$BACKUP_DIR"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "[backup] Container '${CONTAINER}' is not running."
  echo "[backup] External-Postgres mode? Run pg_dump against your external host instead:"
  echo "         pg_dump -h \$RUNNER_DB_HOST -U \$RUNNER_DB_USER \$RUNNER_DB_NAME | gzip > ${BACKUP_DIR}/runner-${STAMP}.sql.gz"
  exit 1
fi

backup_db() {
  local user="$1" db="$2" prefix="$3"
  local out="${BACKUP_DIR}/${prefix}-${STAMP}.sql.gz"
  echo "[backup] Dumping ${db} as ${user} → ${out}"
  if docker exec "$CONTAINER" pg_dump -U "$user" -d "$db" --no-owner | gzip > "$out"; then
    echo "[backup] OK: $(du -h "$out" | cut -f1) ${out}"
  else
    rm -f "$out"
    echo "[backup] FAILED dumping ${db}" >&2
    return 1
  fi
}

backup_db "$RUNNER_DB_USER" "$RUNNER_DB_NAME" "runner"
backup_db "$N8N_DB_USER" "$N8N_DB_NAME" "n8n" || true  # n8n DB may not exist in external-db mode

# Rotation: keep the newest N backups per prefix
for prefix in runner n8n; do
  ls -1t "${BACKUP_DIR}/${prefix}-"*.sql.gz 2>/dev/null | tail -n "+$((RETENTION_COUNT + 1))" | while read -r old; do
    echo "[backup] Rotating out ${old}"
    rm -f "$old"
  done
done

echo "[backup] Done."
