FROM node:24-bookworm

# python3 (hooks), git (Claude Code), curl (healthcheck)
RUN apt-get update && apt-get install -y --no-install-recommends python3 git curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Security scanning tools (gitleaks, trufflehog) - resolve latest versions dynamically
RUN ARCH=$(dpkg --print-architecture) \
    && GL_VER=$(curl -sI https://github.com/gitleaks/gitleaks/releases/latest | grep -i ^location | sed 's|.*/tag/v||;s/\r//') \
    && curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v${GL_VER}/gitleaks_${GL_VER}_linux_${ARCH}.tar.gz" \
       | tar xzf - -C /usr/local/bin gitleaks \
    && TH_VER=$(curl -sI https://github.com/trufflesecurity/trufflehog/releases/latest | grep -i ^location | sed 's|.*/tag/v||;s/\r//') \
    && curl -sSfL "https://github.com/trufflesecurity/trufflehog/releases/download/v${TH_VER}/trufflehog_${TH_VER}_linux_${ARCH}.tar.gz" \
       | tar xzf - -C /usr/local/bin trufflehog

RUN corepack enable && corepack prepare pnpm@9.14.4 --activate \
    && npm install -g @anthropic-ai/claude-code@2.1.121 @qwen-code/qwen-code attio-mcp @leonardsellem/n8n-mcp-server @playwright/mcp snyk \
    && npx playwright install chromium --with-deps

RUN apt-get update && apt-get install -y --no-install-recommends python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages mcp-server-fetch

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY runner.js db.js issue-tracker.js migrate-state-to-postgres.js ./
COPY config.docker.json ./config.json
COPY qwen-settings.docker.json /tmp/qwen-settings.json
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

COPY runner-mcp/package.json runner-mcp/package-lock.json* ./runner-mcp/
RUN cd runner-mcp && npm ci --omit=dev
COPY runner-mcp/index.js ./runner-mcp/

# Run as non-root (claude refuses --dangerously-skip-permissions as root)
RUN mkdir -p /data/logs /home/node/.claude /home/node/.qwen \
    && chown -R node:node /app /data/logs /home/node/.claude /home/node/.qwen
USER node

EXPOSE 3210

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3210/health || exit 1

STOPSIGNAL SIGTERM

ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "runner.js"]
