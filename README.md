<div align="center">

![OpenCode2API Banner](docs/banner.svg)

# ⚡ OpenCode2API

### OpenAI + Anthropic compatible gateway for OpenCode Zen models

> **Proxy-only egress: explicit HTTP, HTTPS, or SOCKS5 proxies with strict health checks and round-robin quota failover. No public proxy scraping.**

[![Node.js](https://img.shields.io/badge/Node.js-20-339933.svg?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker Compose](https://img.shields.io/badge/Docker_Compose-Ready-2496ED.svg?style=for-the-badge&logo=docker&logoColor=white)](docker-compose.yml)
[![Proxy Egress](https://img.shields.io/badge/Egress-Explicit_Proxies-2496ED.svg?style=for-the-badge)](https://github.com/Nystic-Shadow/Opencode2api)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge&logo=opensourceinitiative&logoColor=white)](LICENSE)

</div>

---

## What this is

OpenCode2API exposes OpenCode Zen models through standard **OpenAI** and **Anthropic** APIs. It adds authentication, model discovery, tool/function calling, vision, reasoning streams, bounded concurrency, and health-checked egress through explicit user-owned proxies.

It is designed for **maximum best-effort availability** within upstream limits. Free-tier capacity is controlled upstream. The gateway therefore:

- spreads requests round-robin across the healthy proxies you configure,
- rechecks the full pool in the background every 30 minutes by default, even while idle,
- cools a proxy briefly when it returns `429`, then tries the next routable proxy (bounded by `PROXY_QUOTA_FAILOVERS`),
- rotates the anonymous session identity on retries so a per-session limit does not pin one request forever,
- never scrapes public proxy lists,
- fails over immediately when a proxy tunnel dies and keeps dead routes out of rotation until a later sweep passes,
- auto-removes proxies after two consecutive failed sweeps (configurable, never the last entry),
- exposes `/readyz` so a scheduler or load balancer can stop sending traffic when no route or model is available.

> **Best effort, not a capacity guarantee.** Proxies change the egress IP; they cannot manufacture upstream quota. If OpenCode meters the free tier per account/key rather than per IP (or the limit applies globally), every proxy can still receive `429`. In that case the gateway returns `429` with the earliest real `Retry-After` after exhausting the pool. For predictable capacity, use an upstream Zen key or a provider you are authorized to use.

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

- **Explicit proxy pool:** HTTP, HTTPS, and SOCKS5 with optional authentication
- Maximum 100 configured proxies; no public proxy scraping or ambient proxy fallback
- Credential-only variants on the same host:port are treated as distinct routes
- Five consecutive health checks per proxy, each with a 5-second timeout
- Full-pool rechecks every 30 minutes by default (`PROXY_CHECK_INTERVAL_MINUTES`, `1–1440`)
- Failed proxies leave rotation until a later sweep passes; two failed sweeps auto-remove them (`PROXY_AUTO_PRUNE_DEAD`, never the last entry)
- Immediate route quarantine on a broken proxy tunnel, with exponential backoff
- Round-robin selection across healthy proxies, weighted toward verified endpoints
- Quota-aware failover: a `429` cools that proxy and retries the next routable one before returning a limit
- Route health tracking and circuit breaking on repeated network/`5xx` failures
- Bounded global/per-key admission queue, request deadline, and capped retries
- `/healthz` liveness and `/readyz` readiness endpoints
- Proxy-only Compose deployment with direct fallback disabled by default

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
quota cooldown? ──► skip cooling routes, pick next healthy proxy
    │
    ▼
admission queue ──► 429 queue_full + Retry-After when saturated
    │
    ▼
select egress route: round-robin over healthy explicit proxies; direct only if allowed
    │
    ▼
upstream request with timeout and overall deadline
    │
    ├── 2xx ──► stream/non-stream response (slot held until close)
    ├── 429 / quota 403 ──► cool route, try next routable proxy (bounded), else 429
    ├── network / 5xx ──► next route or retry, then 502/504
    └── fatal 4xx ──► return the upstream error
```

Key properties:

| Behavior | Implementation |
| :--- | :--- |
| Retry budget | `MAX_RETRIES=2` by default, hard-capped at `3` |
| Quota failover budget | `PROXY_QUOTA_FAILOVERS=10` by default, bounded `0–20` |
| Background recheck | Full pool every `30` minutes by default (`PROXY_CHECK_INTERVAL_MINUTES`, `1–1440`) |
| Failed sweep | Route stays out of rotation until a later 5x sweep passes |
| Dead-entry pruning | After two failed sweeps when `PROXY_AUTO_PRUNE_DEAD=true`; the last entry is kept |
| Request timeout | `30s` per attempt by default |
| Overall deadline | `90s` by default |
| Queue | `8` concurrent globally, `4` per key, `100` waiting, `15s` wait |
| Stream admission | Slot held for the full response, not released when headers arrive |
| Quota | Cooling route is skipped; next routable proxy is tried; `429` only after the pool is exhausted |
| Route failover | Round-robin for routing; network errors and `5xx` rotate to the next route |
| Direct egress | Disabled by compose (`ALLOW_DIRECT_FALLBACK=false`) |

---

## Requirements

- **Node.js 20+** for local runs (the Docker image uses `node:20-bookworm-slim`)
- **Docker + Docker Compose v2** for the recommended deployment
- **One or more explicit HTTP, HTTPS, or SOCKS5 proxies** for inference egress. The dashboard shows `0 / 0` and `Not configured` until you add them; nothing is scraped automatically.
- No tunnel sidecar or `NET_ADMIN` capability is required in proxy-only mode

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

### 2. Configure proxies (required)

```dotenv
PROXIES=socks5://user:pass@proxy.example:1080,http://user:pass@proxy-b.example:8080
```

Only explicitly configured proxies are used for inference egress. Public proxy lists are never scraped, ambient `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` variables are ignored, and direct fallback is disabled by Compose. Up to 100 proxies are accepted; each proxy must pass five consecutive health checks with a 5-second timeout. Entries may share the same host and port when different credentials select different egress IPs; they are tracked as separate routes.

The full pool is rechecked in the background every 30 minutes by default, even when there is no traffic. A route that fails a sweep stays out of rotation until a later sweep passes; after two consecutive failed sweeps it is removed automatically when `PROXY_AUTO_PRUNE_DEAD=true`, unless it is the only entry left. You can also remove failed entries immediately from Settings or with `POST /api/proxies/prune`. Pruning updates the saved pool; entries supplied through the `PROXIES` environment variable return on the next restart because environment configuration is authoritative.

Healthy proxies are used round-robin. If a proxy tunnel dies between requests, the gateway marks that route down immediately, continues the request on another routable proxy, and backs the failed route off exponentially. When a route returns upstream quota, the gateway cools it and retries the next routable proxy up to `PROXY_QUOTA_FAILOVERS` times before returning `429` with the earliest retry hint. This is best effort: if quota is tied to the account/key rather than the proxy IP, the whole pool can still be limited.

### 3. Start

```bash
docker compose up -d --build
docker compose ps
```

The stack contains:

- `gateway` — the Node.js API gateway on port `8080`

The gateway binds HTTP immediately; model discovery and proxy health checks run in the background.

### 4. Verify

```bash
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
```

`/readyz` returns `503` until at least one egress route and one model are available. It returns `200` when the gateway is ready to serve inference.

If it stays `503`:

```bash
docker compose logs -f gateway
```

Check that at least one configured proxy is healthy and that the gateway can reach `https://opencode.ai`. A proxy that fails a 5x sweep stays out of rotation until a later sweep passes; two consecutive failed sweeps auto-remove it unless it is the last entry. With an empty pool, the dashboard shows `0 / 0` and `Not configured` — add explicit proxy URLs in Settings or `.env`.

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

For anonymous egress locally, use an explicit proxy:

- **Your proxy (recommended):** set `PROXIES=...` and `EGRESS_MODE=proxy_only`.

If you intentionally want direct egress for local development, set `ALLOW_DIRECT_FALLBACK=true`. This exposes your host IP to the upstream and is not anonymous.

---

## Egress modes

| `EGRESS_MODE` | Route order |
| :--- | :--- |
| `auto` | Explicit proxies → direct only if `ALLOW_DIRECT_FALLBACK=true` |
| `proxy_only` (Compose default) | Explicit user proxies only |
| `direct` | Direct only (not anonymous) |

`ALLOW_DIRECT_FALLBACK`:

- `false` (default) — never use direct egress. Recommended for anonymous deployments.
- `true` — allow direct egress as the last route. This leaks the host IP and is not anonymous.

Compose sets `EGRESS_MODE=proxy_only` and `ALLOW_DIRECT_FALLBACK=false`. `PROXIES` is required.

---

## Environment variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8080` | HTTP port |
| `DASHBOARD_USER` | `admin` | Dashboard username |
| `DASHBOARD_PASS` | generated | Dashboard password; 12+ characters, required by compose |
| `OPENCODE_ZEN_KEY` | empty | Upstream Zen key for paid models |
| `UPSTREAM_INFERENCE_URL` | OpenCode Zen URL | Override the upstream chat endpoint (local testing or compatible mirrors; plain HTTP requires direct egress) |
| `PROXIES` | empty | Comma-separated explicit `http://`, `https://`, or `socks5://` proxies; required by Compose; maximum 100; ambient proxy env vars are ignored |
| `PROXY_QUOTA_FAILOVERS` | `10` | Additional proxies tried after an upstream quota response; bounded `0–20` |
| `PROXY_CHECK_INTERVAL_MINUTES` | `30` | Full-pool background sweep interval in minutes; bounded `1–1440` |
| `PROXY_AUTO_PRUNE_DEAD` | `true` | Remove proxies after two consecutive failed sweeps; the last entry is kept |
| `EGRESS_MODE` | `proxy_only` | `auto`, `proxy_only`, `direct` |
| `ALLOW_DIRECT_FALLBACK` | `false` | `true`/`false` direct-egress policy |
| `MAX_RETRIES` | `2` | Retries per request, capped at `3` |
| `REQUEST_TIMEOUT_MS` | `30000` | Per-attempt timeout |
| `REQUEST_DEADLINE_MS` | `90000` | Overall request deadline |
| `QUEUE_MAX_CONCURRENT` | `8` | Global concurrent upstream requests |
| `QUEUE_MAX_PER_KEY` | `4` | Concurrent upstream requests per API key |
| `QUEUE_MAX_SIZE` | `100` | Maximum queued requests |
| `QUEUE_WAIT_MS` | `15000` | Maximum queue wait before `429` |

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
  "egress_ready": true
}
```

### `GET /readyz` — readiness

`200` only when at least one egress route and one model are available; otherwise `503`.

```json
{
  "status": "ready",
  "models_count": 8,
  "egress": {
    "mode": "proxy_only",
    "ready_routes": [{ "id": "socks5://proxy.example:1080", "type": "proxy" }],
    "proxies_configured": 1,
    "allow_direct": false
  },
  "queue": { "active": 0, "queued": 0, "limits": { "maxConcurrent": 8, "maxPerKey": 4, "maxQueue": 100, "maxWaitMs": 15000 } }
}
```

Compose uses `/readyz` for its healthcheck. The Docker image itself uses `/healthz` so a temporary proxy outage does not restart a healthy process.

---

## Error semantics

| Status | Type | Meaning |
| :--- | :--- | :--- |
| `401` | authentication | Missing/invalid API key, expired key, or paid model without a Zen key |
| `429` | `free_tier_rate_limit` | Upstream quota/capacity on every routable proxy; honor `Retry-After` |
| `429` | `queue_full` | Gateway concurrency limit; retry shortly |
| `502` | upstream/stream | Upstream connection or stream failed |
| `503` | `no_egress_route` | No healthy proxy route and direct fallback disabled |
| `504` | deadline | Overall request deadline exceeded |

On upstream quota, the gateway cools that route and retries the next routable proxy within the `PROXY_QUOTA_FAILOVERS` budget. It returns `429` only when no routable proxy remains (or the budget/deadline is exhausted), using the earliest real `Retry-After`. Proxies cannot create quota when the upstream limit is account- or key-global.

---

## Testing and verification

```bash
npm test                 # security + reliability suites
npm run build            # build the React dashboard
docker compose config    # validate compose interpolation
node --check server/proxy.js
```

The reliability suite covers proxy parsing (including IPv6), SOCKS5 response parsing, retry classification, quota cooldown, round-robin selection, quota failover, direct-fallback preference, 5x health-check gating, failed-sweep persistence, immediate tunnel-failure backoff, interval clamping, manual pruning, and admission queue limits. It does not require network access.

A live smoke test after deployment:

```bash
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $(node -e "console.log(require('./data/keys.json')[0].key)")" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","stream":false,"messages":[{"role":"user","content":"Reply with OK."}]}'
```

Verify the proxy pool:

```bash
npm run check:proxies
```

This runs the same five-probe, 5-second health check used at startup and prints pass/fail, probe count, latency, and the failure reason for each endpoint. It is read-only and never rewrites the configured pool. It exits non-zero when no proxy is healthy. The dashboard Settings page also shows healthy/configured/routable/failed counts, the automatic sweep interval, 5x pass status, latency, and the failed-route list with a manual remove button.

---

## Operations

### Data directory

`data/` is mounted as a volume and contains:

- `config.json` — normalized runtime configuration
- `keys.json` — API keys (master key included)
- `admin-password.txt` — generated dashboard password

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

Healthy proxies are selected round-robin, with freshly verified proxies preferred. A proxy tunnel failure pulls that route out of rotation immediately with exponential backoff (30 seconds, doubling, capped at the sweep interval), and the request continues on the next routable proxy. A network error or repeated `5xx` also rotates to the next route. An upstream `429` marks a quota cooldown but keeps the route in `/readyz`; the request then tries the next routable proxy within `PROXY_QUOTA_FAILOVERS`. When every route is cooling, the gateway returns `429` with the earliest retry hint instead of hammering the upstream.

The full pool is swept every 30 minutes by default (`PROXY_CHECK_INTERVAL_MINUTES`). Each proxy gets five sequential probes with a 5-second timeout; all five must pass. A failed sweep keeps the route out of rotation until a later sweep passes. With `PROXY_AUTO_PRUNE_DEAD=true` (default), two consecutive failed sweeps remove the entry from the saved pool, but the last remaining entry is never auto-removed. Settings exposes the interval, auto-prune toggle, failed-route list, and a manual remove button; `POST /api/proxies/prune` does the same over the API. Proxies injected through the `PROXIES` environment variable reappear after a restart even if pruned from `data/config.json`. There is no public-proxy scraper.

Because quota attribution is controlled by the upstream, proxy rotation is a best-effort mitigation, not a guarantee. If the free tier is limited per account/key, no proxy pool can remove the limit.

### Docker resilience

- `restart: unless-stopped`
- `/readyz` as the real readiness gate
- Persistent `data/` volume
- No tunnel sidecar or `NET_ADMIN` capability required

---

## Limitations and security notes

- **Free-tier capacity is upstream-controlled.** No gateway can guarantee zero `429` responses. Round-robin and quota failover reduce them when the limit is per-IP; if it is per account/key, the pool cannot help. There is no 99%/100% availability guarantee without authorized upstream capacity.
- **Anonymity depends on your egress.** With `ALLOW_DIRECT_FALLBACK=false`, the gateway will return `503` rather than silently leak the host IP.
- **Public proxies are not supported for inference egress.** Use explicit, authorized proxies only; they can see your traffic metadata and may be unstable.
- **Do not expose the dashboard without TLS and strong credentials.** Use a reverse proxy, firewall, or private network.
- **Respect upstream terms and applicable law.** This project is not affiliated with OpenCode, Anthropic, or OpenAI.
- **No warranty.** See the MIT license.

---

## License

This project is open-source software licensed under the [MIT License](LICENSE).
