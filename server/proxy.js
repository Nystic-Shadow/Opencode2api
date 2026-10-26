const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const config = require('./config');
const identity = require('./identity');
const tools = require('./tools');
const discovery = require('./discovery');
const keys = require('./keys');
const metrics = require('./metrics');
const egress = require('./egress');
const requestQueue = require('./requestQueue');
const upstreamQuota = require('./upstreamQuota');
const bunBridge = require('./bunBridge');
const upstreamContext = require('./upstreamContext');

const isDirectOfficialAttempt = bunBridge.isDirectOfficialAttempt;

// Loopback connections to the Bun bridge must never use the egress proxy
// agents; the bridge chooses the proxy for the upstream hop per request.
const bridgeAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  timeout: 30000
});

function routeLabel(route) {
  if (!route) return 'no egress route';
  if (route.type === 'proxy') return `proxy:${route.id}`;
  return 'direct';
}

function configInt(key, fallback, min = 0) {
  const parsed = parseInt(config.get(key), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

const PROXY_TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE'
]);

// A tunnel failure is not upstream capacity. Pull the route out of rotation
// immediately so the same request can move to the next proxy without waiting
// for three generic retry failures.
function isProxyTransportError(err, route) {
  if (!err || !route || route.type !== 'proxy') return false;
  if (err.proxyFailure === true) return true;
  return PROXY_TRANSPORT_CODES.has(err.code);
}

const DEFAULT_UPSTREAM_URL = 'https://opencode.ai/inference/openai/v1/chat/completions';

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

// Build the loopback request sent to the Bun bridge. The selected egress
// proxy travels as base64url so Bun can use it for this request only.
function bridgeRequestOptions(bridge, target, upstreamHeaders, route) {
  const headers = {
    ...upstreamHeaders,
    'x-opencode2api-bridge-token': bridge.token
  };
  const proxyHeader = bunBridge.encodeProxyHeader(route);
  if (proxyHeader) headers['x-opencode2api-bridge-proxy'] = proxyHeader;
  return {
    hostname: bridge.host,
    port: bridge.port,
    path: target.path,
    method: 'POST',
    headers,
    agent: bridgeAgent
  };
}

async function resolveBridgeConnection(officialUpstream, isRequestedFree, waitMs) {
  if (!officialUpstream || !bunBridge.isEnabled()) {
    return { bridge: null, required: false };
  }
  if (!bunBridge.isReady()) {
    await bunBridge.ensureReady(waitMs);
  }
  const bridge = bunBridge.getConnection();
  return { bridge, required: !bridge && isRequestedFree };
}

function sendJsonError(res, statusCode, type, message, headers = {}, extra = {}) {
  if (res.headersSent) {
    try { res.end(); } catch (e) {}
    return;
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({
    error: {
      message,
      type,
      code: statusCode,
      ...extra
    }
  }));
}

function sendAnthropicError(res, statusCode, type, message, headers = {}, extra = {}) {
  if (res.headersSent) {
    try { res.end(); } catch (e) {}
    return;
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({
    type: 'error',
    error: {
      type,
      message,
      ...extra
    }
  }));
}

function freeQuotaHeaders(block) {
  return {
    'Retry-After': String(block.retryAfterSeconds),
    'x-opencode2api-free-quota-reset': block.resetAt,
    'x-opencode2api-upstream-error': 'FreeUsageLimitError'
  };
}

function freeQuotaFields(block) {
  return {
    upstream_error: 'FreeUsageLimitError',
    reset_at: block.resetAt,
    retry_after_seconds: block.retryAfterSeconds
  };
}

function anthropicStopReason(openAiReason, hasToolCalls = false) {
  if (hasToolCalls || openAiReason === 'tool_calls') return 'tool_use';
  if (openAiReason === 'length') return 'max_tokens';
  return 'end_turn';
}

const pausedUpstreams = new WeakSet();

function writeStream(res, upstreamRes, chunk) {
  if (res.destroyed || res.writableEnded) return false;
  let ok = false;
  try {
    ok = res.write(chunk);
  } catch (e) {
    return false;
  }
  if (!ok && upstreamRes && !upstreamRes.destroyed && !pausedUpstreams.has(upstreamRes)) {
    pausedUpstreams.add(upstreamRes);
    upstreamRes.pause();
    res.once('drain', () => {
      pausedUpstreams.delete(upstreamRes);
      if (!upstreamRes.destroyed) upstreamRes.resume();
    });
  }
  return ok;
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION PERSISTENCE — Each egress route keeps a stable session ID to leverage
// OpenCode's session affinity and prompt caching. Only rotated on quota/route
// failure. Direct route gets its own stable session.
// ═══════════════════════════════════════════════════════════════════════════
function sessionKey(keyId, routeKey) {
  return `${keyId || 'anonymous'}\u0000${routeKey}`;
}

const persistentSessions = {
  sessions: new Map(), // keyId + routeKey -> { sessionId, projectId, createdAt }

  getOrCreate(keyId, routeKey) {
    const id = sessionKey(keyId, routeKey);
    if (this.sessions.has(id)) {
      return this.sessions.get(id);
    }
    const session = {
      sessionId: identity.generateCanonicalSessionId(),
      projectId: identity.generateProjectId(),
      createdAt: Date.now()
    };
    this.sessions.set(id, session);
    return session;
  },

  invalidate(keyId, routeKey) {
    this.sessions.delete(sessionKey(keyId, routeKey));
  },

  invalidateRoute(routeKey) {
    const suffix = `\u0000${routeKey}`;
    for (const key of [...this.sessions.keys()]) {
      if (key.endsWith(suffix)) this.sessions.delete(key);
    }
  },

  // Rotate one client's session for a route (e.g., after a quota response).
  rotate(keyId, routeKey) {
    const id = sessionKey(keyId, routeKey);
    this.sessions.set(id, {
      sessionId: identity.generateCanonicalSessionId(),
      projectId: identity.generateProjectId(),
      createdAt: Date.now()
    });
    return this.sessions.get(id);
  }
};

egress.onRouteReset((routeId) => persistentSessions.invalidateRoute(routeId));

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

  let currentModel = requestedModel;
  let upstreamModel = discovery.resolveUpstreamModel(currentModel);

  // If the requested model is in free quota cooldown, attempt smart fallback to another model
  let freeQuotaBlock = isRequestedFree ? upstreamQuota.isBlocked(currentModel) : null;
  if (freeQuotaBlock && config.get('smart_fallback') !== false) {
    const fallback = discovery.getNextFallbackModel(currentModel, new Set([currentModel]));
    if (fallback && !upstreamQuota.isBlocked(fallback)) {
      console.warn(`[Proxy] Model "${currentModel}" is in free quota cooldown until ${freeQuotaBlock.resetAt}. Smart fallback to "${fallback}"...`);
      currentModel = fallback;
      upstreamModel = discovery.resolveUpstreamModel(currentModel);
      freeQuotaBlock = null;
    }
  }

  if (freeQuotaBlock) {
    metrics.recordRequest({
      model: requestedModel,
      status: 429,
      tokens: {},
      latencyMs: Date.now() - startTime,
      stream: isClientStream,
      keyId: keyObj.id
    });
    sendJsonError(res, 429, 'free_tier_rate_limit', freeQuotaBlock.message,
      freeQuotaHeaders(freeQuotaBlock), freeQuotaFields(freeQuotaBlock));
    return;
  }

  const officialUpstream = bunBridge.isOfficialUpstream(upstreamTarget());
  const baseSanitized = sanitizeClientPayload(clientPayload);
  // The official gate requires a system message containing the CLI's <env>
  // block. Preserve the caller's prompt and append the context when missing.
  if (isRequestedFree && officialUpstream) {
    baseSanitized.messages = upstreamContext.ensureUpstreamEnv(baseSanitized.messages);
  }
  const toolResult = tools.mergeTools(clientPayload.tools, clientPayload.tool_choice);
  const mergedTools = toolResult.tools;
  const mergedToolChoice = toolResult.toolChoice;
  const clientToolNames = toolResult.clientToolNames;

  const maxRetries = Math.min(3, configInt('max_retries', 0));
  const requestTimeout = configInt('request_timeout_ms', 30000, 5000);
  const deadline = startTime + Math.max(requestTimeout, configInt('request_deadline_ms', 90000, requestTimeout));
  const queueWaitMs = configInt('queue_wait_ms', 15000, 0);

  let activeRoute = egress.selectRoute();
  if (!activeRoute && (config.get('allow_direct_fallback') !== false || config.get('egress_mode') === 'auto')) {
    activeRoute = { type: 'direct', id: 'direct' };
  }
  if (!activeRoute) {
    const quotaMs = egress.getEarliestQuotaRetryAfter();
    if (quotaMs > 0) {
      const retryAfterSec = Math.max(1, Math.ceil(quotaMs / 1000));
      metrics.recordRequest({
        model: requestedModel,
        status: 429,
        tokens: {},
        latencyMs: Date.now() - startTime,
        stream: isClientStream,
        keyId: keyObj.id
      });
      sendJsonError(res, 429, 'free_tier_rate_limit',
        'OpenCode Free Tier capacity limit reached. Retry after the indicated delay, or configure an upstream Zen key. If the upstream reported FreeUsageLimitError, the limit is global and more proxies will not help.',
        { 'Retry-After': String(retryAfterSec) });
      return;
    }
    metrics.recordRequest({
      model: requestedModel,
      status: 503,
      tokens: {},
      latencyMs: Date.now() - startTime,
      stream: isClientStream,
      keyId: keyObj.id
    });
    sendJsonError(res, 503, 'no_egress_route',
      'No egress route is available. Configure PROXIES and wait for a healthy proxy, or set ALLOW_DIRECT_FALLBACK=true for local development.',
      { 'Retry-After': '5' });
    return;
  }

  const bridgeWaitMs = configInt('bun_bridge_ready_wait_ms', 12000, 0);
  const bridgeResolved = await resolveBridgeConnection(officialUpstream, isRequestedFree, bridgeWaitMs);
  const bridgeConnection = bridgeResolved.bridge;
  if (bridgeResolved.required) {
    metrics.recordRequest({
      model: requestedModel,
      status: 503,
      tokens: {},
      latencyMs: Date.now() - startTime,
      stream: isClientStream,
      keyId: keyObj.id
    });
    sendJsonError(res, 503, 'bun_bridge_unavailable',
      bunBridge.getUnavailableMessage(), { 'Retry-After': '5' });
    return;
  }

  const attemptedRoutes = new Set([activeRoute.id]);
  const triedModels = new Set([requestedModel, currentModel]);
  const quotaFailoverLimit = Math.min(20, configInt('proxy_quota_failovers', 10));
  let quotaFailovers = 0;
  let networkFailures = 0;
  const maxAttempts = maxRetries + 1 + quotaFailoverLimit;

  let lastStatus = 0;
  let lastBody = '';
  let currentUpstreamReq = null;
  let deadlineExceeded = false;

  const deadlineTimer = setTimeout(() => {
    deadlineExceeded = true;
    if (currentUpstreamReq) {
      try { currentUpstreamReq.destroy(new Error('Request deadline exceeded')); } catch (e) {}
    }
  }, Math.max(1, deadline - Date.now()));
  if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();

  res.once('finish', () => clearTimeout(deadlineTimer));
  // Abort the in-flight upstream request if the client goes away. Listening on
  // the response (not the request) avoids destroying the upstream request when
  // the request body has merely finished being read.
  res.once('close', () => {
    clearTimeout(deadlineTimer);
    if (!res.writableEnded && currentUpstreamReq) {
      try { currentUpstreamReq.destroy(); } catch (e) {}
    }
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!activeRoute) break;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      lastStatus = 504;
      lastBody = 'Upstream request deadline exceeded before the next attempt.';
      break;
    }

    const upstreamModel = discovery.resolveUpstreamModel(currentModel);
    const routeKey = activeRoute.id;

    const session = persistentSessions.getOrCreate(keyObj?.id || 'anonymous', routeKey);
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
        let requestOptions;
        if (bridgeConnection) {
          requestOptions = bridgeRequestOptions(bridgeConnection, target, upstreamHeaders, activeRoute);
        } else {
          requestOptions = {
            hostname: target.hostname,
            port: target.port,
            path: target.path,
            method: 'POST',
            headers: upstreamHeaders,
            agent: egress.getAgent(activeRoute, target.protocol)
          };
        }
        requestOptions.timeout = attemptTimeout;
        const requestTransport = bridgeConnection ? http : target.transport;
        const upstreamReq = requestTransport.request(requestOptions, (upstreamRes) => {
          const contentType = String(upstreamRes.headers['content-type'] || '').toLowerCase();
          const isValidContentType = contentType.includes('event-stream') || contentType.includes('application/json');
          const bridgeError = bridgeConnection
            ? String(upstreamRes.headers['x-opencode2api-bridge-error'] || '').toLowerCase()
            : '';
          if (bridgeConnection) bunBridge.markHealthy();

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
                proxyFailure: bridgeError === 'proxy' || (!isValidContentType && activeRoute.type === 'proxy'),
                viaBridge: !!bridgeConnection,
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
            resolvedModel: currentModel,
            viaBridge: !!bridgeConnection
          });
        });

        upstreamReq.on('timeout', () => {
          isTimedOut = true;
          upstreamReq.destroy(new Error('Upstream timeout'));
        });

        upstreamReq.on('error', (err) => {
          resolve({
            success: false,
            statusCode: (isTimedOut || deadlineExceeded) ? 504 : 502,
            proxyFailure: !bridgeConnection && isProxyTransportError(err, activeRoute),
            bridgeFailure: !!bridgeConnection && !isTimedOut && !deadlineExceeded,
            viaBridge: !!bridgeConnection,
            body: deadlineExceeded ? 'Request deadline exceeded' : err.message
          });
        });

        currentUpstreamReq = upstreamReq;
        upstreamReq.write(payloadString);
        upstreamReq.end();
      });
    } catch (err) {
      attemptResult = {
        success: false,
        statusCode: 502,
        headers: {},
        proxyFailure: !bridgeConnection && isProxyTransportError(err, activeRoute),
        bridgeFailure: !!bridgeConnection,
        viaBridge: !!bridgeConnection,
        body: err.message
      };
    }

    if (attemptResult.success) {
      const { upstreamRes, upstreamReq, resolvedModel } = attemptResult;

      // Hold the admission slot for the full response. Streaming inference is
      // the concurrency being bounded, not just header latency.
      upstreamRes.once('close', releaseSlot);
      egress.recordSuccess(activeRoute);
      if (isRequestedFree) upstreamQuota.clear();

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
        let streamedContentChars = 0;
        let streamedReasoningChars = 0;
        let buffer = '';
        const decoder = new StringDecoder('utf8');
        const estimatedPromptTokens = Math.ceil(Buffer.byteLength(payloadString) / 4);
        // index -> 'client' | 'injected'; argument-only chunks carry no name.
        const toolCallKinds = new Map();
        let streamFailed = false;
        const writeSse = (chunk) => writeStream(res, upstreamRes, chunk);

        const failStream = (err) => {
          if (streamFailed) return;
          streamFailed = true;
          releaseSlot();
          // The client already has a partial response, so this request cannot
          // be replayed. Quarantine the proxy briefly so the next request does
          // not reuse a tunnel that died mid-stream.
          if (!deadlineExceeded && !res.destroyed && activeRoute.type === 'proxy') {
            egress.recordFailure(activeRoute, 'proxy_down');
          }
          const status = deadlineExceeded ? 504 : 502;
          const type = deadlineExceeded ? 'upstream_timeout' : 'upstream_stream_error';
          const message = deadlineExceeded
            ? 'Upstream request deadline exceeded.'
            : 'Upstream stream interrupted before completion.';
          console.warn(`[Proxy] Upstream stream interrupted for ${requestedModel} (${routeLabel(activeRoute)}): ${err?.message || 'unknown error'}`);
          if (!res.writableEnded && !res.destroyed) {
            try {
              res.write(`data: ${JSON.stringify({ error: { message, type, code: status } })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            } catch (e) {
              try { res.end(); } catch (e2) {}
            }
          }

          const pTokens = promptTokens || estimatedPromptTokens;
          const cTokens = completionTokens || Math.ceil((streamedContentChars + streamedReasoningChars) / 4);
          const total = totalTokens || (pTokens + cTokens);
          keys.recordUsage(keyObj.id, total);
          metrics.recordRequest({
            model: requestedModel,
            status,
            tokens: {
              prompt_tokens: pTokens,
              completion_tokens: cTokens,
              total_tokens: total,
              reasoning_tokens: reasoningTokens
            },
            latencyMs: Date.now() - startTime,
            stream: true,
            keyId: keyObj.id
          });
        };
        upstreamRes.on('error', failStream);
        upstreamRes.on('aborted', () => failStream(new Error('upstream aborted')));

        upstreamRes.on('data', (chunk) => {
          if (res.destroyed || res.writableEnded) {
            try { upstreamRes.destroy(); } catch (e) {}
            return;
          }
          let chunkStr = decoder.write(chunk);
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
              if (line) writeSse(line + '\n');
              continue;
            }
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') {
              writeSse('data: [DONE]\n\n');
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
              if (Array.isArray(p.choices)) {
                for (const choice of p.choices) {
                  const delta = choice?.delta;
                  if (!delta) continue;
                  if (typeof delta.content === 'string') streamedContentChars += delta.content.length;
                  if (typeof delta.reasoning_content === 'string') streamedReasoningChars += delta.reasoning_content.length;
                }
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

              writeSse(`data: ${JSON.stringify(p)}\n\n`);
              if (res.flush) res.flush();
            } catch (e) {
              writeSse(line + '\n');
              if (res.flush) res.flush();
            }
          }
        });

        upstreamRes.on('end', () => {
          if (streamFailed) return;
          releaseSlot();
          if (!res.writableEnded && !res.destroyed) res.end();
          const latency = Date.now() - startTime;
          const pTokens = promptTokens || estimatedPromptTokens;
          const cTokens = completionTokens || Math.ceil((streamedContentChars + streamedReasoningChars) / 4);
          const total = totalTokens || (pTokens + cTokens);
          keys.recordUsage(keyObj.id, total);
          metrics.recordRequest({
            model: requestedModel,
            status: 200,
            tokens: { prompt_tokens: pTokens, completion_tokens: cTokens, total_tokens: total, reasoning_tokens: reasoningTokens },
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
        let upstreamFinishReason = null;
        const decoder = new StringDecoder('utf8');
        const estimatedPromptTokens = Math.ceil(Buffer.byteLength(payloadString) / 4);

        function failAggregate(err) {
          if (finished) return;
          finished = true;
          releaseSlot();
          const status = deadlineExceeded ? 504 : 502;
          const type = deadlineExceeded ? 'upstream_timeout' : 'upstream_stream_error';
          const message = deadlineExceeded
            ? 'Upstream request deadline exceeded.'
            : 'Upstream stream interrupted before completion.';
          console.warn(`[Proxy] Upstream stream interrupted for ${requestedModel} (${routeLabel(activeRoute)}): ${err?.message || 'unknown error'}`);

          const pTokens = finalUsage?.prompt_tokens || estimatedPromptTokens;
          const cTokens = finalUsage?.completion_tokens || Math.ceil((accumulatedContent.length + accumulatedReasoning.length) / 4);
          const total = finalUsage?.total_tokens || (pTokens + cTokens);
          keys.recordUsage(keyObj.id, total);
          metrics.recordRequest({
            model: requestedModel,
            status,
            tokens: { prompt_tokens: pTokens, completion_tokens: cTokens, total_tokens: total },
            latencyMs: Date.now() - startTime,
            stream: false,
            keyId: keyObj.id
          });
          if (res.headersSent || res.destroyed || res.writableEnded) {
            try { res.end(); } catch (e) {}
            return;
          }
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message, type, code: status } }));
        }
        upstreamRes.on('error', failAggregate);
        upstreamRes.on('aborted', () => failAggregate(new Error('upstream aborted')));

        function finishResponse() {
          if (finished) return;
          finished = true;
          releaseSlot();

          const pTokens = finalUsage?.prompt_tokens || estimatedPromptTokens;
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
                finish_reason: realToolCalls.length > 0 ? "tool_calls" : (upstreamFinishReason || "stop")
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

          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responseJson, null, 2));
          }
        }

        upstreamRes.on('data', (chunk) => {
          if (res.destroyed || res.writableEnded) {
            try { upstreamRes.destroy(); } catch (e) {}
            return;
          }
          buffer += decoder.write(chunk);
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
              if (parsed.choices?.[0]?.finish_reason) upstreamFinishReason = parsed.choices[0].finish_reason;

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

    if (attemptResult.bridgeFailure) {
      bunBridge.reportTransportFailure();
      metrics.recordRequest({
        model: requestedModel,
        status: 503,
        tokens: {},
        latencyMs: Date.now() - startTime,
        stream: isClientStream,
        keyId: keyObj.id
      });
      sendJsonError(res, 503, 'bun_bridge_unavailable',
        bunBridge.getUnavailableMessage(), { 'Retry-After': '5' });
      return;
    }

    if (failureKind === 'quota') {
      egress.recordFailure(activeRoute, 'quota', retryAfterMs || 60000);
      persistentSessions.rotate(keyObj?.id || 'anonymous', routeKey);
      // A 429 from a direct Node request to the official host is a TLS-gate
      // rejection, not a genuine quota signal. Only record quota when the
      // request actually traversed the Bun bridge (or a custom upstream).
      const officialDirect = isDirectOfficialAttempt(officialUpstream, attemptResult);
      if (officialDirect) {
        console.warn(`[Proxy] Ignoring direct Node 429 for official upstream (${routeLabel(activeRoute)}); Bun bridge did not carry this request.`);
      }
      const globalFreeQuota = isRequestedFree && !officialDirect
        ? upstreamQuota.recordFailure({ statusCode, body: bodyStr, retryAfterMs, model: currentModel })
        : null;

      // Smart Fallback: if model hit free usage limit or quota 429, auto-failover to next healthy free model
      if (config.get('smart_fallback') !== false && isRequestedFree) {
        const fallback = discovery.getNextFallbackModel(currentModel, triedModels);
        if (fallback) {
          console.warn(`[Proxy] Model ${currentModel} returned quota 429 on ${routeLabel(activeRoute)}. Smart failover to ${fallback}...`);
          currentModel = fallback;
          upstreamModel = discovery.resolveUpstreamModel(currentModel);
          triedModels.add(fallback);
          attemptedRoutes.clear();
          activeRoute = egress.selectRoute() || ((config.get('allow_direct_fallback') !== false || config.get('egress_mode') === 'auto') ? { type: 'direct', id: 'direct' } : null);
          if (activeRoute) attemptedRoutes.add(activeRoute.id);
          continue;
        }
      }

      const nextRoute = egress.getNextRoutableRoute(attemptedRoutes);
      if (nextRoute && quotaFailovers < quotaFailoverLimit && Date.now() < deadline) {
        quotaFailovers++;
        const failedRoute = activeRoute;
        activeRoute = nextRoute;
        attemptedRoutes.add(activeRoute.id);
        console.warn(`[Proxy] Upstream quota on ${routeLabel(failedRoute)} for ${currentModel}; trying ${routeLabel(activeRoute)} (${quotaFailovers}/${quotaFailoverLimit}).`);
        continue;
      }

      // Try direct egress before giving up
      if (activeRoute && activeRoute.type !== 'direct' && (config.get('allow_direct_fallback') !== false || config.get('egress_mode') === 'auto') && !attemptedRoutes.has('direct')) {
        const failedRoute = activeRoute;
        activeRoute = { type: 'direct', id: 'direct' };
        attemptedRoutes.add('direct');
        console.warn(`[Proxy] All proxies returned quota for ${currentModel}; falling back to direct egress.`);
        continue;
      }

      if (globalFreeQuota) {
        console.warn(`[Proxy] Upstream free quota for ${currentModel} is global; reset at ${globalFreeQuota.resetAt}.`);
        metrics.recordRequest({
          model: requestedModel,
          status: 429,
          tokens: {},
          latencyMs: Date.now() - startTime,
          stream: isClientStream,
          keyId: keyObj.id
        });
        sendJsonError(res, 429, 'free_tier_rate_limit', globalFreeQuota.message,
          freeQuotaHeaders(globalFreeQuota), freeQuotaFields(globalFreeQuota));
        return;
      }

      const retryAfterSec = Math.max(1, Math.ceil((retryAfterMs || egress.getEarliestQuotaRetryAfter() || 60000) / 1000));
      console.warn(`[Proxy] Upstream quota on ${routeLabel(activeRoute)} for ${currentModel}; all routable proxies are exhausted (Retry-After ${retryAfterSec}s).`);
      metrics.recordRequest({
        model: requestedModel,
        status: 429,
        tokens: {},
        latencyMs: Date.now() - startTime,
        stream: isClientStream,
        keyId: keyObj.id
      });
      sendJsonError(res, 429, 'free_tier_rate_limit',
        'OpenCode Free Tier capacity limit reached. Retry after the indicated delay, or configure an upstream Zen key. If the upstream reported FreeUsageLimitError, the limit is global and more proxies will not help.',
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
    const degradeKind = attemptResult.proxyFailure ? 'proxy_down' : 'retry';
    egress.recordFailure(activeRoute, degradeKind);
    networkFailures++;
    console.warn(`[Proxy] Upstream ${statusCode || 'network failure'} on ${routeLabel(activeRoute)} for ${currentModel}: ${bodyStr.slice(0, 200)}`);

    if (networkFailures >= maxRetries + 1) break;

    const nextRoute = egress.getNextRoutableRoute(attemptedRoutes);
    if (nextRoute) {
      activeRoute = nextRoute;
      attemptedRoutes.add(activeRoute.id);
      console.log(`[Proxy] Retrying on ${routeLabel(activeRoute)} (attempt ${attempt + 1}/${maxAttempts})...`);
    } else {
      if (!egress.isAvailable(activeRoute)) break;
      const backoffMs = Math.min(250 * Math.pow(2, networkFailures - 1) + Math.random() * 200, 1500);
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
  let openAiMessages = [];
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

  // If the requested model is in free quota cooldown, attempt smart fallback to another model
  let freeQuotaBlock = isRequestedFree ? upstreamQuota.isBlocked(currentModel) : null;
  if (freeQuotaBlock && config.get('smart_fallback') !== false) {
    const fallback = discovery.getNextFallbackModel(currentModel, new Set([currentModel]));
    if (fallback && !upstreamQuota.isBlocked(fallback)) {
      console.warn(`[Proxy] Anthropic model "${currentModel}" is in free quota cooldown until ${freeQuotaBlock.resetAt}. Smart fallback to "${fallback}"...`);
      currentModel = fallback;
      freeQuotaBlock = null;
    }
  }

  if (freeQuotaBlock) {
    metrics.recordRequest({
      model: requestedModel,
      status: 429,
      tokens: {},
      latencyMs: Date.now() - startTime,
      stream: isClientStream,
      keyId: keyObj.id
    });
    sendAnthropicError(res, 429, 'rate_limit_error', freeQuotaBlock.message,
      freeQuotaHeaders(freeQuotaBlock), freeQuotaFields(freeQuotaBlock));
    return;
  }

  const officialUpstream = bunBridge.isOfficialUpstream(upstreamTarget());
  if (isRequestedFree && officialUpstream) {
    openAiMessages = upstreamContext.ensureUpstreamEnv(openAiMessages);
  }

  const maxRetries = Math.min(3, configInt('max_retries', 0));
  const requestTimeout = configInt('request_timeout_ms', 30000, 5000);
  const deadline = startTime + Math.max(requestTimeout, configInt('request_deadline_ms', 90000, requestTimeout));
  const queueWaitMs = configInt('queue_wait_ms', 15000, 0);

  let activeRoute = egress.selectRoute();
  if (!activeRoute && (config.get('allow_direct_fallback') !== false || config.get('egress_mode') === 'auto')) {
    activeRoute = { type: 'direct', id: 'direct' };
  }
  if (!activeRoute) {
    const quotaMs = egress.getEarliestQuotaRetryAfter();
    if (quotaMs > 0) {
      const retryAfterSec = Math.max(1, Math.ceil(quotaMs / 1000));
      metrics.recordRequest({
        model: requestedModel,
        status: 429,
        tokens: {},
        latencyMs: Date.now() - startTime,
        stream: isClientStream,
        keyId: keyObj.id
      });
      sendAnthropicError(res, 429, 'rate_limit_error',
        'OpenCode Free Tier capacity limit reached. Retry after the indicated delay, or configure an upstream Zen key. If the upstream reported FreeUsageLimitError, the limit is global and more proxies will not help.',
        { 'Retry-After': String(retryAfterSec) });
      return;
    }
    metrics.recordRequest({
      model: requestedModel,
      status: 503,
      tokens: {},
      latencyMs: Date.now() - startTime,
      stream: isClientStream,
      keyId: keyObj.id
    });
    sendAnthropicError(res, 503, 'no_egress_route',
      'No egress route is available. Configure PROXIES and wait for a healthy proxy, or set ALLOW_DIRECT_FALLBACK=true for local development.',
      { 'Retry-After': '5' });
    return;
  }

  const bridgeWaitMs = configInt('bun_bridge_ready_wait_ms', 12000, 0);
  const bridgeResolved = await resolveBridgeConnection(officialUpstream, isRequestedFree, bridgeWaitMs);
  const bridgeConnection = bridgeResolved.bridge;
  if (bridgeResolved.required) {
    metrics.recordRequest({
      model: requestedModel,
      status: 503,
      tokens: {},
      latencyMs: Date.now() - startTime,
      stream: isClientStream,
      keyId: keyObj.id
    });
    sendAnthropicError(res, 503, 'bun_bridge_unavailable',
      bunBridge.getUnavailableMessage(), { 'Retry-After': '5' });
    return;
  }

  const attemptedRoutes = new Set([activeRoute.id]);
  const triedModels = new Set([requestedModel, currentModel]);
  const quotaFailoverLimit = Math.min(20, configInt('proxy_quota_failovers', 10));
  let quotaFailovers = 0;
  let networkFailures = 0;
  const maxAttempts = maxRetries + 1 + quotaFailoverLimit;

  let lastStatus = 0;
  let lastBody = '';
  let currentUpstreamReq = null;
  let deadlineExceeded = false;

  const deadlineTimer = setTimeout(() => {
    deadlineExceeded = true;
    if (currentUpstreamReq) {
      try { currentUpstreamReq.destroy(new Error('Request deadline exceeded')); } catch (e) {}
    }
  }, Math.max(1, deadline - Date.now()));
  if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();

  res.once('finish', () => clearTimeout(deadlineTimer));
  // Abort the in-flight upstream request if the client goes away. Listening on
  // the response (not the request) avoids destroying the upstream request when
  // the request body has merely finished being read.
  res.once('close', () => {
    clearTimeout(deadlineTimer);
    if (!res.writableEnded && currentUpstreamReq) {
      try { currentUpstreamReq.destroy(); } catch (e) {}
    }
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!activeRoute) break;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      lastStatus = 504;
      lastBody = 'Upstream request deadline exceeded before the next attempt.';
      break;
    }

    const upstreamModel = discovery.resolveUpstreamModel(currentModel);
    const routeKey = activeRoute.id;

    const session = persistentSessions.getOrCreate(keyObj?.id || 'anonymous', routeKey);
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
        let requestOptions;
        if (bridgeConnection) {
          requestOptions = bridgeRequestOptions(bridgeConnection, target, upstreamHeaders, activeRoute);
        } else {
          requestOptions = {
            hostname: target.hostname,
            port: target.port,
            path: target.path,
            method: 'POST',
            headers: upstreamHeaders,
            agent: egress.getAgent(activeRoute, target.protocol)
          };
        }
        requestOptions.timeout = attemptTimeout;
        const requestTransport = bridgeConnection ? http : target.transport;
        const upstreamReq = requestTransport.request(requestOptions, (upstreamRes) => {
          const contentType = String(upstreamRes.headers['content-type'] || '').toLowerCase();
          const isValidContentType = contentType.includes('event-stream') || contentType.includes('application/json');
          const bridgeError = bridgeConnection
            ? String(upstreamRes.headers['x-opencode2api-bridge-error'] || '').toLowerCase()
            : '';
          if (bridgeConnection) bunBridge.markHealthy();

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
                proxyFailure: bridgeError === 'proxy' || (!isValidContentType && activeRoute.type === 'proxy'),
                viaBridge: !!bridgeConnection,
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
            resolvedModel: currentModel,
            viaBridge: !!bridgeConnection
          });
        });

        upstreamReq.on('timeout', () => {
          isTimedOut = true;
          upstreamReq.destroy(new Error('Upstream timeout'));
        });

        upstreamReq.on('error', (err) => {
          resolve({
            success: false,
            statusCode: (isTimedOut || deadlineExceeded) ? 504 : 502,
            proxyFailure: !bridgeConnection && isProxyTransportError(err, activeRoute),
            bridgeFailure: !!bridgeConnection && !isTimedOut && !deadlineExceeded,
            viaBridge: !!bridgeConnection,
            body: deadlineExceeded ? 'Request deadline exceeded' : err.message
          });
        });

        upstreamReq.write(payloadString);
        upstreamReq.end();
      });
    } catch (err) {
      attemptResult = {
        success: false,
        statusCode: 502,
        headers: {},
        proxyFailure: !bridgeConnection && isProxyTransportError(err, activeRoute),
        bridgeFailure: !!bridgeConnection,
        viaBridge: !!bridgeConnection,
        body: err.message
      };
    }

    // The success path keeps the slot until the response closes. Failure paths
    // must release it before retrying or returning.
    if (!attemptResult.success) releaseSlot();

    if (attemptResult.success) {
      const { upstreamRes, upstreamReq, resolvedModel } = attemptResult;
      const messageId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);

      // Hold the admission slot until the stream finishes or aborts.
      upstreamRes.once('close', releaseSlot);
      egress.recordSuccess(activeRoute);
      if (isRequestedFree) upstreamQuota.clear();

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
        const estimatedPromptTokens = Math.ceil(Buffer.byteLength(payloadString) / 4);
        const writeSse = (chunk) => writeStream(res, upstreamRes, chunk);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        if (res.flushHeaders) res.flushHeaders();
        if (res.socket?.setNoDelay) res.socket.setNoDelay(true);

        // Send initial message_start
        writeSse(`event: message_start\ndata: ${JSON.stringify({
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
        let streamedContentChars = 0;
        let streamedReasoningChars = 0;
        const decoder = new StringDecoder('utf8');
        let activeBlockIndex = -1;
        let activeBlockType = null;
        let activeToolIndex = null;
        let hasToolCalls = false;
        let upstreamFinishReason = null;
        // index -> 'client' | 'injected'; argument-only chunks carry no name.
        const toolCallKinds = new Map();
        let streamFailed = false;

        const failStream = (err) => {
          if (streamFailed) return;
          streamFailed = true;
          releaseSlot();
          // The client already has a partial response, so this request cannot
          // be replayed. Quarantine the proxy briefly so the next request does
          // not reuse a tunnel that died mid-stream.
          if (!deadlineExceeded && !res.destroyed && activeRoute.type === 'proxy') {
            egress.recordFailure(activeRoute, 'proxy_down');
          }
          const status = deadlineExceeded ? 504 : 502;
          const message = deadlineExceeded
            ? 'Upstream request deadline exceeded.'
            : 'Upstream stream interrupted before completion.';
          console.warn(`[Proxy] Upstream Anthropic stream interrupted for ${requestedModel} (${routeLabel(activeRoute)}): ${err?.message || 'unknown error'}`);
          if (!res.writableEnded && !res.destroyed) {
            try {
              writeSse(`event: error\ndata: ${JSON.stringify({
                type: 'error',
                error: {
                  type: 'api_error',
                  message
                }
              })}\n\n`);
              res.end();
            } catch (e) {
              try { res.end(); } catch (e2) {}
            }
          }

          const pTokens = promptTokens || estimatedPromptTokens;
          const cTokens = completionTokens || Math.ceil((streamedContentChars + streamedReasoningChars) / 4);
          const total = pTokens + cTokens;
          keys.recordUsage(keyObj.id, total);
          metrics.recordRequest({
            model: requestedModel,
            status,
            tokens: {
              prompt_tokens: pTokens,
              completion_tokens: cTokens,
              total_tokens: total,
              reasoning_tokens: reasoningTokens
            },
            latencyMs: Date.now() - startTime,
            stream: true,
            keyId: keyObj.id
          });
        };
        upstreamRes.on('error', failStream);
        upstreamRes.on('aborted', () => failStream(new Error('upstream aborted')));

        function closeCurrentBlock() {
          if (activeBlockIndex >= 0 && activeBlockType !== null) {
            writeSse(`event: content_block_stop\ndata: ${JSON.stringify({
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
            writeSse(`event: content_block_start\ndata: ${JSON.stringify({
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
            writeSse(`event: content_block_start\ndata: ${JSON.stringify({
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
            writeSse(`event: content_block_start\ndata: ${JSON.stringify({
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
          if (res.destroyed || res.writableEnded) {
            try { upstreamRes.destroy(); } catch (e) {}
            return;
          }
          buffer += decoder.write(chunk);
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
              if (parsed.choices?.[0]?.finish_reason) upstreamFinishReason = parsed.choices[0].finish_reason;
              const delta = parsed.choices?.[0]?.delta;
              if (delta) {
                if (typeof delta.reasoning_content === 'string') streamedReasoningChars += delta.reasoning_content.length;
                if (typeof delta.content === 'string') streamedContentChars += delta.content.length;
                if (delta.reasoning_content) {
                  ensureThinkingBlock();
                  writeSse(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: activeBlockIndex,
                    delta: { type: 'thinking_delta', thinking: delta.reasoning_content }
                  })}\n\n`);
                  if (res.flush) res.flush();
                }

                if (delta.content) {
                  ensureTextBlock();
                  writeSse(`event: content_block_delta\ndata: ${JSON.stringify({
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
                      writeSse(`event: content_block_delta\ndata: ${JSON.stringify({
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
            writeSse(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' }
            })}\n\n`);
            writeSse(`event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: 0
            })}\n\n`);
          }

          writeSse(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: anthropicStopReason(upstreamFinishReason, hasToolCalls), stop_sequence: null },
            usage: { output_tokens: completionTokens }
          })}\n\n`);
          writeSse(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          res.end();

          const latency = Date.now() - startTime;
          const pTokens = promptTokens || estimatedPromptTokens;
          const cTokens = completionTokens || Math.ceil((streamedContentChars + streamedReasoningChars) / 4);
          const total = pTokens + cTokens;
          keys.recordUsage(keyObj.id, total);
          metrics.recordRequest({
            model: requestedModel,
            status: 200,
            tokens: { prompt_tokens: pTokens, completion_tokens: cTokens, total_tokens: total, reasoning_tokens: reasoningTokens },
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
        let upstreamFinishReason = null;
        const decoder = new StringDecoder('utf8');
        const estimatedPromptTokens = Math.ceil(Buffer.byteLength(payloadString) / 4);

        function failAggregate(err) {
          if (finished) return;
          finished = true;
          releaseSlot();
          const status = deadlineExceeded ? 504 : 502;
          const message = deadlineExceeded
            ? 'Upstream request deadline exceeded.'
            : 'Upstream stream interrupted before completion.';
          console.warn(`[Proxy] Upstream Anthropic stream interrupted for ${requestedModel} (${routeLabel(activeRoute)}): ${err?.message || 'unknown error'}`);

          const pTokens = finalUsage?.prompt_tokens || estimatedPromptTokens;
          const cTokens = finalUsage?.completion_tokens || Math.ceil((accumulatedContent.length + accumulatedReasoning.length) / 4);
          const total = finalUsage?.total_tokens || (pTokens + cTokens);
          keys.recordUsage(keyObj.id, total);
          metrics.recordRequest({
            model: requestedModel,
            status,
            tokens: { prompt_tokens: pTokens, completion_tokens: cTokens, total_tokens: total },
            latencyMs: Date.now() - startTime,
            stream: false,
            keyId: keyObj.id
          });
          if (res.headersSent || res.destroyed || res.writableEnded) {
            try { res.end(); } catch (e) {}
            return;
          }
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
        }
        upstreamRes.on('error', failAggregate);
        upstreamRes.on('aborted', () => failAggregate(new Error('upstream aborted')));

        function finishAnthropic() {
          if (finished) return;
          finished = true;
          releaseSlot();

          const pTokens = finalUsage?.prompt_tokens || estimatedPromptTokens;
          const cTokens = finalUsage?.completion_tokens || Math.ceil((accumulatedContent.length + accumulatedReasoning.length) / 4);
          const rTokens = finalUsage?.completion_tokens_details?.reasoning_tokens || 0;
          const total = finalUsage?.total_tokens || (pTokens + cTokens);

          const content = [];
          if (accumulatedReasoning) {
            content.push({
              type: 'thinking',
              thinking: accumulatedReasoning
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
            stop_reason: anthropicStopReason(upstreamFinishReason, realToolCalls.length > 0),
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
          if (res.destroyed || res.writableEnded) {
            try { upstreamRes.destroy(); } catch (e) {}
            return;
          }
          buffer += decoder.write(chunk);
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
              if (parsed.choices?.[0]?.finish_reason) upstreamFinishReason = parsed.choices[0].finish_reason;
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

    if (attemptResult.bridgeFailure) {
      bunBridge.reportTransportFailure();
      metrics.recordRequest({
        model: requestedModel,
        status: 503,
        tokens: {},
        latencyMs: Date.now() - startTime,
        stream: isClientStream,
        keyId: keyObj.id
      });
      sendAnthropicError(res, 503, 'bun_bridge_unavailable',
        bunBridge.getUnavailableMessage(), { 'Retry-After': '5' });
      return;
    }

    if (failureKind === 'quota') {
      egress.recordFailure(activeRoute, 'quota', retryAfterMs || 60000);
      persistentSessions.rotate(keyObj?.id || 'anonymous', routeKey);
      const officialDirect = isDirectOfficialAttempt(officialUpstream, attemptResult);
      if (officialDirect) {
        console.warn(`[Proxy] Ignoring direct Node 429 for official Anthropic upstream (${routeLabel(activeRoute)}); Bun bridge did not carry this request.`);
      }
      const globalFreeQuota = isRequestedFree && !officialDirect
        ? upstreamQuota.recordFailure({ statusCode, body: bodyStr, retryAfterMs, model: currentModel })
        : null;

      // Smart Fallback to another free model on Anthropic 429 quota
      if (config.get('smart_fallback') !== false && isRequestedFree) {
        const fallback = discovery.getNextFallbackModel(currentModel, triedModels);
        if (fallback) {
          console.warn(`[Proxy] Anthropic model ${currentModel} returned quota 429 on ${routeLabel(activeRoute)}. Smart failover to ${fallback}...`);
          currentModel = fallback;
          triedModels.add(fallback);
          attemptedRoutes.clear();
          activeRoute = egress.selectRoute() || ((config.get('allow_direct_fallback') !== false || config.get('egress_mode') === 'auto') ? { type: 'direct', id: 'direct' } : null);
          if (activeRoute) attemptedRoutes.add(activeRoute.id);
          continue;
        }
      }

      const nextRoute = egress.getNextRoutableRoute(attemptedRoutes);
      if (nextRoute && quotaFailovers < quotaFailoverLimit && Date.now() < deadline) {
        quotaFailovers++;
        const failedRoute = activeRoute;
        activeRoute = nextRoute;
        attemptedRoutes.add(activeRoute.id);
        console.warn(`[Proxy] Upstream quota on ${routeLabel(failedRoute)} for Anthropic model ${currentModel}; trying ${routeLabel(activeRoute)} (${quotaFailovers}/${quotaFailoverLimit}).`);
        continue;
      }

      // Try direct egress before giving up
      if (activeRoute && activeRoute.type !== 'direct' && (config.get('allow_direct_fallback') !== false || config.get('egress_mode') === 'auto') && !attemptedRoutes.has('direct')) {
        const failedRoute = activeRoute;
        activeRoute = { type: 'direct', id: 'direct' };
        attemptedRoutes.add('direct');
        console.warn(`[Proxy] All proxies returned quota for Anthropic model ${currentModel}; falling back to direct egress.`);
        continue;
      }

      if (globalFreeQuota) {
        console.warn(`[Proxy] Upstream free quota for Anthropic model ${currentModel} is global; reset at ${globalFreeQuota.resetAt}.`);
        metrics.recordRequest({
          model: requestedModel,
          status: 429,
          tokens: {},
          latencyMs: Date.now() - startTime,
          stream: isClientStream,
          keyId: keyObj.id
        });
        sendAnthropicError(res, 429, 'rate_limit_error', globalFreeQuota.message,
          freeQuotaHeaders(globalFreeQuota), freeQuotaFields(globalFreeQuota));
        return;
      }

      const retryAfterSec = Math.max(1, Math.ceil((retryAfterMs || egress.getEarliestQuotaRetryAfter() || 60000) / 1000));
      console.warn(`[Proxy] Upstream quota on ${routeLabel(activeRoute)} for Anthropic model ${currentModel}; all routable proxies are exhausted (Retry-After ${retryAfterSec}s).`);
      metrics.recordRequest({
        model: requestedModel,
        status: 429,
        tokens: {},
        latencyMs: Date.now() - startTime,
        stream: isClientStream,
        keyId: keyObj.id
      });
      sendAnthropicError(res, 429, 'rate_limit_error',
        'OpenCode Free Tier capacity limit reached. Retry after the indicated delay, or configure an upstream Zen key. If the upstream reported FreeUsageLimitError, the limit is global and more proxies will not help.',
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
    const degradeKind = attemptResult.proxyFailure ? 'proxy_down' : 'retry';
    egress.recordFailure(activeRoute, degradeKind);
    networkFailures++;
    console.warn(`[Proxy] Upstream ${statusCode || 'network failure'} on ${routeLabel(activeRoute)} for Anthropic model ${currentModel}: ${bodyStr.slice(0, 200)}`);

    if (networkFailures >= maxRetries + 1) break;

    const nextRoute = egress.getNextRoutableRoute(attemptedRoutes);
    if (nextRoute) {
      activeRoute = nextRoute;
      attemptedRoutes.add(activeRoute.id);
      console.log(`[Proxy] Retrying Anthropic request on ${routeLabel(activeRoute)} (attempt ${attempt + 1}/${maxAttempts})...`);
    } else {
      if (!egress.isAvailable(activeRoute)) break;
      const backoffMs = Math.min(250 * Math.pow(2, networkFailures - 1) + Math.random() * 200, 1500);
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
  _test: {
    isDirectOfficialAttempt
  }
};
