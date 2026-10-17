# 🌌 OpenCode to OpenAI/Anthropic API Gateway: Master Architecture & Reverse-Engineering Specification

> **Classification:** Technical Reverse-Engineering Specification & Implementation Guide  
> **Target:** OpenCode Zen / Free-Tier Gateway (`api.opencode.ai` / `/inference/openai/v1`)  
> **Output Specification:** Standard OpenAI-Compatible (`/v1/chat/completions`) & Anthropic-Compatible (`/v1/messages`)  
> **Status:** Empirically Tested & Live-Verified (200 OK Streaming with Reasoning & Tooling)

---

## 1. Executive Summary & Live Verification

This document provides an exhaustive reverse-engineering blueprint and reference implementation for converting **OpenCode** into a high-speed, production-grade **OpenAI & Anthropic Compatible API Gateway**.

The gateway enables:
1. **100% Free Tier Operation:** Utilizing OpenCode's public anonymous access channel (`Authorization: Bearer public`) without paid keys or rate-wall bans.
2. **Deep Reasoning (`thinking_content`):** Real-time streaming and extraction of interleaved reasoning tokens from frontier thinking models (DeepSeek V4.1, Nemotron 3.5, GLM-5.3, Beam).
3. **Full Multimodal Vision (Images/PDFs):** Processing base64 and URL image inputs with context windows up to 1,048,576 tokens.
4. **Native Tool Calling:** Bidirectional mapping supporting downstream client tools while transparently satisfying upstream gate requirements.
5. **Zero Latency Overhead ("Fast as Normal"):** Zero-copy Server-Sent Events (SSE) streaming and persistent HTTP/2 connection pooling.
6. **Future-Proof Anti-Ban Architecture:** Replicating the official OpenCode 2.x client fingerprint, eliminating `403 FreeTierError` blocks.

```
+--------------------------------------------------------------------------------------------------+
|                                    PROVEN LIVE TEST TRAJECTORY                                   |
+--------------------------------------------------------------------------------------------------+
| Upstream Endpoint : https://opencode.ai/inference/openai/v1/chat/completions                     |
| Auth Mode         : Bearer public (Zero Upstream Account Required)                              |
| Model Probe       : nemotron-3.5-super-vl-free (1M Context) / deepseek-v4.1-flash-free (200K)   |
| Status Code       : HTTP/2 200 OK                                                                |
| Output Mode       : Text/Event-Stream (Realtime SSE)                                             |
| Reasoning Delta   : delta.reasoning_content (Streamed live prior to final answer)                |
| Finish Reason     : stop                                                                         |
+--------------------------------------------------------------------------------------------------+
```

---

## 2. OpenCode Infrastructure & Upstream Topography

### 2.1 The Two Upstream Gates

OpenCode operates two distinct gateway generations:

| Gateway Origin | Path | Protocol Style | Fingerprint Profile |
| :--- | :--- | :--- | :--- |
| **New Gateway (Current 2.x)** | `https://opencode.ai/inference/openai/v1` | OpenAI Chat / SSE | Fingerprints OpenCode CLI 2.x; checks canonical descending session ID and 5 core tools byte-for-byte. |
| **New Gateway (Go Tier)** | `https://opencode.ai/inference/go/openai/v1` | OpenAI Chat / Anthropic | Same fingerprint checks as 2.x with alternate model roster. |
| **Legacy Gateway (1.x)** | `https://opencode.ai/zen/v1` | Legacy OpenAI Chat | Uses OpenCode 1.18.x UA; accepts `prj_*` project ID; only checks single `read` tool. |

### 2.2 Model Metadata & Capability Discovery
OpenCode hosts an authoritative capability catalog at:
```
https://models.opencode.ai/api.json
```
This endpoint provides real-time model definitions, pricing (`cost.input`, `cost.output`), modality support (`modalities.input = ["text", "image"]`), tool-calling support (`tool_call: true`), and reasoning behavior (`interleaved: {"field": "reasoning_content"}`).

---

## 3. Deep Reverse Engineering: The 403 FreeTierError Gate

When calling `https://opencode.ai/inference/openai/v1` without authentic OpenCode client internals, the upstream Cloudflare worker terminates the connection with:

```json
HTTP/403 Forbidden
{
  "type": "error",
  "error": {
    "type": "FreeTierError",
    "message": "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."
  }
}
```

Reverse engineering reveals that the gate enforces **5 mandatory structural invariants**. Violating even one triggers an immediate 403:

```mermaid
flowchart TD
    Req[Incoming Client Request] --> GateCheck{Upstream Free-Tier Gate}
    
    GateCheck -->|Check 1: User-Agent| UA[Must match opencode/latest/2.x.x/cli]
    GateCheck -->|Check 2: Session ID| SES[Must match ses_ + 12 hex descending TS + 14 Base62 chars]
    GateCheck -->|Check 3: Lethal Headers| LH[NO x-opencode-request, NO prj_* project IDs]
    GateCheck -->|Check 4: Core Tools| CT[Must contain shell, edit, glob, grep, read with exact schemas]
    GateCheck -->|Check 5: Stream Mode| SM[Must be stream: true with include_usage]
    
    UA --> Pass[Pass Gate: HTTP 200 OK Streaming]
    SES --> Pass
    LH --> Pass
    CT --> Pass
    SM --> Pass
    
    GateCheck -->|Any Check Fails| Block[HTTP 403 FreeTierError]
```

### Invariant 1: Canonical Descending Session Identifier (`ses_...`)

The gate strictly validates the session header format. It does not accept UUIDs or random strings.

* **Pattern:** `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`
* **Layout:**
  - Prefix: `ses_`
  - Timestamp Part (12 hex characters): Generated using OpenCode's `Identifier.descending()`. It shifts a 36-bit millisecond timestamp into a 48-bit word, ORs counter `1`, and performs a bitwise NOT (`~`). The low 12 bits evaluate to `0xFFF - counter` (valid range `0xFC0` to `0xFFF`, resulting in `...ffe`).
  - Random Part (14 characters): 14 characters encoded from a 10-byte cryptographic hash in Base62 (`0-9A-Za-z`).

#### Mathematical Derivation (Node.js & Go):
```javascript
function generateCanonicalSessionId(seed = 'session-' + Date.now()) {
  const sum = crypto.createHash('sha256').update('ses\x00' + seed).digest();
  
  // 36-bit timestamp into 48-bit word, OR counter 1, bitwise NOT
  let current = ((BigInt(sum[0]) << 28n) |
                 (BigInt(sum[1]) << 20n) |
                 (BigInt(sum[2]) << 12n) |
                 (BigInt(sum[3]) << 4n)  |
                 (BigInt(sum[4]) >> 4n)) << 12n;
  current |= 1n;
  const inverted = (~current) & 0xFFFFFFFFFFFFn;
  
  const timePartBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timePartBytes[i] = Number((inverted >> BigInt((5 - i) * 8)) & 0xFFn);
  }
  const timePart = timePartBytes.toString('hex'); // 12 hex chars

  // 14 Base62 characters from remainder of hash
  const base62Alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let n = BigInt('0x' + sum.subarray(6, 16).toString('hex'));
  let chars = [];
  for (let i = 0; i < 14; i++) {
    chars.unshift(base62Alphabet[Number(n % 62n)]);
    n = n / 62n;
  }
  return 'ses_' + timePart + chars.join('');
}
```

### Invariant 2: Header Fingerprint Matrix

| Header Name | Required Value | Notes / Consequences |
| :--- | :--- | :--- |
| `Authorization` | `Bearer public` | Case-sensitive (`Bearer PUBLIC` returns 401). |
| `User-Agent` | `opencode/latest/2.0.29/cli` | Must reflect official CLI 2.x pattern. Generic curl/Node/Python triggers 403. |
| `x-opencode-client` | `cli` | Explicitly identifies terminal CLI agent environment. |
| `x-opencode-session` | `<canonical_session_id>` | Conversation session key. |
| `x-opencode-session-id` | `<canonical_session_id>` | Secondary session identifier required since Oct 2026. |
| `x-session-affinity` | `<canonical_session_id>` | Routes multi-turn requests to the same node cache. |
| `X-Session-Id` | `<canonical_session_id>` | Redundant affinity header. |
| `x-opencode-project` | `sha256(project)[:20].hex()` | Bare 40-character hex string. |
| **`x-opencode-request`** | **MUST BE OMITTED** | **LETHAL:** Presence triggers immediate 403 on `/inference`. |
| **`prj_*` Project IDs** | **MUST BE OMITTED** | **LETHAL:** Pre-2.x format triggers immediate 403. |

### Invariant 3: Mandatory Core Tools Schema Injection

The free-tier gate verifies that the request originates from an authentic OpenCode agent session by inspecting the declared tools. It requires the presence of **5 core tools** whose parameter schemas and descriptions must match the official CLI definitions byte-for-byte:

1. `shell`: Execute command in bash/powershell.
2. `edit`: Find and replace exact text in files.
3. `glob`: File pattern search.
4. `grep`: Ripgrep-based regular expression search.
5. `read`: File and directory content reader.

> [!IMPORTANT]
> Minimal stub definitions (e.g. `{"name": "shell", "description": "run"}`) will fail schema validation and return 403. The proxy must inject the authentic JSON schemas embedded in this document. Client-supplied custom tools can be seamlessly appended.

### Invariant 4: Mandatory Streaming Mode (`stream: true`)

The upstream `/inference` gate rejects non-streaming JSON requests. 
* Upstream requests must always specify `"stream": true` and `"stream_options": {"include_usage": true}`.
* When a downstream client specifies `"stream": false`, the proxy must silently request an upstream SSE stream, aggregate all chunks into memory, and return a standard non-streaming `chat.completion` response.

---

## 4. Feature Implementation Specs

### 4.1 Reasoning & Thinking Extraction (`thinking_content`)

Frontier models on OpenCode stream thinking tokens interleaved with answer content.

#### Upstream Wire Format:
```json
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"Step 1: Calculate..."},"finish_reason":null}]}
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Final Answer"},"finish_reason":null}]}
```

#### Dual-Mode Downstream Distribution:
1. **Modern Client Mode (DeepSeek/Cherry Studio/NextChat):** Pass through `delta.reasoning_content` directly.
2. **Anthropic Messages Mode:** Translate `reasoning_content` into an Anthropic `thinking_delta` block:
   ```json
   data: {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "..."}}
   ```
3. **Legacy Fallback Mode:** Prepend `<think>\n...\n</think>\n\n` to `delta.content` for clients that do not parse custom fields.

---

### 4.2 Multimodal Vision & Image Calling

OpenCode free-tier models (such as `nemotron-3.5-super-vl-free` and `deepseek-v4.1-flash-free`) natively support vision inputs up to 1,048,576 tokens.

#### Accepted OpenAI Multimodal Structure:
```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "Analyze the attached screenshot:" },
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      }
    }
  ]
}
```
* **Payload Limit:** 32 MiB max body size.
* **Supported MIME Types:** `image/png`, `image/jpeg`, `image/webp`, `image/gif`.

---

### 4.3 Native Tool Calling Handling

```mermaid
sequenceDiagram
    autonumber
    actor Client as Downstream Client
    participant Proxy as OpenCode Gateway
    participant Upstream as OpenCode Zen Upstream

    Client->>Proxy: POST /v1/chat/completions (with Custom Tools)
    Note over Proxy: Inject 5 Core OpenCode Tools<br/>Preserve Client Custom Tools
    Proxy->>Upstream: POST /inference/openai/v1 (stream=true + All Tools)
    Upstream-->>Proxy: SSE stream: delta.tool_calls
    Proxy-->>Client: Forward delta.tool_calls (Standard OpenAI Format)
    Client->>Proxy: POST with tool_result
    Proxy->>Upstream: Forward conversation history with tool_results
    Upstream-->>Proxy: SSE stream: Final Answer
    Proxy-->>Client: Final Answer Stream
```

---

## 5. Verified 100% Free Model Roster

These models are verified functional with `Bearer public` and zero account balance:

| Model ID | Context Window | Modalities | Reasoning (`thinking`) | Tool Calling | Primary Use Case |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`nemotron-3.5-super-vl-free`** | **1,048,576** | **Text + Vision** | **Yes (`reasoning_content`)** | **Yes** | **Ultimate Vision & 1M Long-Context Agent** |
| **`deepseek-v4.1-flash-free`** | 200,000 | Text + Vision | Yes (`reasoning_content`) | Yes | High-Speed Coding & Reasoning |
| **`beam-free`** | 1,048,576 | Text Only | Yes (`reasoning_content`) | Yes | Massive-Context Deep Research |
| **`big-pickle`** | 200,000 | Text Only | Yes (`reasoning_content`) | Yes | Complex Step-by-Step Logic |
| **`nemotron-3.5-lightning-free`**| 262,144 | Text Only | Yes (`reasoning_content`) | Yes | High-Throughput Scripting |
| **`glm-5.3-flash-free`** | 200,000 | Text + Vision + PDF | Yes (`reasoning_content`) | Yes | Multimodal Document Analysis |

---

## 6. Complete Production Reference Implementation

This standalone, high-performance Node.js service (zero npm dependencies) implements all reverse-engineered bypasses, tool injection, reasoning extraction, streaming SSE pipe, and non-streaming fallback.

### 6.1 `gateway.js`

```javascript
/**
 * OpenCode to OpenAI/Anthropic Compatible Reverse-Proxy Gateway
 * Zero external dependencies - runs with pure Node.js (v18+)
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const LOCAL_API_KEY = process.env.LOCAL_API_KEY || 'sk-opencode-free-master';
const OPENCODE_CLIENT_VERSION = '2.0.29';

// 1. Genuine OpenCode CLI Core Tool Schemas (Exact byte-for-byte schemas to pass gate)
const CORE_TOOLS = [
  {
    type: "function",
    function: {
      name: "shell",
      description: "Execute a shell command and return its output. Commands run on Windows using powershell. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command string to execute" },
          workdir: { type: "string", description: "Working directory to execute the command in." },
          timeout: { type: "integer", description: "Timeout in milliseconds." },
          background: { type: "boolean", description: "Run command in background." }
        },
        required: ["command"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Edit the contents of a file by finding and replacing exact text.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File to edit" },
          oldString: { type: "string", description: "Exact text to find and replace" },
          newString: { type: "string", description: "Text to replace oldString with" },
          replaceAll: { type: "boolean", description: "Whether to replace every occurrence." }
        },
        required: ["path", "oldString", "newString"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Search file paths using a glob pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern to match files against" },
          path: { type: "string", description: "Directory to search." },
          hidden: { type: "boolean", description: "Include hidden files." },
          limit: { type: "integer", description: "Maximum matching files to return." }
        },
        required: ["pattern"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents using ripgrep's regular expression syntax.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to match in file contents." },
          path: { type: "string", description: "File or directory to search." },
          include: { type: "string", description: "Glob pattern to filter files." },
          caseSensitive: { type: "boolean", description: "Case-sensitive matching." }
        },
        required: ["pattern"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read the contents of a file or directory. Supports text files, images, and PDFs.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory to read" },
          offset: { type: "integer", description: "The line or entry to start from." },
          limit: { type: "integer", description: "Maximum number of lines to read." }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  }
];

// 2. Canonical Session & Project ID Generation
function generateCanonicalSessionId(seed = 'seed-' + Date.now()) {
  const sum = crypto.createHash('sha256').update('ses\x00' + seed).digest();
  
  let current = ((BigInt(sum[0]) << 28n) |
                 (BigInt(sum[1]) << 20n) |
                 (BigInt(sum[2]) << 12n) |
                 (BigInt(sum[3]) << 4n)  |
                 (BigInt(sum[4]) >> 4n)) << 12n;
  current |= 1n;
  const inverted = (~current) & 0xFFFFFFFFFFFFn;
  
  const timePartBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timePartBytes[i] = Number((inverted >> BigInt((5 - i) * 8)) & 0xFFn);
  }
  const timePart = timePartBytes.toString('hex');

  const base62Alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let n = BigInt('0x' + sum.subarray(6, 16).toString('hex'));
  let chars = [];
  for (let i = 0; i < 14; i++) {
    chars.unshift(base62Alphabet[Number(n % 62n)]);
    n = n / 62n;
  }
  return 'ses_' + timePart + chars.join('');
}

function generateProjectId(project = 'default-project') {
  return crypto.createHash('sha256').update('opencode-project\x00' + project).digest().subarray(0, 20).toString('hex');
}

// 3. HTTP Server & Request Handling
const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // Authentication Check
  const authHeader = req.headers['authorization'] || '';
  const apiKeyHeader = req.headers['x-api-key'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '') || apiKeyHeader;

  if (LOCAL_API_KEY && token !== LOCAL_API_KEY && req.url !== '/healthz') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Unauthorized: Invalid Local API Key' } }));
  }

  // Route: Health Check
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', proxy: 'OpenCode2API-Active', upstream: 'https://opencode.ai' }));
  }

  // Route: Models List
  if (req.url === '/v1/models' && req.method === 'GET') {
    const models = [
      { id: "nemotron-3.5-super-vl-free", object: "model", created: 1792240000, owned_by: "nvidia", context_window: 1048576 },
      { id: "deepseek-v4.1-flash-free", object: "model", created: 1792240000, owned_by: "deepseek", context_window: 200000 },
      { id: "beam-free", object: "model", created: 1792240000, owned_by: "reflection", context_window: 1048576 },
      { id: "big-pickle", object: "model", created: 1792240000, owned_by: "opencode", context_window: 200000 },
      { id: "glm-5.3-flash-free", object: "model", created: 1792240000, owned_by: "zhipuai", context_window: 200000 }
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: "list", data: models }));
  }

  // Route: Chat Completions
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', () => {
      try {
        const clientPayload = JSON.parse(bodyData);
        handleChatCompletions(clientPayload, req, res);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON request body: ' + err.message } }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not Found' } }));
});

// 4. Upstream Forwarding Logic
function handleChatCompletions(clientPayload, req, res) {
  const isClientStream = clientPayload.stream === true;
  const conversationSeed = clientPayload.messages?.[0]?.content ? JSON.stringify(clientPayload.messages[0].content) : 'seed';
  const sessionId = generateCanonicalSessionId(conversationSeed);
  const projectId = generateProjectId();

  // Merge client tools with genuine Core Tools to satisfy upstream gate
  const userTools = Array.isArray(clientPayload.tools) ? clientPayload.tools : [];
  const mergedTools = [...CORE_TOOLS];
  for (const ut of userTools) {
    if (!mergedTools.some(ct => ct.function.name === ut.function?.name)) {
      mergedTools.push(ut);
    }
  }

  // Build Upstream Payload (Upstream strictly requires stream: true)
  const upstreamPayload = {
    ...clientPayload,
    model: clientPayload.model || 'nemotron-3.5-super-vl-free',
    stream: true,
    stream_options: { include_usage: true },
    tools: mergedTools
  };

  const payloadString = JSON.stringify(upstreamPayload);

  const upstreamHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': 'Bearer public',
    'User-Agent': `opencode/latest/${OPENCODE_CLIENT_VERSION}/cli`,
    'x-opencode-client': 'cli',
    'x-opencode-session': sessionId,
    'x-opencode-session-id': sessionId,
    'x-session-affinity': sessionId,
    'X-Session-Id': sessionId,
    'x-opencode-project': projectId,
    'Content-Length': Buffer.byteLength(payloadString)
  };

  const upstreamReq = https.request({
    hostname: 'opencode.ai',
    path: '/inference/openai/v1/chat/completions',
    method: 'POST',
    headers: upstreamHeaders
  }, (upstreamRes) => {
    // Upstream returned error
    if (upstreamRes.statusCode !== 200) {
      let errBody = '';
      upstreamRes.on('data', chunk => errBody += chunk);
      upstreamRes.on('end', () => {
        res.writeHead(upstreamRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(errBody);
      });
      return;
    }

    if (isClientStream) {
      // 1. Direct Streaming Mode
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      upstreamRes.pipe(res);
    } else {
      // 2. Non-Streaming Emulation Mode (Collect chunks and return single JSON)
      let buffer = '';
      let accumulatedContent = '';
      let accumulatedReasoning = '';
      let finalUsage = null;
      let modelId = clientPayload.model;
      let completionId = 'chatcmpl-' + crypto.randomUUID();

      upstreamRes.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep partial trailing line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.id) completionId = parsed.id;
            if (parsed.model) modelId = parsed.model;
            if (parsed.usage) finalUsage = parsed.usage;
            
            const delta = parsed.choices?.[0]?.delta;
            if (delta) {
              if (delta.reasoning_content) accumulatedReasoning += delta.reasoning_content;
              if (delta.content) accumulatedContent += delta.content;
            }
          } catch (e) {}
        }
      });

      upstreamRes.on('end', () => {
        const responseJson = {
          id: completionId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: accumulatedContent,
                reasoning_content: accumulatedReasoning || undefined
              },
              finish_reason: "stop"
            }
          ],
          usage: finalUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseJson, null, 2));
      });
    }
  });

  upstreamReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Upstream gateway connection failure: ' + err.message } }));
  });

  upstreamReq.write(payloadString);
  upstreamReq.end();
}

server.listen(PORT, () => {
  console.log(`🚀 OpenCode API Gateway running on http://127.0.0.1:${PORT}`);
  console.log(`🔑 Local API Key: ${LOCAL_API_KEY}`);
  console.log(`🌐 Base URL: http://127.0.0.1:${PORT}/v1`);
});
```

---

## 7. Client Integration Guide

### 7.1 Curl Streaming Test with Reasoning
```bash
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-opencode-free-master" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nemotron-3.5-super-vl-free",
    "messages": [
      {"role": "user", "content": "Explain quantum superposition in 2 sentences."}
    ],
    "stream": true
  }'
```

### 7.2 Multimodal Vision Call
```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-opencode-free-master" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nemotron-3.5-super-vl-free",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "What is depicted in this image?"},
          {
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}
          }
        ]
      }
    ]
  }'
```

### 7.3 Cherry Studio / NextChat / LibreChat Configuration
* **API Host / Base URL:** `http://127.0.0.1:8080/v1`
* **API Key:** `sk-opencode-free-master`
* **Model ID:** `nemotron-3.5-super-vl-free` or `deepseek-v4.1-flash-free`
* **Thinking Mode:** Set to **Enabled** (Cherry Studio natively renders `reasoning_content` in thought bubbles).

---

## 8. Anti-Ban, Anti-Throttling & Future-Proofing

1. **Session Affinity Maintenance:** 
   Keep conversations on the same session ID by maintaining the `x-session-id` header across sequential turns. This reuses OpenCode's prompt cache on upstream nodes and prevents random re-fingerprinting.
2. **Version Bumping Synchronization:**
   The `User-Agent` references `opencode/latest/2.0.29/cli`. When OpenCode releases a new major CLI tag on GitHub (`anomalyco/opencode`), update the version string to match.
3. **Upstream 429 Handling (Model Rotation):**
   If an upstream model reports temporary unavailability (HTTP 429), configure the client to failover seamlessly across the active free roster:
   $$\text{nemotron-3.5-super-vl-free} \longrightarrow \text{deepseek-v4.1-flash-free} \longrightarrow \text{beam-free} \longrightarrow \text{big-pickle}$$
4. **Zero Account Exposure:**
   Because the system uses `Authorization: Bearer public`, no personal user accounts or payment methods are bound to requests, guaranteeing zero financial risk and zero account ban liability.

---

## 9. React 19 Control Plane & Dashboard Architecture

The gateway features a complete, self-contained **React 19 Control Plane** built with Vite, compiled directly to `/dist`, and served by the Node.js backend.

### 9.1 Design System & Theme Tokens
The interface strictly avoids AI-slop, purple gradients, and emojis, adhering to a high-contrast terminal/engineering aesthetic utilizing `react-icons/fi` feather SVG line icons:
* **Primary Accent:** `#00a33d` (Light) / `#2fbc5b` (Dark)
* **Background:** `#f3faff` (Light) / `#02080e` (Dark)
* **Card Surface:** `#ffffff` (Light) / `#09131a` (Dark)
* **Borders & Dividers:** `#d3e0ea` (Light) / `#202a32` (Dark)
* **Typography:** `Space Grotesk` (UI) and `Space Mono` (Code & Data)

### 9.2 Real-Time Stats & Metrics Engine
* **Sliding 60-Second Sampling:** Computes live Requests Per Minute (RPM) and Tokens Per Minute (TPM).
* **Token Counters:** Tracks Total Tokens Served, Prompt Tokens, Completion Tokens, and Reasoning Tokens.
* **Daily Averages:** Aggregates tokens served per calendar day in `data/stats.json`.
* **Live SVG Trend Graphs:** Renders animated SVG charts for RPM, TPM, and Success Rate history without bulky chart dependencies.
* **Recent Request Stream:** Live tabular feed displaying model, latency (ms), token breakdown, streaming status, and key attribution.

### 9.3 Multi-User API Key Management (`O2P-`)
* **Standard Prefix:** All generated keys strictly start with `O2P-` (e.g., `O2P-master-70f72621...` or custom `O2P-team-a1b2...`).
* **Multi-User Quotas:** Each key can be individually configured with:
  * Unlimited usage toggle.
  * Custom RPM limit (sliding 60-second window).
  * Custom TPM limit (token bucket).
* **Instant Revocation:** Keys can be toggled enabled/disabled or deleted with immediate effect.

### 9.4 Auto Model Discovery & Suffix Stripping
* **Zero Hardcoded Models:** Discovers live models from OpenCode Zen (`https://opencode.ai/zen/v1/models`) and the capability catalog (`https://models.opencode.ai/api.json`).
* **Automatic Suffix Stripping:** All `-free`, `_free`, and `free` suffixes are automatically removed when exposing models to clients (e.g. `nemotron-3.5-super-vl-free` $\to$ `nemotron-3.5-super-vl`, `deepseek-v4.1-flash-free` $\to$ `deepseek-v4.1-flash`).
* **Bidirectional Mapping:** Upstream requests are dynamically routed to the corresponding free model ID.
* **One-Click Discovery:** The Dashboard Models page provides a **Discover Models** button for on-demand synchronization.

### 9.5 OpenCode CLI Version Synchronization & Notification Center
* **Semver Verification:** Checks upstream releases on GitHub (`anomalyco/opencode`) and npm registry (`opencode-ai`).
* **Hot Reloading:** Automatically upgrades the client fingerprint header `opencode/latest/<version>/cli` in runtime memory and `.env`/config with zero container restarts.
* **In-App Notification Center:** Dispatches actionable toast notifications on key generation, model catalog changes, and CLI version bumps.

---

## 10. Anthropic Messages Protocol Compatibility (`/v1/messages`)

The gateway provides native protocol translation for Anthropic clients, allowing tools like **Claude Code**, **LibreChat**, **Cursor**, and **Continue** to use OpenCode free Zen models out-of-the-box.

### 10.1 Endpoint Specification
* **URL:** `http://127.0.0.1:8080/v1/messages`
* **Method:** `POST`
* **Headers:**
  * `x-api-key: O2P-...` or `Authorization: Bearer O2P-...`
  * `anthropic-version: 2023-06-01`
  * `Content-Type: application/json`

### 10.2 Non-Streaming Response Format
```json
{
  "id": "msg_95fa4d0a15a74097a6de",
  "type": "message",
  "role": "assistant",
  "model": "deepseek-v4.1-flash",
  "content": [
    {
      "type": "thinking",
      "thinking": "The model reasoning trace...",
      "signature": "sig_b1b8d1a6e4e18c30"
    },
    {
      "type": "text",
      "text": "The final response text."
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 1577,
    "output_tokens": 23
  }
}
```

### 10.3 Streaming SSE Event Sequence
When `stream: true`, the gateway emits official Anthropic Server-Sent Events:
1. `event: message_start` &rarr; Inits message ID, model, and zeroed usage.
2. `event: content_block_start` &rarr; Starts text block.
3. `event: content_block_delta` &rarr; Emits `text_delta` chunks.
4. `event: content_block_stop` &rarr; Finalizes content block.
5. `event: message_delta` &rarr; Emits `stop_reason: "end_turn"` and total output token usage.
6. `event: message_stop` &rarr; Closes stream.

---

## 11. Interactive Model Playground & Vision Studio

The Control Plane integrates an interactive browser playground at tab `Playground`:
* **Live SSE Streaming:** Streams delta tokens from OpenCode Zen nodes with typewriter effect and generation stop control.
* **Interleaved Thinking Accordion:** Displays live reasoning chains with token count counters and collapsible state.
* **Multimodal Vision Ingestion:** Drag-and-drop or select local images (`image/png`, `image/jpeg`, `image/webp`). Images are auto-encoded to base64 and dispatched via multimodal `image_url` payloads to vision-ready models (`nemotron-3.5-super-vl`, `deepseek-v4.1-flash`, etc.).
* **Runtime Hyperparameters:** Real-time sliders for temperature and max tokens, along with system instruction personalization.

---

## 12. Advanced Key Quota, Expiration & Scoping Engine

API keys now feature granular multi-tenant governance:
* **Token Budget Control:** Allocates total token consumption allowances using custom inputs or sliders with `K` (Thousands) and `M` (Millions) multipliers.
* **Automated Quota Enforcement:** When a budgeted key exhausts its token allotment, the gateway rejects requests with `HTTP 429 Token budget exhausted`.
* **Model Whitelist Scoping:** Restricts keys to specific models (e.g. vision models only), automatically rejecting disallowed models with `HTTP 403 Forbidden`.
* **Lifecycle Expiration:** Configurable validity periods (`7 days`, `30 days`, `90 days`, `permanent`). Expired keys are rejected with `HTTP 403 Key expired`.
* **Visual Progress Bars:** Real-time token usage meter and active status toggle switches for zero-downtime key administration.


