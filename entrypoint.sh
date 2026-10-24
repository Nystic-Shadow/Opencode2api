#!/bin/sh
set -e

# ==============================================================================
# OpenCode2API Docker Entrypoint
# Ensures persistent directories exist and boots Node.js gateway
# Userspace Cloudflare WARP engine is managed dynamically by Node.js
# ==============================================================================

mkdir -p /app/data

# Terminate any leftover wireproxy processes from previous runs to ensure clean ports
pkill -9 -f wireproxy 2>/dev/null || true

# If legacy warp-svc is present on the host/system, start dbus and warp-svc
if command -v warp-svc >/dev/null 2>&1; then
  mkdir -p /var/run/dbus /var/lib/dbus /var/lib/cloudflare-warp
  if [ ! -f /var/lib/dbus/machine-id ]; then
    dbus-uuidgen > /var/lib/dbus/machine-id 2>/dev/null || true
  fi
  dbus-daemon --system --fork 2>/dev/null || true
  warp-svc >/dev/null 2>&1 &
fi

exec "$@"
