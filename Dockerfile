FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Install client dependencies and build React 19 dashboard
COPY client/package*.json ./client/
RUN cd client && npm install
COPY client/ ./client/
RUN cd client && npm run build

# Production runtime stage with integrated Cloudflare WARP client
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies, D-Bus, iptables, and Cloudflare WARP official client
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    lsb-release \
    dbus \
    iptables \
    procps \
    ca-certificates \
    && mkdir -p /usr/share/keyrings \
    && curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ bookworm main" > /etc/apt/sources.list.d/cloudflare-client.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends cloudflare-warp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY server/ ./server/
COPY scripts/ ./scripts/
COPY --from=builder /app/dist ./dist
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh scripts/*.sh && mkdir -p /app/data /var/lib/cloudflare-warp /var/run/dbus

EXPOSE 8080

VOLUME ["/app/data"]

ENTRYPOINT ["/entrypoint.sh"]
CMD ["npm", "start"]
