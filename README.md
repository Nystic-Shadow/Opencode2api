<div align="center">

![OpenCode2API Banner](docs/banner.svg)

# OpenCode2API Gateway & Control Plane

> **Transform Free OpenCode Zen Models into Enterprise-Grade, 100% Resilient OpenAI & Anthropic Endpoints.**

[![License: MIT](https://img.shields.io/badge/License-MIT-2fbc5b.svg?style=for-the-badge&logo=opensourceinitiative&logoColor=white)](LICENSE)
[![Gateway Pass Rate](https://img.shields.io/badge/Pass_Rate-100%25_Zero--Drop-2fbc5b.svg?style=for-the-badge&logo=checkmarx&logoColor=white)]()
[![Zero Dependencies](https://img.shields.io/badge/Server_Deps-0_External-007acc.svg?style=for-the-badge&logo=node.js&logoColor=white)](server/)
[![React 19](https://img.shields.io/badge/Control_Plane-React_19-61DAFB.svg?style=for-the-badge&logo=react&logoColor=black)](client/)
[![Cloudflare WARP](https://img.shields.io/badge/Tunnel-Cloudflare_WARP-F38020.svg?style=for-the-badge&logo=cloudflare&logoColor=white)](https://1.1.1.1/)
[![Docker Ready](https://img.shields.io/badge/Docker-Ready-2496ED.svg?style=for-the-badge&logo=docker&logoColor=white)](Dockerfile)

<br />

**OpenCode2API** is a high-throughput, zero-dependency API Gateway and visual Control Plane designed to liberate free OpenCode Zen models for daily development. Connect free models into **Cursor**, **Cline**, **Roo Code**, **Continue**, **LibreChat**, **OpenAI SDK**, and **Anthropic SDK** with **native tool calling**, **multimodal vision**, **extended thinking streaming**, and **automatic Cloudflare WARP failover**.

</div>

---

## 🏗️ System Architecture & Failover Pipeline

```mermaid
flowchart TD
    subgraph ClientLayer ["Client Applications"]
        IDE["Cursor / Cline / Roo / Continue"]
        SDK["OpenAI / Anthropic SDKs & Agents"]
    end

    subgraph Gateway ["OpenCode2API Gateway (Port 8080)"]
        Router{"Request Router"}
        Auth["Key & Quota Validator (O2P-*)"]
        ToolInj["Core CLI Tool Injector (Anti-Bot Gate Bypass)"]
        SessMint["Descending Session Minter (ses_*)"]
        SSE["Zero-Latency SSE Streamer"]
        Cascade["Smart Cascade Failover (glm -> beam / deepseek)"]
        WarpCtrl["Cloudflare WARP Proxy & Key Rotator (127.0.0.1:40000)"]
    end

    subgraph Upstream ["Upstream Infrastructure"]
        Zen["OpenCode Zen Cloud Engine"]
        CF["Cloudflare Edge Egress (Rotatable IP)"]
    end

    IDE & SDK -->|"HTTP /v1/chat/completions or /v1/messages"| Router
    Router --> Auth
    Auth --> ToolInj
    ToolInj --> SessMint
    SessMint -->|"Direct Inference"| Zen
    Zen -.->|"401 / 403 / FreeTierError"| WarpCtrl
    WarpCtrl -->|"Route via SOCKS5 Tunnel"| CF
    CF --> Zen
    Zen -.->|"429 Model Throttled"| Cascade
    Cascade -->|"Failover Healthy Model"| Zen
    Zen --> SSE --> IDE & SDK
```

---

## 🔮 What Makes OpenCode2API Unique & How We Patched It

OpenCode Zen models are strictly locked behind an upstream anti-bot barrier that returns:
> `403 Forbidden: "OpenCode Zen models can only be used with the OpenCode CLI"`

OpenCode2API completely neutralizes this barrier and guarantees **100% zero-drop availability** through five deep architectural patches:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                             5-LAYER RESILIENCE ENGINE                                  │
├─────────────────────────┬──────────────────────────────────────────────────────────────┤
│ 1. Core Tool Merging    │ Injects official decompiled CLI schemas (shell, edit, glob,  │
│                         │ grep, read) alongside client tools to bypass bot detection.  │
├─────────────────────────┼──────────────────────────────────────────────────────────────┤
│ 2. Canonical Sessions   │ Generates exact inverted 48-bit millisecond timestamps       │
│                         │ ~(ts * 4096 + counter) conforming to Identifier.descending().│
├─────────────────────────┼──────────────────────────────────────────────────────────────┤
│ 3. Cloudflare WARP      │ Native RFC 1928 SOCKS5 tunnel with automatic WireGuard key   │
│    Dynamic Rotation     │ rotation on 401/403 unauth to reset edge egress in ~1.2s.    │
├─────────────────────────┼──────────────────────────────────────────────────────────────┤
│ 4. Claude 3.7 Thinking  │ Translates reasoning tokens to content_block_start/delta     │
│    SSE Protocol         │ thinking events with cryptographic signatures for Cline/IDE. │
├─────────────────────────┼──────────────────────────────────────────────────────────────┤
│ 5. Auto Model Discovery │ Discovers active Zen models every 10 min, automatically      │
│    & Zero-Drop Fallback │ stripping '-free' suffixes; auto-fails over throttled models.│
└─────────────────────────┴──────────────────────────────────────────────────────────────┘
```

### 1. Mandatory Core CLI Tool Injection (`server/tools.js`)
OpenCode's server examines incoming `tools` payloads. Non-CLI tools or empty arrays trigger an instant bot block. Our gateway's `mergeTools()` combines any caller-defined functions with the 5 core CLI tool schemas, satisfying upstream validation byte-for-byte while preserving client tools intact.

### 2. Decompiled Millisecond Session Inversion (`server/identity.js`)
Session IDs are minted using OpenCode's proprietary descending inversion algorithm:
$$\text{Part}_{\text{time}} = \sim(\text{Date.now()} \times 4096 + \text{seq})$$
Combined with 14 Base62 random entropy characters, this produces genuine `ses_[0-9a-f]{12}[0-9A-Za-z]{14}` tokens that pass upstream temporal verification without expiring.

### 3. Cloudflare WARP Proxy & Tunnel Key Rotation (`server/warp.js`)
When an IP hits free-tier hourly usage limits (`FreeTierError`), the gateway automatically switches egress to a local Cloudflare WARP SOCKS5 client on `127.0.0.1:40000`. If WARP's egress is exhausted, it rotates tunnel keys (`warp-cli tunnel rotate-keys`) to acquire a fresh Cloudflare edge IP in 1.2 seconds, retrying seamlessly without dropping the client socket.

### 4. Claude 3.7 Extended Thinking Streaming Protocol (`server/proxy.js`)
In Anthropic mode (`/v1/messages`), deep reasoning traces are translated into standard Anthropic extended thinking blocks (`type: 'thinking'` and `type: 'thinking_delta'`), followed by text or tool blocks, making reasoning models immediately compatible with Cursor, Cline, and Roo Code.

### 5. Autonomous CLI Version Sync & Model Auto-Discovery
The gateway background worker polls official GitHub releases (`anomalyco/opencode`) and the npm registry. Newly released CLI versions are hot-applied to headers without container restarts, and newly added Zen models are automatically discovered and cataloged without hardcoded mappings.

---

## 🖼️ Visual Control Plane Tour

Captured live from the high-performance liquid-glass web interface (`1440x920` Retina):

### 1. System Telemetry & Live 60-Second Performance Monitor
Real-time tracking of RPM, TPM, Token Allocation (Prompt / Completion / Reasoning), Latency, and Genuine 60-second sampled time-series graph.
![Telemetry Dashboard](docs/screenshots/overview.png)

---

### 2. Interactive Test Playground
Dual OpenAI & Anthropic chat interface with live thinking token inspection, image attachments, and temperature controls.
![Interactive Playground](docs/screenshots/playground.png)

---

### 3. Elevated Model Selector & Capability Inspector
Switch dynamically across auto-discovered models with capability badges (Vision, Tools, Reasoning, Context Window).
![Model Dropdown](docs/screenshots/model-dropdown.png)

---

### 4. Multi-Tenant Scoped API Keys & Quota Allocator
Issue custom `O2P-` keys with independent RPM/TPM caps, token budget sliders in K/M, model whitelists, and expiration policies.
![API Key Management](docs/screenshots/api-keys.png)

---

### 5. Auto-Discovered Zen Models Catalog
All available models synchronized directly from OpenCode Zen with clean IDs (zero `-free` suffix leaks) and one-click manual discovery sync.
![Models Catalog](docs/screenshots/models.png)

---

## ⚡ Technology Stack

| Layer | Technologies Used | Key Highlights |
| :--- | :--- | :--- |
| **Backend Core** | Native Node.js (`http`, `https`, `crypto`, `net`) | **Zero external server dependencies**, <30MB RAM, sub-millisecond cold start |
| **Frontend UI** | React 19, Vite, Tailwind CSS, Lucide Icons | Responsive Cyberpunk Liquid Glass design, instant optimistic state |
| **Background WebGL**| Originkit Spark Lattice WebGL Engine | Lightweight ambient GPU particle canvas running in background |
| **Tunneling Egress**| Cloudflare WARP Daemon + RFC 1928 SOCKS5 Client | Built-in WireGuard key rotation, auto-failover, zero dropped TCP connections |
| **Containerization**| Alpine Linux Docker, Multi-Stage Build | Ultra-compact Docker image ready for Coolify, Dokploy, VPS, and local hosts |

---

## 🚀 Quickstart & Deployment

### Option A: Docker Compose (Recommended)

```bash
docker compose up -d --build
```

```yaml
version: '3.8'

services:
  gateway:
    build: .
    container_name: opencode2api
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - PORT=8080
      - DASHBOARD_USER=admin
      - DASHBOARD_PASS=admin123
    volumes:
      - ./data:/app/data
```

### Option B: Local Node.js (v18+)

```bash
git clone https://github.com/Nystic-Shadow/Opencode2api.git
cd Opencode2api

npm run build    # Compile React 19 control plane
npm start        # Start gateway on http://127.0.0.1:8080
```

### Access Endpoints
- **Web Control Plane:** `http://127.0.0.1:8080/` (Login: `admin` / `admin123`)
- **OpenAI Compatible Base URL:** `http://127.0.0.1:8080/v1`
- **Anthropic Messages Endpoint:** `http://127.0.0.1:8080/v1/messages`
- **Master Admin API Key:** `O2P-master-key`

---

## 🔌 IDE & Client Configuration

Use clean model identifiers (e.g. `deepseek-v4.1-flash`, `nemotron-3.5-super-vl`, `beam`). No `-free` suffixes required!

### Cursor & Continue
- **Base URL:** `http://127.0.0.1:8080/v1`
- **API Key:** `O2P-master-key` (or your custom scoped key)
- **Model:** `deepseek-v4.1-flash` or `beam`

### Cline & Roo Code (Anthropic Mode)
- **API Provider:** Anthropic Compatible
- **Base URL:** `http://127.0.0.1:8080`
- **API Key:** `O2P-master-key`
- **Model ID:** `deepseek-v4.1-flash` (supports streaming reasoning tokens)

### Quick cURL Test
```bash
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer O2P-master-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4.1-flash",
    "stream": true,
    "messages": [{"role": "user", "content": "Explain quantum superposition in two sentences."}]
  }'
```

---

## 🧪 Exhaustive 15-Vector Verification Suite

The repository includes a comprehensive verification suite testing all gateway protocols:

```bash
node test_exhaustive.js
```

```
================================================================
       OpenCode2API Enterprise Gateway - Exhaustive Test Suite   
================================================================

[TEST 01] GET /healthz (Service Health & Model Count) .................... PASSED (16ms)
[TEST 02] GET /v1/models (Clean Model IDs & Capability Flags) ............ PASSED (3ms)
[TEST 03] POST /v1/chat/completions (OpenAI Non-streaming Inference) ..... PASSED (1968ms)
[TEST 04] POST /v1/chat/completions (OpenAI SSE Streaming) ............... PASSED (9470ms)
[TEST 05] POST /v1/messages (Anthropic Non-streaming Protocol) ........... PASSED (4920ms)
[TEST 06] POST /v1/messages (Anthropic SSE Streaming with Block Lifecycle) PASSED (2144ms)
[TEST 07] POST /v1/chat/completions (OpenAI Tool & Function Calling) ..... PASSED (1567ms)
[TEST 08] POST /v1/messages (Anthropic Tool Use Protocol) ................ PASSED (2296ms)
[TEST 09] POST /v1/chat/completions (Multimodal Vision / Base64 Image) ... PASSED (3134ms)
[TEST 10] POST /v1/chat/completions (Smart Failover Cascade Recovery) .... PASSED (1680ms)
[TEST 11] GET /api/warp/status (Admin Authentication & WARP Diagnostics) . PASSED (171ms)
[TEST 12] POST /api/warp/rotate (Dynamic WireGuard Key Rotation) ......... PASSED (2565ms)
[TEST 13] POST /v1/chat/completions (WARP Tunnel Egress Inference) ....... PASSED (2088ms)
[TEST 14] API Keys Lifecycle (Creation, Scoped Auth, Quota Deduction) .... PASSED (1399ms)
[TEST 15] GET /api/stats (Real-Time Metrics & Telemetry Accuracy) ........ PASSED (2ms)

================================================================
Test Execution Finished: 15 / 15 Vectors Passed (100%)
================================================================

✔ 100% GATEWAY PASS RATE ACHIEVED ACROSS ALL ENTERPRISE PROTOCOLS!
```

---

## 📜 License

This project is open-source software licensed under the [MIT License](LICENSE).
