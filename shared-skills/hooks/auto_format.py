#!/usr/bin/env python3
"""PostToolUse hook: Auto-format files after Write/Edit.

Runs prettier on supported file types (.ts, .tsx, .js, .jsx, .css, .json)
after they are written or edited. Non-blocking - formatting failures are
logged but do not prevent the operation.
"""

import json
import os
import subprocess
import sys


FORMATTABLE_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".css", ".scss", ".less",
    ".json",
    ".html", ".vue", ".svelte",
    ".yaml", ".yml",
}


def main():
    try:
        input_data = json.load(sys.stdin)
        file_path = input_data.get("tool_input", {}).get("file_path", "")

        if not file_path or not os.path.isfile(file_path):
            print(json.dumps({}))
            sys.exit(0)

        _, ext = os.path.splitext(file_path)
        if ext.lower() not in FORMATTABLE_EXTENSIONS:
            print(json.dumps({}))
            sys.exit(0)

        # Run prettier - best effort, don't block on failure
        try:
            subprocess.run(
                ["npx", "prettier", "--write", file_path],
                capture_output=True,
                timeout=20,
                cwd=os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd()),
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            # prettier not available or timed out - that's fine
            pass

        print(json.dumps({}))

    except Exception as e:
        print(json.dumps({"systemMessage": f"CertPilot auto_format warning: {e}"}))

    sys.exit(0)


if __name__ == "__main__":
    main()
