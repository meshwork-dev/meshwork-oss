#!/bin/bash
# Migrate N8N from SQLite to PostgreSQL
# Usage: N8N_API_KEY=<key> bash scripts/migrate-n8n-to-postgres.sh
#
# Prerequisites:
#   - N8N currently running on SQLite
#   - N8N API key available (or readable from SQLite)
#   - docker compose available
#
# This script:
#   1. Exports all workflows via N8N CLI (fixes empty createdAt for PostgreSQL)
#   2. Exports credentials + user + project data directly from SQLite
#   3. Stops N8N, starts PostgreSQL
#   4. Starts N8N on PostgreSQL (auto-creates schema)
#   5. Imports workflows, credentials, user, project, API keys via CLI + direct SQL
#   6. Activates all previously-active workflows via POST /activate
#
# Known issues addressed:
#   - N8N CLI export produces empty createdAt fields — script strips them
#   - N8N export:credential doesn't exist in v2.x — credentials imported via SQL
#   - N8N v2.x uses POST /activate, not PATCH with {active:true}
#   - Large workflow JSON responses break bash pipe parsing — Python used instead

set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="/tmp/n8n-postgres-migration-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

DB_PATH="$HOME/.n8n/database.sqlite"
N8N_URL="http://localhost:5678"

# --- Resolve N8N API key ---
if [ -n "${N8N_API_KEY:-}" ]; then
  API_KEY="$N8N_API_KEY"
else
  echo "N8N_API_KEY not set. Attempting to read from SQLite..."
  if [ ! -f "$DB_PATH" ]; then
    echo "ERROR: No SQLite database at $DB_PATH and N8N_API_KEY not set."
    exit 1
  fi
  API_KEY=$(sqlite3 "$DB_PATH" "SELECT apiKey FROM user_api_keys WHERE label='Runner' LIMIT 1;" 2>/dev/null || true)
  if [ -z "$API_KEY" ]; then
    echo "ERROR: Could not find Runner API key in SQLite. Set N8N_API_KEY and re-run."
    exit 1
  fi
  echo "Found API key from SQLite."
fi

echo "=== N8N SQLite → PostgreSQL Migration ==="
echo "Backup dir: $BACKUP_DIR"
echo ""

# --- Step 1: Export workflows ---
echo "--- Step 1: Exporting workflows ---"

# Track active workflow IDs via API
WORKFLOWS=$(curl -sf -H "X-N8N-API-KEY: $API_KEY" "$N8N_URL/api/v1/workflows?limit=200" || true)
if [ -z "$WORKFLOWS" ]; then
  echo "ERROR: Could not fetch workflows. Is N8N running?"
  exit 1
fi

echo "$WORKFLOWS" > "$BACKUP_DIR/workflows-api.json"
WF_COUNT=$(echo "$WORKFLOWS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('data',[])))")
echo "Found $WF_COUNT workflows via API."

echo "$WORKFLOWS" | python3 -c "
import json, sys
data = json.load(sys.stdin)
active = [w['id'] for w in data.get('data', []) if w.get('active')]
print('\n'.join(active))
" > "$BACKUP_DIR/active-workflow-ids.txt"
ACTIVE_COUNT=$(wc -l < "$BACKUP_DIR/active-workflow-ids.txt" | tr -d ' ')
echo "  $ACTIVE_COUNT workflows were active."

# CLI export (has full node data)
docker compose exec -T n8n n8n export:workflow --all --output=/home/node/.n8n/workflow-export.json 2>/dev/null || true
if [ -f "$HOME/.n8n/workflow-export.json" ]; then
  # Fix: remove empty createdAt fields that break PostgreSQL timestamp parsing
  python3 -c "
import json, os
path = os.path.expanduser('~/.n8n/workflow-export.json')
with open(path) as f:
    data = json.load(f)
for w in data:
    for key in list(w.keys()):
        if w[key] == '':
            del w[key]
with open(path.replace('export', 'import-fixed'), 'w') as f:
    json.dump(data, f)
print(f'Fixed {len(data)} workflows (removed empty timestamp fields)')
"
  cp "$HOME/.n8n/workflow-export.json" "$BACKUP_DIR/"
fi

# --- Step 2: Export credentials + entities from SQLite ---
echo "--- Step 2: Exporting entities from SQLite ---"
python3 << PYEOF
import sqlite3, json, os

db_path = os.path.expanduser("~/.n8n/database.sqlite")
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

backup = "$BACKUP_DIR"

for table in ['credentials_entity', 'user', 'project', 'project_relation',
              'shared_credentials', 'shared_workflow', 'user_api_keys', 'settings', 'variables']:
    try:
        cursor.execute(f"SELECT * FROM {table}")
        rows = cursor.fetchall()
        cols = [d[0] for d in cursor.description]
        data = [{c: r[c] for c in cols} for r in rows]
        with open(f"{backup}/{table}.json", 'w') as f:
            json.dump(data, f, indent=2)
        print(f"  {table}: {len(data)} rows")
    except Exception as e:
        print(f"  {table}: skipped ({e})")

conn.close()
PYEOF

echo ""

# --- Step 3: Stop N8N, start PostgreSQL ---
echo "--- Step 3: Stopping N8N ---"
docker compose stop n8n
echo "N8N stopped."

echo "--- Step 3b: Starting PostgreSQL ---"
docker compose up -d postgres
echo "Waiting for PostgreSQL to be healthy..."
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U n8n > /dev/null 2>&1; then
    echo "PostgreSQL is ready."
    break
  fi
  [ "$i" -eq 30 ] && { echo "ERROR: PostgreSQL not healthy after 60s."; exit 1; }
  sleep 2
done

# --- Step 4: Start N8N on PostgreSQL ---
echo "--- Step 4: Starting N8N on PostgreSQL ---"
docker compose up -d n8n
echo "Waiting for N8N to initialize schema..."
sleep 15
for i in $(seq 1 20); do
  curl -sf "$N8N_URL/healthz" > /dev/null 2>&1 && { echo "N8N is up on PostgreSQL."; break; }
  [ "$i" -eq 20 ] && { echo "ERROR: N8N did not come up."; exit 1; }
  sleep 3
done

# --- Step 5: Import data ---
echo "--- Step 5: Importing workflows ---"
if [ -f "$HOME/.n8n/workflow-import-fixed.json" ]; then
  docker compose exec -T n8n n8n import:workflow --input=/home/node/.n8n/workflow-import-fixed.json 2>&1 \
    && echo "Workflow import successful." \
    || echo "WARNING: CLI import had errors (check above)."
fi

echo "--- Step 5b: Importing entities via SQL ---"
python3 << PYEOF
import json, subprocess, os

backup = "$BACKUP_DIR"

def run_sql(sql):
    return subprocess.run(
        ["docker", "compose", "exec", "-T", "postgres", "psql", "-U", "n8n", "-d", "n8n", "-c", sql],
        capture_output=True, text=True
    )

def escape(val):
    if val is None: return "NULL"
    if isinstance(val, (int, float)): return str(val)
    if isinstance(val, bool): return "true" if val else "false"
    return "'" + str(val).replace("'", "''") + "'"

# Insert user
with open(f"{backup}/user.json") as f:
    users = json.load(f)
for u in users:
    sql = f"""INSERT INTO "user" (id, email, "firstName", "lastName", password, settings, "roleSlug", disabled, "mfaEnabled")
              VALUES ({escape(u['id'])}, {escape(u.get('email'))}, {escape(u.get('firstName'))}, {escape(u.get('lastName'))},
                      {escape(u.get('password'))}, {escape(u.get('settings'))},
                      {escape(u.get('roleSlug','global:owner'))},
                      {'true' if u.get('disabled') else 'false'},
                      {'true' if u.get('mfaEnabled') else 'false'})
              ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;"""
    r = run_sql(sql)
    print(f"  {'✓' if r.returncode == 0 else '✗'} user: {u.get('email', u['id'])}")

# Insert project
with open(f"{backup}/project.json") as f:
    projects = json.load(f)
for p in projects:
    sql = f"""INSERT INTO project (id, name, type)
              VALUES ({escape(p['id'])}, {escape(p['name'])}, {escape(p['type'])})
              ON CONFLICT (id) DO NOTHING;"""
    r = run_sql(sql)
    print(f"  {'✓' if r.returncode == 0 else '✗'} project: {p['name']}")

# Insert project_relation
with open(f"{backup}/project_relation.json") as f:
    rels = json.load(f)
for rel in rels:
    sql = f"""INSERT INTO project_relation ("projectId", "userId", role)
              VALUES ({escape(rel['projectId'])}, {escape(rel['userId'])}, {escape(rel['role'])})
              ON CONFLICT DO NOTHING;"""
    run_sql(sql)
print(f"  ✓ {len(rels)} project relations")

# Insert credentials
with open(f"{backup}/credentials_entity.json") as f:
    creds = json.load(f)
for c in creds:
    sql = f"""INSERT INTO credentials_entity (id, name, type, data)
              VALUES ({escape(c['id'])}, {escape(c['name'])}, {escape(c['type'])}, {escape(c['data'])})
              ON CONFLICT (id) DO NOTHING;"""
    r = run_sql(sql)
    print(f"  {'✓' if r.returncode == 0 else '✗'} credential: {c['name']}")

# Insert shared_credentials
with open(f"{backup}/shared_credentials.json") as f:
    sc = json.load(f)
ok = 0
for s in sc:
    sql = f"""INSERT INTO shared_credentials ("credentialsId", "projectId", role)
              VALUES ({escape(s['credentialsId'])}, {escape(s['projectId'])}, {escape(s['role'])})
              ON CONFLICT DO NOTHING;"""
    r = run_sql(sql)
    if r.returncode == 0: ok += 1
print(f"  ✓ {ok}/{len(sc)} shared credentials")

# Insert API keys
with open(f"{backup}/user_api_keys.json") as f:
    keys = json.load(f)
for k in keys:
    audience = k.get('apiKeyType', 'public-api')
    sql = f"""INSERT INTO user_api_keys (id, "userId", label, "apiKey", scopes, audience)
              VALUES ({escape(k['id'])}, {escape(k['userId'])}, {escape(k.get('label'))},
                      {escape(k.get('apiKey'))}, {escape(k.get('scopes'))}, {escape(audience)})
              ON CONFLICT (id) DO NOTHING;"""
    r = run_sql(sql)
    print(f"  {'✓' if r.returncode == 0 else '✗'} API key: {k.get('label')}")

# Insert settings
with open(f"{backup}/settings.json") as f:
    settings = json.load(f)
for s in settings:
    sql = f"""INSERT INTO settings (key, value, "loadOnStartup")
              VALUES ({escape(s['key'])}, {escape(s['value'])}, {'true' if s.get('loadOnStartup') else 'false'})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;"""
    run_sql(sql)
print(f"  ✓ {len(settings)} settings")

print("Entity import complete.")
PYEOF

# Restart N8N to pick up imported entities
echo "Restarting N8N..."
docker compose restart n8n
sleep 10
for i in $(seq 1 20); do
  curl -sf "$N8N_URL/healthz" > /dev/null 2>&1 && break
  sleep 3
done

# --- Step 6: Activate workflows ---
echo "--- Step 6: Activating workflows ---"
python3 << PYEOF
import urllib.request, json

api_key = "$API_KEY"
base_url = "$N8N_URL"

with open("$BACKUP_DIR/active-workflow-ids.txt") as f:
    ids = [line.strip() for line in f if line.strip()]

activated = 0
failed = 0
for wf_id in ids:
    try:
        req = urllib.request.Request(
            f"{base_url}/api/v1/workflows/{wf_id}/activate",
            method="POST",
            headers={"X-N8N-API-KEY": api_key}
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            if data.get("active"):
                print(f"  ✓ {data.get('name', wf_id)}")
                activated += 1
            else:
                print(f"  ✗ {wf_id}: not active")
                failed += 1
    except Exception as e:
        print(f"  ✗ {wf_id}: {e}")
        failed += 1

print(f"\nActivated: {activated}/{len(ids)}, Failed: {failed}")
PYEOF

# --- Step 7: Verify ---
echo ""
echo "=== Verification ==="
docker compose exec -T postgres pg_isready -U n8n 2>/dev/null && echo "PostgreSQL: ✓ accepting connections" || echo "PostgreSQL: ✗ not ready"

python3 << PYEOF
import urllib.request, json
api_key = "$API_KEY"
try:
    req = urllib.request.Request("$N8N_URL/api/v1/workflows?limit=200", headers={"X-N8N-API-KEY": api_key})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
        wfs = data.get('data', [])
        active = sum(1 for w in wfs if w.get('active'))
        print(f"N8N: {len(wfs)} workflows, {active} active")
except Exception as e:
    print(f"N8N: error checking - {e}")
PYEOF

echo ""
echo "Backup: $BACKUP_DIR"
echo "SQLite preserved: $DB_PATH"
echo ""
echo "=== Migration complete ==="
