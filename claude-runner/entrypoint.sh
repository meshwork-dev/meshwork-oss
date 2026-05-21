#!/bin/sh
# Copy .claude.json from the staged mount to the actual location.
# This avoids corruption from the host rewriting the bind-mounted file
# while the container is reading it.
if [ -f /home/node/.claude.json.host ]; then
  cp /home/node/.claude.json.host /home/node/.claude.json
fi

exec "$@"
