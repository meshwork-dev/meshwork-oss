#!/usr/bin/env python3
"""PreToolUse hook: Block file writes outside the project directory.

Prevents agents from writing to files outside CLAUDE_PROJECT_DIR or the
current working directory. This ensures agents stay within their sandbox.
"""

import json
import os
import sys


def main():
    try:
        input_data = json.load(sys.stdin)
        file_path = input_data.get("tool_input", {}).get("file_path", "")

        if not file_path:
            print(json.dumps({}))
            sys.exit(0)

        # Resolve to absolute path
        abs_path = os.path.realpath(os.path.expanduser(file_path))

        # Get project root from env or cwd
        project_dir = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
        abs_project = os.path.realpath(os.path.expanduser(project_dir))

        # Allow writes within project directory
        if abs_path.startswith(abs_project + os.sep) or abs_path == abs_project:
            print(json.dumps({}))
            sys.exit(0)

        # Also allow writes to /tmp for temporary files
        if abs_path.startswith("/tmp/") or abs_path.startswith("/var/tmp/"):
            print(json.dumps({}))
            sys.exit(0)

        # Block everything else
        result = {
            "decision": "block",
            "reason": f"CertPilot safety hook: Write blocked - '{file_path}' is outside project directory '{project_dir}'"
        }
        print(json.dumps(result))

    except Exception as e:
        print(json.dumps({"systemMessage": f"CertPilot guard_paths warning: {e}"}))

    sys.exit(0)


if __name__ == "__main__":
    main()
