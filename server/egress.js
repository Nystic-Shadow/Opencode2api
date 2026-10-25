const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const config = require('./config');
const warp = require('./warp');

const DEFAULT_PORTS = {
  http: 80,
  https: 443,
  socks5: 1080
};

function parseProxyUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;

  let url;
  try {
    url = new URL(value);
  } catch (e) {
    return null;
  }

  let type = url.protocol.replace(':', '').toLowerCase();
  if (type === 'socks5h' || type === 'socks') type = 'socks5';
  if (!['http', 'https', 'socks5'].includes(type)) return null;

  const port = parseInt(url.port, 10) || DEFAULT_PORTS[type];
  if (!url.hostname || !port) return null;

  return {
    type,
    host: url.hostname,
    port,
    username: url.username ? decodeURIComponent(url.username) : '',
    password: url.password ? decodeURIComponent(url.password) : '',
    url: `${type}://${url.hostname}:${port}`,
    id: `${type}://${url.hostname}:${port}`
  };
}

function parseProxyList() {
  const configured = config.get('proxies');
  const values = Array.isArray(configured) ? [...configured] : [];
  if (values.length === 0) {
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) {
      if (process.env[name]) {
        values.push(process.env[name]);
        break;
      }
    }
  }

  const seen = new Set();
  const result = [];
  for (const value of values) {
    const proxy = parseProxyUrl(value);
    if (!proxy || seen.has(proxy.id)) continue;
    seen.add(proxy.id);
    result.push(proxy);
  }
  return result;
}

function parseRetryAfter(value) {
  if (value === undefined || value === null || value === '') return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(String(value));
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 0;
}

function classifyUpstreamFailure(statusCode, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body || '');
  const code = Number(statusCode) || 0;

  if (code === 429) return 'quota';
  if (code === 403 && /(freeusage|freetier|capacity|rate.?limit|quota|too many)/i.test(text)) {
    return 'quota';
  }
  if (code === 0 || code === 408 || code === 425 || code === 500 || code === 502 || code === 503 || code === 504) {
    return 'retry';
  }
  if (code >= 500) return 'retry';
  if (code === 400 || code === 401 || code === 403 || code === 404 || code === 405 || code === 409 || code === 413 || code === 422) {
    return 'fatal';
  }
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timeout|SOCKS5|CONNECT/i.test(text)) {
    return 'retry';
  }
  return 'fatal';
}

function parseSocks5ConnectResponse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] !== 0x05) return { error: 'SOCKS5 invalid version' };
  if (buf[1] !== 0x00) return { error: `SOCKS5 CONNECT rejected: code ${buf[1]}` };
  const atyp = buf[3];
  let addressLength;
  if (atyp === 0x01) addressLength = 4;
  else if (atyp === 0x04) addressLength = 16;
  else if (atyp === 0x03) {
    if (buf.length < 5) return null;
    addressLength = buf[4];
    const total = 5 + addressLength + 2;
    return buf.length >= total ? { consumed: total } : null;
  } else {
    return { error: `SOCKS5 unsupported address type ${atyp}` };
  }
  const total = 4 + addressLength + 2;
  return buf.length >= total ? { consumed: total } : null;
}

class EgressManager {
  constructor() {
    this.directAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 64,
      maxFreeSockets: 16,
      timeout: 60000,
      keepAliveMsecs: 30000
    });
    // Plain-HTTP direct egress exists only for local test upstreams. Proxy and
    // WARP agents tunnel TLS, so callers must reject http targets for them.
    this.directHttpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 64,
      maxFreeSockets: 16,
      timeout: 60000,
      keepAliveMsecs: 30000
    });
    this.proxyAgents = new Map();
    this.health = new Map();
    this.proxies = parseProxyList();
    this.lastReload = Date.now();

    config.onChange(() => {
      this.reload();
    });
  }

  reload() {
    this.proxies = parseProxyList();
    for (const agent of this.proxyAgents.values()) {
      try { agent.destroy(); } catch (e) {}
    }
    this.proxyAgents.clear();
    this.lastReload = Date.now();
  }

  _healthKey(route) {
    if (!route) return 'unknown';
    if (route.type === 'warp') return `warp:${route.port}`;
    if (route.type === 'proxy') return route.id;
    return 'direct';
  }

  _health(route) {
    const key = this._healthKey(route);
    if (!this.health.has(key)) {
      this.health.set(key, {
        failures: 0,
        openUntil: 0,
        retryAfterUntil: 0,
        lastError: '',
        lastSuccess: 0,
        lastFailure: 0
      });
    }
    return this.health.get(key);
  }

  isAvailable(route) {
    if (!route) return false;
    if (route.type === 'warp' && !warp.isReady()) return false;
    const health = this._health(route);
    return health.openUntil <= Date.now();
  }

  /**
   * Remaining provider-quota cooldown for a route.
   *
   * Quota is not an infrastructure failure: the route is still usable once the
   * upstream window resets, so it stays in the candidate list (and readiness
   * stays green). Requests fail fast with 429 + Retry-After instead of being
   * silently rotated onto another IP.
   */
  getQuotaRetryAfter(route) {
    if (!route) return 0;
    const health = this._health(route);
    const remaining = health.retryAfterUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  getWarpRoute() {
    if (config.get('warp_mode') === 'disabled' || config.get('warp_mode') === 'never') return null;
    if (!warp.isReady()) return null;
    const port = warp.getBestPort();
    if (!port) return null;
    return { type: 'warp', port, id: `warp:${port}` };
  }

  _allowDirect() {
    const explicit = config.get('allow_direct_fallback');
    if (explicit === true) return true;
    if (explicit === false) return false;
    // No explicit policy: direct egress is only a fallback when no anonymity
    // transport is configured. Deployments that require anonymity set
    // ALLOW_DIRECT_FALLBACK=false (the compose file does this).
    if (this.proxies.length > 0) return false;
    const mode = String(config.get('warp_mode') || 'auto').toLowerCase();
    if (mode === 'disabled' || mode === 'never') return true;
    if (mode === 'always') return false;
    return true;
  }

  getCandidates() {
    const mode = String(config.get('egress_mode') || 'auto').toLowerCase();
    const direct = { type: 'direct', id: 'direct' };
    const proxyRoutes = this.proxies.map(proxy => ({
      ...proxy,
      type: 'proxy',
      proxyType: proxy.type,
      id: proxy.id
    }));
    const warpRoute = this.getWarpRoute();

    let routes;
    if (mode === 'direct') {
      routes = [direct];
    } else if (mode === 'warp_only') {
      routes = warpRoute ? [warpRoute] : [];
    } else if (mode === 'proxy_only' || mode === 'scraped_only') {
      routes = proxyRoutes;
    } else {
      // auto / hybrid: stable WARP first, then user-owned proxies, then direct
      // only when explicitly allowed.
      routes = [];
      if (warpRoute) routes.push(warpRoute);
      routes.push(...proxyRoutes);
      if (this._allowDirect()) routes.push(direct);
    }

    return routes.filter(route => this.isAvailable(route));
  }

  selectRoute() {
    return this.getCandidates()[0] || null;
  }

  nextRoute(current, candidates = null) {
    const routes = candidates || this.getCandidates();
    if (!current) return routes[0] || null;
    const idx = routes.findIndex(route => route.id === current.id);
    if (idx === -1) return routes[0] || null;
    return routes[idx + 1] || null;
  }

  getAgent(route, protocol = 'https:') {
    if (!route) return protocol === 'http:' ? this.directHttpAgent : this.directAgent;
    if (route.type === 'warp') return warp.getWarpAgent(route.port);
    if (route.type === 'direct') return protocol === 'http:' ? this.directHttpAgent : this.directAgent;
    if (route.type === 'proxy') return this._getProxyAgent(route);
    return protocol === 'http:' ? this.directHttpAgent : this.directAgent;
  }

  _getProxyAgent(route) {
    if (this.proxyAgents.has(route.id)) return this.proxyAgents.get(route.id);

    const manager = this;
    const agent = new https.Agent({
      keepAlive: true,
      maxSockets: 32,
      maxFreeSockets: 8,
      timeout: 30000,
      keepAliveMsecs: 15000
    });

    agent.createConnection = function (options, callback) {
      manager._connectViaProxy(route, options, callback);
    };

    this.proxyAgents.set(route.id, agent);
    return agent;
  }

  _connectViaProxy(route, options, callback) {
    const destHost = options.host || options.hostname || 'opencode.ai';
    const destPort = options.port || 443;
    let called = false;
    const done = (err, socket) => {
      if (called) {
        if (socket) socket.destroy();
        return;
      }
      called = true;
      callback(err, socket);
    };

    if (route.proxyType === 'socks5') {
      this._connectSocks5(route, destHost, destPort, done);
      return;
    }

    const secureProxy = route.proxyType === 'https';
    const requestModule = secureProxy ? https : http;
    const headers = {
      Host: `${destHost}:${destPort}`,
      'User-Agent': 'OpenCode2API/3'
    };
    if (route.username) {
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${route.username}:${route.password}`).toString('base64');
    }

    let req;
    try {
      req = requestModule.request({
        host: route.host,
        port: route.port,
        method: 'CONNECT',
        path: `${destHost}:${destPort}`,
        headers,
        timeout: 10000,
        ...(secureProxy ? { servername: route.host, rejectUnauthorized: true } : {})
      });
    } catch (err) {
      done(err);
      return;
    }

    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        try { socket.destroy(); } catch (e) {}
        done(new Error(`Proxy CONNECT returned HTTP ${res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({
        socket,
        servername: options.servername || destHost,
        rejectUnauthorized: true
      }, () => done(null, tlsSocket));
      tlsSocket.on('error', err => done(err));
    });
    req.on('timeout', () => {
      req.destroy(new Error(`Proxy CONNECT to ${route.host}:${route.port} timed out`));
    });
    req.on('error', err => done(err));
    req.end();
  }

  _connectSocks5(route, destHost, destPort, done) {
    const socket = net.connect({ host: route.host, port: route.port, timeout: 10000 }, () => {
      const methods = route.username ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
    });

    let state = 'method';
    let buffer = Buffer.alloc(0);
    let finished = false;
    const finish = (err, stream) => {
      if (finished) {
        if (stream) stream.destroy();
        return;
      }
      finished = true;
      if (err) {
        try { socket.destroy(); } catch (e) {}
        done(err);
        return;
      }
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('timeout');
      socket.setTimeout(0);
      const tlsSocket = tls.connect({
        socket: stream || socket,
        servername: destHost,
        rejectUnauthorized: true
      }, () => done(null, tlsSocket));
      tlsSocket.on('error', err2 => done(err2));
    };

    const sendConnect = () => {
      const hostBuf = Buffer.from(destHost);
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff])
      ]);
      state = 'connect';
      buffer = Buffer.alloc(0);
      socket.write(req);
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (state === 'method') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05) return finish(new Error('SOCKS5 auth negotiation failed'));
        const method = buffer[1];
        buffer = buffer.slice(2);
        if (method === 0x00) return sendConnect();
        if (method === 0x02 && route.username) {
          const user = Buffer.from(route.username);
          const pass = Buffer.from(route.password || '');
          const auth = Buffer.concat([
            Buffer.from([0x01, user.length]),
            user,
            Buffer.from([pass.length]),
            pass
          ]);
          state = 'auth';
          socket.write(auth);
          return;
        }
        return finish(new Error(`SOCKS5 unsupported auth method ${method}`));
      }

      if (state === 'auth') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x01 || buffer[1] !== 0x00) {
          return finish(new Error('SOCKS5 username/password authentication failed'));
        }
        buffer = buffer.slice(2);
        return sendConnect();
      }

      if (state === 'connect') {
        const parsed = parseSocks5ConnectResponse(buffer);
        if (!parsed) return;
        if (parsed.error) return finish(new Error(parsed.error));
        buffer = buffer.slice(parsed.consumed);
        return finish(null, socket);
      }
    });

    socket.on('timeout', () => finish(new Error(`SOCKS5 proxy ${route.host}:${route.port} connection timed out`)));
    socket.on('error', err => finish(err));
  }

  recordSuccess(route) {
    if (!route) return;
    const health = this._health(route);
    health.failures = 0;
    health.openUntil = 0;
    health.retryAfterUntil = 0;
    health.lastError = '';
    health.lastSuccess = Date.now();
  }

  recordFailure(route, kind = 'network', retryAfterMs = 0) {
    if (!route) return;
    const health = this._health(route);
    const now = Date.now();
    health.lastFailure = now;

    if (kind === 'quota') {
      health.retryAfterUntil = Math.max(health.retryAfterUntil, now + Math.max(1000, retryAfterMs || 0));
      return;
    }

    if (kind === 'retry') {
      health.failures++;
      if (health.failures >= 3) {
        health.openUntil = now + 30000;
        health.failures = 0;
      }
      return;
    }

    health.lastError = String(kind || 'error');
  }

  _recoverExpired() {
    const now = Date.now();
    for (const health of this.health.values()) {
      if (health.openUntil && health.openUntil <= now) health.openUntil = 0;
      if (health.retryAfterUntil && health.retryAfterUntil <= now) health.retryAfterUntil = 0;
    }
  }

  getStatus() {
    this._recoverExpired();
    const routes = this.getCandidates().map(route => ({
      id: route.id,
      type: route.type,
      available: this.isAvailable(route)
    }));
    return {
      mode: config.get('egress_mode') || 'auto',
      proxies: this.proxies.map(proxy => ({ id: proxy.id, type: proxy.type })),
      allowDirect: this._allowDirect(),
      warpReady: warp.isReady(),
      routes,
      health: Object.fromEntries(this.health)
    };
  }
}

const manager = new EgressManager();
manager.parseProxyUrl = parseProxyUrl;
manager.parseProxyList = parseProxyList;
manager.parseRetryAfter = parseRetryAfter;
manager.classifyUpstreamFailure = classifyUpstreamFailure;
manager.parseSocks5ConnectResponse = parseSocks5ConnectResponse;
manager._test = {
  parseProxyUrl,
  parseProxyList,
  parseRetryAfter,
  classifyUpstreamFailure,
  parseSocks5ConnectResponse
};

module.exports = manager;
