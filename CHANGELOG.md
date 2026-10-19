# 📜 OpenCode2API Changelog

All notable changes to this project are documented in this file.

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
