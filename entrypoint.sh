#!/bin/sh
set -e

# ==============================================================================
# OpenCode2API Docker Entrypoint
#
# Egress is zero-config. The gateway discovers public HTTP/HTTPS/SOCKS5
# candidates, verifies each with five TLS probes, and keeps only healthy routes.
# Manual PROXIES entries are optional and take precedence.
# ==============================================================================

mkdir -p /app/data

exec "$@"
