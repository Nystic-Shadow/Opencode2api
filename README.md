# 🚀 OpenCode2API Gateway & Control Plane

> **Turn OpenCode Zen Free Models into Enterprise-Grade, 100% Reliable OpenAI & Anthropic Compatible APIs.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-v20%2B-blue.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/Dashboard-React%2019-cyan.svg)](https://react.dev/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg)](https://www.docker.com/)
[![Success Rate](https://img.shields.io/badge/Success%20Rate-100%25-brightgreen.svg)]()
[![Upstream](https://img.shields.io/badge/OpenCode-CLI%20v2.0.29-blueviolet.svg)](https://opencode.ai/)

---

## ⚡ Overview

**OpenCode2API** is a high-performance, resilient API Gateway and telemetry Control Plane that transforms the free models from OpenCode Zen into standard **OpenAI** (`/v1/chat/completions`) and **Anthropic** (`/v1/messages`) endpoints.

It enables you to connect free-tier models into any AI agent, IDE, or tool—including **Cursor**, **Cline**, **Roo Code**, **Continue**, **LibreChat**, **OpenAI SDK**, **Anthropic SDK**, **LangChain**, and custom agentic workflows—with **native tool calling**, **multimodal vision**, and **real-time thinking tokens**.

```
[ Your AI App / IDE / Agent ]
      │ (OpenAI / Anthropic REST & SSE Streaming)
      ▼
┌────────────────────────────────────────────────────────┐
│               OpenCode2API Gateway                      │
│                                                        │
│  ├─ Multi-User Key Auth (`O2P-...`) & Token Quotas     │
│  ├─ Model Auto-Discovery (Strips `-free` Suffixes)     │
│  ├─ Smart Model Failover & Auto-Retry Engine (100% SR) │
│  ├─ Invariant Gate Authentication & Session Minting    │
│  └─ Pure Node.js Core (Zero External Server Deps)      │
└────────────────────────────────────────────────────────┘
      │ (Authentic OpenCode CLI Protocols & Keep-Alive TLS)
      ▼
[ OpenCode Zen Free Infrastructure ]
```

---

## ✨ Features

- **🌐 Dual API Compatibility:**
  - Fully compatible with the **OpenAI API specification** (`/v1/chat/completions`, `/v1/models`).
  - Fully compatible with the **Anthropic Messages API specification** (`/v1/messages`).
  - Real-time Server-Sent Events (SSE) streaming with zero latency and immediate socket flushing.

- **🛡️ 100% High-Availability Resilience Engine:**
  - **Exact Millisecond Descending Session Minting:** Complies with OpenCode's `Identifier.descending()` specification (`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`) preventing session expiration or temporal rejection.
  - **Intelligent Auto-Retry:** Handles transient upstream network resets, `ECONNRESET`, timeouts, and 429/503 errors with exponential backoff and random jitter.
  - **Smart Model Failover:** If an upstream provider experiences model-specific capacity issues (e.g. `glm-5.3-flash` returning 429 "Endpoint is unavailable"), requests automatically cascade to an equivalent healthy model (`deepseek-v4.1-flash` or `beam`) without dropping the client connection.

- **🔄 Automatic Dynamic Model Discovery:**
  - Continuously discovers newly added and deprecated models from OpenCode Zen.
  - Automatically cleanses model IDs by stripping `-free` suffixes so client configs use clean names like `deepseek-v4.1-flash`, `nemotron-3.5-super-vl`, or `beam`.

- **🛠️ Native Tool & Function Calling:**
  - Transparently merges user tools with required OpenCode CLI core schemas to bypass the free-tier anti-bot gate.
  - Full structured JSON arguments parsing and `tool_calls` output generation.

- **👁️ Multimodal Vision Support:**
  - Native support for image understanding via base64 data URLs in both OpenAI (`image_url`) and Anthropic (`image`) block formats on vision-capable models (`nemotron-3.5-super-vl`, `mimo-v2.6-flash`, `longcat-2.5-preview`).

- **🧠 Deep Reasoning & Thinking Tokens:**
  - Extracts raw thinking tokens into OpenAI `reasoning_content` and Anthropic `thinking` blocks.
  - Granular control over thinking budgets: `auto`, `low` (4k), `medium` (16k), `high` (32k), and `max` (64k).

- **📊 Cyberpunk / Liquid Glass UI Dashboard:**
  - Built with **React 19** and **Originkit Spark Lattice WebGL** animated background.
  - **Real-Time Telemetry:** Live RPM, TPM, Total Tokens served, Daily Token Trends, and Latency charts.
  - **Multi-User Key Management:** Create custom `O2P-` API keys with individual token allocation sliders (K/M), RPM/TPM caps, model whitelisting, and expiration dates.
  - **Interactive Playground:** Full markdown chat, vision attachment preview, thinking token inspectors, and model parameter drawers.
  - **Zero Server Dependencies:** The gateway backend runs entirely on native Node.js libraries (`http`, `https`, `crypto`, `fs`).

---

## 🖼️ Dashboard & Playground Preview

| Interactive Model Playground | Discovered Models Catalog |
| :---: | :---: |
| ![Playground](docs/screenshots/playground.png) | ![Model Selector](docs/screenshots/model-dropdown.png) |

---

## 🚀 Quick Start

### Method 1: Local Installation

**Prerequisites:** Node.js 18+ installed.

```bash
# 1. Clone the repository
git clone https://github.com/Nystic-Shadow/Opencode2api.git
cd Opencode2api

# 2. Build the React 19 Frontend Dashboard
npm run build

# 3. Start the Gateway Server
npm start
```

The gateway is now live:
- **Dashboard & Playground:** `http://127.0.0.1:8080/` (Login: `admin` / `admin123`)
- **OpenAI Base URL:** `http://127.0.0.1:8080/v1`
- **Anthropic Messages URL:** `http://127.0.0.1:8080/v1/messages`
- **Master API Key:** `O2P-master-key`

---

### Method 2: Docker & Docker Compose

Deploy with a single command on any VPS, Dokploy, or Coolify instance:

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

## 💻 API Integration Examples

### 1. OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8080/v1",
    api_key="O2P-master-key"
)

# Text Reasoning Completion
response = client.chat.completions.create(
    model="deepseek-v4.1-flash",
    messages=[
        {"role": "user", "content": "Explain quantum superposition in 2 sentences."}
    ],
    stream=True
)

for chunk in response:
    # Access thinking tokens if present
    delta = chunk.choices[0].delta
    if hasattr(delta, "reasoning_content") and delta.reasoning_content:
        print(f"[Thinking]: {delta.reasoning_content}", end="")
    if delta.content:
        print(delta.content, end="")
```

---

### 2. Anthropic Python SDK

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://127.0.0.1:8080",
    api_key="O2P-master-key"
)

message = client.messages.create(
    model="beam",
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "Write a high-performance LRU cache in Python."}
    ]
)

print(message.content[0].text)
```

---

### 3. Tool Calling (Function Calling)

```python
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_current_weather",
            "description": "Fetch real-time weather metrics for a city",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string", "description": "City name"}
                },
                "required": ["city"]
            }
        }
    }
]

response = client.chat.completions.create(
    model="deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "What is the weather in Tokyo?"}],
    tools=tools,
    tool_choice="auto"
)

tool_call = response.choices[0].message.tool_calls[0]
print(f"Function: {tool_call.function.name}")
print(f"Arguments: {tool_call.function.arguments}")
```

---

### 4. Multimodal Vision Analysis

```python
import base64

with open("diagram.png", "rb") as f:
    base64_image = base64.b64encode(f.read()).decode("utf-8")

response = client.chat.completions.create(
    model="nemotron-3.5-super-vl",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Analyze this architecture diagram in detail:"},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{base64_image}"}
                }
            ]
        }
    ]
)

print(response.choices[0].message.content)
```

---

## 📋 Discovered OpenCode Zen Models

The gateway automatically discovers and cleanses model IDs (removing `-free` suffixes). Discovered models currently include:

| Model ID | Family | Context Window | Vision | Reasoning | Description |
| :--- | :--- | :--- | :---: | :---: | :--- |
| `deepseek-v4.1-flash` | DeepSeek | 1,000,000 | ❌ | ✅ | Ultra-fast DeepSeek MoE with deep reasoning capabilities |
| `beam` | Beam | 1,048,576 | ❌ | ✅ | Sparse mixture-of-experts model with 23B active parameters |
| `nemotron-3.5-super-vl` | NVIDIA | 1,048,576 | ✅ | ✅ | NVIDIA flagship multimodal vision-language reasoning model |
| `mimo-v2.6-flash` | MiMo | 200,000 | ✅ | ✅ | Multimodal coding and long-context agent automation |
| `longcat-2.5-preview` | Meituan | 1,000,000 | ✅ | ✅ | Multimodal reasoning model with 1M-token context |
| `big-pickle` | Pickle | 200,000 | ❌ | ✅ | Deliberate step-by-step reasoning and analytical problem solving |
| `space-bunny` | Bunny | 200,000 | ❌ | ✅ | Fast compact reasoning model for agentic tool use |
| `nemotron-3.5-lightning` | NVIDIA | 262,144 | ❌ | ✅ | High-throughput enterprise MoE for fast completions |
| `glm-5.3-flash` | GLM | 200,000 | ❌ | ✅ | Fast general-purpose reasoning model |

---

## 🔑 Multi-User API Key Quotas & Limits

Create scoped API keys in the dashboard under **API Keys**:
- **Custom Prefix:** Generates keys with standard `O2P-` prefixes (e.g. `O2P-prod-agent-7f8a9b`).
- **Flexible Token Budgets:** Choose **Unlimited** or configure a specific token allowance using the interactive slider in **K (Thousands)** or **M (Millions)** of tokens.
- **Rate Limits:** Enforce independent **RPM** (Requests Per Minute) and **TPM** (Tokens Per Minute) caps.
- **Model Whitelists:** Restrict keys to specific models (e.g., text-only or vision-only).
- **Expiration Policies:** Set keys to expire after 7 days, 30 days, 90 days, or never.

---

## ⚙️ Environment Variables

Configure via `.env` or Docker environment variables:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8080` | Port for the HTTP API gateway and dashboard |
| `DASHBOARD_USER` | `admin` | Username for dashboard authentication |
| `DASHBOARD_PASS` | `admin123` | Password for dashboard authentication |

Runtime configurations (smart fallback toggles, rate limits, discovery interval) can be updated live from the **Settings** tab in the dashboard without restarting the service.

---

## 🧪 Verification & Test Suite

Run the full end-to-end gateway test suite:

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
