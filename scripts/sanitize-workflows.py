#!/usr/bin/env python3
"""Sanitize N8N workflow JSON exports for public distribution.

Replaces private hostnames, credential IDs, chat IDs, project keys, and
personal identifiers with templated placeholders that setup.sh resolves
from `.env` at install time.

Usage:
    python3 scripts/sanitize-workflows.py [workflows-dir]

Idempotent: safe to re-run; placeholders are not re-replaced.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPLACEMENTS: list[tuple[str, str]] = [
    (r"https://n8n-certpilot\.ngrok\.app", "{{N8N_PUBLIC_URL}}"),
    (r"https://[a-z0-9-]+\.ngrok(?:-free)?\.app", "{{N8N_PUBLIC_URL}}"),
    (r"http://host\.docker\.internal:3210", "{{RUNNER_INTERNAL_URL}}"),
    (r"http://localhost:3210", "{{RUNNER_INTERNAL_URL}}"),
    (r"\bhello@certpilot\.co\.uk\b", "{{TEAM_EMAIL}}"),
    (r"\bmarkking@niss\.ltd\b", "{{ADMIN_EMAIL}}"),
    (r"\b7932572505\b", "{{TELEGRAM_ADMIN_CHAT_ID}}"),
    (r"nissltd\.atlassian\.net", "{{JIRA_HOST}}"),
    (r"fb4297ec-90a0-41d6-9668-f7d723306f3a", "{{JIRA_CLOUD_ID}}"),
    (r"/Users/markking/Projects/SupplyChain Secure", "{{DEFAULT_WORKING_DIR}}"),
    (r"/Users/markking/Projects/WarrantyManagement", "{{DEFAULT_WORKING_DIR}}"),
    (r"/Users/markking/projects/estateos", "{{DEFAULT_WORKING_DIR}}"),
    (r"/Users/markking/Projects/LEBC", "{{DEFAULT_WORKING_DIR}}"),
    (r"/Users/markking/Projects/MoneyMind", "{{DEFAULT_WORKING_DIR}}"),
    (r"/Users/markking/Projects/CertPilot-AutoDev", "{{PLATFORM_DIR}}"),
    (r"/Users/markking/projects/[a-zA-Z0-9_-]+", "{{DEFAULT_WORKING_DIR}}"),
    (r"/Users/markking/Projects/[a-zA-Z0-9_-]+", "{{DEFAULT_WORKING_DIR}}"),
    (r"spaces/CERTPILOT_ENGINEERING", "{{GCHAT_ENGINEERING_SPACE}}"),
    (r'"projectKey"\s*:\s*"(CER|EOS|WMS|LEBC|MMD)"', '"projectKey": "{{JIRA_PROJECT_KEY}}"'),
    (r'"project"\s*:\s*"(CER|EOS|WMS|LEBC|MMD)"', '"project": "{{JIRA_PROJECT_KEY}}"'),
]

CREDENTIAL_ID_KEYS = ("id", "name")


def scrub_credentials(node_credentials: dict) -> dict:
    out = {}
    for cred_type, cred_obj in node_credentials.items():
        if isinstance(cred_obj, dict):
            out[cred_type] = {k: "" for k in cred_obj if k in CREDENTIAL_ID_KEYS}
        else:
            out[cred_type] = ""
    return out


def sanitize_node(node: dict) -> None:
    if "credentials" in node and isinstance(node["credentials"], dict):
        node["credentials"] = scrub_credentials(node["credentials"])
    if "webhookId" in node:
        node["webhookId"] = ""
    for child_key in ("parameters", "data"):
        child = node.get(child_key)
        if isinstance(child, dict):
            sanitize_dict_inplace(child)


def sanitize_dict_inplace(d: dict) -> None:
    for k, v in list(d.items()):
        if isinstance(v, dict):
            sanitize_dict_inplace(v)
        elif isinstance(v, list):
            for item in v:
                if isinstance(item, dict):
                    sanitize_dict_inplace(item)


def sanitize_text(text: str) -> str:
    for pattern, replacement in REPLACEMENTS:
        text = re.sub(pattern, replacement, text)
    return text


def sanitize_workflow_file(path: Path) -> bool:
    raw = path.read_text()
    cleaned_text = sanitize_text(raw)
    try:
        data = json.loads(cleaned_text)
    except json.JSONDecodeError as exc:
        print(f"  SKIP (invalid JSON after text sub): {path.name} — {exc}", file=sys.stderr)
        return False

    nodes = data.get("nodes", [])
    for node in nodes:
        sanitize_node(node)

    for stripped_key in ("staticData", "tags", "meta", "pinData", "versionId"):
        data.pop(stripped_key, None)

    new_text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    if new_text != raw:
        path.write_text(new_text)
        return True
    return False


def main() -> int:
    workflows_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "workflows")
    if not workflows_dir.is_dir():
        print(f"ERROR: {workflows_dir} is not a directory", file=sys.stderr)
        return 1

    changed = 0
    total = 0
    for path in sorted(workflows_dir.glob("*.json")):
        total += 1
        if sanitize_workflow_file(path):
            changed += 1
            print(f"  sanitized: {path.name}")
    print(f"\nDone: {changed}/{total} workflows updated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
