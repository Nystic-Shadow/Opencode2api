/**
 * Global upstream free-tier quota gate.
 *
 * OpenCode's anonymous free tier ("Authorization: Bearer public") is metered
 * in one shared bucket, not per client IP. The upstream reports
 * `FreeUsageLimitError` with a Retry-After that counts down identically for
 * every proxy route. Rotating egress IPs therefore cannot recover capacity.
 *
 * Once this exact error is observed, remember the reset time and fail
 * subsequent free-tier requests immediately with the real Retry-After instead
 * of burning the whole proxy pool on a limit that no route can escape.
 */

const DEFAULT_FREE_LIMIT_MS = 15 * 60 * 1000;
const MAX_FREE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
const FREE_LIMIT_PATTERN = /FreeUsageLimitError/i;

let state = null;
const modelStates = new Map(); // modelId -> state object

function hasFreeLimitBody(body) {
  if (body === undefined || body === null) return false;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return FREE_LIMIT_PATTERN.test(text);
}

function buildMessage(status) {
  const modelText = status.model ? ` for ${status.model}` : '';
  return `OpenCode's anonymous free tier is exhausted upstream${modelText}. It resets at ${status.resetAtUtc} ` +
    `(${status.retryAfterSeconds}s). This is a global upstream limit, so rotating proxies cannot bypass it; ` +
    'configure an OpenCode Go/Zen key or wait for the reset.';
}

function getModelStatus(mState, now = Date.now()) {
  if (!mState || mState.until <= now) return { blocked: false };
  const status = {
    blocked: true,
    retryAfterSeconds: Math.max(1, Math.ceil((mState.until - now) / 1000)),
    resetAt: mState.resetAt,
    resetAtUtc: mState.resetAtUtc,
    recordedAt: new Date(mState.recordedAt).toISOString(),
    upstreamError: mState.upstreamError,
    model: mState.model,
    retryAfterSource: mState.retryAfterSource
  };
  status.message = buildMessage(status);
  return status;
}

function recordFailure({ statusCode, body, retryAfterMs, model, now = Date.now() } = {}) {
  if (statusCode !== 429 && statusCode !== 403) return null;
  if (!hasFreeLimitBody(body)) return null;

  const parsedRetry = Number(retryAfterMs);
  const hasUpstreamRetry = Number.isFinite(parsedRetry) && parsedRetry > 0;
  const durationMs = Math.min(
    MAX_FREE_LIMIT_MS,
    hasUpstreamRetry ? parsedRetry : DEFAULT_FREE_LIMIT_MS
  );
  // Never let a shorter, defaulted Retry-After shrink a block that a previous
  // response already placed further in the future.
  const previousUntil = state && state.until > now ? state.until : 0;
  const until = Math.max(now + durationMs, previousUntil);

  state = {
    until,
    recordedAt: now,
    resetAt: new Date(until).toISOString(),
    resetAtUtc: new Date(until).toUTCString(),
    upstreamError: 'FreeUsageLimitError',
    model: model || '',
    retryAfterSource: hasUpstreamRetry ? 'upstream' : 'default'
  };

  if (model) {
    const prevModelUntil = modelStates.has(model) && modelStates.get(model).until > now
      ? modelStates.get(model).until
      : 0;
    modelStates.set(model, {
      ...state,
      until: Math.max(now + durationMs, prevModelUntil)
    });
  }

  return getStatus(now);
}

function getStatus(now = Date.now()) {
  if (!state) return { blocked: false };
  if (state.until <= now) {
    state = null;
    return { blocked: false };
  }

  const status = {
    blocked: true,
    retryAfterSeconds: Math.max(1, Math.ceil((state.until - now) / 1000)),
    resetAt: state.resetAt,
    resetAtUtc: state.resetAtUtc,
    recordedAt: new Date(state.recordedAt).toISOString(),
    upstreamError: state.upstreamError,
    model: state.model,
    retryAfterSource: state.retryAfterSource
  };
  status.message = buildMessage(status);
  return status;
}

function isBlocked(modelOrNow = Date.now(), nowParam = null) {
  let model = null;
  let now = Date.now();
  if (typeof modelOrNow === 'string') {
    model = modelOrNow;
    now = typeof nowParam === 'number' ? nowParam : Date.now();
  } else if (typeof modelOrNow === 'number') {
    now = modelOrNow;
  }

  // If a specific model is requested, check its specific state
  if (model && modelStates.has(model)) {
    const mStatus = getModelStatus(modelStates.get(model), now);
    if (mStatus.blocked) return mStatus;
    modelStates.delete(model);
    return null;
  }

  // If a specific model was requested and is not in modelStates, it is not blocked
  if (model) {
    return null;
  }

  // Fallback to global state
  const status = getStatus(now);
  return status.blocked ? status : null;
}

function clear(model = null) {
  if (model && modelStates.has(model)) {
    modelStates.delete(model);
  }
  const hadState = Boolean(state);
  state = null;
  if (!model) modelStates.clear();
  return hadState;
}

module.exports = {
  recordFailure,
  getStatus,
  isBlocked,
  clear,
  _test: {
    reset: clear,
    hasFreeLimitBody,
    DEFAULT_FREE_LIMIT_MS,
    MAX_FREE_LIMIT_MS
  }
};
