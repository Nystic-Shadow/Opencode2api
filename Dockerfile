FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Install client dependencies and build React 19 dashboard
COPY client/package*.json ./client/
RUN cd client && npm install
COPY client/ ./client/
RUN cd client && npm run build

# Production runtime stage (proxy-only egress; no tunnel sidecar)
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
