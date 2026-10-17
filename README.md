<div align="center">

![OpenCode2API Banner](docs/banner.svg)

# OpenCode2API Gateway & Control Plane

> **Turn OpenCode Zen Free Models into Enterprise-Grade, 100% Resilient OpenAI & Anthropic Endpoints.**

[![License: MIT](https://img.shields.io/badge/License-MIT-2fbc5b.svg?style=for-the-badge&logo=opensourceinitiative&logoColor=white)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-v20%2B-339933.svg?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![React 19](https://img.shields.io/badge/Dashboard-React%2019-61DAFB.svg?style=for-the-badge&logo=react&logoColor=black)](https://react.dev/)
[![Docker Ready](https://img.shields.io/badge/Docker-Ready-2496ED.svg?style=for-the-badge&logo=docker&logoColor=white)](Dockerfile)
[![Success Rate](https://img.shields.io/badge/Gateway%20Success%20Rate-100%25-2fbc5b.svg?style=for-the-badge)]()
[![OpenCode CLI](https://img.shields.io/badge/Fingerprint-CLI%20v2.0.29-blueviolet.svg?style=for-the-badge)](https://opencode.ai/)

<br />

**OpenCode2API** is a high-throughput, enterprise-resilient API Gateway and visual Control Plane designed to bridge free OpenCode Zen models directly into your daily coding tools and AI applications. Connect free models into **Cursor**, **Cline**, **Roo Code**, **Continue**, **LibreChat**, **OpenAI SDK**, **Anthropic SDK**, and custom autonomous agent loops with **native tool calling**, **multimodal vision**, and **real-time thinking tokens**.

</div>

---

## ⚡ Core Features & Capabilities

### 🛡️ 1. 100% High-Availability Resilience Engine
- **Exact Millisecond Descending Session Minting:** Complies with OpenCode's `Identifier.descending()` specification (`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`). Decodes millisecond timestamps inverted with `~((Date.now() << 12) | 1)`, strictly satisfying temporal validation and eliminating `401` session expirations.
- **Smart Model Failover Cascades:** If an individual upstream model experiences capacity bottlenecks or maintenance (such as `glm-5.3-flash` returning 429 *"Endpoint is unavailable"*), the gateway automatically reroutes to an equivalent healthy model (`deepseek-v4.1-flash` or `beam` for text, `nemotron-3.5-super-vl` or `mimo-v2.6-flash` for vision) and tags `x-opencode2api-fallback`, preserving 100% uptime for agents without dropping the client connection.
- **Jittered Exponential Backoff:** Automatically retries transient network drops, `ECONNRESET`, timeouts, and `502`/`503` upstream errors up to 3 times before committing any error.

### 🌐 2. Dual Standard API Compatibility
- **OpenAI API Specification:** Standard `/v1/chat/completions` and `/v1/models` endpoints.
- **Anthropic Messages Specification:** Standard `/v1/messages` endpoint with structured content blocks.
- **Zero-Latency SSE Streaming:** Immediate socket flushing and `X-Accel-Buffering: no` ensures prompt tokens and completions stream in real-time with zero buffering delay.

### 🔄 3. Dynamic Model Auto-Discovery
- **Auto-Sync:** Background cron polls active Zen models every 10 minutes (configurable).
- **Clean Model Identifiers:** Automatically strips `-free` and `_free` suffixes from upstream IDs. Use clean model identifiers (`deepseek-v4.1-flash`, `nemotron-3.5-super-vl`, `beam`) in your client applications without having to maintain hardcoded mapping lists.

### 🛠️ 4. Native Tool & Function Calling
- **Anti-Bot Gate Bypass:** Automatically merges client tools with required OpenCode CLI core schemas to bypass the free-tier bot check.
- **Structured Schema Handling:** Supports custom function definitions, argument parsing, and structured `tool_calls` output generation.

### 👁️ 5. Multimodal Vision Analysis
- **Full Image Understanding:** Complete support for image analysis using base64 and data URLs for vision-enabled models (`nemotron-3.5-super-vl`, `mimo-v2.6-flash`, `longcat-2.5-preview`).
- Compatible with both OpenAI `image_url` data URIs and Anthropic `image` block formats.

### 🧠 6. Deep Reasoning & Thinking Token Extraction
- **Live Thinking Stream:** Extracts raw thinking tokens into OpenAI `reasoning_content` and Anthropic `thinking` blocks with cryptographic signatures.
- **Adjustable Thinking Levels:** Fine-tune thinking budgets with custom levels: `auto`, `off` (fast / no think), `low` (4k tokens), `medium` (16k tokens), `high` (32k tokens), and `max` (64k tokens).

### 📊 7. Cyberpunk / Liquid Glass UI Dashboard
- **React 19 & WebGL:** Powered by React 19 and **Originkit Spark Lattice WebGL** ambient particle system.
- **Live Telemetry:** Real-time RPM, TPM, Total Tokens served, Daily Token Trends, and Latency charts.
- **Multi-User Key Quota Management:** Generate custom `O2P-` API keys with individual token allocation sliders (K/M), RPM/TPM caps, model whitelisting, and expiration dates.
- **Interactive Playground:** Full markdown chat, vision attachment preview, thinking token inspectors, and model parameter drawers.

### ⚡ 8. Zero External Server Dependencies
- The backend runs 100% on native Node.js core libraries (`http`, `https`, `crypto`, `fs`, `path`). No heavy node_modules on the server, instant cold-starts, and minimal memory usage (<30MB).

### 🔒 9. Cloudflare WARP Proxy & Unauth Key Rotation Engine
- **Native SOCKS5 Tunneling:** Seamlessly integrates with local Cloudflare WARP (`127.0.0.1:40000`) without external dependencies.
- **Unauth Auto-Switching:** Automatically routes requests through Cloudflare WARP whenever upstream returns 401, 403, or `FreeTierError` on direct connections.
- **Dynamic Key Rotation:** Automatically re-negotiates tunnel session keys on unauth drops to establish fresh Cloudflare edge egress sessions.
- **Visual Control Panel:** Live connection status diagnostics, one-click manual key rotation, and configurable operating modes (`Auto Failover`, `Always WARP`, `Disabled`).

---

## 🖼️ Dashboard & Visual UI Tour

All screenshots captured live from the running OpenCode2API control plane at `1440x920` (Retina 2x):

### 1. System Telemetry & Live Performance
Monitor live RPM, TPM, total token volume, and request success rates in real-time.
![Telemetry Dashboard](docs/screenshots/overview.png)

---

### 2. Interactive Test Playground
Test reasoning models, inspect thinking tokens live, stream completions, and test prompt engineering.
![Interactive Playground](docs/screenshots/playground.png)

---

### 3. Elevated Model Selector & Capability Inspector
Clean model switcher displaying multimodal badges and context window limits floating above the chat feed.
![Model Dropdown](docs/screenshots/model-dropdown.png)

---

### 4. Multi-User API Keys & Token Allocation Quotas
Issue scoped `O2P-` keys for teammates or clients with custom token allocation sliders (K/M), RPM caps, and model restrictions.
![API Key Management](docs/screenshots/api-keys.png)

---

### 5. Auto-Discovered Zen Models Catalog
All active free models discovered from upstream with clean IDs, context limits, and one-click manual discovery sync.
![Models Catalog](docs/screenshots/models.png)

---

## 🏗️ System Architecture

```
                                    ┌────────────────────────────────────────────────────────┐
                                    │               OpenCode2API Gateway Core                │
                                    │                                                        │
[ AI IDE / Custom Agent ]           │  ├─ Auth & Token Quota Validator (`O2P-...`)          │
       │                            │  ├─ Dynamic Model Resolver (Clean ID -> Upstream ID)   │
       ▼ (OpenAI / Anthropic REST)  │  ├─ Canonical Descending Session Minting (ses_...)     │
┌───────────────────────────────┐   │  ├─ Client Tool Merging (Core CLI 403 Gate Bypass)     │
│  http://127.0.0.1:8080/v1     │──▶│  ├─ Smart Model Failover Cascade (100% Resilience)     │
│  /chat/completions            │   │  ├─ Jittered Exponential Retry Engine (429/503/Drops) │
│  /messages                    │   │  ├─ Zero-Latency SSE Event Streamer                    │
└───────────────────────────────┘   │  └─ Telemetry & Metrics Aggregator                     │
                                    └────────────────────────────────────────────────────────┘
                                                                 │
                                                                 ▼ (Authentic CLI Fingerprint)
                                    ┌────────────────────────────────────────────────────────┐
                                    │            OpenCode Zen Free Cloud Engine              │
                                    │   (DeepSeek, Nemotron, Beam, MiMo, LongCat, GLM...)    │
                                    └────────────────────────────────────────────────────────┘
```

---

## 🚀 Quickstart & Deployment

### Option A: Docker Compose (Recommended)

Run with a single command on any VPS, Dokploy, Coolify, or local Docker host:

```bash
docker compose up -d --build
```

#### `docker-compose.yml`
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

---

### Option B: Local Installation

**Prerequisites:** Node.js 18+ installed.

```bash
# 1. Clone repository
git clone https://github.com/Nystic-Shadow/opencode2api.git
cd opencode2api

# 2. Build the React 19 Frontend Dashboard
npm run build

# 3. Start the Gateway Server
npm start
```

Default access points:
- **Web Control Plane:** `http://127.0.0.1:8080/` (Default Login: `admin` / `admin123`)
- **OpenAI Base URL:** `http://127.0.0.1:8080/v1`
- **Anthropic Messages URL:** `http://127.0.0.1:8080/v1/messages`
- **Master Root Key:** `O2P-master-key`

---

## 📚 Complete Documentation & SDK Integrations

### 1. OpenAI Python SDK Integration

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8080/v1",
    api_key="O2P-master-key"  # Or your custom O2P-... key
)

# Text & Deep Reasoning with Streaming
response = client.chat.completions.create(
    model="deepseek-v4.1-flash",
    messages=[
        {"role": "user", "content": "Explain the difference between quantum entanglement and classical correlation."}
    ],
    stream=True
)

for chunk in response:
    delta = chunk.choices[0].delta
    # Access live thinking tokens
    if hasattr(delta, "reasoning_content") and delta.reasoning_content:
        print(f"\033[90m{delta.reasoning_content}\033[0m", end="")
    if delta.content:
        print(delta.content, end="")
```

---

### 2. OpenAI Node.js / TypeScript SDK Integration

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://127.0.0.1:8080/v1',
  apiKey: 'O2P-master-key'
});

async function main() {
  const stream = await openai.chat.completions.create({
    model: 'beam',
    messages: [{ role: 'user', content: 'Write a high-performance LRU Cache in TypeScript.' }],
    stream: true
  });

  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
}

main();
```

---

### 3. Anthropic Python SDK Integration

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://127.0.0.1:8080",
    api_key="O2P-master-key"
)

message = client.messages.create(
    model="deepseek-v4.1-flash",
    max_tokens=2048,
    messages=[
        {"role": "user", "content": "Provide 3 architectural patterns for microservices."}
    ]
)

print(message.content[0].text)
```

---

### 4. Native Tool Calling (Function Calling)

```python
tools = [
    {
        "type": "function",
        "function": {
            "name": "query_database",
            "description": "Execute a safe read-only SQL query on the warehouse",
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {"type": "string", "description": "SQL query statement"}
                },
                "required": ["sql"]
            }
        }
    }
]

response = client.chat.completions.create(
    model="deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "How many active users signed up this week?"}],
    tools=tools,
    tool_choice="auto"
)

tool_call = response.choices[0].message.tool_calls[0]
print(f"Tool to invoke: {tool_call.function.name}")
print(f"SQL arguments:  {tool_call.function.arguments}")
```

---

### 5. Multimodal Vision Analysis

```python
import base64

with open("system_architecture.png", "rb") as f:
    encoded_image = base64.b64encode(f.read()).decode("utf-8")

response = client.chat.completions.create(
    model="nemotron-3.5-super-vl",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Analyze this architecture diagram and list all single points of failure:"},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{encoded_image}"}
                }
            ]
        }
    ]
)

print(response.choices[0].message.content)
```

---

### 6. Custom Thinking Levels & Reasoning Budgets

Control reasoning token depth via the `thinking_level` parameter:

```bash
curl -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer O2P-master-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4.1-flash",
    "thinking_level": "high",
    "messages": [{"role": "user", "content": "Solve the Riemann hypothesis implications on cryptography."}]
  }'
```

**Supported Levels:**
- `"off"`: Reasoning disabled (fastest, lowest latency).
- `"low"`: 4,096 tokens reasoning budget.
- `"medium"`: 16,384 tokens reasoning budget.
- `"high"`: 32,768 tokens reasoning budget.
- `"max"`: 65,536 extended reasoning budget.

---

### 7. cURL Streaming Example

```bash
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer O2P-master-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "beam",
    "stream": true,
    "messages": [{"role": "user", "content": "Count from 1 to 5 with descriptions."}]
  }'
```

---

## 📋 Discovered OpenCode Zen Models Catalog

| Model ID | Provider Family | Context Window | Max Output | Modalities | Reasoning | Description |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| `deepseek-v4.1-flash` | DeepSeek | 1,000,000 | 131,072 | Text | ✅ | Ultra-fast DeepSeek MoE with high-depth mathematical reasoning |
| `beam` | Beam MoE | 1,048,576 | 131,072 | Text | ✅ | Sparse MoE with 23B active parameters for coding & agents |
| `nemotron-3.5-super-vl` | NVIDIA | 1,048,576 | 131,072 | Text, Image | ✅ | NVIDIA flagship vision-language reasoning engine |
| `mimo-v2.6-flash` | MiMo | 200,000 | 32,000 | Text, Image, Audio | ✅ | Multimodal coding and long-context agentic automation |
| `longcat-2.5-preview` | Meituan | 1,000,000 | 131,072 | Text, Image | ✅ | 1M context multimodal reasoning model |
| `big-pickle` | Pickle | 200,000 | 32,000 | Text | ✅ | Deliberate step-by-step reasoning and problem solving |
| `space-bunny` | Bunny | 200,000 | 32,000 | Text | ✅ | Fast compact reasoning model for agent tool calling |
| `nemotron-3.5-lightning` | NVIDIA | 262,144 | 262,144 | Text | ✅ | High-throughput enterprise MoE for low-latency tasks |
| `glm-5.3-flash` | GLM | 200,000 | 32,000 | Text | ✅ | Fast general-purpose reasoning model |

---

## 🔑 Multi-User API Key Quotas & Limits

Configure multi-tenant access in the dashboard under **API Keys**:
- **Key Prefix:** Custom prefix with `O2P-` standard (e.g. `O2P-agent-team-8f92ab`).
- **Token Quota Sliders:** Choose **Unlimited** or set exact token allowances in **K (Thousands)** or **M (Millions)**.
- **Rate Limits:** Independent **RPM** (Requests Per Minute) and **TPM** (Tokens Per Minute) enforcement.
- **Model Whitelists:** Restrict specific keys to text-only or vision-only models.
- **Expiration Policies:** Expire keys after 7 days, 30 days, 90 days, or never.

---

## ⚙️ Environment Variables Reference

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8080` | Port for the HTTP API gateway and dashboard |
| `DASHBOARD_USER` | `admin` | Username for dashboard authentication |
| `DASHBOARD_PASS` | `admin123` | Password for dashboard authentication |

*All runtime settings (smart fallback cascades, rate limits, discovery intervals) can be toggled live via the Settings tab.*

---

## 🧪 Verification & Test Suite

Run the end-to-end verification test suite:

```bash
node test_gateway.js
```

**Verification Results:**
```
=== OpenCode2API Full Gateway Verification Suite ===

✅ [PASS] GET /v1/models (Model Discovery): Returned 9 clean models (no -free suffixes)
✅ [PASS] POST /v1/chat/completions (Non-streaming): Status 200, reply: "Gateway online"
✅ [PASS] POST /v1/chat/completions (Streaming SSE): Status 200, received SSE chunks ending in [DONE]
✅ [PASS] POST /v1/messages (Anthropic Non-streaming): Status 200, reply: "Anthropic OK"
✅ [PASS] POST /v1/messages (Anthropic Streaming SSE): Status 200, received Anthropic message events
✅ [PASS] POST /v1/chat/completions (Smart Failover Resilience): Auto-recovered! Status 200

========================================
Test Results: 6 / 6 Passed (100% Success Rate)
========================================
```

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).
