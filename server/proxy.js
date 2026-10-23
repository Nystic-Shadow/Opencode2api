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
const warp = require('./warp');

// High-performance keepAlive connection agent: keeps TLS sockets hot, eliminates handshake lag
const upstreamAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: 60000,
  keepAliveMsecs: 30000
});

let proxyIndex = 0;

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
    if (this.isWarpDegraded()) return false;
    if (!warp.isReady()) return false;
    return true;
  }
};

/**
 * Returns either a Cloudflare WARP SOCKS5 agent, proxy tunnel agent, or direct keepAlive agent.
 */
function getUpstreamAgent(attempt = 1, useWarp = false) {
  if (useWarp && warp.isReady()) {
    return warp.getWarpAgent(warp.getActivePort(), config.get('warp_host'));
  }

  const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const configuredProxies = config.get('proxies') || [];
  const proxyList = Array.isArray(configuredProxies) && configuredProxies.length > 0
    ? configuredProxies
    : (envProxy ? [envProxy] : []);

  if (proxyList.length > 0) {
    const proxyUrlStr = proxyList[(attempt - 1) % proxyList.length];
    try {
      const proxyUrl = new URL(proxyUrlStr);
      const agent = new https.Agent({
        keepAlive: true
      });
      agent.createConnection = function(options, callback) {
        const targetHost = options.host || options.hostname || 'opencode.ai';
        const targetPort = options.port || 443;
        const connectReq = http.request({
          host: proxyUrl.hostname,
          port: proxyUrl.port || 80,
          method: 'CONNECT',
          path: `${targetHost}:${targetPort}`,
          headers: {
            Host: `${targetHost}:${targetPort}`,
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
            servername: options.servername || targetHost
          }, () => {
            callback(null, tlsSocket);
          });
          tlsSocket.on('error', err => callback(err));
        });
        connectReq.on('error', err => callback(err));
        connectReq.end();
      };
      return agent;
    } catch (err) {
      console.error('[ProxyAgent] Failed to create proxy agent, falling back to direct:', err.message);
    }
  }

  return upstreamAgent;
}

function normalizeModelId(id) {
  if (!id) return '';
  return id.replace(/[-_]?free$/i, '');
}

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
 * Determine the next healthy fallback model for resilient failover.
 * Enabled by default to eliminate capacity limit drops on throttled models.
 */
function getNextFallbackModel(currentModel, triedModels = new Set(), hasImages = false) {
  if (config.get('smart_fallback') !== true) return null;

  // Strict: only free models participate in failover cascades (never downgrade paid models)
  const isFree = discovery.isModelFree(currentModel);
  if (!isFree) return null;

  const allFree = discovery.getAllModels().filter(m => m.is_free);

  // Preferred priority ranking of high-reliability free models (1M context powerhouses first)
  const priorityOrder = [
    'beam',
    'nemotron-3.5-lightning',
    'deepseek-v4.1-flash',
    'glm-5.3-flash',
    'nemotron-3.5-super-vl',
    'mimo-v2.6-flash',
    'big-pickle',
    'flint-40b'
  ];

  const untried = allFree.filter(m => {
    if (m.id === currentModel || m.upstream_id === currentModel) return false;
    if (triedModels.has(m.id) || triedModels.has(m.upstream_id)) return false;
    if (hasImages && !m.supports_vision) return false;
    return true;
  });

  if (untried.length === 0) return null;

  untried.sort((a, b) => {
    let aIdx = priorityOrder.indexOf(a.id);
    let bIdx = priorityOrder.indexOf(b.id);
    if (aIdx === -1) aIdx = 999;
    if (bIdx === -1) bIdx = 999;
    return aIdx - bIdx;
  });

  return untried[0].id;
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
  const mergedTools = tools.mergeTools(clientPayload.tools);

  let currentModel = requestedModel;
  const hasImages = payloadHasImages(clientPayload);
  const triedModels = new Set([currentModel]);
  const maxRetries = config.get('max_retries') !== undefined ? config.get('max_retries') : 5;
  const requestTimeout = config.get('request_timeout_ms') || 60000;
  let requestWarpFailed = false;
  let useWarp = routeHealth.shouldUseWarp(1);
  let consecutiveRateLimits = 0;
  let warpRotatedInThisRequest = false;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (attempt > 1) {
      useWarp = requestWarpFailed ? false : routeHealth.shouldUseWarp(attempt);
    }
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
        agent: getUpstreamAgent(attempt, useWarp),
        timeout: requestTimeout
      }, (upstreamRes) => {
        // If upstream error (non-200), buffer body to inspect retryability
        if (upstreamRes.statusCode !== 200) {
          let errBody = '';
          upstreamRes.on('data', chunk => errBody += chunk.toString());
          upstreamRes.on('end', () => {
            console.warn(`[Proxy] Upstream ${upstreamRes.statusCode} error body for ${currentModel} (${useWarp ? 'WARP' : 'Direct'}): ${errBody}`);
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
    const statusCode = attemptResult.statusCode;
    const bodyStr = typeof attemptResult.body === 'string' ? attemptResult.body : JSON.stringify(attemptResult.body || '');
    const isRateLimited = statusCode === 429 ||
      bodyStr.includes('FreeUsageLimitError') ||
      bodyStr.includes('FreeTierError') ||
      bodyStr.includes('capacity limit') ||
      bodyStr.includes('rate limit') ||
      bodyStr.includes('Rate limit');
    const isForbidden = statusCode === 403;

    const isWarpFailure = useWarp && (
      statusCode === 502 ||
      statusCode === 504 ||
      bodyStr.includes('ECONNREFUSED') ||
      bodyStr.includes('timeout') ||
      bodyStr.includes('ETIMEDOUT') ||
      bodyStr.includes('ECONNRESET') ||
      bodyStr.includes('SOCKS5')
    );

    // If WARP proxy failed with network/socket error, attempt rapid rotation to healthy tunnel slot
    if (isWarpFailure) {
      console.warn(`[Proxy] WARP connection notice (${attemptResult.body}), rotating to clean tunnel slot...`);
      routeHealth.markWarpDegraded(attemptResult.body);
      if (!warpRotatedInThisRequest) {
        const rotated = await warp.rotateKeys('connection_failure');
        warpRotatedInThisRequest = true;
        if (rotated) {
          useWarp = true;
          requestWarpFailed = false;
        } else {
          useWarp = false;
          requestWarpFailed = true;
        }
      }
    } else if (isRateLimited || isForbidden) {
      consecutiveRateLimits++;
      // Only rotate WARP tunnel if 2 consecutive models fail with 429 on this tunnel (or smart fallback disabled)
      // AND we haven't already rotated in this request
      const shouldRotateWarp = useWarp && (consecutiveRateLimits >= 2 || config.get('smart_fallback') === false) && !warpRotatedInThisRequest;

      if (shouldRotateWarp) {
        console.warn(`[WARP] Consecutive rate limits detected (${consecutiveRateLimits}) on port ${warp.getActivePort()}. Auto-rotating tunnel session keys to fresh egress IP...`);
        const rotated = await warp.rotateKeys('auto_rate_limit');
        warpRotatedInThisRequest = true;
        consecutiveRateLimits = 0;
        if (rotated) {
          console.log(`[WARP] Fresh Cloudflare egress IP active on port ${warp.getActivePort()}. Retrying request seamlessly...`);
          useWarp = true;
          requestWarpFailed = false;
        }
      } else if (useWarp) {
        console.log(`[Proxy] Model "${currentModel}" returned ${statusCode}. Preserving tunnel, attempting fallback on current slot...`);
      } else {
        // Direct route hit 429 or 403!
        console.warn(`[Proxy] Direct route returned ${statusCode} (${isRateLimited ? 'Rate Limit' : 'Forbidden'}). Auto-promoting Cloudflare WARP as primary egress...`);
        routeHealth.markDirectDegraded(statusCode);
        if (warp.isReady() && config.get('warp_mode') !== 'disabled') {
          useWarp = true;
          requestWarpFailed = false;
        } else if (config.get('warp_mode') !== 'disabled') {
          warp.autoBootstrap().catch(() => {});
        }
      }
    } else if (!useWarp) {
      // Direct route failed with other error
      routeHealth.markDirectDegraded(statusCode || attemptResult.body);
      if (warp.isReady() && !routeHealth.isWarpDegraded() && config.get('warp_mode') !== 'disabled') {
        useWarp = true;
      }
    }

    // Strict Model Isolation: Paid models (Claude Opus, GPT, etc.) must NEVER failover to a different model!
    if (!isRequestedFree) {
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
      try { JSON.parse(errPayload); } catch (e) {
        errPayload = JSON.stringify({
          error: {
            message: typeof errPayload === 'string' && errPayload ? errPayload : `Upstream error for model "${requestedModel}" (${attemptResult.statusCode})`,
            type: 'upstream_error',
            code: attemptResult.statusCode
          }
        });
      }
      res.end(errPayload);
      return;
    }

    if (attempt <= maxRetries) {
      const fallback = getNextFallbackModel(currentModel, triedModels, hasImages);
      if (fallback) {
        console.log(`[Proxy] Model ${currentModel} returned ${attemptResult.statusCode}. Smart failover to ${fallback} (Attempt ${attempt}/${maxRetries + 1})...`);
        currentModel = fallback;
        triedModels.add(fallback);
      } else {
        const routeLabel = useWarp ? `Cloudflare WARP (port ${warp.getActivePort()})` : 'direct route';
        console.log(`[Proxy] Upstream ${attemptResult.statusCode || 'failure'} on model "${currentModel}". Retrying via ${routeLabel} with fresh session ID (Attempt ${attempt}/${maxRetries + 1})...`);
      }

      // Exponential backoff with random jitter
      const backoffMs = Math.min(300 * Math.pow(1.5, attempt - 1) + Math.random() * 200, 2000);
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
      const isFreeTierErr = (attemptResult.statusCode === 403 || attemptResult.statusCode === 429) && typeof errPayload === 'string' &&
        (errPayload.includes('FreeTierError') || errPayload.includes('FreeUsageLimitError') || errPayload.includes('capacity limit') || errPayload.includes('rate limit') || errPayload.includes('Rate limit'));

      if (isFreeTierErr) {
        if (warp.isAvailable()) {
          warp.rotateKeys('exhausted_failover').catch(() => {});
        }
        errPayload = JSON.stringify({
          error: {
            message: "OpenCode Free Tier capacity limit reached for this IP window. Rate limits automatically reset shortly. You can also configure an upstream Zen key or proxy in Settings to continue without interruption.",
            type: "free_tier_rate_limit",
            code: attemptResult.statusCode
          }
        });
      } else {
        try {
          JSON.parse(errPayload);
        } catch (e) {
          errPayload = JSON.stringify({
            error: {
              message: typeof errPayload === 'string' && errPayload ? errPayload : `Upstream gateway error (Status ${attemptResult.statusCode})`,
              type: 'upstream_error',
              code: attemptResult.statusCode
            }
          });
        }
      }
      res.end(errPayload);
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

  const mergedTools = tools.mergeTools(clientTools);

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
  const hasImages = anthropicPayloadHasImages(clientPayload);
  const triedModels = new Set([currentModel]);
  const maxRetries = config.get('max_retries') !== undefined ? config.get('max_retries') : 5;
  const requestTimeout = config.get('request_timeout_ms') || 60000;
  let requestWarpFailed = false;
  let useWarp = routeHealth.shouldUseWarp(1);
  let consecutiveRateLimits = 0;
  let warpRotatedInThisRequest = false;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (attempt > 1) {
      useWarp = requestWarpFailed ? false : routeHealth.shouldUseWarp(attempt);
    }
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
        agent: getUpstreamAgent(attempt, useWarp),
        timeout: requestTimeout
      }, (upstreamRes) => {
        if (upstreamRes.statusCode !== 200) {
          let errBody = '';
          upstreamRes.on('data', chunk => errBody += chunk.toString());
          upstreamRes.on('end', () => {
            console.warn(`[Proxy] Upstream ${upstreamRes.statusCode} error body for ${currentModel} (${useWarp ? 'WARP' : 'Direct'}): ${errBody}`);
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
                    ensureToolBlock(tIndex, tc.id, tc.function?.name);
                    if (tc.function?.arguments) {
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
    const statusCode = attemptResult.statusCode;
    const bodyStr = typeof attemptResult.body === 'string' ? attemptResult.body : JSON.stringify(attemptResult.body || '');
    const isRateLimited = statusCode === 429 ||
      bodyStr.includes('FreeUsageLimitError') ||
      bodyStr.includes('FreeTierError') ||
      bodyStr.includes('capacity limit') ||
      bodyStr.includes('rate limit') ||
      bodyStr.includes('Rate limit');
    const isForbidden = statusCode === 403;

    const isWarpFailure = useWarp && (
      statusCode === 502 ||
      statusCode === 504 ||
      bodyStr.includes('ECONNREFUSED') ||
      bodyStr.includes('timeout') ||
      bodyStr.includes('ETIMEDOUT') ||
      bodyStr.includes('ECONNRESET') ||
      bodyStr.includes('SOCKS5')
    );

    // If WARP proxy failed with network/socket error, attempt rapid rotation to healthy tunnel slot
    if (isWarpFailure) {
      console.warn(`[Proxy] Anthropic WARP connection notice (${attemptResult.body}), rotating to clean tunnel slot...`);
      routeHealth.markWarpDegraded(attemptResult.body);
      if (!warpRotatedInThisRequest) {
        const rotated = await warp.rotateKeys('connection_failure');
        warpRotatedInThisRequest = true;
        if (rotated) {
          useWarp = true;
          requestWarpFailed = false;
        } else {
          useWarp = false;
          requestWarpFailed = true;
        }
      }
    } else if (isRateLimited || isForbidden) {
      consecutiveRateLimits++;
      // Only rotate WARP tunnel if 2 consecutive models fail with 429 on this tunnel (or smart fallback disabled)
      // AND we haven't already rotated in this request
      const shouldRotateWarp = useWarp && (consecutiveRateLimits >= 2 || config.get('smart_fallback') === false) && !warpRotatedInThisRequest;

      if (shouldRotateWarp) {
        console.warn(`[WARP] Anthropic Consecutive rate limits detected (${consecutiveRateLimits}) on port ${warp.getActivePort()}. Auto-rotating tunnel session keys to fresh egress IP...`);
        const rotated = await warp.rotateKeys('auto_rate_limit');
        warpRotatedInThisRequest = true;
        consecutiveRateLimits = 0;
        if (rotated) {
          console.log(`[WARP] Fresh Cloudflare egress IP active on port ${warp.getActivePort()}. Retrying Anthropic request seamlessly...`);
          useWarp = true;
          requestWarpFailed = false;
        }
      } else if (useWarp) {
        console.log(`[Proxy] Anthropic Model "${currentModel}" returned ${statusCode}. Preserving tunnel, attempting fallback on current slot...`);
      } else {
        // Direct route hit 429 or 403!
        console.warn(`[Proxy] Anthropic direct route returned ${statusCode} (${isRateLimited ? 'Rate Limit' : 'Forbidden'}). Auto-promoting Cloudflare WARP as primary egress...`);
        routeHealth.markDirectDegraded(statusCode);
        if (warp.isReady() && config.get('warp_mode') !== 'disabled') {
          useWarp = true;
          requestWarpFailed = false;
        } else if (config.get('warp_mode') !== 'disabled') {
          warp.autoBootstrap().catch(() => {});
        }
      }
    } else if (!useWarp) {
      // Direct route failed with other error
      routeHealth.markDirectDegraded(statusCode || attemptResult.body);
      if (warp.isReady() && !routeHealth.isWarpDegraded() && config.get('warp_mode') !== 'disabled') {
        useWarp = true;
      }
    }

    // Strict Model Isolation: Paid models (Claude Opus, GPT, etc.) must NEVER failover to a different model!
    if (!isRequestedFree) {
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
      try { JSON.parse(errPayload); } catch (e) {
        errPayload = JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: typeof errPayload === 'string' && errPayload ? errPayload : `Upstream error for model "${requestedModel}" (${attemptResult.statusCode})`
          }
        });
      }
      res.end(errPayload);
      return;
    }

    if (attempt <= maxRetries) {
      const fallback = getNextFallbackModel(currentModel, triedModels, hasImages);
      if (fallback) {
        console.log(`[Proxy] Anthropic Model ${currentModel} returned ${attemptResult.statusCode}. Smart failover to ${fallback}...`);
        currentModel = fallback;
        triedModels.add(fallback);
      } else {
        const routeLabel = useWarp ? `Cloudflare WARP (port ${warp.getActivePort()})` : 'direct route';
        console.log(`[Proxy] Upstream ${attemptResult.statusCode || 'failure'} on Anthropic model "${currentModel}". Retrying via ${routeLabel} with fresh session ID (Attempt ${attempt}/${maxRetries + 1})...`);
      }
      const backoffMs = Math.min(300 * Math.pow(1.5, attempt - 1) + Math.random() * 200, 2000);
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
      const isFreeTierErr = (attemptResult.statusCode === 403 || attemptResult.statusCode === 429) && typeof errPayload === 'string' &&
        (errPayload.includes('FreeTierError') || errPayload.includes('FreeUsageLimitError') || errPayload.includes('capacity limit') || errPayload.includes('rate limit') || errPayload.includes('Rate limit'));

      if (isFreeTierErr) {
        if (warp.isAvailable()) {
          warp.rotateKeys('exhausted_failover').catch(() => {});
        }
        errPayload = JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: "OpenCode Free Tier capacity limit reached for this IP window. Rate limits automatically reset shortly. Configure Cloudflare WARP, an upstream proxy, or an upstream Zen key in Settings to continue without interruption."
          }
        });
      } else {
        try {
          JSON.parse(errPayload);
        } catch (e) {
          errPayload = JSON.stringify({
            type: 'error',
            error: {
              type: 'api_error',
              message: typeof errPayload === 'string' && errPayload ? errPayload : `Upstream gateway error (${attemptResult.statusCode})`
            }
          });
        }
      }
      res.end(errPayload);
      return;
    }
  }
}

module.exports = {
  handleChatCompletions,
  handleAnthropicMessages,
  routeHealth
};
