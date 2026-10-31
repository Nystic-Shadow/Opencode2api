const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const config = require('./config');

const DEFAULT_PORTS = {
  http: 80,
  https: 443,
  socks5: 1080
};

// Proxy providers commonly expose one host:port and select the egress IP from
// the username. Two entries can therefore be different routes while sharing an
// endpoint. The tag keeps them distinct without exposing the credentials in
// logs, status responses, or session keys.
const ROUTE_TAG_SALT = crypto.randomBytes(16);

function credentialTag(username, password) {
  if (!username && !password) return '';
  return crypto
    .createHmac('sha256', ROUTE_TAG_SALT)
    .update(`${username}\u0000${password}`)
    .digest('hex')
    .slice(0, 10);
}

function tlsServername(name) {
  if (!name || net.isIP(name)) return undefined;
  return name;
}

function applyRotatingSession(username, sessionMode = 'auto') {
  if (sessionMode === 'disabled' || sessionMode === 'raw') return username || '';
  const randId = crypto.randomBytes(4).toString('hex');
  let user = String(username || '');
  if (user.includes('{session}') || user.includes('{rand}')) {
    return user.replaceAll('{session}', randId).replaceAll('{rand}', randId);
  }
  if (sessionMode === 'custom') return user;
  if (/([-:_]session[-:_])[a-zA-Z0-9]+/i.test(user)) {
    return user.replace(/([-_:]session[-:_])[a-zA-Z0-9]+/i, `$1${randId}`);
  }
  return user ? `${user}-session-${randId}` : `session-${randId}`;
}

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

  let username = '';
  let password = '';
  try {
    username = url.username ? decodeURIComponent(url.username) : '';
    password = url.password ? decodeURIComponent(url.password) : '';
  } catch (e) {
    // A malformed percent escape must be rejected, not crash config reload.
    return null;
  }
  if (type === 'socks5') {
    // SOCKS5 username/password auth encodes both lengths in one byte.
    if (Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255) return null;
  }

  const port = url.port ? parseInt(url.port, 10) : DEFAULT_PORTS[type];
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // URL.hostname keeps IPv6 brackets; net.connect/tls.connect need the bare
  // address, while display IDs must keep the brackets to remain valid URLs.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) return null;
  const displayHost = hostname.includes(':') ? `[${hostname}]` : hostname;
  const tag = credentialTag(username, password);
  const endpoint = `${type}://${displayHost}:${port}`;

  return {
    type,
    host: hostname,
    port,
    username,
    password,
    url: endpoint,
    // The fragment is an opaque route key, never sent on the wire.
    id: tag ? `${endpoint}#${tag}` : endpoint
  };
}

function parseProxyList() {
  const configured = config.get('proxies');
  let values = [];
  if (Array.isArray(configured)) {
    values = [...configured];
  } else if (typeof configured === 'string') {
    values = configured.split(/[\n,]/).map(value => value.trim()).filter(Boolean);
  }
  // Deliberately no HTTPS_PROXY/HTTP_PROXY/ALL_PROXY fallback. Proxy-only
  // deployments must use the explicit PROXIES list; an ambient variable can
  // silently route inference somewhere the operator did not choose.

  const seen = new Set();
  const result = [];
  for (const value of values) {
    const proxy = parseProxyUrl(value);
    if (!proxy || seen.has(proxy.id)) continue;
    seen.add(proxy.id);
    result.push(proxy);
    if (result.length >= 100) break;
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
  if (code === 403 && /(regionerror|not available in your country)/i.test(text)) {
    return 'retry';
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
    // Plain-HTTP direct egress exists only for local test upstreams. Proxy
    // agents tunnel TLS, so callers must reject http targets for them.
    this.directHttpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 64,
      maxFreeSockets: 16,
      timeout: 60000,
      keepAliveMsecs: 30000
    });
    this.proxyAgents = new Map();
    this.health = new Map();
    this.manualProxies = parseProxyList();
    this.autoProxies = [];
    this.autoProxyIds = new Set();
    this.maxProxyPool = Math.max(150, parseInt(config.get('max_proxy_pool'), 10) || 150);
    this.maxAutoPool = Math.max(100, parseInt(config.get('max_auto_pool'), 10) || 100);
    this.proxies = this._mergeProxyLists();
    this.proxyIds = new Set(this.proxies.map(p => p.id));
    this.manualFingerprint = JSON.stringify(this.manualProxies);
    this.proxyFingerprint = JSON.stringify(this.proxies);
    this.routeResetListeners = [];
    this.autoRemovalListeners = [];
    this.proxyChecks = new Map();
    this.probeErrors = new Map();
    this.proxyChecksRunning = false;
    this.proxyChecksPromise = null;
    this.proxyChecksEnabled = false;
    this.proxyCheckTimer = null;
    this.nextCheckAt = 0;
    this.lastCheckAt = 0;
    this.routeCursor = 0;
    this.lastReload = Date.now();
    this.checkIntervalMs = this._checkIntervalMs();
    this.rotatingProxy = null;
    this._loadRotatingProxy();

    config.onChange(() => {
      this._loadRotatingProxy();
      this.reload();
      const interval = this._checkIntervalMs();
      if (interval !== this.checkIntervalMs) {
        this.checkIntervalMs = interval;
        this._scheduleNextCheck();
      }
    });
  }

  onRouteReset(fn) {
    if (typeof fn === 'function') this.routeResetListeners.push(fn);
  }

  onAutoProxyRemoved(fn) {
    if (typeof fn === 'function') this.autoRemovalListeners.push(fn);
  }

  resetRoute(route, reason = 'route_reset') {
    if (!route || !route.id) return;
    this.health.delete(this._healthKey(route));
    for (const fn of this.routeResetListeners) {
      try { fn(route.id, reason); } catch (e) {}
    }
  }

  _mergeProxyLists(manual = this.manualProxies, auto = this.autoProxies) {
    const seen = new Set();
    const merged = [];
    for (const proxy of [...manual, ...auto]) {
      if (!proxy || !proxy.id || seen.has(proxy.id)) continue;
      seen.add(proxy.id);
      merged.push(proxy);
      if (merged.length >= this.maxProxyPool) break;
    }
    return merged;
  }

  _clearProxyState(ids) {
    for (const id of ids) {
      this.health.delete(id);
      this.proxyChecks.delete(id);
      this.probeErrors.delete(id);
      const agent = this.proxyAgents.get(id);
      if (agent) {
        try { agent.destroy(); } catch (e) {}
        this.proxyAgents.delete(id);
      }
    }
  }

  _applyMergedProxies(reason = 'proxy_reload') {
    const nextProxies = this._mergeProxyLists();
    const oldIds = new Set(this.proxyIds);
    const nextIds = new Set(nextProxies.map(proxy => proxy.id));
    const removed = [...oldIds].filter(id => !nextIds.has(id));
    const added = [...nextIds].filter(id => !oldIds.has(id));

    this.proxies = nextProxies;
    this.proxyIds = nextIds;
    this.proxyFingerprint = JSON.stringify(nextProxies);
    this._clearProxyState(new Set([...removed, ...added]));
    for (const id of [...this.health.keys()]) {
      if (!nextIds.has(id)) this.health.delete(id);
    }
    for (const id of [...this.proxyChecks.keys()]) {
      if (!nextIds.has(id)) this.proxyChecks.delete(id);
    }
    for (const id of [...this.probeErrors.keys()]) {
      if (!nextIds.has(id)) this.probeErrors.delete(id);
    }

    this.routeCursor = 0;
    this.lastReload = Date.now();

    for (const id of [...removed, ...added]) {
      for (const fn of this.routeResetListeners) {
        try { fn(id, reason); } catch (e) {}
      }
    }
    return { added, removed };
  }

  reload() {
    const nextManual = parseProxyList();
    const nextFingerprint = JSON.stringify(nextManual);
    if (nextFingerprint === this.manualFingerprint) {
      this.lastReload = Date.now();
      return;
    }

    this.manualProxies = nextManual;
    this.manualFingerprint = nextFingerprint;
    // Manual configuration always wins over a discovered route with the same
    // endpoint. Dropping the duplicate here avoids two health records for one
    // proxy while keeping the operator-supplied credentials intact.
    const manualIds = new Set(nextManual.map(proxy => proxy.id));
    this.autoProxies = this.autoProxies.filter(proxy => !manualIds.has(proxy.id));
    this.autoProxyIds = new Set(this.autoProxies.map(proxy => proxy.id));

    this._applyMergedProxies('proxy_reload');
    if (this.proxyChecksEnabled) {
      this._runAndSchedule();
    }
  }

  _loadRotatingProxy() {
    const isEnabled = config.get('rotating_proxy_enabled') === true;
    const rawUrl = String(config.get('rotating_proxy_url') || '').trim();
    if (!isEnabled || !rawUrl) {
      this.rotatingProxy = null;
      return;
    }
    const parsed = parseProxyUrl(rawUrl);
    if (!parsed) {
      this.rotatingProxy = null;
      return;
    }
    this.rotatingProxy = {
      ...parsed,
      type: 'proxy',
      proxyType: parsed.type,
      id: 'rotating_proxy',
      isRotating: true,
      rawUrl
    };
  }

  isRotatingProxyHealthy() {
    if (!this.rotatingProxy) return false;
    return this.isAvailable(this.rotatingProxy);
  }

  getRotatingProxyLatency() {
    if (!this.rotatingProxy) return 0;
    return this.proxyChecks.get('rotating_proxy')?.latency || 0;
  }

  getRotatingProxyStatus() {
    const isEnabled = config.get('rotating_proxy_enabled') === true;
    const rawUrl = String(config.get('rotating_proxy_url') || '').trim();
    const hasUrl = !!rawUrl;
    const check = this.proxyChecks.get('rotating_proxy');
    const health = this.health.get('rotating_proxy');
    let maskedUrl = '';
    if (rawUrl) {
      try {
        const u = new URL(rawUrl.includes('://') ? rawUrl : `http://${rawUrl}`);
        if (u.username || u.password) {
          u.username = '***';
          u.password = '***';
        }
        maskedUrl = u.toString().replace(/\/$/, '');
      } catch (e) {
        maskedUrl = rawUrl;
      }
    }
    return {
      enabled: isEnabled,
      configured: hasUrl,
      url: maskedUrl,
      endpoint: this.rotatingProxy ? this.rotatingProxy.url : '',
      available: this.rotatingProxy ? this.isAvailable(this.rotatingProxy) : false,
      routable: this.rotatingProxy ? this.isAvailable(this.rotatingProxy) : false,
      sessionMode: config.get('rotating_proxy_session_mode') || 'auto',
      healthy: check ? check.healthy : (this.rotatingProxy ? this.isAvailable(this.rotatingProxy) : null),
      latency: check?.latency || 0,
      lastCheck: check?.lastCheck || 0,
      lastError: health?.lastError || (check && !check.healthy ? check.error : '') || '',
      lastSuccess: health?.lastSuccess || 0,
      lastFailure: health?.lastFailure || 0
    };
  }

  async testRotatingProxy(rawUrl) {
    const parsed = parseProxyUrl(rawUrl);
    if (!parsed) {
      return { success: false, error: 'Invalid proxy URL format. Example: http://user:pass@gate.provider.com:7000' };
    }
    const route = {
      ...parsed,
      type: 'proxy',
      proxyType: parsed.type,
      id: 'rotating_proxy_test',
      isRotating: true,
      rawUrl
    };
    const target = this._probeTarget();
    const started = Date.now();
    try {
      const ok = await this._probeRoute(route, 8000, true);
      const latency = Date.now() - started;
      if (!ok) {
        const err = this.probeErrors.get('rotating_proxy_test') || 'Proxy CONNECT handshake timed out or was rejected';
        return { success: false, latency, error: err };
      }
      return { success: true, latency, message: `Connected to ${target.host} via rotating proxy in ${latency}ms` };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  }

  getAutoCapacity() {
    return Math.max(0, Math.min(this.maxAutoPool, this.maxProxyPool - this.manualProxies.length));
  }

  getManualProxyIds() {
    return this.manualProxies.map(proxy => proxy.id);
  }

  getAutoProxyIds() {
    return [...this.autoProxyIds];
  }

  isManualProxy(id) {
    return this.manualProxies.some(proxy => proxy.id === id);
  }

  isKnownProxy(id) {
    return this.proxyIds.has(id);
  }

  /**
   * Automatic routes that have failed two consecutive full sweeps. A single
   * failed sweep only keeps the route out of rotation; discovery must not
   * replace it before the normal two-sweep pruning threshold.
   */
  getFailedAutoProxyIds() {
    return this.autoProxies
      .filter(proxy => {
        const check = this.proxyChecks.get(proxy.id);
        const health = this.health.get(proxy.id);
        return check && check.healthy === false && (health?.checkFailures || 0) >= 2;
      })
      .map(proxy => proxy.id);
  }

  /**
   * Replace the automatically discovered pool. Entries here have already
   * passed the discovery module's five consecutive TLS probes, so they are
   * seeded as verified instead of waiting for the next background sweep.
   */
  setAutoProxies(entries) {
    const manualIds = new Set(this.manualProxies.map(proxy => proxy.id));
    const previous = new Set(this.autoProxyIds);
    const seen = new Set();
    const nextAuto = [];
    const capacity = this.getAutoCapacity();
    const list = Array.isArray(entries) ? [...entries].sort((a, b) => (a.latency || 9999) - (b.latency || 9999)) : [];

    for (const entry of list) {
      if (nextAuto.length >= capacity) break;
      // Prefer the full URL so credentials discovered on a source are kept;
      // the id is the credential-free display key.
      const proxy = entry ? parseProxyUrl(entry.url || entry.id) : null;
      if (!proxy || manualIds.has(proxy.id) || seen.has(proxy.id)) continue;
      // Public list entries can include credentials. Keep them for the tunnel
      // even though the display URL and route id stay credential-free.
      if (entry.username) proxy.username = entry.username;
      if (entry.password) proxy.password = entry.password;
      if (Number.isFinite(entry.latency)) proxy.latency = Math.max(0, Math.round(entry.latency));
      seen.add(proxy.id);
      nextAuto.push(proxy);
    }

    this.autoProxies = nextAuto;
    this.autoProxyIds = new Set(nextAuto.map(proxy => proxy.id));
    const { added, removed } = this._applyMergedProxies('auto_proxy_sync');

    for (const proxy of nextAuto) {
      if (!this.proxyIds.has(proxy.id) || previous.has(proxy.id)) continue;
      this.proxyChecks.set(proxy.id, {
        healthy: true,
        passes: 5,
        checks: 5,
        latency: proxy.latency || 0,
        lastCheck: Date.now(),
        failures: 0,
        error: ''
      });
      const health = this._health({ ...proxy, type: 'proxy', proxyType: proxy.type, id: proxy.id });
      health.failures = 0;
      health.openUntil = 0;
      health.retryAfterUntil = 0;
      health.checkFailed = false;
      health.checkFailures = 0;
      health.proxyFailures = 0;
      health.lastError = '';
      health.lastSuccess = Date.now();
    }

    const removedIds = removed.filter(id => previous.has(id) && !manualIds.has(id));
    if (removedIds.length) this._notifyAutoProxyRemoved(removedIds, 'auto_proxy_removed');
    return { added: added.length, removed: removed.length };
  }

  removeAutoProxies(ids, reason = 'auto_proxy_removed') {
    const target = ids instanceof Set ? ids : new Set(ids || []);
    const removed = this.autoProxies.filter(proxy => target.has(proxy.id));
    if (removed.length === 0) return 0;

    this.autoProxies = this.autoProxies.filter(proxy => !target.has(proxy.id));
    this.autoProxyIds = new Set(this.autoProxies.map(proxy => proxy.id));
    this._applyMergedProxies(reason);

    const removedIds = removed
      .map(proxy => proxy.id)
      .filter(id => !this.isManualProxy(id));
    if (removedIds.length) this._notifyAutoProxyRemoved(removedIds, reason);
    return removed.length;
  }

  _notifyAutoProxyRemoved(ids, reason) {
    for (const fn of this.autoRemovalListeners) {
      try { fn(ids, reason); } catch (e) {}
    }
  }

  _checkIntervalMs() {
    const minutes = Number(config.get('proxy_check_interval_minutes'));
    const safeMinutes = Number.isFinite(minutes) ? Math.min(1440, Math.max(1, minutes)) : 30;
    return safeMinutes * 60 * 1000;
  }

  startHealthChecks() {
    this.proxyChecksEnabled = true;
    this.recheckNow();
  }

  recheckNow() {
    this.proxyChecksEnabled = true;
    return this._runAndSchedule();
  }

  async _runAndSchedule() {
    try {
      await this.runProxyChecks();
    } catch (err) {
      console.warn('[Egress] Proxy health checks failed:', err.message);
    } finally {
      this._scheduleNextCheck();
    }
  }

  _scheduleNextCheck(delayMs = null) {
    if (!this.proxyChecksEnabled) return;
    if (this.proxyCheckTimer) {
      clearTimeout(this.proxyCheckTimer);
      this.proxyCheckTimer = null;
    }
    const wait = delayMs === null ? this._checkIntervalMs() : delayMs;
    this.nextCheckAt = Date.now() + wait;
    this.proxyCheckTimer = setTimeout(() => {
      this.proxyCheckTimer = null;
      this._runAndSchedule();
    }, wait);
    if (typeof this.proxyCheckTimer.unref === 'function') this.proxyCheckTimer.unref();
  }

  stopHealthChecks() {
    this.proxyChecksEnabled = false;
    this.nextCheckAt = 0;
    if (this.proxyCheckTimer) {
      clearTimeout(this.proxyCheckTimer);
      this.proxyCheckTimer = null;
    }
  }

  async runProxyChecks() {
    if (this.proxyChecksRunning) return this.proxyChecksPromise;
    this.proxyChecksRunning = true;
    this.proxyChecksPromise = (async () => {
      const proxies = [...this.proxies].slice(0, this.maxProxyPool);
      let index = 0;
      const concurrency = Math.min(5, proxies.length || 1);

      const worker = async () => {
        while (index < proxies.length) {
          const proxy = proxies[index++];
          await this.checkProxy(proxy);
        }
      };

      await Promise.all(Array.from({ length: concurrency }, worker));
      this.lastCheckAt = Date.now();
      await this._pruneDeadProxies();
    })();

    try {
      return await this.proxyChecksPromise;
    } finally {
      this.proxyChecksRunning = false;
      this.proxyChecksPromise = null;
    }
  }

  /**
   * Remove proxies that failed two consecutive full 5x sweeps. A proxy that
   * fails a sweep is already excluded from routing by checkFailed; pruning
   * only cleans the pool. Manual entries are never all removed automatically:
   * when every manual entry is dead, the last one is kept so a later sweep can
   * recover it. Automatic entries can all be removed because discovery will
   * replenish the pool with freshly verified routes.
   */
  async _pruneDeadProxies() {
    if (process.env.O2P_CONFIG_READONLY === '1') return 0;
    if (config.get('proxy_auto_prune_dead') === false) return 0;

    const isDead = (proxy) => {
      const check = this.proxyChecks.get(proxy.id);
      const health = this.health.get(proxy.id);
      return check && check.healthy === false && (health?.checkFailures || 0) >= 2;
    };

    const deadManual = this.manualProxies.filter(isDead);
    const deadAuto = this.autoProxies.filter(isDead);
    const removable = new Set();

    if (deadManual.length > 0) {
      const manualRemovable = deadManual.length >= this.manualProxies.length
        ? deadManual.slice(0, -1)
        : deadManual;
      for (const proxy of manualRemovable) removable.add(proxy.id);
    }
    for (const proxy of deadAuto) removable.add(proxy.id);
    if (removable.size === 0) return 0;

    const removed = this.removeProxies(removable);
    if (removed > 0) {
      console.warn(`[Egress] Auto-removed ${removed} dead route${removed === 1 ? '' : 's'} after two failed 5x checks.`);
      try {
        require('./notifications').add(
          'Dead Proxies Removed',
          `${removed} route${removed === 1 ? '' : 's'} failed two consecutive 5x checks and ${removed === 1 ? 'was' : 'were'} removed. Automatic discovery will replace failed routes.`,
          'warning'
        );
      } catch (e) {}
    }
    return removed;
  }

  removeProxies(ids) {
    const target = ids instanceof Set ? new Set(ids) : new Set(ids || []);
    target.delete('rotating_proxy');
    target.delete('rotating_proxy_test');
    const configured = config.get('proxies');
    let raw = [];
    if (Array.isArray(configured)) {
      raw = [...configured];
    } else if (typeof configured === 'string') {
      raw = configured.split(/[\n,]/).map(value => value.trim()).filter(Boolean);
    }
    const remaining = raw.filter(entry => {
      const parsed = parseProxyUrl(entry);
      return !parsed || !target.has(parsed.id);
    });
    const removedManual = raw.length - remaining.length;
    if (removedManual > 0) config.update({ proxies: remaining });
    const removedAuto = this.removeAutoProxies(target, 'proxy_pruned');
    return removedManual + removedAuto;
  }

  pruneFailed() {
    const ids = new Set(
      this.proxies
        .filter(proxy => this.proxyChecks.get(proxy.id)?.healthy === false)
        .map(proxy => proxy.id)
    );
    if (ids.size === 0) {
      return { removed: 0, remaining: this.proxies.length };
    }
    const removed = this.removeProxies(ids);
    return { removed, remaining: this.proxies.length };
  }

  async checkProxy(proxy) {
    const route = {
      ...proxy,
      type: 'proxy',
      proxyType: proxy.type,
      id: proxy.id
    };
    const checks = 5;
    const timeoutMs = 5000;
    const started = Date.now();
    const results = [];
    // Sequential probes avoid false failures on proxies that allow only one
    // concurrent CONNECT. Each probe is still capped at 5 seconds.
    for (let i = 0; i < checks; i++) {
      results.push(await this.probeProxy(route, timeoutMs));
    }
    const passes = results.filter(Boolean).length;
    const healthy = passes === checks;
    const latency = Math.round((Date.now() - started) / checks);
    // A reload can remove the proxy while its probes are in flight. Never
    // resurrect health or check state for a route that is no longer pooled.
    if (!this.proxyIds.has(proxy.id)) return;
    const health = this._health(route);
    const probeError = this.probeErrors.get(route.id) || '';

    if (healthy) {
      health.failures = 0;
      health.openUntil = 0;
      health.checkFailed = false;
      health.checkFailures = 0;
      health.proxyFailures = 0;
      health.lastError = '';
      health.lastSuccess = Date.now();
      this.probeErrors.delete(route.id);
    } else {
      health.checkFailures = (health.checkFailures || 0) + 1;
      health.checkFailed = true;
      health.openUntil = 0;
      health.lastError = `Proxy health check failed (${passes}/${checks})${probeError ? `: ${probeError}` : ''}`;
      health.lastFailure = Date.now();
    }

    this.proxyChecks.set(proxy.id, {
      healthy,
      passes,
      checks,
      latency,
      lastCheck: Date.now(),
      failures: health.checkFailures || 0,
      error: healthy ? '' : health.lastError
    });
  }

  _probeTarget() {
    const raw = config.get('upstream_inference_url') || 'https://opencode.ai';
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:') {
        return { host: 'opencode.ai', port: 443, servername: 'opencode.ai' };
      }
      const host = url.hostname.replace(/^\[|\]$/g, '');
      return {
        host,
        port: parseInt(url.port, 10) || 443,
        servername: tlsServername(host)
      };
    } catch (e) {
      return { host: 'opencode.ai', port: 443, servername: 'opencode.ai' };
    }
  }

  probeProxy(route, timeoutMs = 5000) {
    return this._probeRoute(route, timeoutMs, true);
  }

  /**
   * Probe an untrusted discovery candidate without recording its failure in
   * the per-route error map. Screening hundreds of public candidates must not
   * pollute diagnostics for routes that actually made it into rotation.
   */
  probeCandidate(route, timeoutMs = 3000) {
    return this._probeRoute(route, timeoutMs, false);
  }

  _probeRoute(route, timeoutMs = 3000, recordErrors = true) {
    return new Promise((resolve) => {
      let settled = false;
      let socket = null;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (socket) {
          try { socket.destroy(); } catch (e) {}
        }
        if (recordErrors) this.probeErrors.set(route.id, 'probe timeout');
        resolve(false);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const done = (err, stream) => {
        if (settled) {
          if (stream) {
            try { stream.destroy(); } catch (e) {}
          }
          return;
        }
        if (err || !stream) {
          settled = true;
          clearTimeout(timer);
          if (stream) {
            try { stream.destroy(); } catch (e) {}
          }
          if (recordErrors) this.probeErrors.set(route.id, (err && err.message) || 'probe failed');
          resolve(false);
          return;
        }
        socket = stream;

        // Active HTTP probe to verify the proxy IP is clean and not blocked (403/429) upstream
        const targetHost = (this._probeTarget && this._probeTarget().host) || 'opencode.ai';
        const probePath = targetHost === 'opencode.ai' ? '/zen/v1/models' : '/';
        let responseHeader = '';

        const onData = (chunk) => {
          responseHeader += chunk.toString('utf8');
          if (responseHeader.includes('\r\n') || responseHeader.length >= 12) {
            cleanup();
            const firstLine = responseHeader.split('\r\n')[0] || '';
            // For opencode.ai, verify HTTP 200 OK (rejects 403 Cloudflare challenges and 429 rate limits)
            const isOk = targetHost === 'opencode.ai' ? firstLine.includes(' 200') : /^[A-Z\/0-9.]+ [23]\d\d/.test(firstLine);
            if (!isOk && recordErrors) {
              this.probeErrors.set(route.id, `Upstream rejected: ${firstLine.slice(0, 40)}`);
            }
            settled = true;
            clearTimeout(timer);
            resolve(isOk);
          }
        };

        const onError = (e) => {
          cleanup();
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (recordErrors) this.probeErrors.set(route.id, e.message || 'socket error');
          resolve(false);
        };

        const cleanup = () => {
          try {
            stream.removeListener('data', onData);
            stream.removeListener('error', onError);
            stream.destroy();
          } catch (e) {}
        };

        stream.on('data', onData);
        stream.on('error', onError);
        try {
          stream.write(`GET ${probePath} HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: OpenCode2API/3\r\nAuthorization: Bearer public\r\nConnection: close\r\n\r\n`);
        } catch (e) {
          cleanup();
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(false);
          }
        }
      };

      this._connectViaProxy(route, this._probeTarget(), done);
    });
  }

  getProxyStatus() {
    const entries = this.proxies.map(proxy => {
      const route = { ...proxy, type: 'proxy', proxyType: proxy.type, id: proxy.id };
      const health = this._health(route);
      const check = this.proxyChecks.get(proxy.id);
      const available = this.isAvailable(route);
      const quotaRetryAfterMs = this.getQuotaRetryAfter(route);
      const checkHealthy = check ? check.healthy : null;
      let state = 'unverified';
      if (health.checkFailed) state = 'failed';
      else if (quotaRetryAfterMs > 0) state = 'quota';
      else if (!available) state = 'cooling';
      else if (checkHealthy === true) state = 'healthy';
      else if (checkHealthy === false) state = 'failed';
      return {
        id: proxy.id,
        endpoint: proxy.url,
        source: this.autoProxyIds.has(proxy.id) ? 'auto' : 'manual',
        auto: this.autoProxyIds.has(proxy.id),
        available,
        routable: available && quotaRetryAfterMs === 0,
        quotaRetryAfterMs,
        state,
        failures: health.failures || 0,
        checkFailures: health.checkFailures || 0,
        checkFailed: health.checkFailed === true,
        openUntil: health.openUntil || 0,
        lastError: health.lastError || '',
        passes: check?.passes || 0,
        checks: check?.checks || 5,
        latency: check?.latency || 0,
        lastCheck: check?.lastCheck || 0,
        healthy: checkHealthy
      };
    });

    const verified = entries.filter(entry => entry.available && entry.healthy === true);
    const routable = verified.filter(entry => entry.routable);
    const failed = entries.filter(entry => entry.healthy === false);
    const fastest = [...routable].sort((a, b) => (a.latency || Infinity) - (b.latency || Infinity))[0] || null;
    return {
      configuredCount: this.proxies.length,
      manualCount: this.manualProxies.length,
      autoCount: this.autoProxyIds.size,
      maxPool: this.maxProxyPool,
      verifiedCount: verified.length,
      routableCount: routable.length,
      failedCount: failed.length,
      unverifiedCount: entries.filter(entry => entry.healthy === null).length,
      checkIntervalMinutes: Math.round(this._checkIntervalMs() / 60000),
      nextCheckAt: this.nextCheckAt || 0,
      lastCheckAt: this.lastCheckAt || 0,
      isScanning: this.proxyChecksRunning,
      autoPruneDead: config.get('proxy_auto_prune_dead') !== false,
      configuredViaEnv: !!process.env.PROXIES,
      fastestProxy: fastest,
      rotatingProxy: this.getRotatingProxyStatus(),
      topProxies: routable.slice(0, 10).map(entry => ({
        endpoint: entry.endpoint,
        source: entry.source,
        latency: entry.latency,
        passes: entry.passes,
        checks: entry.checks
      })),
      proxies: entries
    };
  }

  _healthKey(route) {
    if (!route) return 'unknown';
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
        checkFailed: false,
        checkFailures: 0,
        proxyFailures: 0,
        lastError: '',
        lastSuccess: 0,
        lastFailure: 0
      });
    }
    return this.health.get(key);
  }

  isAvailable(route) {
    if (!route) return false;
    if (route.isRotating) {
      // Rotating proxy is a gateway endpoint to an entire pool of exit IPs.
      // It is always available as long as it has a valid host and port.
      return !!(route.host && route.port);
    }
    const health = this._health(route);
    if (health.checkFailed) return false;
    return health.openUntil <= Date.now();
  }

  /**
   * Remaining provider-quota cooldown for a route.
   *
   * Quota is not an infrastructure failure: the route is still usable once the
   * upstream window resets, so it stays in the candidate list (and readiness
   * stays green). Callers may skip cooling routes and fail over to another
   * proxy; the route returns to normal rotation when the cooldown expires.
   */
  getQuotaRetryAfter(route) {
    if (!route) return 0;
    if (route.isRotating) {
      // Rotating proxy assigns a different IP on every request. An upstream 429 on
      // one IP does NOT lock out the entire rotating gateway.
      return 0;
    }
    const health = this._health(route);
    const remaining = health.retryAfterUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Earliest time any currently available route leaves provider-quota
   * cooldown. Used only when every routable proxy is exhausted.
   */
  getEarliestQuotaRetryAfter(candidates = null) {
    const routes = Array.isArray(candidates) ? candidates : this.getCandidates();
    let earliest = 0;
    for (const route of routes) {
      const remaining = this.getQuotaRetryAfter(route);
      if (remaining > 0 && (earliest === 0 || remaining < earliest)) earliest = remaining;
    }
    return earliest;
  }

  clearAllQuotaFailures() {
    for (const [key, health] of this.health) {
      if (health && health.retryAfterUntil > 0) {
        health.retryAfterUntil = 0;
      }
    }
  }

  _allowDirect() {
    return config.get('allow_direct_fallback') === true;
  }

  getCandidates({ includeQuota = true } = {}) {
    if (config.get('rotating_proxy_enabled') === true && this.rotatingProxy) {
      const routes = [this.rotatingProxy];
      if (this._allowDirect() && !this.isAvailable(this.rotatingProxy)) {
        routes.push({ type: 'direct', id: 'direct' });
      }
      return routes;
    }

    const mode = String(config.get('egress_mode') || 'proxy_only').toLowerCase();
    const direct = { type: 'direct', id: 'direct' };
    const proxyRoutes = this.proxies.map(proxy => ({
      ...proxy,
      type: 'proxy',
      proxyType: proxy.type,
      id: proxy.id
    }));

    let routes;
    if (mode === 'direct') {
      routes = [direct];
    } else if (mode === 'proxy_only') {
      routes = proxyRoutes;
    } else {
      // auto: proxies first, direct only when explicitly allowed.
      routes = [...proxyRoutes];
      if (this._allowDirect()) routes.push(direct);
    }

    return routes.filter(route => {
      if (!this.isAvailable(route)) return false;
      if (!includeQuota && this.getQuotaRetryAfter(route) > 0) return false;
      return true;
    });
  }

  /**
   * Routes eligible for normal traffic. Verified proxies come first. Direct is
   * only used when no proxy route is available at all.
   */
  getRoutableRoutes({ includeUnverified = false } = {}) {
    if (config.get('rotating_proxy_enabled') === true && this.rotatingProxy) {
      if (this.isAvailable(this.rotatingProxy)) return [this.rotatingProxy];
      return this._allowDirect() ? [{ type: 'direct', id: 'direct' }] : [this.rotatingProxy];
    }

    const candidates = this.getCandidates({ includeQuota: false });
    const proxies = candidates.filter(route => route.type !== 'direct');
    const pool = proxies.length > 0 ? proxies : candidates;
    const verified = pool.filter(route => this.proxyChecks.get(route.id)?.healthy === true);
    if (verified.length > 0) return includeUnverified ? pool : verified;
    return pool;
  }

  /**
   * Round-robin across routable proxies so one endpoint does not absorb every
   * request (and every quota hit) while the rest of the pool sits idle.
   */
  selectRoute(routes = null) {
    if (config.get('rotating_proxy_enabled') === true && this.rotatingProxy) {
      return this.rotatingProxy;
    }

    const pool = Array.isArray(routes) ? routes : this.getRoutableRoutes();
    if (pool.length === 0) return null;
    const sorted = [...pool].sort((a, b) => {
      const latA = this.proxyChecks.get(a.id)?.latency ?? a.latency ?? 0;
      const latB = this.proxyChecks.get(b.id)?.latency ?? b.latency ?? 0;
      if (latA !== latB) return latA - latB;
      return 0;
    });
    // Round-robin among the fastest pool (up to 12 fastest routes for high throughput and ultra-low latency)
    const tierSize = Math.min(12, sorted.length);
    const index = this.routeCursor % tierSize;
    this.routeCursor = (index + 1) % tierSize;
    return sorted[index];
  }

  getNextRoutableRoute(attempted = null) {
    if (config.get('rotating_proxy_enabled') === true && this.rotatingProxy) {
      return this.rotatingProxy;
    }

    const excluded = attempted instanceof Set ? attempted : new Set(attempted || []);
    const verified = this.getRoutableRoutes().filter(route => !excluded.has(route.id));
    if (verified.length > 0) {
      verified.sort((a, b) => {
        const latA = this.proxyChecks.get(a.id)?.latency ?? a.latency ?? 0;
        const latB = this.proxyChecks.get(b.id)?.latency ?? b.latency ?? 0;
        return latA - latB;
      });
      // Distribute failovers across top-tier fast proxies instead of hammering only verified[0]
      const topTier = verified.slice(0, Math.min(4, verified.length));
      const idx = Math.floor(Math.random() * topTier.length);
      return topTier[idx];
    }
    // Verified proxies may all have been attempted (for example after a quota
    // cooldown). Fall back to unchecked-but-available proxies rather than
    // returning a 429 while part of the pool has never been tried.
    const unverified = this.getRoutableRoutes({ includeUnverified: true })
      .filter(route => !excluded.has(route.id));
    if (unverified.length > 0) {
      unverified.sort((a, b) => {
        const latA = this.proxyChecks.get(a.id)?.latency ?? a.latency ?? 0;
        const latB = this.proxyChecks.get(b.id)?.latency ?? b.latency ?? 0;
        return latA - latB;
      });
      const topTier = unverified.slice(0, Math.min(4, unverified.length));
      const idx = Math.floor(Math.random() * topTier.length);
      return topTier[idx];
    }
    const candidates = this.getCandidates({ includeQuota: false });
    return candidates.find(route => route.type === 'direct' && !excluded.has(route.id)) || null;
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
    if (route.type === 'direct') return protocol === 'http:' ? this.directHttpAgent : this.directAgent;
    if (route.type === 'proxy') {
      if (route.isRotating) return this._getRotatingProxyAgent(route);
      return this._getProxyAgent(route);
    }
    return protocol === 'http:' ? this.directHttpAgent : this.directAgent;
  }

  _getRotatingProxyAgent(route) {
    const key = `rotating_${route.id}_${route.rawUrl || route.url}`;
    if (this.proxyAgents.has(key)) return this.proxyAgents.get(key);

    const manager = this;
    const agent = new https.Agent({
      keepAlive: false, // Disables socket reuse so proxy provider assigns a new exit IP per connection
      maxSockets: 64,
      timeout: 30000
    });

    agent.createConnection = function (options, callback) {
      manager._connectViaProxy(route, options, callback);
    };

    this.proxyAgents.set(key, agent);
    return agent;
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
      if (err && typeof err === 'object') {
        // Lets the request path distinguish a broken proxy tunnel from an
        // upstream response instead of only seeing a generic socket error.
        try { err.proxyFailure = true; } catch (e) {}
      }
      callback(err, socket);
    };

    if (route.proxyType === 'socks5') {
      this._connectSocks5(route, destHost, destPort, done);
      return;
    }

    const secureProxy = route.proxyType === 'https';
    const requestModule = secureProxy ? https : http;
    // CONNECT authority form requires brackets around IPv6 literals.
    const connectHost = destHost.includes(':') ? `[${destHost}]` : destHost;
    const authority = `${connectHost}:${destPort}`;
    const isRotating = route.isRotating || (config.get('rotating_proxy_enabled') === true && route.id === 'rotating_proxy');
    const effectiveUsername = isRotating
      ? applyRotatingSession(route.username, config.get('rotating_proxy_session_mode'))
      : route.username;

    const headers = {
      Host: authority,
      'User-Agent': 'OpenCode2API/3'
    };
    if (effectiveUsername) {
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${effectiveUsername}:${route.password}`).toString('base64');
    }

    let req;
    try {
      req = requestModule.request({
        host: route.host,
        port: route.port,
        method: 'CONNECT',
        path: authority,
        headers,
        timeout: 10000,
        ...(secureProxy ? { servername: tlsServername(route.host), rejectUnauthorized: true } : {})
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
        servername: tlsServername(options.servername || destHost),
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
        servername: tlsServername(destHost),
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
    health.checkFailed = false;
    health.checkFailures = 0;
    health.proxyFailures = 0;
    health.lastError = '';
    health.lastSuccess = Date.now();
  }

  recordFailure(route, kind = 'network', retryAfterMs = 0) {
    if (!route) return;
    const health = this._health(route);
    const now = Date.now();
    health.lastFailure = now;

    if (route.isRotating) {
      if (kind === 'quota') {
        // Upstream IP rate limit on a rotating proxy: THAT EXIT IP was rate-limited,
        // but the proxy gateway itself is alive. Do NOT set retryAfterUntil!
        health.lastError = 'exit ip quota (rotating)';
        return;
      }
      if (kind === 'proxy_down') {
        health.proxyFailures = (health.proxyFailures || 0) + 1;
        health.lastError = 'rotating proxy exit IP connection failed';
        // Note: Do NOT set health.openUntil for rotating proxy:
        // One failing exit node must never disable the entire gateway or cause /readyz to fail.
        return;
      }
      health.lastError = String(kind || 'error');
      return;
    }

    if (kind === 'quota') {
      health.retryAfterUntil = Math.max(health.retryAfterUntil, now + Math.max(1000, retryAfterMs || 0));
      health.lastError = 'upstream quota';
      return;
    }

    if (kind === 'proxy_down') {
      // A proxy-level connection failure is stronger evidence than an upstream
      // 5xx. Pull the route out of rotation immediately and back off
      // exponentially, capped at the configured sweep interval.
      health.proxyFailures = (health.proxyFailures || 0) + 1;
      const exponent = Math.min(health.proxyFailures - 1, 6);
      const backoff = Math.min(this._checkIntervalMs(), 30000 * Math.pow(2, exponent));
      health.openUntil = Math.max(health.openUntil, now + backoff);
      health.lastError = 'proxy connection failed';
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
      available: this.isAvailable(route),
      routable: this.isAvailable(route) && this.getQuotaRetryAfter(route) === 0,
      quotaRetryAfterMs: this.getQuotaRetryAfter(route)
    }));
    return {
      mode: config.get('egress_mode') || 'proxy_only',
      proxies: this.proxies.map(proxy => ({
        id: proxy.id,
        type: proxy.type,
        source: this.autoProxyIds.has(proxy.id) ? 'auto' : 'manual'
      })),
      allowDirect: this._allowDirect(),
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
manager.applyRotatingSession = applyRotatingSession;
manager._test = {
  parseProxyUrl,
  parseProxyList,
  parseRetryAfter,
  classifyUpstreamFailure,
  parseSocks5ConnectResponse,
  applyRotatingSession
};

module.exports = manager;
