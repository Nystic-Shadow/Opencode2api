<div align="center">

![OpenCode2API Banner](docs/banner.svg)

# ⚡ OpenCode2API

### OpenAI + Anthropic compatible gateway for OpenCode Zen models

> **Stable, observable egress through Cloudflare WARP or your own proxies. No IP rotation to evade upstream quotas.**

[![Node.js](https://img.shields.io/badge/Node.js-20-339933.svg?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker Compose](https://img.shields.io/badge/Docker_Compose-Ready-2496ED.svg?style=for-the-badge&logo=docker&logoColor=white)](docker-compose.yml)
[![Cloudflare WARP](https://img.shields.io/badge/Egress-Cloudflare_WARP-F38020.svg?style=for-the-badge&logo=cloudflare&logoColor=white)](https://1.1.1.1/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge&logo=opensourceinitiative&logoColor=white)](LICENSE)

</div>

---

## What this is

OpenCode2API exposes OpenCode Zen models through standard **OpenAI** and **Anthropic** APIs. It adds authentication, model discovery, tool/function calling, vision, reasoning streams, bounded concurrency, and health-checked egress through Cloudflare WARP or user-owned proxies.

It is designed for **stable operation**, not for defeating provider limits. Free-tier capacity is controlled upstream. The gateway therefore:

- fails fast on upstream quota (`429`) with a real `Retry-After`,
- never rotates WARP keys or switches IPs to evade `401`/`429`,
- never scrapes public proxy lists in the request path,
- only fails over between routes on network errors and `5xx` responses,
- exposes `/readyz` so a scheduler or load balancer can stop sending traffic when no route or model is available.

> **There is no 99% or 100% availability guarantee.** If the upstream free tier is exhausted, the gateway returns `429`; it does not manufacture capacity. For predictable capacity, use an upstream Zen key or a provider you are authorized to use.

---

## Features

### API compatibility

- **OpenAI:** `/v1/chat/completions` (streaming and non-streaming), `/v1/models`, `/v1/models/:model`
- **Anthropic:** `/v1/messages` (text, thinking blocks, `tool_use`, images)
- SSE streaming with `X-Accel-Buffering: no` and TCP `setNoDelay(true)`
- OpenAI `tools` / `tool_choice` and Anthropic tool-use translation
- Vision via OpenAI `image_url` data URIs and Anthropic `image` blocks
- Reasoning traces as OpenAI `reasoning_content` and Anthropic `thinking_delta`

### Upstream compatibility

- Injects the core CLI tool schemas the upstream expects while preserving client-defined tools
- Mints canonical descending `ses_...` session identifiers
- Discovers models from OpenCode Zen every 10 minutes and strips `-free` / `_free` suffixes
- Supports an upstream Zen key for paid models (`OPENCODE_ZEN_KEY`)

### Egress and reliability

- **Cloudflare WARP** in four explicit modes: `sidecar`, `embedded`, `cli`, `disabled`
- **User-owned proxies:** HTTP, HTTPS, and SOCKS5 with optional authentication
- Deterministic route order: **WARP → user proxies → direct (only if allowed)**
- Route health tracking, circuit breaking on repeated network/`5xx` failures, and route failover
- Provider-quota cooldown that fails fast with `429` + `Retry-After` while keeping the route ready
- Bounded global/per-key admission queue, request deadline, and capped retries
- `/healthz` liveness and `/readyz` readiness endpoints
- Docker Compose sidecar deployment with direct fallback disabled by default

### Control plane

- React dashboard with live telemetry, playground, model catalog, and API-key management
- Scoped `O2P-` API keys with RPM/TPM limits, token budgets, model whitelists, and expiry
- Cryptographically random master key and admin password on first run
- No hardcoded `O2P-master-key` or `admin123` backdoors

---

## Reliability model

```text
client request
    │
    ▼
API key auth ──► 401 on invalid/expired key
    │
    ▼
quota cooldown? ──► 429 + Retry-After (no IP rotation)
    │
    ▼
admission queue ──► 429 queue_full + Retry-After when saturated
    │
    ▼
select egress route: WARP → user proxies → direct (if allowed)
    │
    ▼
upstream request with timeout and overall deadline
    │
    ├── 2xx ──► stream/non-stream response (slot held until close)
    ├── 429 / quota 403 ──► 429 + Retry-After (fail fast)
    ├── network / 5xx ──► next route or retry, then 502/504
    └── fatal 4xx ──► return the upstream error
```

Key properties:

| Behavior | Implementation |
| :--- | :--- |
| Retry budget | `MAX_RETRIES=2` by default, hard-capped at `3` |
| Request timeout | `30s` per attempt by default |
| Overall deadline | `90s` by default |
| Queue | `8` concurrent globally, `4` per key, `100` waiting, `15s` wait |
| Stream admission | Slot held for the full response, not released when headers arrive |
| Quota | `429` with `Retry-After`; route remains in `/readyz` |
| Route failover | Network errors and `5xx` only |
| Direct egress | Disabled by compose (`ALLOW_DIRECT_FALLBACK=false`) |

---

## Requirements

- **Node.js 20+** for local runs (the Docker image uses `node:20-bookworm-slim`)
- **Docker + Docker Compose v2** for the recommended deployment
- **Cloudflare WARP sidecar** (provided by the compose file) or your own SOCKS5/HTTP proxies
- Linux host for the WARP sidecar (`NET_ADMIN` capability is required)

---

## Quickstart: Docker Compose (recommended)

### 1. Configure secrets

```bash
cp .env.example .env
```

Edit `.env` and set a strong dashboard password:

```dotenv
DASHBOARD_USER=admin
DASHBOARD_PASS=replace-with-a-long-random-password
```

Generate one with:

```bash
openssl rand -base64 24
```

`DASHBOARD_PASS` is required by `docker-compose.yml`. Known defaults such as `admin123` and passwords shorter than 12 characters are ignored; the gateway generates a random password and writes it to `data/admin-password.txt`.

### 2. Optional: add your own proxies

```dotenv
PROXIES=socks5://user:pass@proxy.example:1080,http://proxy.example:8080
```

Proxies are used after WARP and before direct egress. They are never scraped from public lists.

### 3. Start

```bash
docker compose up -d --build
docker compose ps
```

The stack contains:

- `gateway` — the Node.js API gateway on port `8080`
- `warp` — `caomingjun/warp`, providing a SOCKS5 endpoint at `warp:1080`

The gateway binds HTTP immediately. WARP and model discovery run in the background, so a slow sidecar cannot make the container fail its liveness probe.

### 4. Verify

```bash
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
```

`/readyz` returns `503` until at least one egress route and one model are available. It returns `200` when the gateway is ready to serve inference.

If it stays `503`:

```bash
docker compose logs -f warp
docker compose logs -f gateway
```

Check that the sidecar answers SOCKS5 on `warp:1080` and that the gateway can reach `https://opencode.ai`.

### 5. Read the generated credentials

```bash
cat data/admin-password.txt
cat data/keys.json
```

- `data/admin-password.txt` — generated dashboard password (only when no strong `DASHBOARD_PASS` is configured)
- `data/keys.json` — master API key (`O2P-...`)

Keep the `data/` directory private. It contains credentials and runtime state.

---

## Local Node.js

```bash
npm install --prefix client
npm run build

# Linux/macOS
DASHBOARD_PASS='replace-with-a-long-random-password' npm start

# PowerShell
$env:DASHBOARD_PASS='replace-with-a-long-random-password'; npm start
```

Open <http://127.0.0.1:8080/>. The API base URL is `http://127.0.0.1:8080/v1`.

For anonymous egress locally, use one of:

- **Embedded WARP:** install `wireproxy` and set `WARP_ENGINE=embedded` (the Docker image ships it; a local Windows build can use `wireproxy.exe` in the repository root).
- **WARP CLI:** install Cloudflare WARP and set `WARP_ENGINE=cli`.
- **Sidecar:** run a SOCKS5 WARP container and set `WARP_ENGINE=sidecar`, `WARP_HOST`, `WARP_PORT`.
- **Your proxy:** set `PROXIES=...`.

If you intentionally want direct egress for local development, set `WARP_ENGINE=disabled` and `ALLOW_DIRECT_FALLBACK=true`. This exposes your host IP to the upstream and is not anonymous.

---

## WARP engine modes

`WARP_ENGINE` controls who owns the tunnel:

| Mode | Behavior | Use when |
| :--- | :--- | :--- |
| `sidecar` | The gateway only talks to an external SOCKS5 endpoint. It never spawns `wireproxy`. | Docker Compose, or a separate WARP container |
| `embedded` | The gateway spawns and supervises `wireproxy` on loopback ports `40000–40003`. | Local Linux/Windows with `wireproxy` installed |
| `cli` | The gateway configures and uses the official `warp-cli` proxy mode. | Host with Cloudflare WARP installed |
| `disabled` | No WARP transport. | Direct or user-proxy-only deployments |
| `auto` | `sidecar` for a non-loopback `WARP_HOST`; otherwise `embedded` if `wireproxy` exists, then `cli`, then `sidecar`. | Default |

Aliases: `external`, `proxy`, and `socks5` map to `sidecar`; `wireproxy` maps to `embedded`; `warp-cli` maps to `cli`; `off` and `none` map to `disabled`.

### Rotation policy

- `WARP_AUTO_ROTATE_MINUTES=0` by default: no periodic key churn.
- `warp_rotate_on_unauth` and `warp_rotate_on_rate_limit` are forced to `false`.
- In `sidecar` mode, key rotation belongs to the sidecar. Restart the sidecar if you intentionally need a new WARP identity.
- The gateway does **not** rotate IPs to evade quotas or anti-bot controls.

---

## Egress modes

| `EGRESS_MODE` | Route order |
| :--- | :--- |
| `auto` / `hybrid` (default) | WARP → user proxies → direct only if `ALLOW_DIRECT_FALLBACK=true` |
| `warp_only` | WARP only |
| `proxy_only` | User proxies only |
| `direct` | Direct only (not anonymous) |

`ALLOW_DIRECT_FALLBACK`:

- `false` — never use direct egress. Recommended for anonymous deployments.
- `true` — allow direct egress as the last route.
- unset — direct is allowed only when no proxy is configured and `WARP_MODE` is not `always`.

`WARP_MODE`:

- `always` — keep WARP enabled and prevent implicit direct fallback.
- `disabled` / `never` — disable WARP.
- `auto` — default.

Compose sets `WARP_ENGINE=sidecar`, `WARP_MODE=always`, and `ALLOW_DIRECT_FALLBACK=false`.

---

## Environment variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8080` | HTTP port |
| `DASHBOARD_USER` | `admin` | Dashboard username |
| `DASHBOARD_PASS` | generated | Dashboard password; 12+ characters, required by compose |
| `OPENCODE_ZEN_KEY` | empty | Upstream Zen key for paid models |
| `UPSTREAM_INFERENCE_URL` | OpenCode Zen URL | Override the upstream chat endpoint (local testing or compatible mirrors; plain HTTP requires direct egress) |
| `PROXIES` | empty | Comma-separated `http://`, `https://`, or `socks5://` proxies |
| `WARP_ENGINE` | `auto` | `auto`, `sidecar`, `embedded`, `cli`, `disabled` |
| `WARP_MODE` | `auto` | `auto`, `always`, `disabled`/`never` |
| `WARP_HOST` | `127.0.0.1` | WARP SOCKS5 host |
| `WARP_PORT` | `40000` | WARP SOCKS5 port (compose uses `1080`) |
| `WARP_AUTO_ROTATE_MINUTES` | `0` | Periodic key rotation; `0` disables it |
| `EGRESS_MODE` | `auto` | `auto`, `warp_only`, `proxy_only`, `direct` |
| `ALLOW_DIRECT_FALLBACK` | unset | `true`/`false` direct-egress policy |
| `MAX_RETRIES` | `2` | Retries per request, capped at `3` |
| `REQUEST_TIMEOUT_MS` | `30000` | Per-attempt timeout |
| `REQUEST_DEADLINE_MS` | `90000` | Overall request deadline |
| `QUEUE_MAX_CONCURRENT` | `8` | Global concurrent upstream requests |
| `QUEUE_MAX_PER_KEY` | `4` | Concurrent upstream requests per API key |
| `QUEUE_MAX_SIZE` | `100` | Maximum queued requests |
| `QUEUE_WAIT_MS` | `15000` | Maximum queue wait before `429` |
| `PROXY_SCRAPER_ENABLED` | `false` | Diagnostics only; never used for request egress |

Explicit environment variables override cached values in `data/config.json`. `data/config.json` is rewritten on startup with normalized defaults.

---

## Authentication

Send the master key from `data/keys.json`, or a scoped key created in the dashboard:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer O2P-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4.1-flash",
    "stream": true,
    "messages": [{"role": "user", "content": "Explain quantum superposition in two sentences."}]
  }'
```

Anthropic clients can use either header:

```bash
curl http://127.0.0.1:8080/v1/messages \
  -H "x-api-key: O2P-your-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4.1-flash",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

The old `O2P-master-key` and `sk-opencode-free-master` defaults are rejected with `401`.

To choose the master key on a fresh deployment, set `INITIAL_KEY` or `MASTER_KEY` before the first start. Otherwise a random `O2P-...` key is generated and stored in `data/keys.json`.

---

## Client configuration

Use clean model IDs such as `deepseek-v4.1-flash`, `nemotron-3.5-super-vl`, or `beam`.

### Cursor / Continue (OpenAI mode)

- **Base URL:** `http://127.0.0.1:8080/v1`
- **API Key:** master key from `data/keys.json`, or a scoped key
- **Model:** any ID from `/v1/models`

### Cline / Roo Code (Anthropic mode)

- **API Provider:** Anthropic compatible
- **Base URL:** `http://127.0.0.1:8080`
- **API Key:** master key or scoped key
- **Model ID:** any ID from `/v1/models`

For a remote deployment, put the gateway behind HTTPS (reverse proxy, tunnel, or load balancer) and never expose the dashboard over plain HTTP to the public internet.

---

## Health and readiness

### `GET /healthz` — liveness

Always `200` while the Node process is alive. Used by the image `HEALTHCHECK`.

```json
{
  "status": "ok",
  "service": "OpenCode2API",
  "uptime_seconds": 42,
  "models_count": 8,
  "egress_ready": true,
  "warp_ready": true
}
```

### `GET /readyz` — readiness

`200` only when at least one egress route and one model are available; otherwise `503`.

```json
{
  "status": "ready",
  "models_count": 8,
  "warp": { "engine": "sidecar", "ready": true, "host": "warp", "port": 1080 },
  "egress": {
    "mode": "auto",
    "ready_routes": [{ "id": "warp:1080", "type": "warp" }],
    "proxies_configured": 0,
    "allow_direct": false
  },
  "queue": { "active": 0, "queued": 0, "limits": { "maxConcurrent": 8, "maxPerKey": 4, "maxQueue": 100, "maxWaitMs": 15000 } }
}
```

Compose uses `/readyz` for its healthcheck. The Docker image itself uses `/healthz` so a temporary WARP outage does not restart a healthy process.

---

## Error semantics

| Status | Type | Meaning |
| :--- | :--- | :--- |
| `401` | authentication | Missing/invalid API key, expired key, or paid model without a Zen key |
| `429` | `free_tier_rate_limit` | Upstream quota/capacity; honor `Retry-After` |
| `429` | `queue_full` | Gateway concurrency limit; retry shortly |
| `502` | upstream/stream | Upstream connection or stream failed |
| `503` | `no_egress_route` | WARP/proxy not ready and direct fallback disabled |
| `504` | deadline | Overall request deadline exceeded |

The gateway does not retry `429` on another IP. It returns the limit to the caller so clients can back off honestly.

---

## Testing and verification

```bash
npm test                 # security + reliability suites
npm run build            # build the React dashboard
docker compose config    # validate compose interpolation
node --check server/proxy.js
```

The reliability suite covers proxy parsing, SOCKS5 response parsing, retry classification, quota cooldown, route ordering, admission queue limits, and WARP engine selection. It does not require network access.

A live smoke test after deployment:

```bash
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $(node -e "console.log(require('./data/keys.json')[0].key)")" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","stream":false,"messages":[{"role":"user","content":"Reply with OK."}]}'
```

Verify WARP egress from the sidecar:

```bash
docker compose exec warp curl -s https://cloudflare.com/cdn-cgi/trace | grep -E 'ip=|warp='
```

---

## Operations

### Data directory

`data/` is mounted as a volume and contains:

- `config.json` — normalized runtime configuration
- `keys.json` — API keys (master key included)
- `admin-password.txt` — generated dashboard password
- `warp_account.json`, `warp_pool.json`, `wireproxy_*.conf` — embedded WARP state (when used)

Back up `keys.json` and `config.json`. Treat the whole directory as a secret.

### Change the dashboard password

Set a strong `DASHBOARD_PASS` in `.env` and restart:

```bash
docker compose up -d --force-recreate gateway
```

Passwords shorter than 12 characters and known defaults are ignored.

### Change the master API key

Create a new scoped key in the dashboard, or edit `data/keys.json` while the gateway is stopped. Restart afterwards.

### Proxy failover

Routes are tried in order. A network error or `5xx` marks the route unhealthy after repeated failures; `429` marks a quota cooldown but keeps the route ready. There is no background public-proxy scanner in the request path.

### Docker resilience

- `restart: unless-stopped` on both services
- `depends_on` for startup order, with `/readyz` as the real readiness gate
- Persistent `data/` and `warp-data/` volumes
- Sidecar restart does not require recreating the gateway

---

## Limitations and security notes

- **Free-tier capacity is upstream-controlled.** No gateway can guarantee 99% availability without authorized upstream capacity.
- **Anonymity depends on your egress.** With `ALLOW_DIRECT_FALLBACK=false`, the gateway will return `503` rather than silently leak the host IP.
- **WARP sidecar image is not pinned.** `caomingjun/warp:latest` can change. Pin a digest or version for reproducible deployments.
- **Do not expose the dashboard without TLS and strong credentials.** Use a reverse proxy, firewall, or private network.
- **Respect upstream terms and applicable law.** This project is not affiliated with OpenCode, Anthropic, OpenAI, or Cloudflare.
- **No warranty.** See the MIT license.

---

## License

This project is open-source software licensed under the [MIT License](LICENSE).
