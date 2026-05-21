#!/usr/bin/env python3
"""Sanitize config.template.json and config.docker.template.json.

Replaces hostnames, paths, IDs, and credentials with __PLACEHOLDER__ tokens
that setup.sh resolves from `.env` at install time.

Idempotent — safe to re-run.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPLACEMENTS: list[tuple[str, str]] = [
    (r"https://n8n-certpilot\.ngrok\.app", "__N8N_PUBLIC_URL__"),
    (r"https://[a-z0-9-]+\.ngrok(?:-free)?\.app", "__N8N_PUBLIC_URL__"),
    (r"/Users/markking/Projects/SupplyChain Secure", "__WORKING_DIR__"),
    (r"/Users/markking/Projects/WarrantyManagement", "__WORKING_DIR__"),
    (r"/Users/markking/projects/estateos", "__WORKING_DIR__"),
    (r"/Users/markking/Projects/LEBC", "__WORKING_DIR__"),
    (r"/Users/markking/Projects/MoneyMind", "__WORKING_DIR__"),
    (r"/Users/markking/Projects/CertPilot-AutoDev/[a-zA-Z0-9_/-]+", "__PLUGIN_DIR__"),
    (r"/Users/markking/Projects/CertPilot-AutoDev", "__PLATFORM_DIR__"),
    (r"/Users/markking/projects/[a-zA-Z0-9_/-]+", "__WORKING_DIR__"),
    (r"/Users/markking/Projects/[a-zA-Z0-9_-]+", "__WORKING_DIR__"),
    (r"\b7932572505\b", "__TELEGRAM_ADMIN_CHAT_ID__"),
    (r"\bhello@certpilot\.co\.uk\b", "__TEAM_EMAIL__"),
    (r"\bmarkking@niss\.ltd\b", "__ADMIN_EMAIL__"),
    (r"nissltd\.atlassian\.net", "__JIRA_HOST__"),
    (r'"projectKey"\s*:\s*"(CER|EOS|WMS|LEBC|MMD)"', '"projectKey": "__JIRA_PROJECT_KEY__"'),
    (r'"jiraProject"\s*:\s*"(CER|EOS|WMS|LEBC|MMD)"', '"jiraProject": "__JIRA_PROJECT_KEY__"'),
    (r'"boardId"\s*:\s*\d+', '"boardId": 0'),
]


def sanitize_file(path: Path) -> int:
    if not path.is_file():
        print(f"  skip (missing): {path}")
        return 0
    text = path.read_text()
    original = text
    for pattern, repl in REPLACEMENTS:
        text = re.sub(pattern, repl, text)
    if text != original:
        path.write_text(text)
        print(f"  sanitized: {path}")
        return 1
    print(f"  no changes: {path}")
    return 0


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    targets = [
        root / "config.template.json",
        root / "config.docker.template.json",
    ]
    changed = sum(sanitize_file(p) for p in targets)
    print(f"\nDone: {changed}/{len(targets)} updated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
