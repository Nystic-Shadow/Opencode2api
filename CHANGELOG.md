# 📜 OpenCode2API Changelog

All notable changes to this project are documented in this file.

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
