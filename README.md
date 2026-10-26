<div align="center">

![OpenCode2API Banner](docs/banner.svg)

# ⚡ OpenCode2API

### OpenAI + Anthropic compatible gateway for OpenCode Zen models

> **Zero-config automatic egress: discovers, verifies, rotates, and prunes public HTTP/HTTPS/SOCKS5 routes. Strict 5x TLS checks and round-robin quota failover. No manual proxy setup.**

[![Node.js](https://img.shields.io/badge/Node.js-20-339933.svg?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker Compose](https://img.shields.io/badge/Docker_Compose-Ready-2496ED.svg?style=for-the-badge&logo=docker&logoColor=white)](docker-compose.yml)
[![Proxy Egress](https://img.shields.io/badge/Egress-Automatic_Discovery-2496ED.svg?style=for-the-badge)](https://github.com/Nystic-Shadow/Opencode2api)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge&logo=opensourceinitiative&logoColor=white)](LICENSE)

</div>

---

## What this is

OpenCode2API exposes OpenCode Zen models through standard **OpenAI** and **Anthropic** APIs. It adds authentication, model discovery, tool/function calling, vision, reasoning streams, bounded concurrency, and self-managing egress. `.env` only needs a port and dashboard credentials; proxies are discovered and verified automatically.

It is designed for **maximum best-effort availability** within upstream limits. Free-tier capacity is controlled upstream. The gateway therefore:

- discovers public HTTP/HTTPS/SOCKS5 candidates every 10 minutes,
- probes every candidate directly against the configured upstream and only adds routes that pass five consecutive TLS checks,
- spreads requests round-robin across verified routes,
- rechecks the full pool in the background every 30 minutes by default, even while idle,
- cools a proxy briefly when it returns `429`, then tries the next routable proxy (bounded by `PROXY_QUOTA_FAILOVERS`),
- detects a global `FreeUsageLimitError` and fails fast with the exact upstream reset time instead of rotating proxies against a shared bucket,
- rotates the anonymous session identity on retries so a per-session limit does not pin one request forever,
- never routes through an unverified candidate,
- fails over immediately when a proxy tunnel dies and keeps dead routes out of rotation until a later sweep passes,
- auto-removes failed routes after two consecutive failed sweeps (configurable, one manual entry is retained),
- exposes `/readyz` so a scheduler or load balancer can stop sending traffic when no route or model is available.

> **Best effort, not a capacity guarantee.** Proxies change the egress IP; they cannot manufacture upstream quota. If OpenCode meters the free tier per account/key rather than per IP (or the limit applies globally), every proxy can still receive `429`. The gateway detects the anonymous free-tier `FreeUsageLimitError` specifically and, because that bucket is shared across egress IPs, returns `429` immediately with the exact upstream reset time instead of exhausting the pool. For predictable capacity, use an upstream Zen key or a provider you are authorized to use.

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

- **Zero-config automatic discovery:** public HTTP, HTTPS, and SOCKS5 candidates are loaded from several sources, screened, and verified
- **Manual overrides remain optional:** explicit `PROXIES` entries take precedence and are never removed by discovery
- Maximum 100 total routes; up to 40 automatic and a 20-route discovery target
- Credential-only variants on the same host:port are treated as distinct routes
- Five consecutive TLS probes per route, each with a 5-second timeout; unverified candidates never receive traffic
- Private, loopback, CGNAT, link-local, documentation, multicast, and other reserved proxy targets are rejected
- Discovery refresh every 10 minutes; full-pool rechecks every 30 minutes by default (`PROXY_CHECK_INTERVAL_MINUTES`, `1–1440`)
- Failed proxies leave rotation until a later sweep passes; two failed sweeps auto-remove them (`PROXY_AUTO_PRUNE_DEAD`, one manual entry is retained)
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
select egress route: round-robin over verified discovered routes and manual routes; direct only if allowed
    │
    ▼
upstream request with timeout and overall deadline
    │
    ├── 2xx ──► stream/non-stream response (slot held until close)
    ├── 429 / quota 403 ──► cool route, try next (bounded); FreeUsageLimitError → fail fast with upstream reset
    ├── network / 5xx ──► next route or retry, then 502/504
    └── fatal 4xx ──► return the upstream error
```

Key properties:

| Behavior | Implementation |
| :--- | :--- |
| Retry budget | `MAX_RETRIES=2` by default, hard-capped at `3` |
| Quota failover budget | `PROXY_QUOTA_FAILOVERS=10` by default, bounded `0–20` |
| Background recheck | Full pool every `30` minutes by default (`PROXY_CHECK_INTERVAL_MINUTES`, `1–1440`) |
| Automatic discovery | Refresh every `10` minutes, target `20` verified routes, up to `40` automatic routes |
| Candidate verification | One screen probe plus five consecutive TLS probes, `5s` timeout each |
| Failed sweep | Route stays out of rotation until a later 5x sweep passes |
| Dead-entry pruning | After two failed sweeps when `PROXY_AUTO_PRUNE_DEAD=true`; one manual entry is retained |
| Request timeout | `30s` per attempt by default |
| Overall deadline | `90s` by default |
| Queue | `8` concurrent globally, `4` per key, `100` waiting, `15s` wait |
| Stream admission | Slot held for the full response, not released when headers arrive |
| Quota | Route-level `429` cools and rotates; a global `FreeUsageLimitError` fails fast with the exact upstream reset |
| Route failover | Round-robin for routing; network errors and `5xx` rotate to the next route |
| Direct egress | Disabled by compose (`ALLOW_DIRECT_FALLBACK=false`) |

---

## Requirements

- **Node.js 20+** for local runs (the Docker image uses `node:20-bookworm-slim`)
- **Docker + Docker Compose v2** for the recommended deployment
- **No proxy configuration required.** The gateway discovers and verifies public HTTP/HTTPS/SOCKS5 routes automatically. Manual `PROXIES` entries are optional overrides.
- No tunnel sidecar or `NET_ADMIN` capability is required

---

## Quickstart: Docker Compose (recommended)

### 1. Configure secrets

```bash
cp .env.example .env
```

Edit `.env`. It only needs the port and dashboard credentials:

```dotenv
PORT=8080
DASHBOARD_USER=admin
DASHBOARD_PASS=replace-with-a-long-random-password
```

Generate a password with:

```bash
openssl rand -base64 24
```

`DASHBOARD_PASS` is required by `docker-compose.yml`. Known defaults such as `admin123` and passwords shorter than 12 characters are ignored; the gateway generates a random password and writes it to `data/admin-password.txt`.

### 2. Egress is automatic (nothing to configure)

On first start the gateway fetches public proxy candidates, screens them with a direct probe, then requires five consecutive TLS probes against the configured upstream before a route enters rotation. Verification uses SNI and certificate validation, and private or reserved proxy targets are rejected. The pool target is 20 verified routes, refreshed every 10 minutes; the automatic pool is capped at 40 and the total pool at 100. Cold start normally takes 2–4 minutes while candidates are screened.

You can optionally add your own proxies in Settings or with `PROXIES`:

```dotenv
PROXIES=socks5://user:pass@proxy.example:1080,http://user:pass@proxy-b.example:8080
```

Manual entries take precedence over discovered routes with the same endpoint and are never removed by discovery. Ambient `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` variables are ignored. Entries may share the same host and port when different credentials select different egress IPs; they are tracked as separate routes.

The full pool is rechecked in the background every 30 minutes by default, even when there is no traffic. A route that fails a sweep stays out of rotation until a later sweep passes; after two consecutive failed sweeps it is removed automatically when `PROXY_AUTO_PRUNE_DEAD=true`. Automatic routes are then replenished by discovery; one manual entry is retained for recovery. You can also trigger a refresh and remove failed entries from Settings or with `POST /api/proxies/recheck` and `POST /api/proxies/prune`.

Healthy routes are used round-robin. If a proxy tunnel dies between requests, the gateway marks that route down immediately, continues the request on another routable proxy, and backs the failed route off exponentially. When a route returns upstream quota, the gateway cools it and retries the next routable proxy up to `PROXY_QUOTA_FAILOVERS` times before returning `429` with the earliest retry hint. This is best effort: if quota is tied to the account/key rather than the proxy IP, the whole pool can still be limited.

### 3. Start

```bash
docker compose up -d --build
docker compose ps
```

The stack contains:

- `gateway` — the Node.js API gateway on port `8080`

The gateway binds HTTP immediately; model discovery, automatic proxy discovery, and proxy health checks run in the background.

### 4. Verify

```bash
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
```

`/readyz` returns `503` until at least one verified egress route and one model are available. It returns `200` when the gateway is ready to serve inference. First start normally returns `503` for 2–4 minutes while automatic discovery screens and verifies candidates.

If it stays `503`:

```bash
docker compose logs -f gateway
```

Look for `ProxyDiscovery` lines showing verified routes and source health. Check that the gateway can reach `https://opencode.ai`. With no verified route, the dashboard shows `Discovering routes` and the latest discovery note. Automatic discovery retries more quickly when the pool is empty.

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

Open <http://127.0.0.1:8080/>. The API base URL is `http://127.0.0.1:8080/v1`. Automatic proxy discovery is enabled by default; no proxy flags are required.

If you intentionally want direct egress for local development, set `ALLOW_DIRECT_FALLBACK=true` and `EGRESS_MODE=auto` or `direct`. This exposes your host IP to the upstream and is not anonymous.

---

## Egress modes

| `EGRESS_MODE` | Route order |
| :--- | :--- |
| `auto` | Verified discovered/manual proxies → direct only if `ALLOW_DIRECT_FALLBACK=true` |
| `proxy_only` (Compose default) | Verified discovered/manual proxies only |
| `direct` | Direct only (not anonymous) |

`ALLOW_DIRECT_FALLBACK`:

- `false` (default) — never use direct egress. Recommended for anonymous deployments.
- `true` — allow direct egress as the last route. This leaks the host IP and is not anonymous.

Compose sets `EGRESS_MODE=proxy_only` and `ALLOW_DIRECT_FALLBACK=false`. `PROXIES` is optional; automatic discovery supplies the pool.

---

## Environment variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8080` | HTTP port |
| `DASHBOARD_USER` | `admin` | Dashboard username |
| `DASHBOARD_PASS` | generated | Dashboard password; 12+ characters, required by compose |
| `OPENCODE_ZEN_KEY` | empty | Upstream Zen key for paid models |
| `UPSTREAM_INFERENCE_URL` | OpenCode Zen URL | Override the upstream chat endpoint (local testing or compatible mirrors; plain HTTP requires direct egress) |
| `PROXIES` | empty | Optional comma-separated `http://`, `https://`, or `socks5://` overrides; maximum 100; ambient proxy env vars are ignored |
| `AUTO_PROXY_DISCOVERY` | `true` | Discover, verify, rotate, and prune public proxy routes automatically |
| `PROXY_QUOTA_FAILOVERS` | `10` | Additional proxies tried after an upstream quota response; bounded `0–20` |
| `PROXY_CHECK_INTERVAL_MINUTES` | `30` | Full-pool background sweep interval in minutes; bounded `1–1440` |
| `PROXY_AUTO_PRUNE_DEAD` | `true` | Remove failed routes after two consecutive failed sweeps; one manual entry is retained |
| `EGRESS_MODE` | `proxy_only` | `auto`, `proxy_only`, `direct` |
| `ALLOW_DIRECT_FALLBACK` | `false` | `true`/`false` direct-egress policy |
| `MAX_RETRIES` | `2` | Retries per request, capped at `3` |
| `REQUEST_TIMEOUT_MS` | `30000` | Per-attempt timeout |
| `REQUEST_DEADLINE_MS` | `90000` | Overall request deadline |
| `QUEUE_MAX_CONCURRENT` | `8` | Global concurrent upstream requests |
| `QUEUE_MAX_PER_KEY` | `4` | Concurrent upstream requests per API key |
| `QUEUE_MAX_SIZE` | `100` | Maximum queued requests |
| `QUEUE_WAIT_MS` | `15000` | Maximum queue wait before `429` |

Explicit environment variables override cached values in `data/config.json`. `data/config.json` is rewritten on startup with normalized defaults. `.env.example` deliberately contains only `PORT`, `DASHBOARD_USER`, and `DASHBOARD_PASS`; everything else has a safe automatic default.

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
    "automatic_proxies": 0,
    "manual_proxies": 1,
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
| `429` | `free_tier_rate_limit` | Upstream quota/capacity. Global `FreeUsageLimitError` includes the exact reset time; honor `Retry-After` |
| `429` | `queue_full` | Gateway concurrency limit; retry shortly |
| `502` | upstream/stream | Upstream connection or stream failed |
| `503` | `no_egress_route` | No healthy proxy route and direct fallback disabled |
| `504` | deadline | Overall request deadline exceeded |

On route-level upstream quota, the gateway cools that route and retries the next routable proxy within the `PROXY_QUOTA_FAILOVERS` budget. A `FreeUsageLimitError` from the anonymous free tier is different: that bucket is shared across egress IPs, so the gateway records the upstream reset and fails subsequent free-tier requests immediately with `429`, `Retry-After`, `reset_at`, and `retry_after_seconds`. It clears the gate after a successful free-tier request or when the reset passes. Proxies cannot create quota when the upstream limit is account- or key-global.

---

## Testing and verification

```bash
npm test                 # security + reliability suites
npm run build            # build the React dashboard
docker compose config    # validate compose interpolation
node --check server/proxy.js
```

The reliability suite covers proxy parsing (including IPv6), SOCKS5 response parsing, retry classification, quota cooldown, round-robin selection, quota failover, direct-fallback preference, 5x health-check gating, failed-sweep persistence, immediate tunnel-failure backoff, interval clamping, manual pruning, admission queue limits, automatic-discovery parsing/filtering, five-probe verification, capacity limits, manual/automatic pool merging, and automatic-route pruning. It does not require network access.

A live smoke test after deployment:

```bash
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $(node -e "console.log(require('./data/keys.json')[0].key)")" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","stream":false,"messages":[{"role":"user","content":"Reply with OK."}]}'
```

Verify the automatic pool:

```bash
npm run check:proxies
```

This runs automatic discovery when enabled and/or the same five-probe, 5-second health check used at startup, then prints pass/fail, source, probe count, latency, and the failure reason for each endpoint. It is read-only and never rewrites the saved pool. It exits non-zero when no route is healthy. The dashboard Settings page also shows healthy/total, automatic/manual counts, discovery progress, source health, last/next refresh, the sweep interval, latency, and the failed-route list with a manual remove button.

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

Healthy routes are selected round-robin, with freshly verified proxies preferred. Automatic discovery keeps the pool replenished without operator action; manual entries are optional and take precedence. A proxy tunnel failure pulls that route out of rotation immediately with exponential backoff (30 seconds, doubling, capped at the sweep interval), and the request continues on the next routable proxy. A network error or repeated `5xx` also rotates to the next route. An upstream `429` marks a quota cooldown but keeps the route in `/readyz`; the request then tries the next routable proxy within `PROXY_QUOTA_FAILOVERS`. A global `FreeUsageLimitError` short-circuits that loop and returns the upstream reset immediately. When every route is cooling, the gateway returns `429` with the earliest retry hint instead of hammering the upstream.

The full pool is swept every 30 minutes by default (`PROXY_CHECK_INTERVAL_MINUTES`). Each route gets five sequential probes with a 5-second timeout; all five must pass. A failed sweep keeps the route out of rotation until a later sweep passes. With `PROXY_AUTO_PRUNE_DEAD=true` (default), two consecutive failed sweeps remove the entry; automatic routes are replenished by discovery, and one manual entry is retained for recovery. Settings exposes the discovery toggle, interval, auto-prune toggle, failed-route list, and a manual remove button; `POST /api/proxies/recheck` and `POST /api/proxies/prune` provide the same actions over the API. Manual proxies injected through `PROXIES` reappear after a restart even if pruned from `data/config.json`.

Because quota attribution is controlled by the upstream, proxy rotation is a best-effort mitigation, not a guarantee. The anonymous free tier currently reports `FreeUsageLimitError` with an identical `Retry-After` across direct connections and unrelated proxy IPs, which means the bucket is global; the gateway treats it that way and fails fast. For capacity, use an upstream Zen key or another provider.

### Docker resilience

- `restart: unless-stopped`
- `/readyz` as the real readiness gate
- Persistent `data/` volume
- No tunnel sidecar or `NET_ADMIN` capability required

---

## Limitations and security notes

- **Free-tier capacity is upstream-controlled.** No gateway can guarantee zero `429` responses. The anonymous free tier is currently a single global bucket; when it is exhausted, every proxy receives the same `FreeUsageLimitError` and reset time. The gateway fails fast with that reset instead of pretending another IP can help. For predictable capacity, use an upstream Zen key or another provider.
- **Anonymity depends on egress.** With `ALLOW_DIRECT_FALLBACK=false`, the gateway will return `503` rather than silently leak the host IP. Automatic discovery uses public proxies, which are untrusted and may log traffic metadata. TLS certificate validation is enabled and private/reserved proxy targets are rejected, but public proxies are still best-effort infrastructure.
- **Public proxies can be unstable or malicious.** The gateway never routes through an unverified candidate and requires five consecutive TLS probes, but it cannot audit a proxy operator's logging or reliability. Use manual, authorized proxies when traffic confidentiality is critical.
- **Do not expose the dashboard without TLS and strong credentials.** Use a reverse proxy, firewall, or private network.
- **Respect upstream terms and applicable law.** This project is not affiliated with OpenCode, Anthropic, or OpenAI.
- **No warranty.** See the MIT license.

---

## License

This project is open-source software licensed under the [MIT License](LICENSE).
