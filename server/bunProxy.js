/**
 * Bun-hosted reverse proxy for the official OpenCode inference endpoint.
 *
 * Node's TLS fingerprint is rejected by the upstream free-tier gate even when
 * the request headers and body are authentic. The OpenCode CLI binary embeds
 * Bun, so the gateway starts this script with `BUN_BE_BUN=1` and sends
 * inference requests through a loopback-only hop. Bun performs the outbound
 * TLS connection (and, when supplied, the per-route egress proxy) with the
 * accepted fingerprint.
 *
 * This file is executed by Bun, never required by Node.
 */

const UPSTREAM_ORIGIN = String(process.env.BUN_BRIDGE_UPSTREAM || 'https://opencode.ai').replace(/\/+$/, '');
const BRIDGE_TOKEN = process.env.BUN_BRIDGE_TOKEN || '';
const HOST = process.env.BUN_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.BUN_BRIDGE_PORT) || 0;
const PARENT_PID = Number(process.env.BUN_BRIDGE_PARENT_PID) || 0;

// The gateway normally stops the bridge during graceful shutdown. If it is
// force-killed instead, the loopback listener would otherwise survive as an
// orphan. Poll the parent and exit as soon as it disappears.
if (PARENT_PID > 0) {
  const parentWatchdog = setInterval(() => {
    try {
      process.kill(PARENT_PID, 0);
    } catch (err) {
      if (err && err.code === 'ESRCH') {
        console.error('[bun-bridge] Parent gateway is gone; exiting.');
        process.exit(0);
      }
    }
  }, 15000);
  if (typeof parentWatchdog.unref === 'function') parentWatchdog.unref();
}

const TOKEN_HEADER = 'x-opencode2api-bridge-token';
const PROXY_HEADER = 'x-opencode2api-bridge-proxy';
const BRIDGE_HEADER = 'x-opencode2api-bridge';
const ERROR_HEADER = 'x-opencode2api-bridge-error';

const HOP_BY_HOP = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'accept-encoding',
  TOKEN_HEADER,
  PROXY_HEADER
]);

function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function decodeProxy(value) {
  if (!value) return '';
  try {
    const decoded = Buffer.from(String(value), 'base64url').toString('utf8');
    // Bun's native fetch() supports http:// and https:// tunneling; socks5 results in UnsupportedProxyProtocol
    if (!/^https?:\/\//i.test(decoded)) return '';
    return decoded;
  } catch (e) {
    return '';
  }
}

function plainHeaders(headers) {
  const out = new Headers();
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === 'content-encoding') continue;
    out.set(name, value);
  }
  return out;
}

const startedAt = Date.now();

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/__health') {
      return jsonResponse(200, {
        status: 'ok',
        pid: process.pid,
        uptime_seconds: Math.round((Date.now() - startedAt) / 1000)
      });
    }

    if (!url.pathname.startsWith('/inference/')) {
      return jsonResponse(404, { error: { type: 'not_found', message: 'Not found' } });
    }

    if (BRIDGE_TOKEN && req.headers.get(TOKEN_HEADER) !== BRIDGE_TOKEN) {
      return jsonResponse(401, { error: { type: 'unauthorized', message: 'Invalid bridge token' } });
    }

    const proxy = decodeProxy(req.headers.get(PROXY_HEADER));
    const forceRotate = req.headers.get('x-opencode2api-force-rotate') === '1';
    const timeoutHeader = Number(req.headers.get('x-opencode2api-timeout-ms'));
    // Generous default stream deadline (90s); Node enforces connect timeout via attemptTimeout
    const timeoutMs = (Number.isFinite(timeoutHeader) && timeoutHeader > 0) ? timeoutHeader : 90000;

    let signal;
    if (typeof AbortSignal !== 'undefined') {
      const timerSignal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
      if (req.signal && timerSignal && typeof AbortSignal.any === 'function') {
        signal = AbortSignal.any([req.signal, timerSignal]);
      } else {
        signal = req.signal || timerSignal;
      }
    }

    // Isolated FetchSession for proxy & rotating requests guarantees zero TCP connection pooling
    // across route failovers, ensuring rotating proxies always connect fresh and exit via new IPs.
    const useSession = Boolean(proxy || forceRotate) && typeof Bun.FetchSession === 'function';
    const session = useSession ? new Bun.FetchSession() : null;
    const fetchFn = session ? session.fetch.bind(session) : fetch;

    try {
      const headers = plainHeaders(req.headers);
      // Ask for an uncompressed stream so the Node side can parse SSE without
      // depending on Bun's automatic decompression behaviour.
      headers.set('accept-encoding', 'identity');
      if (forceRotate) {
        headers.set('connection', 'close');
      }
      if (!headers.has('authorization')) headers.set('authorization', 'Bearer public');

      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const body = hasBody ? Buffer.from(await req.arrayBuffer()) : undefined;

      const upstream = await fetchFn(`${UPSTREAM_ORIGIN}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
        ...(signal ? { signal } : {}),
        ...(proxy ? { proxy } : {})
      });

      const responseHeaders = plainHeaders(upstream.headers);
      responseHeaders.set(BRIDGE_HEADER, '1');

      if (upstream.status !== 200) {
        if (session) {
          try { session.close(); } catch (e) {}
        }
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders
        });
      }

      let responseBody = upstream.body;
      if (session && responseBody && typeof TransformStream !== 'undefined') {
        const ts = new TransformStream({
          flush() {
            try { session.close(); } catch (e) {}
          },
          cancel() {
            try { session.close(); } catch (e) {}
          }
        });
        responseBody = responseBody.pipeThrough(ts);
      }

      return new Response(responseBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      });
    } catch (err) {
      if (session) {
        try { session.close(); } catch (e) {}
      }
      // A proxy failure should rotate the egress route; a direct transport
      // failure is a bridge problem and must not prune the proxy pool.
      const kind = proxy ? 'proxy' : 'transport';
      const message = err && err.message ? err.message : String(err);
      console.error(`[bun-bridge] ${kind} request failed: ${message}`);
      return jsonResponse(502, {
        error: {
          type: kind === 'proxy' ? 'proxy_transport_error' : 'bridge_transport_error',
          message
        }
      }, { [ERROR_HEADER]: kind });
    }
  }
});

console.log(`BUN_BRIDGE_READY ${server.port}`);
