FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Install client dependencies and build React 19 dashboard
COPY client/package*.json ./client/
RUN cd client && npm install
COPY client/ ./client/
RUN cd client && npm run build

# Production runtime stage (automatically managed proxy egress; no tunnel sidecar)
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive

# Minimal runtime: curl for healthchecks and CA roots for HTTPS proxies/upstreams.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# The official inference gate rejects Node's TLS fingerprint. The gateway
# reuses the Bun runtime embedded in the OpenCode CLI for that one upstream
# hop, so the runtime image ships the CLI at a pinned version.
ARG OPENCODE_CLI_VERSION=2.1.4
RUN npm install -g --no-audit --no-fund "@opencode/cli@${OPENCODE_CLI_VERSION}" \
    && npm cache clean --force

COPY package*.json ./
COPY server/ ./server/
COPY --from=builder /app/dist ./dist
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /app/data

EXPOSE 8080

VOLUME ["/app/data"]

# Liveness only: the image must stay healthy even when all proxies are unavailable.
# docker-compose overrides this with /readyz for deployment readiness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["npm", "start"]
