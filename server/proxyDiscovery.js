const net = require('net');

const egress = require('./egress');
const config = require('./config');

const DISCOVERY_INTERVAL_MS = 10 * 60 * 1000;
const EMPTY_RETRY_MS = [3 * 60 * 1000, 6 * 60 * 1000, 10 * 60 * 1000];
const SCREEN_TIMEOUT_MS = 3500;
const VERIFY_TIMEOUT_MS = 4000;
const VERIFY_CHECKS = 5;
const AUTO_TARGET = 100;
const MAX_SCREEN_CANDIDATES = 4000;
const SCREEN_CONCURRENCY = 64;
const VERIFY_CONCURRENCY = 16;
const SCREEN_FAIL_COOLDOWN_MS = 15 * 60 * 1000;
const VERIFY_FAIL_COOLDOWN_MS = 30 * 60 * 1000;
const REMOVED_COOLDOWN_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_LINES = 1500;

// High-speed, US-targeted proxy discovery sources. OpenCode models, early access,
// and regional capacity perform with highest reliability from United States routes,
// eliminating "RegionError: This model is not available in your country" (403).
const DEFAULT_SOURCES = [
  {
    name: 'proxifly-us',
    protocol: 'http',
    maxLines: 1500,
    url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/US/data.txt'
  },
  {
    name: 'proxyscrape-us-all',
    protocol: 'http',
    maxLines: 600,
    url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&country=us'
  },
  {
    name: 'proxyscrape-us-http',
    protocol: 'http',
    maxLines: 500,
    url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&country=us&proxy_format=ipport&format=text'
  },
  {
    name: 'proxyscrape-us-socks5',
    protocol: 'socks5',
    maxLines: 500,
    url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&country=us&proxy_format=ipport&format=text'
  },
  {
    name: 'geonode-us',
    protocol: 'http',
    maxLines: 500,
    url: 'https://proxylist.geonode.com/api/proxy-list?country=US&limit=500&page=1&sort_by=lastChecked&sort_type=desc'
  },
  {
    name: 'spys-me-us-http',
    protocol: 'http',
    maxLines: 500,
    countryFilter: 'US',
    url: 'https://spys.me/proxy.txt'
  },
  {
    name: 'spys-me-us-socks5',
    protocol: 'socks5',
    maxLines: 500,
    countryFilter: 'US',
    url: 'https://spys.me/socks.txt'
  },
  {
    name: 'proxyscrape-v2-us-http',
    protocol: 'http',
    maxLines: 400,
    url: 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=US&ssl=all&anonymity=all'
  },
  {
    name: 'proxyscrape-v2-us-socks5',
    protocol: 'socks5',
    maxLines: 400,
    url: 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks5&timeout=10000&country=US'
  }
];

function ipv4Octets(host) {
  if (net.isIP(host) !== 4) return null;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    return null;
  }
  return octets;
}

function isPublicIpv4(host) {
  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [a, b, c] = octets;

  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF / TEST-NET-1
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 88 && c === 99) return false; // deprecated 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

function isPublicIpv6(host) {
  const clean = String(host || '').split('%')[0].toLowerCase();
  if (net.isIP(clean) !== 6) return false;
  const parts = clean.split(':');
  const first = parseInt(parts[0] || '0', 16);
  const second = parseInt(parts[1] || '0', 16);

  // Only global unicast 2000::/3 is acceptable. This rejects loopback,
  // unspecified, link-local, unique-local, multicast, and NAT64 prefixes.
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && second === 0x0000) return false; // Teredo
  if (first === 0x2001 && second === 0x0002) return false; // benchmarking
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (first === 0x2002) return false; // 6to4 embeds an IPv4 target
  return true;
}

function isPublicIp(host) {
  const family = net.isIP(host);
  if (family === 4) return isPublicIpv4(host);
  if (family === 6) return isPublicIpv6(host);
  return false;
}

function parseCandidateLine(raw, protocol) {
  let value = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!value || value.startsWith('#') || value.startsWith('//')) return { proxy: null, reason: 'invalid' };

  const hash = value.indexOf('#');
  if (hash >= 0) value = value.slice(0, hash).trim();
  if (!value) return { proxy: null, reason: 'invalid' };

  // Lists use several separators: "ip:port", "ip:port:Country",
  // "ip:port,CC", and explicit scheme URLs. Keep only the endpoint token.
  const token = value.split(/[\s,;|]+/)[0];
  if (!token) return { proxy: null, reason: 'invalid' };
  let candidate = token;

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const v4 = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})(?::.*)?$/);
    const v6 = candidate.match(/^(\[[0-9a-fA-F:]+\]):(\d{1,5})(?::.*)?$/);
    if (v4) candidate = `${v4[1]}:${v4[2]}`;
    else if (v6) candidate = `${v6[1]}:${v6[2]}`;
    candidate = `${protocol}://${candidate}`;
  }

  const proxy = egress.parseProxyUrl(candidate);
  if (!proxy) return { proxy: null, reason: 'invalid' };
  if (!isPublicIp(proxy.host)) return { proxy: null, reason: 'private' };
  return { proxy, reason: '' };
}

function parseSourceText(text, protocol, maxLines = 500, countryFilter = null) {
  const limit = Math.min(MAX_SOURCE_LINES, Math.max(1, parseInt(maxLines, 10) || 500));
  const result = {
    proxies: [],
    rejectedPrivate: 0,
    rejectedInvalid: 0,
    scanned: 0
  };
  if (typeof text !== 'string' || !text) return result;

  // JSON source support (e.g. GeoNode proxy lists)
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsedJson = JSON.parse(trimmed);
      const items = Array.isArray(parsedJson.data) ? parsedJson.data : (Array.isArray(parsedJson) ? parsedJson : []);
      const seen = new Set();
      for (const item of items) {
        if (result.proxies.length >= limit) break;
        result.scanned++;
        if (countryFilter && item.country && String(item.country).toUpperCase() !== countryFilter.toUpperCase()) {
          continue;
        }
        const proto = (item.protocols && item.protocols.includes('socks5')) ? 'socks5' : (protocol || 'http');
        const candidate = `${proto}://${item.ip}:${item.port}`;
        const parsed = parseCandidateLine(candidate, proto);
        if (!parsed.proxy) {
          if (parsed.reason === 'private') result.rejectedPrivate++;
          else result.rejectedInvalid++;
          continue;
        }
        if (seen.has(parsed.proxy.id)) continue;
        seen.add(parsed.proxy.id);
        result.proxies.push(parsed.proxy);
      }
      return result;
    } catch (e) {}
  }

  const lines = text.split(/\r?\n/);
  const scanLimit = Math.min(lines.length, Math.max(limit * 10, 1000));
  const seen = new Set();

  for (let index = 0; index < scanLimit && result.proxies.length < limit; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    result.scanned++;

    // Country verification for sources with explicit country metadata (e.g., spys.me "ip:port CC-ANON")
    if (countryFilter && line.includes(' ') && !line.startsWith('#') && !line.startsWith('//')) {
      const tokens = line.split(/\s+/);
      const ccToken = tokens[1] ? tokens[1].slice(0, 2).toUpperCase() : '';
      if (/^[A-Z]{2}$/.test(ccToken) && ccToken !== countryFilter.toUpperCase()) {
        continue;
      }
    }

    const parsed = parseCandidateLine(line, protocol);
    if (!parsed.proxy) {
      if (parsed.reason === 'private') result.rejectedPrivate++;
      else result.rejectedInvalid++;
      continue;
    }
    if (seen.has(parsed.proxy.id)) continue;
    seen.add(parsed.proxy.id);
    result.proxies.push(parsed.proxy);
  }
  return result;
}

async function fetchSourceText(url, timeoutMs = FETCH_TIMEOUT_MS) {
  if (typeof fetch !== 'function') throw new Error('global fetch is unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'OpenCode2API/3 auto-proxy-discovery' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > MAX_SOURCE_BYTES) {
      throw new Error('source response is too large');
    }
    const text = await response.text();
    return text.length > MAX_SOURCE_BYTES ? text.slice(0, MAX_SOURCE_BYTES) : text;
  } finally {
    clearTimeout(timer);
  }
}

function proxyRoute(proxy) {
  return {
    type: 'proxy',
    proxyType: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password,
    url: proxy.url,
    id: proxy.id
  };
}

class ProxyDiscovery {
  constructor({
    egressManager = egress,
    cfg = config,
    fetchText = fetchSourceText,
    probe = null,
    sources = DEFAULT_SOURCES,
    target = AUTO_TARGET,
    maxCandidates = MAX_SCREEN_CANDIDATES,
    screenConcurrency = SCREEN_CONCURRENCY,
    verifyConcurrency = VERIFY_CONCURRENCY,
    intervalMs = DISCOVERY_INTERVAL_MS,
    verbose = true
  } = {}) {
    this.egressManager = egressManager;
    this.cfg = cfg;
    this.fetchText = fetchText;
    this.sources = Array.isArray(sources) ? sources.slice() : DEFAULT_SOURCES.slice();
    const configTarget = cfg && typeof cfg.get === 'function' ? cfg.get('auto_proxy_target') : null;
    this.target = Math.max(1, parseInt(target !== undefined && target !== null ? target : configTarget, 10) || AUTO_TARGET);
    this.maxCandidates = Math.max(1, parseInt(maxCandidates, 10) || MAX_SCREEN_CANDIDATES);
    this.screenConcurrency = Math.max(1, parseInt(screenConcurrency, 10) || SCREEN_CONCURRENCY);
    this.verifyConcurrency = Math.max(1, parseInt(verifyConcurrency, 10) || VERIFY_CONCURRENCY);
    this.intervalMs = Math.max(60000, parseInt(intervalMs, 10) || DISCOVERY_INTERVAL_MS);
    this.verbose = verbose !== false;

    this.probe = probe || ((route, timeoutMs) => {
      if (typeof this.egressManager.probeCandidate === 'function') {
        return this.egressManager.probeCandidate(route, timeoutMs);
      }
      return this.egressManager.probeProxy(route, timeoutMs);
    });

    this.verified = new Map(); // id -> { proxy, latency, verifiedAt }
    this.cooldowns = new Map(); // id -> { until, reason }
    this.sourceStatus = [];
    this.started = false;
    this.requested = false;
    this.enabled = this.isEnabled();
    this.running = false;
    this.promise = null;
    this.timer = null;
    this.emptyRuns = 0;
    this.lastRefreshAt = 0;
    this.lastRefreshStartedAt = 0;
    this.lastRefreshFinishedAt = 0;
    this.lastDurationMs = 0;
    this.lastError = '';
    this.lastSourceError = '';
    this.nextRefreshAt = 0;
    this.lastRun = this._blankRun();

    if (typeof this.egressManager.onAutoProxyRemoved === 'function') {
      this.egressManager.onAutoProxyRemoved((ids, reason) => {
        this._handleAutoRemoved(ids, reason);
      });
    }

    // A dashboard toggle must take effect without a restart. Transitioning
    // from off to on starts discovery; turning it off stops the scheduler and
    // leaves the already verified routes in place for the current process.
    if (this.cfg && typeof this.cfg.onChange === 'function') {
      this.cfg.onChange(() => {
        const enabled = this.isEnabled();
        if (!enabled) {
          this.enabled = false;
          this.stop();
          // Disabling automatic discovery returns egress to manual proxies
          // only. Clear cooldowns afterwards: the removal listeners cool every
          // route they see, which would otherwise block an immediate re-enable.
          this.verified.clear();
          this._syncEgress();
          this.cooldowns.clear();
          return;
        }
        const wasEnabled = this.enabled;
        this.enabled = true;
        if (this.requested && (wasEnabled === false || !this.started)) this.start();
      });
    }
  }

  _blankRun() {
    return {
      candidatesSeen: 0,
      screened: 0,
      screenPasses: 0,
      verified: 0,
      added: 0,
      removed: 0,
      sourcesOk: 0,
      sourcesFailed: 0,
      skipped: false
    };
  }

  isEnabled() {
    if (!this.cfg || typeof this.cfg.get !== 'function') return true;
    return this.cfg.get('auto_proxy_discovery') !== false;
  }

  start() {
    this.requested = true;
    this.enabled = this.isEnabled();
    if (!this.enabled) {
      this.stop();
      return;
    }
    this.started = true;
    if (this.running) return;
    this.refreshNow();
  }

  stop() {
    this.started = false;
    this.nextRefreshAt = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  refreshNow() {
    if (!this.isEnabled()) return Promise.resolve(this.getStatus());
    if (this.running) return this.promise;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRefreshAt = 0;
    this.running = true;
    this.lastRefreshStartedAt = Date.now();

    this.promise = this._run()
      .catch((err) => {
        this.lastError = err.message || String(err);
        if (this.verbose) console.warn('[ProxyDiscovery] Refresh failed:', this.lastError);
      })
      .finally(() => {
        this.running = false;
        this.promise = null;
        this.lastRefreshAt = Date.now();
        this.lastRefreshFinishedAt = this.lastRefreshAt;
        this.lastDurationMs = this.lastRefreshAt - this.lastRefreshStartedAt;
        if (!this.isEnabled()) {
          this.verified.clear();
          this._syncEgress();
          this.cooldowns.clear();
        }
        this._scheduleNext();
      });
    return this.promise;
  }

  async _run() {
    const summary = this._blankRun();
    this.lastRun = summary;
    this.lastError = '';
    this.lastSourceError = '';
    this._pruneCooldowns();
    this._reconcile();
    this._pruneFailedAuto(summary);
    if (!this.isEnabled()) return;

    const target = this._target();
    if (this.verified.size >= target) {
      summary.skipped = true;
      this._syncEgress();
      this.emptyRuns = 0;
      return;
    }
    if (target === 0) {
      this._syncEgress();
      return;
    }

    const candidates = await this._fetchCandidates(summary);
    summary.candidatesSeen = candidates.length;
    if (!this.isEnabled()) return;
    if (candidates.length === 0) {
      this.emptyRuns++;
      if (this.verified.size === 0) {
        this.lastError = summary.sourcesFailed === this.sources.length
          ? `All proxy sources failed${this.lastSourceError ? `: ${this.lastSourceError}` : ''}`
          : 'No new public proxy candidates are available';
      }
      this._syncEgress();
      return;
    }

    let round = 0;
    const screenState = { index: 0 };
    while (this.verified.size < target && screenState.index < candidates.length && round < 8) {
      round++;
      const need = target - this.verified.size;
      const maxPassers = Math.max(30, need * 3);
      const passers = await this._screenBatch(candidates, screenState, maxPassers, summary);
      if (passers.length === 0) break;
      summary.screenPasses += passers.length;
      await this._verifyPassers(passers, target, summary);
    }

    const synced = this._syncEgress();
    summary.added += synced.added || 0;
    summary.removed += synced.removed || 0;
    summary.sourcesOk = this.sourceStatus.filter(source => source.ok).length;
    summary.sourcesFailed = this.sourceStatus.length - summary.sourcesOk;

    if (this.verified.size === 0) {
      this.emptyRuns++;
      if (!this.lastError) {
        this.lastError = summary.sourcesFailed === this.sources.length && this.sources.length > 0
          ? `All proxy sources failed${this.lastSourceError ? `: ${this.lastSourceError}` : ''}`
          : 'No public proxy passed screening and 5x TLS verification';
      }
    } else {
      this.emptyRuns = 0;
      this.lastError = '';
    }

    if (this.verbose && summary.screened > 0) {
      const seconds = ((Date.now() - this.lastRefreshStartedAt) / 1000).toFixed(0);
      console.log(
        `[ProxyDiscovery] ${this.verified.size}/${target} automatic route(s) verified | ` +
        `${summary.candidatesSeen} candidates, ${summary.screened} screened | ` +
        `${summary.sourcesOk}/${this.sources.length} sources | ${seconds}s`
      );
    }
  }

  async _fetchCandidates(summary) {
    const results = await Promise.all(this.sources.map(async (source) => {
      const started = Date.now();
      try {
        const text = await this.fetchText(source.url, FETCH_TIMEOUT_MS);
        const parsed = parseSourceText(text, source.protocol, source.maxLines, source.countryFilter || 'US');
        return {
          source,
          ok: true,
          count: parsed.proxies.length,
          rejectedPrivate: parsed.rejectedPrivate,
          rejectedInvalid: parsed.rejectedInvalid,
          proxies: parsed.proxies,
          durationMs: Date.now() - started,
          error: ''
        };
      } catch (err) {
        return {
          source,
          ok: false,
          count: 0,
          rejectedPrivate: 0,
          rejectedInvalid: 0,
          proxies: [],
          durationMs: Date.now() - started,
          error: err.name === 'AbortError' ? 'fetch timed out' : (err.message || String(err))
        };
      }
    }));

    this.sourceStatus = results.map(result => ({
      name: result.source.name,
      protocol: result.source.protocol,
      ok: result.ok,
      count: result.count,
      rejectedPrivate: result.rejectedPrivate,
      rejectedInvalid: result.rejectedInvalid,
      durationMs: result.durationMs,
      error: result.error
    }));
    summary.sourcesOk = this.sourceStatus.filter(source => source.ok).length;
    summary.sourcesFailed = this.sourceStatus.length - summary.sourcesOk;
    if (summary.sourcesFailed > 0) {
      const firstFailure = this.sourceStatus.find(source => !source.ok);
      this.lastSourceError = firstFailure ? `${firstFailure.name}: ${firstFailure.error}` : '';
    }

    const candidates = [];
    const seen = new Set();
    for (const result of results) {
      if (!result.ok) continue;
      for (const proxy of result.proxies) {
        if (candidates.length >= this.maxCandidates) break;
        if (seen.has(proxy.id)) continue;
        seen.add(proxy.id);
        if (this._isKnown(proxy.id)) continue;
        if (this._onCooldown(proxy.id)) continue;
        candidates.push(proxy);
      }
      if (candidates.length >= this.maxCandidates) break;
    }
    return candidates;
  }

  async _screenBatch(candidates, state, maxPassers, summary) {
    const passers = [];
    let stopped = false;
    const workerCount = Math.min(this.screenConcurrency, candidates.length - state.index);
    const workers = Array.from({ length: Math.max(0, workerCount) }, async () => {
      while (!stopped && this.isEnabled()) {
        if (passers.length >= maxPassers) {
          stopped = true;
          return;
        }
        const position = state.index++;
        if (position >= candidates.length) return;
        const proxy = candidates[position];
        if (this._isKnown(proxy.id) || this._onCooldown(proxy.id)) continue;
        let passed = false;
        try {
          passed = !!(await this.probe(proxyRoute(proxy), SCREEN_TIMEOUT_MS));
        } catch (err) {
          passed = false;
        }
        summary.screened++;
        if (passed) passers.push(proxy);
        else this._cooldown(proxy.id, 'screen_failed', SCREEN_FAIL_COOLDOWN_MS);
      }
    });
    await Promise.all(workers);
    return passers;
  }

  async _verifyPassers(passers, target, summary) {
    let index = 0;
    let claimed = 0;
    const workers = Array.from(
      { length: Math.min(this.verifyConcurrency, passers.length) },
      async () => {
        while (this.isEnabled() && this.verified.size + claimed < target) {
          const position = index++;
          if (position >= passers.length) return;
          const proxy = passers[position];
          if (this.verified.has(proxy.id)) continue;
          // Reserve a target slot before the slow probe sequence. Without this
          // reservation, parallel workers all see verified.size below target
          // and can overshoot the configured pool size.
          claimed++;
          const verdict = await this._verify(proxy);
          claimed--;
          if (!this.isEnabled()) continue;
          if (!verdict.ok) {
            this._cooldown(proxy.id, 'verify_failed', VERIFY_FAIL_COOLDOWN_MS);
            continue;
          }
          if (this.verified.has(proxy.id)) continue;
          this.verified.set(proxy.id, {
            proxy,
            latency: verdict.latency,
            verifiedAt: Date.now()
          });
          summary.verified++;
          const synced = this._syncEgress();
          summary.added += synced.added || 0;
          summary.removed += synced.removed || 0;
        }
      }
    );
    await Promise.all(workers);
  }

  async _verify(proxy) {
    const route = proxyRoute(proxy);
    const started = Date.now();
    for (let check = 0; check < VERIFY_CHECKS; check++) {
      let passed = false;
      try {
        passed = !!(await this.probe(route, VERIFY_TIMEOUT_MS));
      } catch (err) {
        passed = false;
      }
      if (!passed) return { ok: false, latency: 0 };
    }
    return { ok: true, latency: Math.round((Date.now() - started) / VERIFY_CHECKS) };
  }

  _syncEgress() {
    if (!this.egressManager || typeof this.egressManager.setAutoProxies !== 'function') {
      return { added: 0, removed: 0 };
    }
    // A refresh can still be in flight when an operator disables discovery.
    // Never repopulate the automatic pool after that toggle.
    const entries = this.isEnabled()
      ? [...this.verified.values()].map(entry => ({
        ...entry.proxy,
        latency: entry.latency
      }))
      : [];
    return this.egressManager.setAutoProxies(entries);
  }

  _pruneFailedAuto(summary) {
    if (!this.egressManager || typeof this.egressManager.getFailedAutoProxyIds !== 'function') return;
    const failed = this.egressManager.getFailedAutoProxyIds();
    if (!Array.isArray(failed) || failed.length === 0) return;
    const removed = typeof this.egressManager.removeAutoProxies === 'function'
      ? this.egressManager.removeAutoProxies(failed, 'health_failed')
      : 0;
    summary.removed += removed || 0;
    for (const id of failed) this.verified.delete(id);
  }

  _reconcile() {
    if (!this.egressManager || typeof this.egressManager.getAutoProxyIds !== 'function') return;
    const active = new Set(this.egressManager.getAutoProxyIds());
    for (const id of [...this.verified.keys()]) {
      if (active.has(id)) continue;
      this.verified.delete(id);
      if (!(this.egressManager.isManualProxy && this.egressManager.isManualProxy(id))) {
        this._cooldown(id, 'left_auto_pool', REMOVED_COOLDOWN_MS);
      }
    }
  }

  _handleAutoRemoved(ids, reason) {
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      this.verified.delete(id);
      if (this.egressManager.isManualProxy && this.egressManager.isManualProxy(id)) continue;
      this._cooldown(id, reason || 'removed', REMOVED_COOLDOWN_MS);
    }
  }

  _isKnown(id) {
    if (this.egressManager && typeof this.egressManager.isKnownProxy === 'function') {
      return this.egressManager.isKnownProxy(id);
    }
    return false;
  }

  _target() {
    if (!this.egressManager || typeof this.egressManager.getAutoCapacity !== 'function') {
      return this.target;
    }
    return Math.max(0, Math.min(this.target, this.egressManager.getAutoCapacity()));
  }

  _cooldown(id, reason, durationMs) {
    if (!id) return;
    this.cooldowns.set(id, { until: Date.now() + Math.max(1000, durationMs), reason: reason || 'cooldown' });
  }

  _onCooldown(id) {
    const record = this.cooldowns.get(id);
    if (!record) return false;
    if (record.until > Date.now()) return true;
    this.cooldowns.delete(id);
    return false;
  }

  _pruneCooldowns() {
    const now = Date.now();
    for (const [id, record] of this.cooldowns) {
      if (!record || record.until <= now) this.cooldowns.delete(id);
    }
  }

  _scheduleNext() {
    if (!this.started || !this.isEnabled()) {
      this.nextRefreshAt = 0;
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    let delay = this.intervalMs;
    if (this.verified.size === 0 && this.emptyRuns > 0) {
      delay = Math.min(this.intervalMs, EMPTY_RETRY_MS[Math.min(this.emptyRuns - 1, EMPTY_RETRY_MS.length - 1)]);
    }
    this.nextRefreshAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refreshNow();
    }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  getStatus() {
    const now = Date.now();
    let cooldownCount = 0;
    for (const record of this.cooldowns.values()) {
      if (record && record.until > now) cooldownCount++;
    }
    return {
      enabled: this.isEnabled(),
      running: this.running,
      intervalMinutes: Math.round(this.intervalMs / 60000),
      target: this._target(),
      configuredTarget: this.target,
      verifiedCount: this.verified.size,
      cooldownCount,
      lastRefreshAt: this.lastRefreshAt,
      lastRefreshStartedAt: this.lastRefreshStartedAt,
      nextRefreshAt: this.nextRefreshAt,
      lastDurationMs: this.lastDurationMs,
      lastError: this.lastError,
      lastSourceError: this.lastSourceError,
      sourcesTotal: this.sources.length,
      sourcesOk: this.sourceStatus.filter(source => source.ok).length,
      lastRun: { ...this.lastRun },
      sources: this.sourceStatus.map(source => ({ ...source }))
    };
  }
}

const manager = new ProxyDiscovery();

module.exports = manager;
module.exports.ProxyDiscovery = ProxyDiscovery;
module.exports._test = {
  DEFAULT_SOURCES,
  isPublicIp,
  isPublicIpv4,
  isPublicIpv6,
  parseCandidateLine,
  parseSourceText,
  proxyRoute
};
