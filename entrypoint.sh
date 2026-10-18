#!/bin/sh
set -e

# ==============================================================================
# OpenCode2API Docker Entrypoint
# Boots Cloudflare WARP background service (if available) and launches Node gateway
# ==============================================================================

if command -v warp-svc >/dev/null 2>&1; then
  echo "[Entrypoint] Initializing Cloudflare WARP service..."
  
  # Ensure dbus and warp runtime directories exist
  mkdir -p /var/run/dbus /var/lib/dbus /var/lib/cloudflare-warp
  if [ ! -f /var/lib/dbus/machine-id ]; then
    dbus-uuidgen > /var/lib/dbus/machine-id 2>/dev/null || true
  fi
  
  # Start system D-Bus daemon
  dbus-daemon --system --fork 2>/dev/null || true
  
  # Launch warp-svc background daemon
  warp-svc >/dev/null 2>&1 &
  
  # Asynchronously register and connect WARP in proxy mode on port 40000
  (
    sleep 3
    if command -v warp-cli >/dev/null 2>&1; then
      warp-cli --accept-tos registration new 2>/dev/null || true
      warp-cli --accept-tos mode proxy 2>/dev/null || true
      warp-cli --accept-tos proxy port 40000 2>/dev/null || true
      warp-cli --accept-tos connect 2>/dev/null || true
      echo "[Entrypoint] Cloudflare WARP daemon active in proxy mode on 127.0.0.1:40000"
    fi
  ) &
fi

exec "$@"
