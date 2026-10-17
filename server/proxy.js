const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const config = require('./config');
const identity = require('./identity');
const tools = require('./tools');
const discovery = require('./discovery');
const keys = require('./keys');
const metrics = require('./metrics');

// High-performance keepAlive connection agent: keeps TLS sockets hot, eliminates handshake lag
// Explicitly enforce IPv4 (family: 4) to avoid Cloudflare IPv6 /64 CIDR rate limits on opencode.ai
const upstreamAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: 60000,
  keepAliveMsecs: 30000,
  family: 4
});

let proxyIndex = 0;

/**
 * Returns either a direct keepAlive agent or a proxy tunnel agent based on config/environment.
 * If retrying and configured proxies fail, falls back directly to direct IPv4 agent.
 */
function getUpstreamAgent(attempt = 1) {
  const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const configuredProxies = config.get('proxies') || [];
  const proxyList = Array.isArray(configuredProxies) && configuredProxies.length > 0
    ? configuredProxies
    : (envProxy ? [envProxy] : []);

  if (proxyList.length === 0) {
    return upstreamAgent;
  }

  // If retrying past the number of proxies, fall back to direct IPv4
  if (attempt > proxyList.length) {
    return upstreamAgent;
  }

  // Rotate through configured proxies
  const proxyUrlStr = proxyList[proxyIndex % proxyList.length];
  proxyIndex++;

  try {
    const proxyUrl = new URL(proxyUrlStr);
    return new https.Agent({
      keepAlive: true,
      family: 4,
      createConnection(options, callback) {
        const connectReq = http.request({
          host: proxyUrl.hostname,
          port: proxyUrl.port || 80,
          method: 'CONNECT',
          path: `${options.host}:${options.port || 443}`,
          headers: {
            Host: `${options.host}:${options.port || 443}`,
            ...(proxyUrl.username ? {
              'Proxy-Authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')
            } : {})
          },
          timeout: 10000
        });
        connectReq.on('timeout', () => {
          connectReq.destroy(new Error(`Proxy CONNECT to ${proxyUrl.host} timed out`));
        });
        connectReq.on('connect', (res, socket, head) => {
          if (res.statusCode !== 200) {
            callback(new Error(`Proxy CONNECT returned HTTP ${res.statusCode}`));
            return;
          }
          const tlsSocket = tls.connect({
            socket: socket,
            servername: options.servername || options.host
          }, () => {
            callback(null, tlsSocket);
          });
          tlsSocket.on('error', err => callback(err));
        });
        connectReq.on('error', err => callback(err));
        connectReq.end();
      }
    });
  } catch (err) {
    console.error('[ProxyAgent] Failed to create proxy agent, falling back to direct:', err.message);
    return upstreamAgent;
  }
}

// Resilient fallback cascades by model family & capability
const FALLBACK_CASCADES = {
  // Multimodal Vision models
  'mimo-v2.6-flash': ['nemotron-3.5-super-vl', 'longcat-2.5-preview', 'beam', 'deepseek-v4.1-flash'],
  'nemotron-3.5-super-vl': ['mimo-v2.6-flash', 'longcat-2.5-preview', 'beam', 'deepseek-v4.1-flash'],
  'longcat-2.5-preview': ['nemotron-3.5-super-vl', 'mimo-v2.6-flash', 'beam', 'deepseek-v4.1-flash'],

  // High performance text / reasoning models
  'glm-5.3-flash': ['beam', 'deepseek-v4.1-flash', 'mimo-v2.6-flash', 'space-bunny', 'big-pickle'],
  'deepseek-v4.1-flash': ['beam', 'glm-5.3-flash', 'mimo-v2.6-flash', 'space-bunny', 'big-pickle'],
  'beam': ['deepseek-v4.1-flash', 'glm-5.3-flash', 'mimo-v2.6-flash', 'space-bunny', 'big-pickle'],
  'nemotron-3.5-lightning': ['beam', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'space-bunny'],
  'big-pickle': ['beam', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'space-bunny'],
  'space-bunny': ['beam', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'mimo-v2.6-flash']
};

/**
 * Determine the next healthy fallback model for resilient failover.
 */
function getNextFallbackModel(currentModel, triedModels = new Set()) {
  if (config.get('smart_fallback') === false) return null;

  const cascade = FALLBACK_CASCADES[currentModel] || [];
  for (const candidate of cascade) {
    if (!triedModels.has(candidate)) {
      return candidate;
    }
  }

  // Capability-based search if cascade is exhausted
  const allModels = discovery.getModels();
  const currentMeta = allModels.find(m => m.id === currentModel);
  const wantsVision = currentMeta?.supports_vision;

  for (const m of allModels) {
    if (!triedModels.has(m.id)) {
      if (wantsVision ? m.supports_vision : true) {
        return m.id;
      }
    }
  }
  return null;
}

/**
 * Clean & normalize chat completion request parameters for upstream compatibility.
 */
function sanitizeClientPayload(payload) {
  const allowed = [
    'messages', 'model', 'stream', 'tools', 'tool_choice',
    'temperature', 'top_p', 'max_tokens', 'presence_penalty',
    'frequency_penalty', 'reasoning_effort', 'thinking', 'response_format'
  ];
  const cleaned = {};
  for (const key of allowed) {
    if (payload[key] !== undefined) {
      cleaned[key] = payload[key];
    }
  }
  return cleaned;
}

/**
 * Handle OpenAI Chat Completions endpoint (/v1/chat/completions) with auto-retry & smart failover.
 */
async function handleChatCompletions(clientPayload, req, res, keyObj) {
  const startTime = Date.now();
  const isClientStream = clientPayload.stream === true;
  const requestedModel = clientPayload.model || 'nemotron-3.5-super-vl';

  // Parse custom thinking levels
  let reasoningEffort = clientPayload.reasoning_effort;
  let thinkingConfig = clientPayload.thinking;

  if (clientPayload.thinking_level) {
    const level = String(clientPayload.thinking_level).toLowerCase();
    if (level === 'off' || level === 'none') {
      reasoningEffort = 'none';
      thinkingConfig = { type: 'disabled' };
    } else if (level === 'low') {
      reasoningEffort = 'low';
      thinkingConfig = { type: 'enabled', budget_tokens: 4096 };
    } else if (level === 'medium') {
      reasoningEffort = 'medium';
      thinkingConfig = { type: 'enabled', budget_tokens: 16384 };
    } else if (level === 'high') {
      reasoningEffort = 'high';
      thinkingConfig = { type: 'enabled', budget_tokens: 32768 };
    } else if (level === 'max') {
      reasoningEffort = 'high';
      thinkingConfig = { type: 'enabled', budget_tokens: 65536 };
    }
  }

  const baseSanitized = sanitizeClientPayload(clientPayload);
  const mergedTools = tools.mergeTools(clientPayload.tools);

  let currentModel = requestedModel;
  const triedModels = new Set([currentModel]);
  const maxRetries = config.get('max_retries') !== undefined ? config.get('max_retries') : 2;
  const requestTimeout = config.get('request_timeout_ms') || 60000;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const upstreamModel = discovery.resolveUpstreamModel(currentModel);
    const sessionId = identity.generateCanonicalSessionId();
    const projectId = identity.generateProjectId();

    const upstreamPayload = {
      ...baseSanitized,
      model: upstreamModel,
      stream: true,
      tools: mergedTools,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(thinkingConfig ? { thinking: thinkingConfig } : {})
    };

    const payloadString = JSON.stringify(upstreamPayload);
    const upstreamHeaders = identity.buildUpstreamHeaders(sessionId, projectId, Buffer.byteLength(payloadString));

    const attemptResult = await new Promise((resolve) => {
      let isTimedOut = false;
      const upstreamReq = https.request({
        hostname: 'opencode.ai',
        path: '/inference/openai/v1/chat/completions',
        method: 'POST',
        headers: upstreamHeaders,
        agent: getUpstreamAgent(attempt),
        family: 4,
        timeout: requestTimeout
      }, (upstreamRes) => {
        // If upstream error (non-200), buffer body to inspect retryability
        if (upstreamRes.statusCode !== 200) {
          let errBody = '';
          upstreamRes.on('data', chunk => errBody += chunk.toString());
          upstreamRes.on('end', () => {
            resolve({
              success: false,
              statusCode: upstreamRes.statusCode,
              body: errBody
            });
          });
          return;
        }

        // Upstream responded 200 OK!
        resolve({
          success: true,
          statusCode: 200,
          upstreamRes,
          upstreamReq,
          resolvedModel: currentModel
        });
      });

      upstreamReq.on('timeout', () => {
        isTimedOut = true;
        upstreamReq.destroy(new Error('Upstream timeout'));
      });

      upstreamReq.on('error', (err) => {
        resolve({
          success: false,
          statusCode: isTimedOut ? 504 : 502,
          body: err.message
        });
      });

      // Abort upstream if client disconnects
      req.on('close', () => {
        if (!res.writableEnded) {
          try { upstreamReq.destroy(); } catch (e) {}
        }
      });

      upstreamReq.write(payloadString);
      upstreamReq.end();
    });

    if (attemptResult.success) {
      const { upstreamRes, upstreamReq, resolvedModel } = attemptResult;

      // Set fallback headers if auto-failover occurred
      if (resolvedModel !== requestedModel) {
        res.setHeader('x-opencode2api-fallback', `${requestedModel} -> ${resolvedModel}`);
      }
      res.setHeader('x-opencode2api-resolved-model', resolvedModel);

      if (isClientStream) {
        // 1. Streaming response mode (Real-time zero latency)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        if (res.flushHeaders) res.flushHeaders();
        if (res.socket?.setNoDelay) res.socket.setNoDelay(true);

        let promptTokens = 0;
        let completionTokens = 0;
        let totalTokens = 0;
        let reasoningTokens = 0;
        let buffer = '';

        upstreamRes.on('data', (chunk) => {
          let chunkStr = chunk.toString();
          // Ensure model ID in chunks reflects the requested or resolved ID
          if (upstreamModel && resolvedModel && upstreamModel !== resolvedModel) {
            chunkStr = chunkStr.replaceAll(upstreamModel, requestedModel);
          }
          res.write(chunkStr);
          if (res.flush) res.flush();

          // Inspect usage events
          buffer += chunkStr;
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') continue;
            try {
              const p = JSON.parse(dataStr);
              if (p.usage) {
                promptTokens = p.usage.prompt_tokens || promptTokens;
                completionTokens = p.usage.completion_tokens || completionTokens;
                totalTokens = p.usage.total_tokens || totalTokens;
                reasoningTokens = p.usage.completion_tokens_details?.reasoning_tokens || reasoningTokens;
              }
            } catch (e) {}
          }
        });

        upstreamRes.on('end', () => {
          res.end();
          const latency = Date.now() - startTime;
          const total = totalTokens || (promptTokens + completionTokens);
          keys.recordUsage(keyObj.id, total);
          metrics.recordRequest({
            model: requestedModel,
            status: 200,
            tokens: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: total, reasoning_tokens: reasoningTokens },
            latencyMs: latency,
            stream: true,
            keyId: keyObj.id
          });
        });
      } else {
        // 2. Non-streaming aggregation mode
        let buffer = '';
        let accumulatedContent = '';
        let accumulatedReasoning = '';
        let accumulatedToolCalls = [];
        let finalUsage = null;
        let completionId = 'chatcmpl-' + crypto.randomUUID();
        let finished = false;

        function finishResponse() {
          if (finished) return;
          finished = true;

          const pTokens = finalUsage?.prompt_tokens || 0;
          const cTokens = finalUsage?.completion_tokens || Math.ceil((accumulatedContent.length + accumulatedReasoning.length) / 4);
          const rTokens = finalUsage?.completion_tokens_details?.reasoning_tokens || Math.ceil(accumulatedReasoning.length / 4);
          const total = finalUsage?.total_tokens || (pTokens + cTokens);

          const responseJson = {
            id: completionId,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: accumulatedContent,
                  reasoning_content: accumulatedReasoning || undefined,
                  tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined
                },
                finish_reason: accumulatedToolCalls.length > 0 ? "tool_calls" : "stop"
              }
            ],
            usage: finalUsage || {
              prompt_tokens: pTokens,
              completion_tokens: cTokens,
              total_tokens: total,
              completion_tokens_details: { reasoning_tokens: rTokens }
            }
          };

          const latency = Date.now() - startTime;
          keys.recordUsage(keyObj.id, total);
          metrics.recordRequest({
            model: requestedModel,
            status: 200,
            tokens: { prompt_tokens: pTokens, completion_tokens: cTokens, total_tokens: total, reasoning_tokens: rTokens },
            latencyMs: latency,
            stream: false,
            keyId: keyObj.id
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responseJson, null, 2));
        }

        upstreamRes.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') {
              finishResponse();
              try { upstreamReq.destroy(); } catch (e) {}
              return;
            }

            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.id) completionId = parsed.id;
              if (parsed.usage) finalUsage = parsed.usage;

              const delta = parsed.choices?.[0]?.delta;
              if (delta) {
                if (delta.reasoning_content) accumulatedReasoning += delta.reasoning_content;
                if (delta.content) accumulatedContent += delta.content;
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index || 0;
                    if (!accumulatedToolCalls[idx]) {
                      accumulatedToolCalls[idx] = { id: tc.id || 'call_' + idx, type: 'function', function: { name: '', arguments: '' } };
                    }
                    if (tc.function?.name) accumulatedToolCalls[idx].function.name += tc.function.name;
                    if (tc.function?.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
                  }
                }
              }
            } catch (e) {}
          }
        });

        upstreamRes.on('end', () => finishResponse());
      }
      return; // Request handled successfully!
    }

    // Upstream failed this attempt — inspect if we can retry or failover
    const isUnavailable = attemptResult.statusCode === 429 ||
                          attemptResult.statusCode === 403 ||
                          (typeof attemptResult.body === 'string' && (
                            attemptResult.body.includes('unavailable') ||
                            attemptResult.body.includes('FreeTierError') ||
                            attemptResult.body.includes('FreeUsageLimitError') ||
                            attemptResult.body.includes('Rate limit exceeded')
                          )) ||
                          attemptResult.statusCode >= 500;

    if (attempt <= maxRetries) {
      if (isUnavailable) {
        const fallback = getNextFallbackModel(currentModel, triedModels);
        if (fallback) {
          console.log(`[Proxy] Model ${currentModel} returned ${attemptResult.statusCode}. Smart failover to ${fallback} (Attempt ${attempt}/${maxRetries + 1})...`);
          currentModel = fallback;
          triedModels.add(fallback);
        } else {
          console.log(`[Proxy] Upstream transient ${attemptResult.statusCode} on ${currentModel}. Retrying with fresh session ID...`);
        }
      }

      // Exponential backoff with random jitter
      const backoffMs = Math.min(250 * Math.pow(1.5, attempt - 1) + Math.random() * 200, 2500);
      await new Promise(r => setTimeout(r, backoffMs));
    } else {
      // Retries exhausted
      metrics.recordRequest({
        model: requestedModel,
        status: attemptResult.statusCode,
        tokens: {},
        latencyMs: Date.now() - startTime,
        stream: isClientStream,
        keyId: keyObj.id
      });
      res.writeHead(attemptResult.statusCode, { 'Content-Type': 'application/json' });
      let errPayload = attemptResult.body;
      if (attemptResult.statusCode === 403 && typeof attemptResult.body === 'string' && attemptResult.body.includes('FreeTierError')) {
        errPayload = JSON.stringify({
          error: {
            message: "OpenCode Free Tier capacity limit reached for this IP window. Rate limits automatically reset shortly. You can also configure an upstream Zen key or proxy in Settings to continue without interruption.",
            type: "free_tier_rate_limit",
            code: 403
          }
        });
      }
      res.end(errPayload || JSON.stringify({ error: { message: `Upstream gateway error (Status ${attemptResult.statusCode})` } }));
      return;
    }
  }
}

/**
 * Handle Anthropic Messages endpoint (/v1/messages) with auto-retry & smart failover.
 */
async function handleAnthropicMessages(clientPayload, req, res, keyObj) {
  const startTime = Date.now();
  const isClientStream = clientPayload.stream === true;
  const requestedModel = clientPayload.model || 'nemotron-3.5-super-vl';

  // 1. Translate Anthropic system & messages to OpenAI format
  const openAiMessages = [];
  if (clientPayload.system) {
    if (typeof clientPayload.system === 'string') {
      openAiMessages.push({ role: 'system', content: clientPayload.system });
    } else if (Array.isArray(clientPayload.system)) {
      const sysText = clientPayload.system.map(s => s.text || '').join('\n');
      openAiMessages.push({ role: 'system', content: sysText });
    }
  }

  for (const msg of clientPayload.messages || []) {
    if (typeof msg.content === 'string') {
      openAiMessages.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (Array.isArray(msg.content)) {
      const parts = [];
      const toolCalls = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${block.source?.media_type || 'image/png'};base64,${block.source?.data || ''}` }
          });
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
            }
          });
        } else if (block.type === 'tool_result') {
          openAiMessages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')
          });
        }
      }
      if (parts.length > 0 || toolCalls.length > 0) {
        const item = { role: msg.role, content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts };
        if (toolCalls.length > 0) item.tool_calls = toolCalls;
        openAiMessages.push(item);
      }
    }
  }

  // 2. Translate Anthropic tools
  let clientTools = undefined;
  if (Array.isArray(clientPayload.tools)) {
    clientTools = clientPayload.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} }
      }
    }));
  }

  const mergedTools = tools.mergeTools(clientTools);

  let currentModel = requestedModel;
  const triedModels = new Set([currentModel]);
  const maxRetries = config.get('max_retries') !== undefined ? config.get('max_retries') : 2;
  const requestTimeout = config.get('request_timeout_ms') || 60000;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const upstreamModel = discovery.resolveUpstreamModel(currentModel);
    const sessionId = identity.generateCanonicalSessionId();
    const projectId = identity.generateProjectId();

    const upstreamPayload = {
      model: upstreamModel,
      messages: openAiMessages,
      stream: true,
      tools: mergedTools,
      ...(clientPayload.temperature !== undefined ? { temperature: clientPayload.temperature } : {}),
      ...(clientPayload.top_p !== undefined ? { top_p: clientPayload.top_p } : {}),
      ...(clientPayload.max_tokens ? { max_tokens: clientPayload.max_tokens } : {})
    };

    const payloadString = JSON.stringify(upstreamPayload);
    const upstreamHeaders = identity.buildUpstreamHeaders(sessionId, projectId, Buffer.byteLength(payloadString));

    const attemptResult = await new Promise((resolve) => {
      let isTimedOut = false;
      const upstreamReq = https.request({
        hostname: 'opencode.ai',
        path: '/inference/openai/v1/chat/completions',
        method: 'POST',
        headers: upstreamHeaders,
        agent: getUpstreamAgent(attempt),
        family: 4,
        timeout: requestTimeout
      }, (upstreamRes) => {
        if (upstreamRes.statusCode !== 200) {
          let errBody = '';
          upstreamRes.on('data', chunk => errBody += chunk.toString());
          upstreamRes.on('end', () => {
            resolve({
              success: false,
              statusCode: upstreamRes.statusCode,
              body: errBody
            });
          });
          return;
        }

        resolve({
          success: true,
          statusCode: 200,
          upstreamRes,
          upstreamReq,
          resolvedModel: currentModel
        });
      });

      upstreamReq.on('timeout', () => {
        isTimedOut = true;
        upstreamReq.destroy(new Error('Upstream timeout'));
      });

      upstreamReq.on('error', (err) => {
        resolve({
          success: false,
          statusCode: isTimedOut ? 504 : 502,
          body: err.message
        });
      });

      req.on('close', () => {
        if (!res.writableEnded) {
          try { upstreamReq.destroy(); } catch (e) {}
        }
      });

      upstreamReq.write(payloadString);
      upstreamReq.end();
    });

    if (attemptResult.success) {
      const { upstreamRes, upstreamReq, resolvedModel } = attemptResult;
      const messageId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);

      if (resolvedModel !== requestedModel) {
        res.setHeader('x-opencode2api-fallback', `${requestedModel} -> ${resolvedModel}`);
      }
      res.setHeader('x-opencode2api-resolved-model', resolvedModel);

      if (isClientStream) {
        // Stream Anthropic SSE with zero buffering
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        if (res.flushHeaders) res.flushHeaders();
        if (res.socket?.setNoDelay) res.socket.setNoDelay(true);

        // Send initial message_start
        res.write(`event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: requestedModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        })}\n\n`);

        res.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        })}\n\n`);

        let buffer = '';
        let promptTokens = 0;
        let completionTokens = 0;

        upstreamRes.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') continue;

            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.usage) {
                promptTokens = parsed.usage.prompt_tokens || promptTokens;
                completionTokens = parsed.usage.completion_tokens || completionTokens;
              }
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: delta.content }
                })}\n\n`);
                if (res.flush) res.flush();
              }
            } catch (e) {}
          }
        });

        upstreamRes.on('end', () => {
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
          res.write(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: completionTokens }
          })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          res.end();

          const latency = Date.now() - startTime;
          const total = promptTokens + completionTokens;
          keys.recordUsage(keyObj.id, total);
          metrics.recordRequest({
            model: requestedModel,
            status: 200,
            tokens: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: total, reasoning_tokens: 0 },
            latencyMs: latency,
            stream: true,
            keyId: keyObj.id
          });
        });
      } else {
        // Non-streaming Anthropic aggregation
        let buffer = '';
        let accumulatedContent = '';
        let accumulatedReasoning = '';
        let accumulatedToolCalls = [];
        let finalUsage = null;
        let finished = false;

        function finishAnthropic() {
          if (finished) return;
          finished = true;

          const pTokens = finalUsage?.prompt_tokens || 0;
          const cTokens = finalUsage?.completion_tokens || Math.ceil((accumulatedContent.length + accumulatedReasoning.length) / 4);
          const rTokens = finalUsage?.completion_tokens_details?.reasoning_tokens || 0;
          const total = finalUsage?.total_tokens || (pTokens + cTokens);

          const content = [];
          if (accumulatedReasoning) {
            content.push({
              type: 'thinking',
              thinking: accumulatedReasoning,
              signature: 'sig_' + crypto.randomBytes(8).toString('hex')
            });
          }
          if (accumulatedContent) {
            content.push({
              type: 'text',
              text: accumulatedContent
            });
          }
          for (const tc of accumulatedToolCalls) {
            let parsedInput = {};
            try { parsedInput = JSON.parse(tc.function.arguments); } catch (e) {}
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: parsedInput
            });
          }

          const anthropicRes = {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: requestedModel,
            content: content,
            stop_reason: accumulatedToolCalls.length > 0 ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: pTokens,
              output_tokens: cTokens
            }
          };

          const latency = Date.now() - startTime;
          keys.recordUsage(keyObj.id, total);
          metrics.recordRequest({
            model: requestedModel,
            status: 200,
            tokens: { prompt_tokens: pTokens, completion_tokens: cTokens, total_tokens: total, reasoning_tokens: rTokens },
            latencyMs: latency,
            stream: false,
            keyId: keyObj.id
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(anthropicRes, null, 2));
        }

        upstreamRes.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') {
              finishAnthropic();
              try { upstreamReq.destroy(); } catch (e) {}
              return;
            }

            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.usage) finalUsage = parsed.usage;
              const delta = parsed.choices?.[0]?.delta;
              if (delta) {
                if (delta.reasoning_content) accumulatedReasoning += delta.reasoning_content;
                if (delta.content) accumulatedContent += delta.content;
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index || 0;
                    if (!accumulatedToolCalls[idx]) {
                      accumulatedToolCalls[idx] = { id: tc.id || 'call_' + idx, type: 'function', function: { name: '', arguments: '' } };
                    }
                    if (tc.function?.name) accumulatedToolCalls[idx].function.name += tc.function.name;
                    if (tc.function?.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
                  }
                }
              }
            } catch (e) {}
          }
        });

        upstreamRes.on('end', () => finishAnthropic());
      }
      return;
    }

    // Upstream error on Anthropic request
    const isUnavailable = attemptResult.statusCode === 429 ||
                          attemptResult.statusCode === 403 ||
                          (typeof attemptResult.body === 'string' && (
                            attemptResult.body.includes('unavailable') ||
                            attemptResult.body.includes('FreeTierError') ||
                            attemptResult.body.includes('FreeUsageLimitError') ||
                            attemptResult.body.includes('Rate limit exceeded')
                          )) ||
                          attemptResult.statusCode >= 500;

    if (attempt <= maxRetries) {
      if (isUnavailable) {
        const fallback = getNextFallbackModel(currentModel, triedModels);
        if (fallback) {
          console.log(`[Proxy] Anthropic Model ${currentModel} returned ${attemptResult.statusCode}. Smart failover to ${fallback}...`);
          currentModel = fallback;
          triedModels.add(fallback);
        }
      }
      const backoffMs = Math.min(250 * Math.pow(1.5, attempt - 1) + Math.random() * 200, 2500);
      await new Promise(r => setTimeout(r, backoffMs));
    } else {
      metrics.recordRequest({
        model: requestedModel,
        status: attemptResult.statusCode,
        tokens: {},
        latencyMs: Date.now() - startTime,
        stream: isClientStream,
        keyId: keyObj.id
      });
      res.writeHead(attemptResult.statusCode, { 'Content-Type': 'application/json' });
      let errPayload = attemptResult.body;
      if (attemptResult.statusCode === 403 && typeof attemptResult.body === 'string' && attemptResult.body.includes('FreeTierError')) {
        errPayload = JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: "OpenCode Free Tier capacity limit reached for this IP window. Rate limits automatically reset shortly. You can also configure an upstream Zen key or proxy in Settings to continue without interruption."
          }
        });
      }
      res.end(errPayload || JSON.stringify({ error: { type: 'api_error', message: `Upstream gateway error (${attemptResult.statusCode})` } }));
      return;
    }
  }
}

module.exports = {
  handleChatCompletions,
  handleAnthropicMessages
};
