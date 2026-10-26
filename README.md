<div align="center">

![OpenCode2API Banner](docs/banner.svg)

# ⚡ OpenCode2API v3.0.0

### High-Performance OpenAI & Anthropic Compatible Gateway for OpenCode Models

> **Zero-config intelligent egress: discovers, verifies, latency-ranks, rotates, and prunes public HTTP/HTTPS routes with Bun TLS fingerprint synchronization, resilient proxy failover, and real-time SSE streaming.**

[![Version](https://img.shields.io/badge/Version-v3.0.0-00E5FF.svg?style=for-the-badge&logo=semver&logoColor=white)](package.json)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933.svg?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker Compose](https://img.shields.io/badge/Docker_Compose-Ready-2496ED.svg?style=for-the-badge&logo=docker&logoColor=white)](docker-compose.yml)
[![Egress](https://img.shields.io/badge/Egress-Latency--Ranked_US_Pool-FF6D00.svg?style=for-the-badge)](https://github.com/Nystic-Shadow/Opencode2api)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge&logo=opensourceinitiative&logoColor=white)](LICENSE)

</div>

---

> [!WARNING]
> ### ⚠️ Educational & Research Purpose Disclaimer
> This software project is designed and released **strictly for educational, protocol research, and reverse-engineering study purposes**. It demonstrates modern API translation architectures, loopback TLS fingerprint matching, dynamic proxy pool lifecycle management, and cross-schema streaming protocols between OpenAI SSE and Anthropic Messages.
> 
> The developers and contributors do **not** encourage, condone, or support any abuse of third-party platforms or violation of upstream Terms of Service. Users are exclusively responsible for their own usage and must ensure compliance with all applicable platform policies, terms of service, and local laws.

---

## 📖 Table of Contents

- [What OpenCode2API Does](#what-opencode2api-does)
- [Architecture & Upstream Quota Reality](#architecture--upstream-quota-reality)
  - [Residential ISP vs. Cloud Datacenter IPs](#residential-isp-vs-cloud-datacenter-ips)
  - [3 Ways to 100% Reliability](#3-ways-to-100-reliability)
- [Key Features in v3.0.0](#key-features-in-v300)
- [Discovered Models Roster](#discovered-models-roster)
- [Quickstart: Local Installation (Recommended)](#quickstart-local-installation-recommended)
- [Quickstart: Docker & Docker Compose](#quickstart-docker--docker-compose)
- [Deploying to Dokploy / Coolify](#deploying-to-dokploy--coolify)
- [Zero-Cost Remote Access via Cloudflare Tunnel](#zero-cost-remote-access-via-cloudflare-tunnel)
- [Turnkey PowerShell Testing Scripts](#turnkey-powershell-testing-scripts)
- [API Usage Examples](#api-usage-examples)
  - [OpenAI Chat Completions](#openai-chat-completions)
  - [Anthropic Messages](#anthropic-messages)
  - [Streaming in Python](#streaming-in-python)
- [Configuration Reference](#configuration-reference)
- [License](#license)

---

## What OpenCode2API Does

OpenCode2API acts as a drop-in gateway translating standard **OpenAI** (`/v1/chat/completions`) and **Anthropic** (`/v1/messages`) requests to OpenCode Zen inference endpoints. It eliminates the friction of proprietary CLI formats, offering:

- **Universal Client Support**: Works natively in Cursor, VS Code (Continue/Cline), LibreChat, OpenAI SDK, Anthropic SDK, LangChain, and LiteLLM.
- **Deep Reasoning Traces**: Streams interleaved `<think>` blocks as `reasoning_content` (OpenAI) and `thinking_delta` (Anthropic).
- **Core Tool Calling**: Merges OpenCode CLI tool schemas upstream while allowing custom client function calling.
- **Vision Integration**: Accepts multi-modal images via OpenAI base64 `image_url` and Anthropic `image` blocks.
- **Built-in Control Plane**: React-based dashboard with live request telemetry, interactive playground, scoped `O2P-` API key manager, and proxy diagnostics.

---

## Architecture & Upstream Quota Reality

### Residential ISP vs. Cloud Datacenter IPs

When using the anonymous free tier (`Authorization: Bearer public`), OpenCode enforces **per-IP rate limiting and daily usage quotas** guarded by Cloudflare bot management:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        UPSTREAM EGRESS ARCHITECTURE                    │
├───────────────────────────────┬────────────────────────────────────────┤
│ Local PC (Residential ISP)    │ Cloud VPS / Public Datacenter Proxies   │
├───────────────────────────────┼────────────────────────────────────────┤
│ ✅ Clean Residential IP Range │ ❌ Shared Datacenter ASN (AWS/Hetzner) │
│ ✅ Never flagged by Bot Guard │ ❌ Cloudflare IP reputation penalty    │
│ ✅ Full Free Daily Quota      │ ❌ Shared Free Quota exhausted early   │
│ ✅ 100% Success Rate (2–4s)   │ ⚠️ Returns FreeUsageLimitError (429)   │
└───────────────────────────────┴────────────────────────────────────────┘
```

When public proxies from scraped lists are used on cloud servers (Dokploy, VPS, AWS), Cloudflare detects datacenter ASN ranges where multiple bots have already burned the anonymous free tier quota for that day, returning:
```json
{
  "type": "error",
  "error": {
    "type": "FreeUsageLimitError",
    "message": "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"
  }
}
```
*(With an upstream `Retry-After: 41514` header resetting at midnight UTC).*

### 3 Ways to 100% Reliability

Depending on your environment, you can achieve **100% zero-drop pass rates**:

1. **Local Daemon (Zero Cost, 100% Free)**:
   Running OpenCode2API on your local machine uses your personal broadband/residential IP. It bypasses Cloudflare datacenter blocks with 100% success rate across all models.
2. **Upstream Zen Key (Recommended for Cloud VPS / Dokploy)**:
   Add your genuine OpenCode Zen Key / API key in Dashboard Settings or via `OPENCODE_ZEN_KEY` environment variable. Authenticated requests use `Bearer <key>`, completely bypassing anonymous IP quotas on any server.
3. **Private / Residential Proxies**:
   If hosting on a VPS without a Zen key, add dedicated residential proxy URLs (such as Webshare, BrightData, or IPRoyal) under **Proxy Egress -> Manual Proxies**.

---

## Key Features in v3.0.0

- 🧵 **Loopback Bun TLS Bridge**: OpenCode's upstream gate rejects Node.js TLS fingerprints. v3.0.0 launches an embedded Bun worker under `BUN_BE_BUN=1` using OpenCode CLI v2.1.4, matching upstream client fingerprints byte-for-byte.
- ⚡ **Latency-Ranked Routing**: Active proxies are sorted dynamically by measured latency ascending; completions round-robin exclusively across the top 12 fastest routes.
- 🛡️ **Pool-First Sequential Failover**: When a proxy hits an upstream rate limit, it cools down and immediately fails over to the next fastest proxy in the pool (up to 10 failovers) before attempting fallback.
- 🌐 **13 US-Targeted Proxy Sources**: Continuously screens candidates targeting United States endpoints to eliminate `RegionError: This model is not available in your country` (403).
- 🔄 **Bun Proxy Protocol Safety**: Enforces pure HTTP/HTTPS CONNECT tunneling across all scraped candidates, eliminating `UnsupportedProxyProtocol` crashes.
- 📊 **No Synthetic Telemetry**: Real 60-second sliding-window RPM, TPM, latency, and token allocation calculations with detailed request audit logs.

---

## Discovered Models Roster

Discovered and dynamically mapped from OpenCode Zen:

| Model ID | Provider | Context | Modality | Reasoning |
| :--- | :--- | :--- | :--- | :---: |
| `big-pickle` | OpenCode Zen | 128k | Text | ✅ Extended |
| `beam` | OpenCode Zen | 128k | Text | ✅ Native |
| `glm-5.3-flash` | GLM / Zhipu | 128k | Text / Code | ✅ Native |
| `deepseek-v4.1-flash` | DeepSeek | 128k | Text / Code | ✅ Native |
| `mimo-v2.6-flash` | Mimo | 128k | Multimodal Vision | ❌ Standard |
| `nemotron-3.5-super-vl` | NVIDIA | 128k | Multimodal Vision | ❌ Standard |
| `nemotron-3.5-lightning` | NVIDIA | 128k | Text / Code | ❌ Fast |
| `flint-40b` | Flint | 128k | Text / Code | ❌ Standard |

---

## Quickstart: Local Installation (Recommended)

Running locally gives you **100% free, unthrottled access** through your residential connection.

### 1. Prerequisites
- **Node.js**: v20 or higher installed ([nodejs.org](https://nodejs.org/))
- **OpenCode CLI**: Installed globally for the Bun TLS engine:
  ```bash
  npm install -g @opencode/cli@2.1.4
  ```

### 2. Clone & Install
```bash
git clone https://github.com/Nystic-Shadow/Opencode2api.git
cd Opencode2api
npm install
npm run build
```

### 3. Start Gateway
```bash
# Windows PowerShell
$env:DASHBOARD_PASS="762920"; npm start

# Linux / macOS
DASHBOARD_PASS="762920" npm start
```

### 4. Access Gateway & Playground
- **Dashboard & Playground**: [http://127.0.0.1:8080/](http://127.0.0.1:8080/)
- **API Base URL**: `http://127.0.0.1:8080/v1`
- **Master API Key**: View in `data/keys.json` or dashboard.

---

## Quickstart: Docker & Docker Compose

Deploy a self-contained container with Node.js 20 and OpenCode CLI bundled:

```bash
# 1. Clone repository
git clone https://github.com/Nystic-Shadow/Opencode2api.git
cd Opencode2api

# 2. Configure environment
cp .env.example .env
```

Edit `.env`:
```dotenv
PORT=8080
DASHBOARD_USER=admin
DASHBOARD_PASS=MySecretPassword123!
EGRESS_MODE=auto
AUTO_PROXY_TARGET=100
ALLOW_DIRECT_FALLBACK=true
```

Start the stack:
```bash
docker compose up -d --build
```

---

## Deploying to Dokploy / Coolify

OpenCode2API deploys seamlessly on **Dokploy** or **Coolify**:

1. Create a new Application in Dokploy from GitHub repository: `https://github.com/Nystic-Shadow/Opencode2api.git` (Branch: `main`).
2. Build Type: **Dockerfile** (Port: `8080`).
3. Set Environment Variables:
   ```dotenv
   DASHBOARD_USER=shadow
   DASHBOARD_PASS=762920
   EGRESS_MODE=auto
   AUTO_PROXY_TARGET=100
   ALLOW_DIRECT_FALLBACK=true
   OPENCODE_ZEN_KEY=your_optional_zen_key_here
   ```
4. Click **Deploy**. Dokploy will build the image, initialize the Bun TLS bridge, and start serving.

---

## Zero-Cost Remote Access via Cloudflare Tunnel

Want to access your local residential gateway from your phone, laptop, or cloud apps without port-forwarding or public IP exposure?

Run Cloudflare Tunnel directly on your local machine:
```powershell
npx cloudflared tunnel --url http://127.0.0.1:8080
```

Cloudflare generates a secure, free HTTPS URL (e.g. `https://random-subdomain.trycloudflare.com`). You now have an internet-accessible gateway powered by your clean residential IP!

---

## Turnkey PowerShell Testing Scripts

Ready-to-use PowerShell verification scripts are included in [`scripts/`](scripts/):

### 1. Test Chat Completions (Any Model)
```powershell
powershell -ExecutionPolicy Bypass -File scripts\test-chat.ps1 -Model "big-pickle"
```
*(Supports `-Model "beam"`, `-Model "glm-5.3-flash"`, `-Model "deepseek-v4.1-flash"`).*

### 2. Test Real-Time SSE Token Streaming
Streams characters live to console and calculates Time-To-First-Token (TTFT) and token velocity:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\test-stream.ps1 -Model "glm-5.3-flash"
```

---

## API Usage Examples

### OpenAI Chat Completions

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer O2P-54ce9d315cbf95864a41accc5e2fc69e" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "big-pickle",
    "messages": [
      {"role": "user", "content": "Explain quantum superposition in 20 words."}
    ],
    "stream": false
  }'
```

### Anthropic Messages

```bash
curl http://127.0.0.1:8080/v1/messages \
  -H "x-api-key: O2P-54ce9d315cbf95864a41accc5e2fc69e" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.3-flash",
    "max_tokens": 150,
    "messages": [
      {"role": "user", "content": "Write a haiku about high-speed AI gateways."}
    ]
  }'
```

### Streaming in Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8080/v1",
    api_key="O2P-54ce9d315cbf95864a41accc5e2fc69e"
)

response = client.chat.completions.create(
    model="glm-5.3-flash",
    messages=[{"role": "user", "content": "Count from 1 to 10."}],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
```

---

## Configuration Reference

Key environment variables in `.env`:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8080` | Port for the gateway server |
| `DASHBOARD_USER` | `admin` | Admin dashboard username |
| `DASHBOARD_PASS` | *Auto-generated* | Admin dashboard password (min 12 chars) |
| `OPENCODE_ZEN_KEY` | `""` | Optional OpenCode Zen Key for paid/authenticated quota |
| `EGRESS_MODE` | `auto` | Egress mode (`auto`, `proxy_only`, `direct`) |
| `ALLOW_DIRECT_FALLBACK` | `true` | Fallback to host egress if all proxies are exhausted |
| `AUTO_PROXY_TARGET` | `100` | Target verified proxy pool size |
| `MAX_PROXY_POOL` | `150` | Maximum combined proxy pool capacity |
| `PROXY_QUOTA_FAILOVERS` | `10` | Maximum proxy hops on 429 quota before deadline |
| `REQUEST_TIMEOUT_MS` | `30000` | Timeout per inference attempt (30 seconds) |
| `REQUEST_DEADLINE_MS` | `90000` | Total end-to-end inference deadline (90 seconds) |
| `GLOBAL_CONCURRENCY` | `8` | Maximum simultaneous upstream inferences |

---

## License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

Developed for educational and technical research into high-performance AI gateways and reverse-proxy protocol adapters.
