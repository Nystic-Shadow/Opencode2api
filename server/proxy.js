const http = require('http');
const https = require('https');
const crypto = require('crypto');
const config = require('./config');
const identity = require('./identity');
const tools = require('./tools');
const discovery = require('./discovery');
const keys = require('./keys');
const metrics = require('./metrics');
const warp = require('./warp');
const egress = require('./egress');
const requestQueue = require('./requestQueue');

function routeLabel(route) {
  if (!route) return 'no egress route';
  if (route.type === 'warp') return `WARP:${route.port}`;
  if (route.type === 'proxy') return `proxy:${route.id}`;
  return 'direct';
}

function configInt(key, fallback, min = 0) {
  const parsed = parseInt(config.get(key), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

const DEFAULT_UPSTREAM_URL = 'https://opencode.ai/inference/v1/chat/completions';

// Resolve the upstream endpoint once per attempt. The default is the real
// OpenCode Zen inference URL; overriding it is intended for local test
// upstreams and self-hosted compatible mirrors.
function upstreamTarget() {
  const raw = config.get('upstream_inference_url') || DEFAULT_UPSTREAM_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (e) {
    parsed = new URL(DEFAULT_UPSTREAM_URL);
  }
  const isHttps = parsed.protocol === 'https:';
  return {
    protocol: parsed.protocol,
    transport: isHttps ? https : http,
    hostname: parsed.hostname,
    port: parseInt(parsed.port, 10) || (isHttps ? 443 : 80),
    path: `${parsed.pathname || '/'}${parsed.search || ''}`
  };
}

function sendJsonError(res, statusCode, type, message, headers = {}) {
  if (res.headersSent) {
    try { res.end(); } catch (e) {}
    return;
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({
    error: {
      message,
      type,
      code: statusCode
    }
  }));
}

function sendAnthropicError(res, statusCode, type, message, headers = {}) {
  if (res.headersSent) {
    try { res.end(); } catch (e) {}
    return;
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({
    type: 'error',
    error: {
      type,
      message
    }
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION PERSISTENCE — Each egress route keeps a stable session ID to leverage
// OpenCode's session affinity and prompt caching. Only rotated on quota/route
// failure. Direct route gets its own stable session.
// ═══════════════════════════════════════════════════════════════════════════
const persistentSessions = {
  sessions: new Map(), // routeKey -> { sessionId, projectId, createdAt }

  getOrCreate(routeKey) {
    if (this.sessions.has(routeKey)) {
      return this.sessions.get(routeKey);
    }
    const session = {
      sessionId: identity.generateCanonicalSessionId(),
      projectId: identity.generateProjectId(),
      createdAt: Date.now()
    };
    this.sessions.set(routeKey, session);
    return session;
  },

  invalidate(routeKey) {
    this.sessions.delete(routeKey);
  },

  // Rotate session for a route (e.g., after rate limit)
  rotate(routeKey) {
    this.sessions.set(routeKey, {
      sessionId: identity.generateCanonicalSessionId(),
      projectId: identity.generateProjectId(),
      createdAt: Date.now()
    });
    return this.sessions.get(routeKey);
  }
};

// Adaptive Route Health & Intelligent Egress Router
const routeHealth = {
  directDegradedUntil: 0,
  directConsecutiveFailures: 0,
  directLastReason: '',
  warpDegradedUntil: 0,
  warpConsecutiveFailures: 0,
  warpLastReason: '',

  markDirectDegraded(reason = 'upstream error') {
    // Keep degraded for 3 minutes so subsequent requests immediately route through WARP without long lockouts
    this.directDegradedUntil = Date.now() + (3 * 60 * 1000);
    this.directConsecutiveFailures++;
    this.directLastReason = String(reason);
    console.warn(`[RouteManager] Direct route degraded (${reason}). Auto-promoting Cloudflare WARP as primary egress...`);
  },

  markDirectHealthy() {
    this.directDegradedUntil = 0;
    this.directConsecutiveFailures = 0;
  },

  isDirectDegraded() {
    return Date.now() < this.directDegradedUntil;
  },

  markWarpDegraded(reason = 'warp error') {
    this.warpConsecutiveFailures++;
    this.warpLastReason = String(reason);
    const warpMode = config.get('warp_mode') || 'auto';
    if (warpMode === 'always') return;
    // Only failover to direct route if direct route is NOT currently degraded and we have 3+ failures
    if (!this.isDirectDegraded() && this.warpConsecutiveFailures >= 3) {
      this.warpDegradedUntil = Date.now() + 15000;
      console.warn(`[RouteManager] Cloudflare WARP route degraded (${reason}). Auto-failing over to direct route for 15s...`);
    }
  },

  markWarpHealthy() {
    this.warpDegradedUntil = 0;
    this.warpConsecutiveFailures = 0;
  },

  isWarpDegraded() {
    const warpMode = config.get('warp_mode') || 'auto';
    if (warpMode === 'always') return false;
    return Date.now() < this.warpDegradedUntil;
  },

  shouldUseWarp(attempt = 1) {
    const warpMode = config.get('warp_mode') || 'auto';
    if (warpMode === 'disabled' || warpMode === 'never') return false;
    if (warpMode === 'always') return warp.isReady();
    // If direct route is degraded (e.g. VPS IP 429), ALWAYS use WARP
    if (this.isDirectDegraded()) return true;
    if (this.isWarpDegraded()) return false;
    if (!warp.isReady()) return false;
    return true;
  }
};

/**
 * Clean & normalize chat completion request parameters for upstream compatibility.
 */

function payloadHasImages(payload) {
  if (!payload || !Array.isArray(payload.messages)) return false;
  for (const msg of payload.messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && (part.type === 'image_url' || part.image_url || part.type === 'image')) {
          return true;
        }
      }
    }
  }
  return false;
}

function anthropicPayloadHasImages(payload) {
  if (!payload || !Array.isArray(payload.messages)) return false;
  for (const msg of payload.messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && (part.type === 'image' || part.source?.type === 'base64')) {
          return true;
        }
      }
    }
  }
  return false;
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
  const rawRequestedModel = clientPayload.model;

  // On-demand model sync: If model is not in local cache, query upstream Zen models
  if (rawRequestedModel) {
    await discovery.ensureModel(rawRequestedModel);
  }

  const requestedModel = rawRequestedModel || discovery.getDefaultModelId();

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

  const isFreeOnly = config.get('free_only') !== false;
  const isRequestedFree = discovery.isModelFree(requestedModel);

  // If gateway is in free-only mode, reject paid models explicitly
  if (isFreeOnly && !isRequestedFree) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `Model "${requestedModel}" is not an OpenCode Free Tier model. The gateway is currently configured to "Enforce 100% Free Models Only". To use paid models, disable this setting in Gateway Settings and provide an Upstream Zen Key.`,
        type: 'invalid_request_error',
        code: 'model_not_free'
      }
    }));
    return;
  }

  // If requesting a paid model, verify an Upstream Zen Key is configured
  const upstreamKey = config.get('upstream_zen_key') || process.env.OPENCODE_ZEN_KEY || process.env.OPENCODE_API_KEY;
  if (!isRequestedFree && !upstreamKey) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `Model "${requestedModel}" is a paid model that requires an Upstream Zen Key. Please enter your OpenCode Zen Key in Gateway Settings to route to this model.`,
        type: 'authentication_error',
        code: 'zen_key_required'
      }
    }));
    return;
  }

  const baseSanitized = sanitizeClientPayload(clientPayload);
  const toolResult = tools.mergeTools(clientPayload.tools, clientPayload.tool_choice);
  const mergedTools = toolResult.tools;
  const mergedToolChoice = toolResult.toolChoice;
  const clientToolNames = toolResult.clientToolNames;

  let currentModel = requestedModel;
  const maxRetries = Math.min(3, configInt('max_retries', 0));
  const requestTimeout = configInt('request_timeout_ms', 30000, 5000);
  const deadline = startTime + Math.max(requestTimeout, configInt('request_deadline_ms', 90000, requestTimeout));
  const queueWaitMs = configInt('queue_wait_ms', 15000, 0);

  let activeRoute = egress.getCandidates()[0] || null;
  if (!activeRoute) {
    metrics.recordRequest({
      model: requestedModel,
      status: 503,
      tokens: {},
      latencyMs: Date.now() - startTime,
      stream: isClientStream,
      keyId: keyObj.id
    });
    sendJsonError(res, 503, 'no_egress_route',
      'No egress route is available. WARP is not ready and direct fallback is disabled. Wait for the sidecar or configure PROXIES / ALLOW_DIRECT_FALLBACK.',
      { 'Retry-After': '5' });
    return;
  }

  // Quota is a provider window, not a broken route: fail fast with the real
  // reset hint instead of rotating egress to evade the limit.
  const initialQuotaMs = egress.getQuotaRetryAfter(activeRoute);
  if (initialQuotaMs > 0) {
    const retryAfterSec = Math.max(1, Math.ceil(initialQuotaMs / 1000));
    sendJsonError(res, 429, 'free_tier_rate_limit',
      'OpenCode Free Tier capacity limit reached for this egress. The gateway fails fast instead of rotating IPs. Retry after the indicated delay, or configure an upstream Zen key or a user-owned proxy.',
      { 'Retry-After': String(retryAfterSec) });
    return;
  }

  let lastStatus = 0;
  let lastBody = '';
  let currentUpstreamReq = null;

  // Abort the in-flight upstream request if the client goes away. Listening on
  // the response (not the request) avoids destroying the upstream request when
  // the request body has merely finished being read.
  res.once('close', () => {
    if (!res.writableEnded && currentUpstreamReq) {
      try { currentUpstreamReq.destroy(); } catch (e) {}
    }
  });

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (!activeRoute) break;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      lastStatus = 504;
      lastBody = 'Upstream request deadline exceeded before the next attempt.';
      break;
    }

    const useWarp = activeRoute.type === 'warp';
    const upstreamModel = discovery.resolveUpstreamModel(currentModel);
    const routeKey = activeRoute.id;

    const session = persistentSessions.getOrCreate(routeKey);
    const sessionId = (attempt === 1) ? session.sessionId : identity.generateCanonicalSessionId();
    const projectId = (attempt === 1) ? session.projectId : identity.generateProjectId();

    // Admission control: bound concurrent upstream requests per gateway and per API key.
    const releaseSlot = await requestQueue.acquire(keyObj?.id || 'anonymous', Math.min(queueWaitMs, remainingMs));
    if (!releaseSlot) {
      metrics.recordRequest({
        model: requestedModel,
        status: 429,
        tokens: {},
        latencyMs: Date.now() - startTime,
        stream: isClientStream,
        keyId: keyObj.id
      });
      sendJsonError(res, 429, 'queue_full',
        'Gateway concurrency limit reached. Retry shortly.',
        { 'Retry-After': '5' });
      return;
    }

    const upstreamPayload = {
      ...baseSanitized,
      model: upstreamModel,
      stream: true,
      tools: mergedTools,
      ...(mergedToolChoice !== undefined ? { tool_choice: mergedToolChoice } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(thinkingConfig ? { thinking: thinkingConfig } : {})
    };

    const payloadString = JSON.stringify(upstreamPayload);
    const upstreamHeaders = identity.buildUpstreamHeaders(sessionId, projectId, Buffer.byteLength(payloadString));
    const attemptTimeout = Math.max(1000, Math.min(requestTimeout, deadline - Date.now()));

    const target = upstreamTarget();
    let attemptResult;
    try {
      attemptResult = await new Promise((resolve) => {
        if (target.protocol !== 'https:' && activeRoute.type !== 'direct') {
          resolve({
            success: false,
            statusCode: 502,
            headers: {},
            body: 'Plaintext upstream_inference_url requires direct egress'
          });
          return;
        }
        let isTimedOut = false;
        const upstreamReq = target.transport.request({
          hostname: target.hostname,
          port: target.port,
          path: target.path,
          method: 'POST',
          headers: upstreamHeaders,
          agent: egress.getAgent(activeRoute, target.protocol),
          timeout: attemptTimeout
        }, (upstreamRes) => {
          const contentType = String(upstreamRes.headers['content-type'] || '').toLowerCase();
          const isValidContentType = contentType.includes('event-stream') || contentType.includes('application/json');

          // If upstream error (non-200) or bogus proxy payload (non-API content-type)
          if (upstreamRes.statusCode !== 200 || !isValidContentType) {
            let errBody = '';
            upstreamRes.on('data', chunk => errBody += chunk.toString());
            upstreamRes.on('end', () => {
              console.warn(`[Proxy] Upstream ${upstreamRes.statusCode} error body for ${currentModel} (${routeLabel(activeRoute)}) [CT: ${contentType}]: ${errBody.slice(0, 300)}`);
              if (!isValidContentType) {
                try { upstreamReq.destroy(); } catch (e) {}
                if (upstreamRes.socket) {
                  try { upstreamRes.socket.destroy(); } catch (e) {}
                }
              }
              resolve({
                success: false,
                statusCode: (!isValidContentType && upstreamRes.statusCode === 200) ? 502 : upstreamRes.statusCode,
                headers: upstreamRes.headers,
                body: (!isValidContentType && upstreamRes.statusCode === 200) ? 'Proxy returned non-API payload (invalid content-type)' : errBody
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

        currentUpstreamReq = upstreamReq;
        upstreamReq.write(payloadString);
        upstreamReq.end();
      });
    } catch (err) {
      attemptResult = { success: false, statusCode: 502, headers: {}, body: err.message };
    }

    if (attemptResult.success) {
      const { upstreamRes, upstreamReq, resolvedModel } = attemptResult;

      // Hold the admission slot for the full response. Streaming inference is
      // the concurrency being bounded, not just header latency.
      upstreamRes.once('close', releaseSlot);
      egress.recordSuccess(activeRoute);
      if (!useWarp) {
        routeHealth.markDirectHealthy();
      } else {
        routeHealth.markWarpHealthy();
      }

      // Set fallback headers if auto-failover occurred
      if (resolvedModel !== requestedModel) {
        res.setHeader('x-opencode2api-fallback', `${requestedModel} -> ${resolvedModel}`);
      }
      res.setHeader('x-opencode2api-resolved-model', resolvedModel);
      res.setHeader('x-opencode2api-upstream-model', upstreamModel);
      if (upstreamRes.headers['x-zen-model']) {
        res.setHeader('x-zen-model', upstreamRes.headers['x-zen-model']);
      }

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
        // index -> 'client' | 'injected'; argument-only chunks carry no name.
        const toolCallKinds = new Map();
        let streamFailed = false;

        const failStream = (err) => {
          if (streamFailed) return;
          streamFailed = true;
          releaseSlot();
          console.warn(`[Proxy] Upstream stream interrupted for ${requestedModel} (${routeLabel(activeRoute)}): ${err?.message || 'unknown error'}`);
          if (!res.writableEnded && !res.destroyed) {
            try {
              res.write(`data: ${JSON.stringify({
                error: {
                  message: 'Upstream stream interrupted before completion.',
                  type: 'upstream_stream_error',
                  code: 502
                }
              })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            } catch (e) {
              try { res.end(); } catch (e2) {}
            }
          }
          metrics.recordRequest({
            model: requestedModel,
            status: 502,
            tokens: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
            latencyMs: Date.now() - startTime,
            stream: true,
            keyId: keyObj.id
          });
        };
        upstreamRes.on('error', failStream);
        upstreamRes.on('aborted', () => failStream(new Error('upstream aborted')));

        upstreamRes.on('data', (chunk) => {
          let chunkStr = chunk.toString();
          // Ensure model ID in chunks reflects the requested or resolved ID
          if (upstreamModel && resolvedModel && upstreamModel !== resolvedModel) {
            chunkStr = chunkStr.replaceAll(upstreamModel, requestedModel);
          }

          buffer += chunkStr;
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) {
              if (line) res.write(line + '\n');
              continue;
            }
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') {
              res.write('data: [DONE]\n\n');
              if (res.flush) res.flush();
              continue;
            }
            try {
              const p = JSON.parse(dataStr);
              if (p.usage) {
                promptTokens = p.usage.prompt_tokens || promptTokens;
                completionTokens = p.usage.completion_tokens || completionTokens;
                totalTokens = p.usage.total_tokens || totalTokens;
                reasoningTokens = p.usage.completion_tokens_details?.reasoning_tokens || reasoningTokens;
              }

              // Filter out injected tool calls from client stream (H2).
              // Tool argument chunks do not repeat the function name, so track
              // each streamed tool-call index once its name is known.
              if (p.choices && Array.isArray(p.choices)) {
                let skipChunk = false;
                for (const choice of p.choices) {
                  if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls)) {
                    const kept = [];
                    for (const tc of choice.delta.tool_calls) {
                      const idx = Number.isInteger(tc.index) ? tc.index : 0;
                      const name = tc.function?.name;
                      if (name) {
                        const isClient = !!(clientToolNames && clientToolNames.has(name));
                        toolCallKinds.set(idx, isClient ? 'client' : 'injected');
                      }
                      const kind = toolCallKinds.get(idx);
                      if (kind === 'client') {
                        kept.push(tc);
                      }
                    }
                    if (kept.length > 0) {
                      choice.delta.tool_calls = kept;
                    } else {
                      delete choice.delta.tool_calls;
                      if (choice.finish_reason === 'tool_calls') {
                        choice.finish_reason = 'stop';
                      }
                      if (!choice.delta.content && !choice.delta.reasoning_content && !choice.finish_reason) {
                        skipChunk = true;
                      }
                    }
                  }
                }
                if (skipChunk && !p.choices.some(c => c.delta?.content || c.finish_reason)) {
                  continue;
                }
              }

              res.write(`data: ${JSON.stringify(p)}\n\n`);
              if (res.flush) res.flush();
            } catch (e) {
              res.write(line + '\n');
              if (res.flush) res.flush();
            }
          }
        });

        upstreamRes.on('end', () => {
          if (streamFailed) return;
          releaseSlot();
          if (!res.writableEnded && !res.destroyed) res.end();
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

        function failAggregate(err) {
          if (finished) return;
          finished = true;
          releaseSlot();
          console.warn(`[Proxy] Upstream stream interrupted for ${requestedModel} (${routeLabel(activeRoute)}): ${err?.message || 'unknown error'}`);
          metrics.recordRequest({
            model: requestedModel,
            status: 502,
            tokens: { prompt_tokens: 0, completion_tokens: 0 },
            latencyMs: Date.now() - startTime,
            stream: false,
            keyId: keyObj.id
          });
          if (res.headersSent || res.destroyed || res.writableEnded) {
            try { res.end(); } catch (e) {}
            return;
          }
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: 'Upstream stream interrupted before completion.',
              type: 'upstream_stream_error',
              code: 502
            }
          }));
        }
        upstreamRes.on('error', failAggregate);
        upstreamRes.on('aborted', () => failAggregate(new Error('upstream aborted')));

        function finishResponse() {
          if (finished) return;
          finished = true;
          releaseSlot();

          const pTokens = finalUsage?.prompt_tokens || 0;
          const cTokens = finalUsage?.completion_tokens || Math.ceil((accumulatedContent.length + accumulatedReasoning.length) / 4);
          const rTokens = finalUsage?.completion_tokens_details?.reasoning_tokens || Math.ceil(accumulatedReasoning.length / 4);
          const total = finalUsage?.total_tokens || (pTokens + cTokens);

          const realToolCalls = accumulatedToolCalls.filter(tc => {
            const name = tc.function?.name;
            if (!name) return false;
            if (clientToolNames && clientToolNames.size > 0) {
              return clientToolNames.has(name);
            }
            return false;
          });
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
                  tool_calls: realToolCalls.length > 0 ? realToolCalls : undefined
                },
                finish_reason: realToolCalls.length > 0 ? "tool_calls" : "stop"
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
          if (!res.destroyed && !res.writableEnded) {
            res.end(JSON.stringify(responseJson, null, 2));
          }
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

    // No live stream was established; release admission before retrying.
    releaseSlot();

    // Upstream failed this attempt. Classify before spending more time.
    const statusCode = attemptResult.statusCode || 0;
    const bodyStr = typeof attemptResult.body === 'string' ? attemptResult.body : JSON.stringify(attemptResult.body || '');
    const retryAfterMs = egress.parseRetryAfter(attemptResult.headers?.['retry-after']);
    const failureKind = egress.classifyUpstreamFailure(statusCode, bodyStr);

    lastStatus = statusCode || 502;
    lastBody = bodyStr;

    if (failureKind === 'quota') {
      egress.recordFailure(activeRoute, 'quota', retryAfterMs || 60000);
      persistentSessions.rotate(routeKey);
      const retryAfterSec = Math.max(1, Math.ceil((retryAfterMs || 60000) / 1000));
      console.warn(`[Proxy] Upstream quota/capacity limit on ${routeLabel(activeRoute)} for ${currentModel}. Failing fast (Retry-After ${retryAfterSec}s).`);
      metrics.recordRequest({
        model: requestedModel,
        status: 429,
        tokens: {},
        latencyMs: Date.now() - startTime,
        stream: isClientStream,
        keyId: keyObj.id
      });
      sendJsonError(res, 429, 'free_tier_rate_limit',
        'OpenCode Free Tier capacity limit reached for this egress. The gateway fails fast instead of rotating IPs. Retry after the indicated delay, or configure an upstream Zen key or a user-owned proxy.',
        { 'Retry-After': String(retryAfterSec) });
      return;
    }

    if (failureKind === 'fatal') {
      egress.recordFailure(activeRoute, 'fatal');
      metrics.recordRequest({
        model: requestedModel,
        status: statusCode || 502,
        tokens: {},
        latencyMs: Date.now() - startTime,
        stream: isClientStream,
        keyId: keyObj.id
      });
      let errPayload = attemptResult.body;
      try { JSON.parse(errPayload); } catch (e) {
        errPayload = JSON.stringify({
          error: {
            message: typeof errPayload === 'string' && errPayload ? errPayload : `Upstream error for model "${requestedModel}" (${statusCode})`,
            type: 'upstream_error',
            code: statusCode || 502
          }
        });
      }
      if (typeof errPayload !== 'string') errPayload = JSON.stringify(errPayload);
      res.writeHead(statusCode || 502, { 'Content-Type': 'application/json' });
      res.end(errPayload);
      return;
    }

    // Network / 5xx failure: degrade the route and try the next configured one.
    egress.recordFailure(activeRoute, 'retry');
    if (activeRoute.type === 'warp') routeHealth.markWarpDegraded(bodyStr || `HTTP ${statusCode}`);
    else if (activeRoute.type === 'direct') routeHealth.markDirectDegraded(bodyStr || `HTTP ${statusCode}`);
    console.warn(`[Proxy] Upstream ${statusCode || 'network failure'} on ${routeLabel(activeRoute)} for ${currentModel}: ${bodyStr.slice(0, 200)}`);

    if (attempt > maxRetries) break;

    const nextRoute = egress.nextRoute(activeRoute, egress.getCandidates());
    if (nextRoute) {
      activeRoute = nextRoute;
      console.log(`[Proxy] Retrying on ${routeLabel(activeRoute)} (attempt ${attempt + 1}/${maxRetries + 1})...`);
    } else {
      const backoffMs = Math.min(250 * Math.pow(2, attempt - 1) + Math.random() * 200, 1500);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }

  // Retries exhausted, no alternate route, or deadline reached.
  metrics.recordRequest({
    model: requestedModel,
    status: lastStatus || 502,
    tokens: {},
    latencyMs: Date.now() - startTime,
    stream: isClientStream,
    keyId: keyObj.id
  });
  const finalStatus = lastStatus === 504 ? 504 : 502;
  sendJsonError(res, finalStatus, finalStatus === 504 ? 'upstream_timeout' : 'upstream_unavailable',
    lastStatus === 504
      ? 'Upstream request deadline exceeded.'
      : `All configured egress routes failed: ${(lastBody || 'unknown upstream error').slice(0, 300)}`);
}

/**
 * Handle Anthropic Messages endpoint (/v1/messages) with auto-retry & smart failover.
 */
async function handleAnthropicMessages(clientPayload, req, res, keyObj) {
  const startTime = Date.now();
  const isClientStream = clientPayload.stream === true;
  const rawRequestedModel = clientPayload.model;

  // On-demand model sync: If model is not in local cache, query upstream Zen models
  if (rawRequestedModel) {
    await discovery.ensureModel(rawRequestedModel);
  }

  const requestedModel = rawRequestedModel || discovery.getDefaultModelId();

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
          let toolContent = '';
          if (typeof block.content === 'string') {
            toolContent = block.content;
          } else if (Array.isArray(block.content)) {
            toolContent = block.content.map(c => (typeof c === 'string' ? c : c.text || JSON.stringify(c))).join('\n');
          } else {
            toolContent = JSON.stringify(block.content || '');
          }
          openAiMessages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolContent
          });
        }
      }
      if (parts.length > 0 || toolCalls.length > 0) {
        const item = {
          role: msg.role,
          content: parts.length === 0 ? null : (parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts)
        };
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

  let clientToolChoice = undefined;
  if (clientPayload.tool_choice) {
    if (clientPayload.tool_choice.type === 'auto') clientToolChoice = 'auto';
    else if (clientPayload.tool_choice.type === 'any') clientToolChoice = 'required';
    else if (clientPayload.tool_choice.type === 'tool' && clientPayload.tool_choice.name) {
      clientToolChoice = { type: 'function', function: { name: clientPayload.tool_choice.name } };
    }
  }

  const toolResult = tools.mergeTools(clientTools, clientToolChoice);
  const mergedTools = toolResult.tools;
  const mergedToolChoice = toolResult.toolChoice;
  const clientToolNames = toolResult.clientToolNames;

  const isFreeOnly = config.get('free_only') !== false;
  const isRequestedFree = discovery.isModelFree(requestedModel);

  // If gateway is in free-only mode, reject paid models explicitly
  if (isFreeOnly && !isRequestedFree) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `Model "${requestedModel}" is not an OpenCode Free Tier model. The gateway is currently configured to "Enforce 100% Free Models Only". To use paid models, disable this setting in Gateway Settings and provide an Upstream Zen Key.`
      }
    }));
    return;
  }

  // If requesting a paid model, verify an Upstream Zen Key is configured
  const upstreamKey = config.get('upstream_zen_key') || process.env.OPENCODE_ZEN_KEY || process.env.OPENCODE_API_KEY;
  if (!isRequestedFree && !upstreamKey) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: `Model "${requestedModel}" is a paid model that requires an Upstream Zen Key. Please enter your OpenCode Zen Key in Gateway Settings to route to this model.`
      }
    }));
    return;
  }

  let currentModel = requestedModel;
  const maxRetries = Math.min(3, configInt('max_retries', 0));
  const requestTimeout = configInt('request_timeout_ms', 30000, 5000);
  const deadline = startTime + Math.max(requestTimeout, configInt('request_deadline_ms', 90000, requestTimeout));
  const queueWaitMs = configInt('queue_wait_ms', 15000, 0);

  let activeRoute = egress.getCandidates()[0] || null;
  if (!activeRoute) {
    metrics.recordRequest({
      model: requestedModel,
      status: 503,
      tokens: {},
      latencyMs: Date.now() - startTime,
      stream: isClientStream,
      keyId: keyObj.id
    });
    sendAnthropicError(res, 503, 'no_egress_route',
      'No egress route is available. WARP is not ready and direct fallback is disabled. Wait for the sidecar or configure PROXIES / ALLOW_DIRECT_FALLBACK.',
      { 'Retry-After': '5' });
    return;
  }

  const initialQuotaMs = egress.getQuotaRetryAfter(activeRoute);
  if (initialQuotaMs > 0) {
    const retryAfterSec = Math.max(1, Math.ceil(initialQuotaMs / 1000));
    sendAnthropicError(res, 429, 'rate_limit_error',
      'OpenCode Free Tier capacity limit reached for this egress. The gateway fails fast instead of rotating IPs. Retry after the indicated delay, or configure an upstream Zen key or a user-owned proxy.',
      { 'Retry-After': String(retryAfterSec) });
    return;
  }

  let lastStatus = 0;
  let lastBody = '';
  let currentUpstreamReq = null;

  // Abort the in-flight upstream request if the client goes away. Listening on
  // the response (not the request) avoids destroying the upstream request when
  // the request body has merely finished being read.
  res.once('close', () => {
    if (!res.writableEnded && currentUpstreamReq) {
      try { currentUpstreamReq.destroy(); } catch (e) {}
    }
  });

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (!activeRoute) break;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      lastStatus = 504;
      lastBody = 'Upstream request deadline exceeded before the next attempt.';
      break;
    }

    const useWarp = activeRoute.type === 'warp';
    const upstreamModel = discovery.resolveUpstreamModel(currentModel);
    const routeKey = activeRoute.id;

    const session = persistentSessions.getOrCreate(routeKey);
    const sessionId = (attempt === 1) ? session.sessionId : identity.generateCanonicalSessionId();
    const projectId = (attempt === 1) ? session.projectId : identity.generateProjectId();

    const releaseSlot = await requestQueue.acquire(keyObj?.id || 'anonymous', Math.min(queueWaitMs, remainingMs));
    if (!releaseSlot) {
      metrics.recordRequest({
        model: requestedModel,
        status: 429,
        tokens: {},
        latencyMs: Date.now() - startTime,
        stream: isClientStream,
        keyId: keyObj.id
      });
      sendAnthropicError(res, 429, 'queue_full',
        'Gateway concurrency limit reached. Retry shortly.',
        { 'Retry-After': '5' });
      return;
    }

    const upstreamPayload = {
      model: upstreamModel,
      messages: openAiMessages,
      stream: true,
      tools: mergedTools,
      ...(mergedToolChoice !== undefined ? { tool_choice: mergedToolChoice } : {}),
      ...(clientPayload.temperature !== undefined ? { temperature: clientPayload.temperature } : {}),
      ...(clientPayload.top_p !== undefined ? { top_p: clientPayload.top_p } : {}),
      ...(clientPayload.max_tokens ? { max_tokens: clientPayload.max_tokens } : {})
    };

    const payloadString = JSON.stringify(upstreamPayload);
    const upstreamHeaders = identity.buildUpstreamHeaders(sessionId, projectId, Buffer.byteLength(payloadString));
    const attemptTimeout = Math.max(1000, Math.min(requestTimeout, deadline - Date.now()));

    const target = upstreamTarget();
    let attemptResult;
    try {
      attemptResult = await new Promise((resolve) => {
        if (target.protocol !== 'https:' && activeRoute.type !== 'direct') {
          resolve({
            success: false,
            statusCode: 502,
            headers: {},
            body: 'Plaintext upstream_inference_url requires direct egress'
          });
          return;
        }
        let isTimedOut = false;
        const upstreamReq = target.transport.request({
          hostname: target.hostname,
          port: target.port,
          path: target.path,
          method: 'POST',
          headers: upstreamHeaders,
          agent: egress.getAgent(activeRoute, target.protocol),
          timeout: attemptTimeout
        }, (upstreamRes) => {
          const contentType = String(upstreamRes.headers['content-type'] || '').toLowerCase();
          const isValidContentType = contentType.includes('event-stream') || contentType.includes('application/json');

          if (upstreamRes.statusCode !== 200 || !isValidContentType) {
            let errBody = '';
            upstreamRes.on('data', chunk => errBody += chunk.toString());
            upstreamRes.on('end', () => {
              console.warn(`[Proxy] Upstream ${upstreamRes.statusCode} error body for Anthropic model ${currentModel} (${routeLabel(activeRoute)}) [CT: ${contentType}]: ${errBody.slice(0, 300)}`);
              if (!isValidContentType) {
                try { upstreamReq.destroy(); } catch (e) {}
                if (upstreamRes.socket) {
                  try { upstreamRes.socket.destroy(); } catch (e) {}
                }
              }
              resolve({
                success: false,
                statusCode: (!isValidContentType && upstreamRes.statusCode === 200) ? 502 : upstreamRes.statusCode,
                headers: upstreamRes.headers,
                body: (!isValidContentType && upstreamRes.statusCode === 200) ? 'Proxy returned non-API payload (invalid content-type)' : errBody
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
    } finally {
      releaseSlot();
    }

    if (attemptResult.success) {
      const { upstreamRes, upstreamReq, resolvedModel } = attemptResult;
      const messageId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);

      // Hold the admission slot until the stream finishes or aborts.
      upstreamRes.once('close', releaseSlot);
      egress.recordSuccess(activeRoute);
      if (!useWarp) {
        routeHealth.markDirectHealthy();
      } else {
        routeHealth.markWarpHealthy();
      }

      if (resolvedModel !== requestedModel) {
        res.setHeader('x-opencode2api-fallback', `${requestedModel} -> ${resolvedModel}`);
      }
      res.setHeader('x-opencode2api-resolved-model', resolvedModel);
      res.setHeader('x-opencode2api-upstream-model', upstreamModel);
      if (upstreamRes.headers['x-zen-model']) {
        res.setHeader('x-zen-model', upstreamRes.headers['x-zen-model']);
      }

      if (isClientStream) {
        // Stream Anthropic SSE with zero buffering & extended thinking / tool call support
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

        let buffer = '';
        let promptTokens = 0;
        let completionTokens = 0;
        let reasoningTokens = 0;
        let activeBlockIndex = -1;
        let activeBlockType = null;
        let activeToolIndex = null;
        let hasToolCalls = false;
        // index -> 'client' | 'injected'; argument-only chunks carry no name.
        const toolCallKinds = new Map();
        let streamFailed = false;

        const failStream = (err) => {
          if (streamFailed) return;
          streamFailed = true;
          releaseSlot();
          console.warn(`[Proxy] Upstream Anthropic stream interrupted for ${requestedModel} (${routeLabel(activeRoute)}): ${err?.message || 'unknown error'}`);
          if (!res.writableEnded && !res.destroyed) {
            try {
              res.write(`event: error\ndata: ${JSON.stringify({
                type: 'error',
                error: {
                  type: 'api_error',
                  message: 'Upstream stream interrupted before completion.'
                }
              })}\n\n`);
              res.end();
            } catch (e) {
              try { res.end(); } catch (e2) {}
            }
          }
          metrics.recordRequest({
            model: requestedModel,
            status: 502,
            tokens: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
            latencyMs: Date.now() - startTime,
            stream: true,
            keyId: keyObj.id
          });
        };
        upstreamRes.on('error', failStream);
        upstreamRes.on('aborted', () => failStream(new Error('upstream aborted')));

        function closeCurrentBlock() {
          if (activeBlockIndex >= 0 && activeBlockType !== null) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: activeBlockIndex
            })}\n\n`);
            activeBlockType = null;
          }
        }

        function ensureThinkingBlock() {
          if (activeBlockType !== 'thinking') {
            closeCurrentBlock();
            activeBlockIndex++;
            activeBlockType = 'thinking';
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: activeBlockIndex,
              content_block: {
                type: 'thinking',
                thinking: ''
              }
            })}\n\n`);
          }
        }

        function ensureTextBlock() {
          if (activeBlockType !== 'text') {
            closeCurrentBlock();
            activeBlockIndex++;
            activeBlockType = 'text';
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: activeBlockIndex,
              content_block: {
                type: 'text',
                text: ''
              }
            })}\n\n`);
          }
        }

        function ensureToolBlock(toolIndex, toolId, toolName) {
          if (activeBlockType !== 'tool_use' || activeToolIndex !== toolIndex) {
            closeCurrentBlock();
            activeBlockIndex++;
            activeBlockType = 'tool_use';
            activeToolIndex = toolIndex;
            hasToolCalls = true;
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: activeBlockIndex,
              content_block: {
                type: 'tool_use',
                id: toolId || ('call_' + activeBlockIndex),
                name: toolName || '',
                input: {}
              }
            })}\n\n`);
          }
        }

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
                reasoningTokens = parsed.usage.completion_tokens_details?.reasoning_tokens || reasoningTokens;
              }
              const delta = parsed.choices?.[0]?.delta;
              if (delta) {
                if (delta.reasoning_content) {
                  ensureThinkingBlock();
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: activeBlockIndex,
                    delta: { type: 'thinking_delta', thinking: delta.reasoning_content }
                  })}\n\n`);
                  if (res.flush) res.flush();
                }

                if (delta.content) {
                  ensureTextBlock();
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: activeBlockIndex,
                    delta: { type: 'text_delta', text: delta.content }
                  })}\n\n`);
                  if (res.flush) res.flush();
                }

                if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const tIndex = tc.index !== undefined ? tc.index : 0;
                    const name = tc.function?.name;
                    if (name) {
                      const isClient = !!(clientToolNames && clientToolNames.has(name));
                      toolCallKinds.set(tIndex, isClient ? 'client' : 'injected');
                    }
                    if (toolCallKinds.get(tIndex) !== 'client') continue;
                    if (name) {
                      ensureToolBlock(tIndex, tc.id, name);
                    }
                    if (tc.function?.arguments && activeBlockType === 'tool_use' && activeToolIndex === tIndex) {
                      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: 'content_block_delta',
                        index: activeBlockIndex,
                        delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
                      })}\n\n`);
                      if (res.flush) res.flush();
                    }
                  }
                }
              }
            } catch (e) {}
          }
        });

        upstreamRes.on('end', () => {
          if (streamFailed) return;
          releaseSlot();
          if (res.destroyed || res.writableEnded) return;
          closeCurrentBlock();

          if (activeBlockIndex < 0) {
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' }
            })}\n\n`);
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: 0
            })}\n\n`);
          }

          res.write(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: hasToolCalls ? 'tool_use' : 'end_turn', stop_sequence: null },
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
            tokens: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: total, reasoning_tokens: reasoningTokens },
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

        function failAggregate(err) {
          if (finished) return;
          finished = true;
          releaseSlot();
          console.warn(`[Proxy] Upstream Anthropic stream interrupted for ${requestedModel} (${routeLabel(activeRoute)}): ${err?.message || 'unknown error'}`);
          metrics.recordRequest({
            model: requestedModel,
            status: 502,
            tokens: { prompt_tokens: 0, completion_tokens: 0 },
            latencyMs: Date.now() - startTime,
            stream: false,
            keyId: keyObj.id
          });
          if (res.headersSent || res.destroyed || res.writableEnded) {
            try { res.end(); } catch (e) {}
            return;
          }
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: {
              type: 'api_error',
              message: 'Upstream stream interrupted before completion.'
            }
          }));
        }
        upstreamRes.on('error', failAggregate);
        upstreamRes.on('aborted', () => failAggregate(new Error('upstream aborted')));

        function finishAnthropic() {
          if (finished) return;
          finished = true;
          releaseSlot();

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
          const realToolCalls = accumulatedToolCalls.filter(tc => {
            const name = tc.function?.name;
            if (!name) return false;
            return clientToolNames && clientToolNames.has(name);
          });
          for (const tc of realToolCalls) {
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
            stop_reason: realToolCalls.length > 0 ? 'tool_use' : 'end_turn',
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
          if (!res.destroyed && !res.writableEnded) {
            res.end(JSON.stringify(anthropicRes, null, 2));
          }
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

    // No live stream was established; release admission before retrying.
    releaseSlot();

    // Upstream failed this attempt. Classify before spending more time.
    const statusCode = attemptResult.statusCode || 0;
    const bodyStr = typeof attemptResult.body === 'string' ? attemptResult.body : JSON.stringify(attemptResult.body || '');
    const retryAfterMs = egress.parseRetryAfter(attemptResult.headers?.['retry-after']);
    const failureKind = egress.classifyUpstreamFailure(statusCode, bodyStr);

    lastStatus = statusCode || 502;
    lastBody = bodyStr;

    if (failureKind === 'quota') {
      egress.recordFailure(activeRoute, 'quota', retryAfterMs || 60000);
      persistentSessions.rotate(routeKey);
      const retryAfterSec = Math.max(1, Math.ceil((retryAfterMs || 60000) / 1000));
      console.warn(`[Proxy] Upstream quota/capacity limit on ${routeLabel(activeRoute)} for ${currentModel}. Failing fast (Retry-After ${retryAfterSec}s).`);
      metrics.recordRequest({
        model: requestedModel,
        status: 429,
        tokens: {},
        latencyMs: Date.now() - startTime,
        stream: isClientStream,
        keyId: keyObj.id
      });
      sendAnthropicError(res, 429, 'rate_limit_error',
        'OpenCode Free Tier capacity limit reached for this egress. The gateway fails fast instead of rotating IPs. Retry after the indicated delay, or configure an upstream Zen key or a user-owned proxy.',
        { 'Retry-After': String(retryAfterSec) });
      return;
    }

    if (failureKind === 'fatal') {
      egress.recordFailure(activeRoute, 'fatal');
      metrics.recordRequest({
        model: requestedModel,
        status: statusCode || 502,
        tokens: {},
        latencyMs: Date.now() - startTime,
        stream: isClientStream,
        keyId: keyObj.id
      });
      let errPayload = attemptResult.body;
      try { JSON.parse(errPayload); } catch (e) {
        errPayload = JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: typeof errPayload === 'string' && errPayload ? errPayload : `Upstream error for model "${requestedModel}" (${statusCode})`
          }
        });
      }
      if (typeof errPayload !== 'string') errPayload = JSON.stringify(errPayload);
      res.writeHead(statusCode || 502, { 'Content-Type': 'application/json' });
      res.end(errPayload);
      return;
    }

    // Network / 5xx failure: degrade the route and try the next configured one.
    egress.recordFailure(activeRoute, 'retry');
    if (activeRoute.type === 'warp') routeHealth.markWarpDegraded(bodyStr || `HTTP ${statusCode}`);
    else if (activeRoute.type === 'direct') routeHealth.markDirectDegraded(bodyStr || `HTTP ${statusCode}`);
    console.warn(`[Proxy] Upstream ${statusCode || 'network failure'} on ${routeLabel(activeRoute)} for Anthropic model ${currentModel}: ${bodyStr.slice(0, 200)}`);

    if (attempt > maxRetries) break;

    const nextRoute = egress.nextRoute(activeRoute, egress.getCandidates());
    if (nextRoute) {
      activeRoute = nextRoute;
      console.log(`[Proxy] Retrying Anthropic request on ${routeLabel(activeRoute)} (attempt ${attempt + 1}/${maxRetries + 1})...`);
    } else {
      const backoffMs = Math.min(250 * Math.pow(2, attempt - 1) + Math.random() * 200, 1500);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }

  // Retries exhausted, no alternate route, or deadline reached.
  metrics.recordRequest({
    model: requestedModel,
    status: lastStatus || 502,
    tokens: {},
    latencyMs: Date.now() - startTime,
    stream: isClientStream,
    keyId: keyObj.id
  });
  const finalStatus = lastStatus === 504 ? 504 : 502;
  sendAnthropicError(res, finalStatus, finalStatus === 504 ? 'api_error' : 'api_error',
    lastStatus === 504
      ? 'Upstream request deadline exceeded.'
      : `All configured egress routes failed: ${(lastBody || 'unknown upstream error').slice(0, 300)}`);
}

module.exports = {
  handleChatCompletions,
  handleAnthropicMessages,
  routeHealth
};
