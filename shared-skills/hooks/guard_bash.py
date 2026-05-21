#!/usr/bin/env python3
"""PreToolUse hook: Block dangerous Bash commands.

Blocks destructive commands like rm -rf /, sudo, npm publish, force push,
and SQL drop table statements. Allows all other commands to proceed.
"""

import json
import re
import sys


DANGEROUS_PATTERNS = [
    r"rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?/(?!\w)",  # rm -rf / (but not /Users/... etc)
    r"\bsudo\b",
    r"\bnpm\s+publish\b",
    r"\bgit\s+push\s+.*--force(?!-with-lease)\b",
    r"\bgit\s+push\s+-f\b",
    r"\bdrop\s+(table|database|schema)\b",
    r"\bdocker\s+(rm|rmi)\s+-f\b",
    r"\bmkfs\b",
    r"\bdd\s+.*of=/dev/",
    r"\b:(){ :\|:& };:",  # fork bomb
]


def main():
    try:
        input_data = json.load(sys.stdin)
        command = input_data.get("tool_input", {}).get("command", "")

        for pattern in DANGEROUS_PATTERNS:
            if re.search(pattern, command, re.IGNORECASE):
                result = {
                    "decision": "block",
                    "reason": f"OrchestraCode safety hook: Blocked potentially dangerous command matching pattern '{pattern}'"
                }
                print(json.dumps(result))
                sys.exit(0)

        # Allow the command
        print(json.dumps({}))

    except Exception as e:
        # On error, allow the operation - don't block work due to hook failure
        print(json.dumps({"systemMessage": f"OrchestraCode guard_bash warning: {e}"}))

    sys.exit(0)


if __name__ == "__main__":
    main()
