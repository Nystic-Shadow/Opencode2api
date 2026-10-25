#!/bin/sh
set -e

# ==============================================================================
# OpenCode2API Docker Entrypoint
#
# WARP is owned by exactly one process:
#   - WARP_ENGINE=sidecar  -> the compose `warp` service owns the tunnel
#   - WARP_ENGINE=embedded -> this container's Node process owns wireproxy
#
# The entrypoint therefore does not start, kill, or reconfigure WARP engines.
# Doing so would race the gateway and can leave a stale process on the SOCKS
# port after a container restart.
# ==============================================================================

mkdir -p /app/data

exec "$@"
