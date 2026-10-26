# 📜 OpenCode2API Changelog

All notable changes to this project are documented in this file.

---

## [Unreleased] - 2026-10-26 — Zero-Config Automatic Proxy Egress, Round-Robin Quota Failover, and Bounded Admission

> This release supersedes the quota-rotation and WARP-tunnel design described in the entries below. WARP support has been removed entirely. Egress is automatically discovered and verified HTTP/HTTPS/SOCKS5, with optional manual overrides.

### Behavior changes

- **WARP removed**: server modules, admin endpoints, configuration, dashboard controls, install scripts, and container wiring are gone.
- **Zero-config automatic egress**: on boot and every 10 minutes, the gateway fetches public HTTP/HTTPS/SOCKS5 candidates, screens each with a direct probe, then requires five consecutive TLS probes (5s timeout) against the configured upstream before adding a route. Unverified candidates never receive traffic. The automatic target is 20 routes, capped at 40 automatic and 100 total.
- **Safe verification**: probes use SNI and certificate validation (`rejectUnauthorized: true`). Private, loopback, CGNAT, link-local, documentation, multicast, Teredo, 6to4, NAT64, and other reserved proxy targets are rejected.
- **Manual overrides remain optional**: explicit `PROXIES` entries take precedence over a discovered route with the same endpoint and are never removed by discovery. Ambient `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` variables remain ignored.
- **Best-effort quota failover**: requests rotate round-robin across healthy routes. An upstream `429` (or quota-flavored `403`) cools that route and retries the next routable proxy, bounded by `PROXY_QUOTA_FAILOVERS` (default `10`, max `20`). The gateway returns `429` with the earliest real `Retry-After` only when the pool or budget is exhausted. Proxies change the egress IP; they cannot remove quota that is tied to the account or key.
- **Global free-quota fail-fast**: the anonymous free tier is one shared upstream bucket, not a per-IP allowance. On `FreeUsageLimitError`, the gateway records the real reset time (15-minute default when `Retry-After` is missing, capped at 7 days, never shortened) and fails subsequent free-tier requests immediately instead of rotating through every proxy. The `429 free_tier_rate_limit` response carries `Retry-After`, `x-opencode2api-free-quota-reset`, `x-opencode2api-upstream-error`, `reset_at`, and `retry_after_seconds`; paid models and explicit Zen-key requests are unaffected. The gate clears after a successful free-tier request or once the reset passes, and its state appears in `/api/proxies/status`, recheck/prune responses, `/readyz` (`upstream_quota`), and the Settings page.
- **Credential-only variants are distinct routes**: two proxy entries may share a host and port when their credentials select different egress IPs. They receive separate health, quota, session, and agent state.
- **Anonymous by default in Compose**: `EGRESS_MODE=proxy_only` and `ALLOW_DIRECT_FALLBACK=false`. The gateway returns `503 no_egress_route` instead of silently leaking the host IP.
- **Required dashboard password**: `docker-compose.yml` requires `DASHBOARD_PASS`. Known defaults such as `admin123` and passwords shorter than 12 characters are ignored; a random password is generated and written to `data/admin-password.txt`.
- **Minimal `.env`**: only `PORT`, `DASHBOARD_USER`, and `DASHBOARD_PASS` are needed. Proxy tuning, discovery, queue, and retry settings have safe defaults.
- **Explicit environment wins**: shell and container variables take precedence over `.env` values.
- **Scheduled full-pool rechecks**: every route is swept in the background every 30 minutes by default (`PROXY_CHECK_INTERVAL_MINUTES`, bounded `1–1440`), even with no traffic. Each route must pass five sequential 5-second probes.
- **Failed routes stay out of rotation**: a failed 5x sweep keeps the route unavailable until a later sweep passes. The previous five-minute quarantine is gone, so a dead proxy is not retried just because time elapsed.
- **Immediate tunnel-failure failover**: a broken proxy connection or interrupted proxy stream marks that route `proxy_down` immediately, backs it off exponentially (30 seconds doubling, capped at the sweep interval), and continues the request on another routable proxy.
- **Dead-route pruning and replenishment**: with `PROXY_AUTO_PRUNE_DEAD=true` (default), two consecutive failed sweeps remove an entry; one manual entry is retained for recovery, and automatic routes are replenished by discovery. Settings exposes the discovery toggle/status, recheck interval, auto-prune toggle, failed-route list, and a manual remove button; `POST /api/proxies/recheck` and `POST /api/proxies/prune` provide the same actions. Proxies injected through `PROXIES` return after a restart.
- **Configurable upstream endpoint**: `UPSTREAM_INFERENCE_URL` is now honored (defaults to the real OpenCode Zen inference URL) for local test upstreams and compatible mirrors.

### Reliability

- Egress manager with round-robin route selection (**verified proxies first; direct only if allowed and no proxy is routable**), route health tracking, circuit breaking on network/`5xx` failures, and quota cooldowns that keep a route in `/readyz`.
- Automatic discovery manager with source fetch timeouts and size caps, candidate dedupe/cooldowns, 32-way screening, 4-way five-probe verification, empty-pool backoff, source health reporting, and manual/automatic pool merging.
- Quota-aware candidate selection: cooling routes are skipped, unchecked-but-available proxies remain available for failover, and `PROXY_QUOTA_FAILOVERS` is tracked separately from the network retry budget.
- Total proxy pool capped at 100, automatic pool at 40, discovery target at 20. Background sweeps run every 30 minutes by default with five sequential 5-second probes per route. A failed sweep keeps the route out of rotation until a later pass; two failed sweeps auto-prune it when enabled, with one manual entry retained. Probes target the configured upstream host.
- Proxy tunnel failures (`ECONNREFUSED`, resets, non-API proxy payloads, interrupted proxy streams) open an immediate exponential circuit instead of waiting for three generic retries.
- IPv6 proxy hosts are parsed correctly (`net`/`tls` receive a bare address; display IDs keep brackets). Public IPv6 discovery is restricted to global unicast.
- Bounded global and per-key admission queue with zero-value support (`QUEUE_MAX_SIZE=0`, `QUEUE_WAIT_MS=0` fail fast).
- Per-attempt timeout, overall request deadline, retries capped at `3` (default `2`), and fail-fast `429 queue_full` when saturated.
- Admission slots are held for the full stream, not released when headers arrive. Client aborts destroy the in-flight upstream request; release is idempotent.
- `GET /healthz` is liveness and always `200` while the process is alive. `GET /readyz` is `200` only with at least one egress route and one model.
- HTTP binds immediately; automatic discovery, proxy checks, and model discovery run in the background. Compose healthcheck uses `/readyz`; the image healthcheck uses `/healthz`.

### Testing

- `npm test` runs the security suite plus the 47-test reliability suite covering proxy parsing (including IPv6), SOCKS5 frames, retry classification, quota cooldown, round-robin selection, quota failover, direct-fallback preference, 5x health-check gating, failed-sweep persistence, immediate tunnel-failure backoff, interval clamping, manual pruning, automatic-discovery parsing/filtering/cooldowns/five-probe gating/capacity/source failures, mid-run discovery disable, manual/automatic pool merging, automatic-route pruning, the global free-quota gate (exact reset, no shortening, default block, clear on success), and queue limits/timeouts.
- `npm run check:proxies` runs automatic discovery when enabled and/or the real five-probe, 5-second verification, prints live progress, then exits non-zero when no route is healthy.
- Live zero-config run: 13/13 sources, 800 candidates screened, 20/20 routes verified in about 280 seconds, `/healthz` and `/readyz` returned `200`, and the recheck/prune endpoints completed without error. A real chat request fanned out across 10 verified routes; every route received the same upstream `FreeUsageLimitError`, confirming that proxies cannot bypass account-wide free-tier quota.
- Verified round-robin quota failover against a local mock 429 upstream through both an HTTP CONNECT proxy and a SOCKS5 proxy: two upstream attempts, `429` with `Retry-After`, then an immediate `429` with no extra upstream hits while both routes were cooling, then fresh attempts after the cooldown.
- Verified pool lifecycle against local HTTP CONNECT and SOCKS5 proxies plus a mock SSE upstream: both routes passed the 5x sweep, killing the HTTP proxy mid-run left traffic on SOCKS5, the dead route entered `proxy_down`, and two failed sweeps auto-pruned it while the saved config kept only the survivor.
- Verified OpenAI non-stream, OpenAI stream, Anthropic non-stream, and Anthropic stream against a local mock upstream.
- Verified `/healthz` liveness, `/readyz` gating, legacy-key rejection, and `503 no_egress_route` with `Retry-After`.

---

## [2.5.2] - 2026-10-24 — Quad-Spectrum Hybrid Egress & Multi-Subnet Tunnel Diversity

### 🚀 Major Highlights

- **Quad-Spectrum Hybrid Egress (Dual-Stack IPv6 + Pure IPv4-Only Alternation)**:
  - Slots `40000` and `40002` operate on **Dual-Stack IPv6** with dedicated `/128` addresses.
  - Slots `40001` and `40003` operate in **Pure IPv4-Only** mode (`0.0.0.0/0` with IPv4-only DNS), forcing WireProxy to route through Cloudflare's IPv4 egress pool (`104.28.x.x` / `8.x.x.x`).
  - This ensures that if Cloudflare's IPv6 range in Singapore (`2a09:bac...`) hits OpenCode's sliding capacity limit window, the gateway immediately fails over to an IPv4 egress IP, completely bypassing the IPv6 subnet rate limit.
- **Multi-Subnet Ingress Endpoint Diversity**:
  - Expanded WireGuard endpoints across diverse Cloudflare ingress subnets (`162.159.192.x`, `162.159.193.x`, `162.159.195.x`), avoiding single Anycast cluster congestion.
- **Dynamic Multi-Slot Rotation in Retry Loop**:
  - Removed single-rotation blockers in both OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) endpoints.
  - On any 429 (`FreeUsageLimitError`), the gateway immediately marks the slot on cooldown and hops across all 4 available pool ports sequentially, falling back to direct host egress if all slots are momentarily exhausted.
- **Accelerated Burn Replacement (2x Threshold)**:
  - Accounts are retired and hot-swapped after 2 rate limit events (down from 3), keeping the pool continuously refreshed with clean network identities.

---

## [2.5.1] - 2026-10-24 — Automatic Account Retirement & Stale Pool Purging

### 🚀 Major Highlights

- **Automated Account Retirement on 3x Rate Limit**: Accounts that hit upstream rate limits 3 times are recognized as having exhausted their quota; the gateway automatically purges the burned account, registers a fresh Cloudflare WARP account in the background, and re-arms the live WireProxy port with a new IPv6 address.
- **Stale Pool Pruning (2-Hour Lifespan)**: Boot sequence and pool loader now automatically discard accounts older than 2 hours from `warp_pool.json`, ensuring the gateway never reuses stale, exhausted accounts across restarts or redeployments.
- **Dedicated Pool Reset Endpoint (`POST /api/warp/refresh-pool`)**: Added an administrative endpoint to flush cached pool credentials and instantly re-bootstrap 4 clean Cloudflare WARP accounts.

---

## [2.5.0] - 2026-10-24 — Concurrent 4-Port Pre-Warmed WARP Pool & Zero-Drop Resilience

### 🚀 Major Highlights

- **Concurrent 4-Port Pre-Warmed WARP Pool**: Operates 4 persistent userspace WireProxy daemons concurrently on loopback ports `40000`, `40001`, `40002`, and `40003`. Each port is backed by an independent Cloudflare WARP account with a dedicated `/128` IPv6 address.
- **Round-Robin Egress Load Balancing**: Inbound inference requests automatically distribute across healthy, warm tunnels, quadrupling aggregate RPM throughput while keeping individual accounts well below upstream rate-limit thresholds.
- **Zero-Latency Port Hopping (`0ms`)**: Rate-limited ports are marked on a 45-second cooldown without destroying processes or severing sockets. Active requests hop instantly to the next live port with zero startup lag.
- **Decoupled Model Fallback & Tunnel Isolation**: Model capacity limits are strictly isolated from IP rotations. When an individual model throttles upstream, fallback models are attempted on the same active tunnel before rotating network egress.
- **100% Dual-Stack IPv6 Enforcement**: Eliminated Cloudflare Singapore shared NAT IPv4 collisions (`104.28.222.43`), ensuring all tunnels receive unique, non-colliding IPv6 addresses.
- **Independent Keep-Alive Connection Pools**: Dedicated HTTP/HTTPS agent instances per port keep TLS connections hot, reducing TTFT latency to ~1.3s–3.0s.
- **Full Protocol Parity**: Verified end-to-end compatibility for both OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) formats across JSON non-streaming, SSE streaming, multi-turn tool calling, and multimodal vision.

---

## [1.5.1] - 2026-10-23 — Autonomous Zero-Downtime WARP Hot-Swap & Rate Limit Healing

### 🚀 Major Highlights

- **Autonomous Zero-Downtime Dual-Port Hot-Swap**: Upgraded the Userspace WireProxy engine to alternate seamlessly between primary (`40000`) and secondary (`40001`) SOCKS5 loopback ports. When a tunnel rotation is triggered, the new WireGuard session and Cloudflare Anycast edge IP are spawned and verified on the alternate port *before* switching traffic. In-flight streaming requests on the old port are granted a 30-second graceful drain window, eliminating dropped streams and `ECONNREFUSED` connection cuts.
- **Autonomous Auto-Rotation on 429 / FreeUsageLimitError**: Fixed a critical issue where the gateway retried on the same exhausted IP upon hitting upstream rate limits (`FreeUsageLimitError` / HTTP 429). The gateway now detects upstream rate limits in real time across both OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) endpoints, instantly acquiring a fresh Cloudflare egress IP and seamlessly retrying within the same inference request.
- **Concurrent Rotation Deduplication**: Multiple concurrent agent requests (e.g. Hermes Agent, Cursor, Cline) hitting rate limits simultaneously are deduplicated into a single in-flight rotation promise. All waiting requests automatically resume on the newly established tunnel without duplicate registrations or port conflicts.
- **Optimized Debounce Cooldown (8s)**: Reduced the key rotation cooldown from 120s down to 8s with atomic state management. Prevents flapping while ensuring rapid recovery for high-throughput coding agent loops.
- **WARP-First Egress in Auto Mode**: In `auto` mode, the gateway automatically prefers Cloudflare WARP whenever connected and verified live, avoiding datacenter VPS IP blocks (HTTP 403 / 429) from the very first request. Direct VPS degradation now retains a 24-hour stability shield.
- **Settings UI Enhancement**: Added explicit controls and notifications for `Auto-Rotate WARP Keys on Rate Limit (429) & Unauth` in the control plane dashboard.

---

## [1.5.0] - 2026-10-19 — Production Release

### 🚀 Major Highlights

- **Dual-Stack IPv4 / IPv6 WireProxy Egress**: Upgraded userspace WireGuard engine to negotiate both IPv4 (`172.16.0.2/32`) and dedicated IPv6 (`/128`) routes via Cloudflare WARP Anycast (`engage.cloudflareclient.com:2408`). Bypasses shared IPv4 NAT congestion on Cloudflare edge and eliminates upstream `FreeUsageLimitError` rate-limiting collisions.
- **Adaptive Route Health Manager**: Automatic egress sensing engine detects host VPS datacenter IP blocks (HTTP 403 / timeouts) and auto-promotes Cloudflare WARP as primary egress for all subsequent requests on Attempt 1 with a 1-hour stability cooldown.
- **Strict Model Routing & Isolation**: `smart_fallback` is now `false` by default to guarantee 100% deterministic model routing. Requests route strictly to the exact model requested. Paid models (`claude-opus-5-5`, `gpt-5.3-codex-spark`) are strictly blocked in free-only mode with clean HTTP 400 errors and never degrade into free models or MiMo.
- **Upstream Model Verification Headers**: All OpenAI and Anthropic responses now return `x-opencode2api-resolved-model`, `x-opencode2api-upstream-model`, and `x-zen-model` (direct from Cloudflare edge), allowing clients and developers to verify the exact model executed on upstream hardware.
- **Playground Model Isolation**: Fixed multi-turn context leakage in the React 19 Playground. Switching models in the dropdown now automatically clears the active conversation history, preventing old model personas from polluting new model contexts.

### 🛡️ Network & Resilience Fixes

- **Fixed 8s SOCKS5 Handshake Socket Kill**: Resolved an issue in `server/warp.js` where `socket.setTimeout(8000)` was not cleared upon handshake completion. Long-running thinking/reasoning responses (>8s) no longer suffer sudden connection terminations.
- **Fixed Double Callback Invocation**: Guarded against calling `callback(err)` after connection establishment succeeded in `agent.createConnection`.
- **Eliminated Destructive In-Flight Process Kills**: Removed runtime `wireproxyProcess.kill('SIGTERM')` from request retry loops. Key rotation is now throttled and safely executed without dropping active streams.
- **Dynamic Session & Workspace Isolation**: Replaced static `'default-project'` and `/app` project directories with randomized project IDs (`proj_<rand>`) and isolated workspaces (`/workspace/<id>`) per request, preventing rate-limit bucket collisions across concurrent sessions.

### 🔄 Protocol & Model Discovery

- **Clean Model Identification**: Discovered model catalog strips only genuine `-free` suffixes while preserving exact upstream IDs. Zero false-positive free classifications.
- **Zero-Prompt Guarantee**: Downstream messages are forwarded byte-for-byte to upstream OpenCode Zen without injected system prompts, identity wrappers, or hidden instructions.
- **Discovery Through WARP**: Model indexing (`models.opencode.ai/api.json` and `/zen/v1/models`) now routes through the active WARP tunnel to prevent upstream Cloudflare timeouts on datacenter servers.

---

## [1.0.0] - 2026-10-18 — Initial Production Gateway

- Initial release of OpenCode2API Gateway.
- OpenAI-compatible `/v1/chat/completions` and `/v1/models` endpoints.
- Anthropic-compatible `/v1/messages` endpoint with thinking blocks.
- Real-time SSE streaming engine with sub-millisecond overhead.
- React 19 Admin Dashboard and interactive Playground.
- Userspace WireProxy integration for Cloudflare WARP.
