#!/usr/bin/env python3
"""Stop hook: Post completion notification to callback URL.

When CERTPILOT_CALLBACK_URL is set (for interactive sessions outside the runner),
posts a completion notification. The runner handles its own callbacks, so this
hook is a no-op when invoked from runner-managed sessions.
"""

import json
import os
import sys
import urllib.request
import urllib.error


def main():
    try:
        input_data = json.load(sys.stdin)
        callback_url = os.environ.get("CERTPILOT_CALLBACK_URL")

        if not callback_url:
            # No callback configured - runner handles its own callbacks
            print(json.dumps({}))
            sys.exit(0)

        stop_reason = input_data.get("stop_hook_reason", "unknown")
        session_id = os.environ.get("CLAUDE_SESSION_ID", "unknown")

        payload = json.dumps({
            "source": "certpilot-plugin-stop-hook",
            "sessionId": session_id,
            "stopReason": stop_reason,
        }).encode("utf-8")

        secret = os.environ.get("CERTPILOT_CALLBACK_SECRET", "")
        headers = {
            "Content-Type": "application/json",
        }
        if secret:
            headers["x-callback-secret"] = secret

        req = urllib.request.Request(callback_url, data=payload, headers=headers, method="POST")
        try:
            urllib.request.urlopen(req, timeout=5)
        except urllib.error.URLError:
            # Best effort - don't fail the session over a callback issue
            pass

        print(json.dumps({}))

    except Exception as e:
        print(json.dumps({"systemMessage": f"CertPilot on_stop warning: {e}"}))

    sys.exit(0)


if __name__ == "__main__":
    main()
