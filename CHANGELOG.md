# 📜 OpenCode2API Changelog

All notable changes to this project are documented in this file.

---

## [3.2.3] - 2026-10-31 — Model Fallback Lockdown, Direct Egress Quota Lockout Protection, Universal Proxy Parser & Shared IP Pool Optimization

### 🎯 Model Fallback Lockdown ("Fallback Not On Model")
- **Strict Deterministic Model Routing by Default**: Disabled automatic model switching (`smart_fallback: false` by default across config and migration). When a user requests `deepseek-v4.1-flash`, the gateway strictly serves `deepseek-v4.1-flash` and never secretly swaps to `big-pickle`, `mimo`, `nemotron`, `beam`, `flint`, or `glm`.
- **Configurable Smart Fallback Toggle**: Added an explicit toggle in the Settings UI so operators who want cross-model failovers can opt-in, while preserving exact model requested for normal inference workflows.
- **Eliminated 40s+ Cascading Failover Stalls**: Prevented the gateway from cycling through 8 consecutive models when all proxies are exhausted.

### 🛡️ Direct Egress Quota Lockout Protection
- **No Direct Fallback During Quota Cooldown**: Fixed a critical bug where `server/proxy.js` fell back to direct host egress even when the host IP was actively in an 11.5-hour rate-limit cooldown (`Retry-After: 41350s`). All direct fallback paths now check `egress.getQuotaRetryAfter(directRoute) === 0` before attempting direct egress, failing fast rather than hanging on burned host IPs.

### 🔄 Universal Proxy Parser & Rotating IP Switching
- **Standard `host:port:user:pass` Format Support**: Enhanced `parseProxyUrl` and admin routes to natively parse `host:port:username:password` and `ip:port:username:password` (used by 90% of residential proxy providers including Webshare, Smartproxy, IPRoyal, Bright Data) alongside standard URLs.
- **Forced Session Mutation on 429 Quota Retry**: When a rotating proxy hits an upstream 429 in `auto` mode, the retry immediately injects a fresh `-session-<randId>` token, forcing the proxy provider to assign a brand-new exit IP instead of retrying the exact same rate-limited IP.
- **Connection Close Headers**: Bun proxy sets `proxy-connection: close` alongside `connection: close` on forced rotations to guarantee zero socket reuse at the proxy gateway level.

### 🌐 Shared IP Quota Cooldown & Unique-Host Scraper Optimization
- **Shared IP Host Quota Propagation**: When one proxy port (e.g. `102.244.78.61:8087`) hits an upstream IP rate limit, the quota cooldown is automatically shared with all sibling routes on the same host IP (`:8081`, `:8086`, `:8082`), preventing wasted attempts on the same rate-limited IP.
- **Unique IP Host Enforcement in Auto Discovery**: Automatic proxy scraper now enforces IP address uniqueness (maximum 1 proxy per IP host), preventing the pool from being diluted by multiple ports on the same host and maximizing genuine egress IP diversity.

---

## [3.2.2] - 2026-10-31 — Bun Stream Abortion Bug Elimination, Isolated FetchSession Connection Pool, and High-Throughput Egress Routing

### 🚀 Long Stream Cutoff Fix ("Beech Beech Mai Stream Cut Ho Jana")
- **Eliminated 8s Stream Abort Bomb**: Fixed a critical bug where `proxyAttemptTimeout` (8000ms) was passed to the Bun bridge as `x-opencode2api-timeout-ms`, causing Bun's `AbortSignal.timeout(8000)` to force-abort the upstream SSE connection at exactly 8.0 seconds mid-generation. Long-running completions streaming thousands of tokens (2,000+ tokens) were severed with HTTP 502.
- **Full Request Deadline Passed to Bridge**: The Bun bridge now receives the full stream deadline (`streamDeadlineMs`, minimum 60s–90s) via `x-opencode2api-timeout-ms`, while Node's 5s connect timeout is strictly disarmed with `upstreamReq.setTimeout(0)` the moment initial response headers arrive.
- **Stream Chunk Watchdog**: Implemented an active JavaScript chunk-to-chunk watchdog in both OpenAI and Anthropic streaming pipelines that refreshes on every incoming SSE chunk (60s idle timeout), ensuring active completions never get severed while frozen or hung sockets are cleaned up safely.

### 🔄 Zero-Reuse Isolated `FetchSession` for Rotating Proxies
- **Eliminated Bun Global TCP Socket Pooling**: Discovered that Bun stripped `Connection: close` (WHATWG Fetch specification prohibits setting forbidden `Connection` header in client requests), keeping TCP CONNECT tunnels open in the global pool. Consequently, retries and subsequent requests reused the same socket and hit the exact same rate-limited exit IP.
- **Isolated `Bun.FetchSession` Per Egress Hop**: When using proxies or rotating proxies, the bridge now spawns an isolated `Bun.FetchSession` that automatically disposes all sockets via `TransformStream` on `flush` or `cancel`. Rotating proxies (Webshare, Smartproxy, Bright Data, Oxylabs, etc.) are guaranteed a brand-new TCP handshake and fresh exit IP on every single request and retry.
- **Instant Quota Failover**: Quota failovers immediately continue to the next routable proxy or fresh rotating exit IP without artificial waiting or socket hang timeouts.

### 🎨 Dashboard UI Egress State Alignment
- **Dynamic Egress Mode Display**: Replaced hardcoded "Explicit pool, fail-closed routing" text in `Sidebar.jsx` with dynamic mode status reflecting active configuration: Residential Rotating Egress, Auto Discovery + Verified Pool, Explicit Pool, or Direct Egress.

---

## [3.2.1] - 2026-10-31 — Model Fidelity Guarantee, Clean Upstream Session Minting, and Port-Based Rotating Proxy Auth Parity

### 🎯 Model Fidelity Guarantee (No Unwanted Model Fallback)
- **Strict Model Preservation**: Removed model-switching fallbacks from the proxy retry and quota failover loops across both OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) handlers. When a user requests `big-pickle`, the gateway strictly stays on `big-pickle` across all proxy failovers and retries without ever silently altering the requested model.

### 🧹 Upstream Session Affinity Bleed Elimination
- **Removed Cloudflare Session-Pinning Headers**: Stripped non-standard headers (`x-session-affinity`, `X-Session-Id`, `x-opencode-session-id`) that caused Cloudflare Edge to pin incoming requests to previously exhausted rate-limit buckets.
- **Fresh Canonical Session Minting**: Each inference request now mints a fresh canonical `sessionId` and `projectId` per attempt, preventing rate-limit state from bleeding across unrelated chats or subsequent requests.

### 🔄 Port-Based Rotating Proxy Auth Parity
- **Preserved Raw Credentials in `auto` Mode**: Port-based rotating proxies (Webshare, Proxy-Cheap, StormProxies) rotate exit IPs on every new connection and reject mutated usernames. In `auto` mode, credentials are now preserved as-is to eliminate `407 Proxy Authentication Required` and socket timeouts, while `session_suffix` mode remains available for residential providers (Smartproxy, Bright Data) that rotate via username suffix.

---

## [3.2.0] - 2026-10-31 — Universal Rotating Proxy Session Injection, Instant Smart Fallback, and Resilient Gateway Availability

### 🔄 Universal Rotating Proxy Smart Session Injection
- **Automatic IP Rotation on Every Request (`auto` mode)**: Fixed a critical issue where default `auto` mode did not mutate proxy credentials, causing Bun and proxy providers to reuse identical sticky exit IPs that remained rate-limited (`FreeUsageLimitError` 429 loops). In v3.2.0, `applyRotatingSession` dynamically injects and rotates isolated session hex IDs (`-session-<rand>`) across both Bun bridge and Node.js egress for all major providers (Webshare, Smartproxy, Bright Data, Oxylabs, IPRoyal, Rayobyte).
- **Sticky Session Renewal**: Automatically detects existing `-session-`, `_session_`, and `{session}` placeholders and mints fresh random tokens per request/retry.
- **Node.js Direct Egress & Probe Parity**: Synchronized rotating proxy session headers inside `server/egress.js` `_connectViaProxy` so connection tests and direct socket probes test the exact same rotating credentials used during production inference.

### 🛡️ Non-Disruptive Gateway Availability & Docker Healthcheck Protection
- **Permanent Rotating Gateway Readiness**: Removed destructive circuit-breaker trip (`openUntil = now + backoff`) from rotating proxies. Because rotating proxies represent millions of exit IPs, a single slow or timed-out exit node no longer shuts down the entire proxy endpoint or causes `/readyz` to return 503.
- **Eliminated Container SIGTERM Kills**: With `/readyz` protected from false 503 outages, Docker and container orchestrators (Dokploy, Coolify) no longer fail health checks or terminate the gateway with `npm error signal SIGTERM`.

### ⚡ Bounded Fast Timeouts & Instant Smart Fallback
- **Fast 8s Proxy Timeout**: Reduced default `rotating_proxy_timeout_ms` from 15s to 8s, eliminating long 30s+ request stalls when a peer hangs.
- **Instant Model Fallback on Repeated 429**: When a free model (e.g. `big-pickle`) encounters 3 consecutive upstream 429 quota responses on a rotating proxy, the gateway automatically triggers Smart Fallback to an available free model (`deepseek-v4.1-flash`, `glm-5.3-flash`, `mimo-v2.6-flash`), completing client requests in 2–3s rather than burning 20 retries on an exhausted model.
- **Corrected Bridge Error Header Matching**: Fixed proxy failure classification in `server/proxy.js` so `x-opencode2api-bridge-error: proxy_failure` is properly detected and never falsely attributed to bridge crashes.

---

## [3.1.1] - 2026-10-31 — UHQ Active Probe Proxy Screening and Dashboard State Synchronization

### 🛠️ Settings Form & State Auto-Reset Fix
- **Eliminated Background Polling Collision**: Previously, `fetchAllData()` executed every 5 seconds, triggering an unconditional `useEffect` in `Settings.jsx` that clobbered the user's active form edits (flipping the Rotating Proxy toggle back to OFF and wiping newly entered proxy URLs before they could be saved).
- **One-Time Form Initialization**: Guarded form fields with `initializedRef` so settings only initialize once when loaded from the server, preventing background polling from overwriting user changes.
- **Active Tab Polling Suppression**: In `App.jsx`, polling `/api/settings` is paused whenever the user is actively navigating the Settings tab, with immediate state synchronization occurring upon explicit save.
- **Runtime Environment Synchronization**: Synced `ROTATING_PROXY_ENABLED`, `ROTATING_PROXY_URL`, and `ROTATING_PROXY_SESSION_MODE` directly into `process.env` and added them to `EXPLICIT_ENV_KEYS` to ensure persistence across config saves.

### 💎 Ultra-High-Quality (UHQ) Proxy Active Probe & Screening
- **Active HTTP 200 Verification Probe**: Previously, `_probeRoute` only checked TLS handshakes to `opencode.ai:443`. Burned datacenter proxies passed TLS but failed on inference with `FreeUsageLimitError` (429) or Cloudflare CAPTCHAs (403), causing long 30s+ retry hops. Probes now execute an active HTTP/1.1 request (`GET /zen/v1/models`) and strictly verify `HTTP/1.1 200 OK` before admitting any proxy into the routing pool.
- **Elimination of Port 443/8443 TLS EPROTO Errors**: Scraped candidates listening on ports 443 and 8443 are automatically recognized as `https://` schemes, preventing `EPROTO: The TLS handshake failed` transport errors.
- **Curated Elite & Residential Sources**: Prioritized verified high-yield lists (`proxifly-us`, `proxyscrape-elite-v4`, `hideip-https`, `hideip-http`, `proxifly-ca`, `proxifly-gb`, `spys-me-us-http`, `proxyscrape-v2-elite`) to ensure higher uptime and clean IPs.

---

## [3.1.0] - 2026-10-31 — Dedicated Rotating Proxy Support, Ultra-Strict 3s High-Concurrency Scraper, and Instant Rate Limit Switching

### 🔄 Dedicated Rotating Proxy Support
- **Single Backconnect Gateway Endpoint**: Added native dashboard support for backconnect rotating proxies (Webshare, Smartproxy, Oxylabs, BrightData, IPRoyal). Users simply toggle **Rotating Proxy Mode** ON in Dashboard Settings and provide a single endpoint URL (`http://user:pass@host:port` or `socks5://...`), bypassing the need to maintain multi-line lists of static proxies.
- **Dynamic Session Injection**: Supports `auto`, `session_suffix`, and `disabled` modes. Dynamically replaces `{session}` or `{rand}` tokens in credentials or automatically appends isolated session suffixes (`-session-<hex>`) per request to guarantee IP rotation.
- **TCP Keep-Alive Termination for Fresh Exit IPs**: Standard HTTP keep-alive sockets reused TCP connections, pinning requests to the same exit IP and triggering repeated rate limits. v3.1.0 forces `keepAlive: false` in Node.js and injects `Connection: close` (`x-opencode2api-force-rotate: 1`) through the Bun bridge so every request opens a fresh socket and receives a clean exit IP.
- **Elimination of 60s Quota Lockouts**: Rotating proxy routes are marked with `isRotating: true` and are immune to 60-second quota lockouts on upstream 429 errors. Stale free-quota gate memory never blocks rotating proxies, ensuring non-stop throughput.

### ⚡ Ultra-Strict 3s Scraper & High-Concurrency 5x Verifier
- **Ultra-Hard 3s Screening Window**: Lowered screening and verification timeouts to a strict 3000ms (`SCREEN_TIMEOUT_MS = 3000`, `VERIFY_TIMEOUT_MS = 3000`, `MAX_VERIFIED_LATENCY_MS = 3000`), rejecting slow, sluggish, or hanging public proxies.
- **Strict 5x Sequential Verification**: Every discovered candidate must successfully complete five consecutive end-to-end TLS verification probes against the upstream inference endpoint with average latency under 3000ms before admission into rotation.
- **High-Concurrency Screening Engine**: Doubled screening concurrency to 200 workers (`SCREEN_CONCURRENCY = 200`) and verification concurrency to 60 workers (`VERIFY_CONCURRENCY = 60`), allowing thousands of scraped candidates to be processed in seconds.
- **High-Yield Sources**: Replaced inactive sources with working public lists (`clarketm`, `proxifly-all`, `monosans-all`, `vakhov-https`, `ercindedeoglu-https`, `murongpig-http`).
- **On-Demand Scraping & Testing**: Added "Scrape Proxies Now" and "Test Connection" buttons directly into the React control plane for live verification.

### 🚀 Instant Rate-Limit & Quota Switching
- **Zero-Latency Proxy Hopping**: On upstream 429 rate limit or quota response, the gateway rotates canonical session and project identifiers and immediately retries the next routable proxy without artificial sleeps or exponential delays.
- **Bounded Proxy Attempt Timeouts**: Added `proxy_attempt_timeout_ms` (default 8s) and embedded `AbortSignal.timeout` in Bun bridge's fetch, preventing slow or hanging proxies from stalling the entire inference pipeline or triggering client-side timeouts.
- **Immediate Failure Classification**: Timeouts on proxy sockets are immediately identified as proxy transport failures (`proxyFailure: true`), instantly routing traffic to the next healthy proxy candidate.
- **Extended Quota Failover Budget**: Raised `proxy_quota_failovers` to 20 across the pool to maximize completion probability during peak load.

---

## [3.0.0] - 2026-10-26 — Zero-Config Automatic Proxy Egress, Round-Robin Quota Failover, and Bounded Admission

> This release supersedes the quota-rotation and WARP-tunnel design described in the entries below. WARP support has been removed entirely. Egress is automatically discovered and verified HTTP/HTTPS/SOCKS5, with optional manual overrides.

### Free-tier transport

- **CLI Bun bridge**: the official inference gate rejects Node's TLS fingerprint with a `429` that the previous build could mistake for exhausted quota. The gateway now discovers the OpenCode CLI, starts `server/bunProxy.js` under the CLI's embedded Bun runtime (`BUN_BE_BUN=1`) on a random loopback port with a per-process random token, and forwards `/inference/*` through it while preserving SSE streaming. The bridge is supervised (health probe, exponential restart, parent-exit watchdog) and performs the per-request egress proxy hop inside Bun so route rotation still applies.
- **No false quota poisoning**: a direct Node `429` from the official host is treated as a fingerprint rejection and no longer sets the global free-tier quota block. Only a request actually carried by the bridge (or a custom non-official upstream) can trip the fail-fast gate.
- **Upstream context gate**: free-tier requests to the official endpoint append the CLI's `<env>` block (working directory, workspace root, git-repo flag, platform) to the existing system prompt instead of replacing it.
- **Canonical inference path**: the default upstream is now `/inference/openai/v1/chat/completions`; the previously persisted `/inference/v1/chat/completions` is migrated in memory and still accepted.
- **Readiness**: `/healthz` reports the bridge state and `/readyz` returns `503` while the bridge is required but not ready. `BUN_BRIDGE_ENABLED=false` disables the bridge; `BUN_BRIDGE_CLI_PATH` overrides CLI discovery.
- **Docker**: the runtime image installs `@opencode/cli` at a pinned version (`OPENCODE_CLI_VERSION`, default `2.1.4`) so the documented Compose deployment keeps working free-tier inference.

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

- `npm test` runs the security suite plus the 54-test reliability suite covering proxy parsing (including IPv6), SOCKS5 frames, retry classification, quota cooldown, round-robin selection, quota failover, direct-fallback preference, 5x health-check gating, failed-sweep persistence, immediate tunnel-failure backoff, interval clamping, manual pruning, automatic-discovery parsing/filtering/cooldowns/five-probe gating/capacity/source failures, mid-run discovery disable, manual/automatic pool merging, automatic-route pruning, the global free-quota gate (exact reset, no shortening, default block, clear on success), queue limits/timeouts, and the Bun bridge (CLI discovery, official-URL detection, proxy URL/header round-trip, required/ready status, direct-429 quota guard, and `<env>` gate injection).
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
