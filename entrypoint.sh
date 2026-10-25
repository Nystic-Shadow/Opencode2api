#!/bin/sh
set -e

# ==============================================================================
# OpenCode2API Docker Entrypoint (proxy-only)
#
# The gateway owns no tunnel in the default deployment. Egress is provided by
# the explicit HTTP/HTTPS/SOCKS5 proxies configured in PROXIES.
# ==============================================================================

mkdir -p /app/data

exec "$@"
