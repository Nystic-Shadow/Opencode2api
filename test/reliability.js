const assert = require('assert');

console.log('🧪 Starting OpenCode2API Reliability Verification Suite...\n');

const config = require('../server/config');
const egress = require('../server/egress');
const proxyDiscoveryModule = require('../server/proxyDiscovery');
const requestQueue = require('../server/requestQueue');

const { ProxyDiscovery } = proxyDiscoveryModule;
const discoveryHelpers = proxyDiscoveryModule._test;

let passed = 0;
let failed = 0;

// Keep the process alive while awaiting queue timers. Without this, an
// unresolved promise with only unref'd timers makes Node exit 0 mid-suite.
const watchdog = setTimeout(() => {
  console.error('\n❌ Reliability suite timed out with unresolved work.');
  process.exit(1);
}, 30000);

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
  }
}

async function withConfig(patch, fn) {
  const saved = new Map();
  for (const key of Object.keys(patch)) {
    saved.set(key, Object.prototype.hasOwnProperty.call(config.config, key) ? config.config[key] : undefined);
    config.config[key] = patch[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete config.config[key];
      else config.config[key] = value;
    }
  }
}

function createFakeEgress(capacity = 40) {
  const state = { auto: new Map(), capacity };
  return {
    state,
    onAutoProxyRemoved() {},
    getFailedAutoProxyIds: () => [],
    removeAutoProxies: () => 0,
    getAutoProxyIds: () => [...state.auto.keys()],
    isManualProxy: () => false,
    isKnownProxy: id => state.auto.has(id),
    getAutoCapacity: () => state.capacity,
    setAutoProxies(entries) {
      const next = new Map();
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (next.size >= state.capacity) break;
        if (entry && entry.id) next.set(entry.id, entry);
      }
      const added = [...next.keys()].filter(id => !state.auto.has(id)).length;
      const removed = [...state.auto.keys()].filter(id => !next.has(id)).length;
      state.auto = next;
      return { added, removed };
    }
  };
}

async function main() {
  const helpers = egress._test;

  console.log('[Test 1] Proxy URL parsing');
  await test('parses HTTP proxy credentials and default ports', () => {
    const proxy = helpers.parseProxyUrl('http://user:p%40ss@proxy.example:8080');
    assert.strictEqual(proxy.type, 'http');
    assert.strictEqual(proxy.host, 'proxy.example');
    assert.strictEqual(proxy.port, 8080);
    assert.strictEqual(proxy.username, 'user');
    assert.strictEqual(proxy.password, 'p@ss');
    assert.strictEqual(proxy.url, 'http://proxy.example:8080');
    assert.match(proxy.id, /^http:\/\/proxy\.example:8080#[0-9a-f]{10}$/);
    assert.strictEqual(helpers.parseProxyUrl('proxy.example:3128').port, 3128);
    assert.strictEqual(helpers.parseProxyUrl('proxy.example:3128').type, 'http');
  });

  await test('keeps credential-only variants as distinct routes', () => {
    const first = helpers.parseProxyUrl('http://session-a:secret@gateway.example:7000');
    const second = helpers.parseProxyUrl('http://session-b:secret@gateway.example:7000');
    const repeat = helpers.parseProxyUrl('http://session-a:secret@gateway.example:7000');

    assert.strictEqual(first.url, second.url);
    assert.notStrictEqual(first.id, second.id);
    assert.strictEqual(first.id, repeat.id);
  });

  await test('normalizes SOCKS5 aliases and HTTPS defaults', () => {
    const socks = helpers.parseProxyUrl('socks5h://127.0.0.1');
    assert.strictEqual(socks.type, 'socks5');
    assert.strictEqual(socks.port, 1080);
    assert.strictEqual(socks.id, 'socks5://127.0.0.1:1080');

    const secure = helpers.parseProxyUrl('https://secure-proxy.example');
    assert.strictEqual(secure.type, 'https');
    assert.strictEqual(secure.port, 443);
  });

  await test('keeps IPv6 hosts bare for sockets and bracketed in IDs', () => {
    const socks = helpers.parseProxyUrl('socks5://[2001:db8::1]:1080');
    assert.strictEqual(socks.host, '2001:db8::1');
    assert.strictEqual(socks.port, 1080);
    assert.strictEqual(socks.id, 'socks5://[2001:db8::1]:1080');

    const loopback = helpers.parseProxyUrl('http://[::1]:8080');
    assert.strictEqual(loopback.host, '::1');
    assert.strictEqual(loopback.id, 'http://[::1]:8080');
  });

  await test('rejects malformed or unsupported proxy URLs', () => {
    assert.strictEqual(helpers.parseProxyUrl(''), null);
    assert.strictEqual(helpers.parseProxyUrl(null), null);
    assert.strictEqual(helpers.parseProxyUrl(42), null);
    assert.strictEqual(helpers.parseProxyUrl('ftp://proxy.example:21'), null);
    assert.strictEqual(helpers.parseProxyUrl('http://'), null);
    assert.strictEqual(helpers.parseProxyUrl('http://proxy.example:0'), null);
    assert.strictEqual(helpers.parseProxyUrl('http://user:%E0%A4%A@proxy.example:8080'), null);
    assert.strictEqual(helpers.parseProxyUrl(`socks5://${'u'.repeat(256)}:pass@proxy.example:1080`), null);
  });

  console.log('\n[Test 2] Proxy list parsing');
  await test('deduplicates configured proxies and skips invalid entries', async () => {
    await withConfig({
      proxies: [
        'http://proxy.example:8080',
        'http://proxy.example:8080',
        'socks5://127.0.0.1:1080',
        'ftp://bad.example:21'
      ]
    }, () => {
      const list = helpers.parseProxyList();
      assert.deepStrictEqual(list.map(p => p.id), [
        'http://proxy.example:8080',
        'socks5://127.0.0.1:1080'
      ]);
    });
  });

  await test('retains credential-only variants and accepts newline strings', async () => {
    await withConfig({
      proxies: [
        'http://session-a:pw@gateway.example:7000',
        'http://session-b:pw@gateway.example:7000',
        'http://session-a:pw@gateway.example:7000'
      ]
    }, () => {
      assert.strictEqual(helpers.parseProxyList().length, 2);
    });

    await withConfig({
      proxies: 'http://one.example:8080\nhttp://two.example:8080'
    }, () => {
      assert.deepStrictEqual(helpers.parseProxyList().map(p => p.url), [
        'http://one.example:8080',
        'http://two.example:8080'
      ]);
    });
  });

  await test('does not use ambient proxy environment variables', async () => {
    const saved = {
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      HTTP_PROXY: process.env.HTTP_PROXY,
      ALL_PROXY: process.env.ALL_PROXY
    };
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.ALL_PROXY;
    try {
      await withConfig({ proxies: [] }, () => {
        process.env.HTTPS_PROXY = 'http://env-proxy.example:9000';
        assert.deepStrictEqual(helpers.parseProxyList(), []);
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  console.log('\n[Test 3] Retry-After parsing');
  await test('parses seconds, HTTP dates, and invalid values', () => {
    assert.strictEqual(helpers.parseRetryAfter('2'), 2000);
    assert.strictEqual(helpers.parseRetryAfter(0), 0);
    assert.strictEqual(helpers.parseRetryAfter(''), 0);
    assert.strictEqual(helpers.parseRetryAfter(null), 0);
    assert.strictEqual(helpers.parseRetryAfter('not-a-date'), 0);
    assert.strictEqual(helpers.parseRetryAfter('-3'), 0);

    const remaining = helpers.parseRetryAfter(new Date(Date.now() + 5000).toUTCString());
    assert.ok(remaining > 2500 && remaining <= 6000, `unexpected remaining value: ${remaining}`);
  });

  console.log('\n[Test 4] Upstream failure classification');
  await test('distinguishes quota, retryable, and fatal failures', () => {
    assert.strictEqual(helpers.classifyUpstreamFailure(429, ''), 'quota');
    assert.strictEqual(helpers.classifyUpstreamFailure(403, 'FreeTierError: free usage exceeded'), 'quota');
    assert.strictEqual(helpers.classifyUpstreamFailure(403, 'rate limit reached'), 'quota');
    assert.strictEqual(helpers.classifyUpstreamFailure(403, 'OpenCode Zen models can only be used with the OpenCode CLI'), 'fatal');
    assert.strictEqual(helpers.classifyUpstreamFailure(401, 'unauthorized'), 'fatal');
    assert.strictEqual(helpers.classifyUpstreamFailure(400, 'bad request'), 'fatal');
    assert.strictEqual(helpers.classifyUpstreamFailure(500, ''), 'retry');
    assert.strictEqual(helpers.classifyUpstreamFailure(503, 'maintenance'), 'retry');
    assert.strictEqual(helpers.classifyUpstreamFailure(0, 'ECONNRESET'), 'retry');
    assert.strictEqual(helpers.classifyUpstreamFailure(418, 'teapot'), 'fatal');
  });

  console.log('\n[Test 5] SOCKS5 CONNECT response parsing');
  await test('handles IPv4, IPv6, domain, rejection, and partial frames', () => {
    const ipv4 = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90]);
    assert.deepStrictEqual(helpers.parseSocks5ConnectResponse(ipv4), { consumed: 10 });

    const ipv6 = Buffer.concat([
      Buffer.from([0x05, 0x00, 0x00, 0x04]),
      Buffer.alloc(16, 1),
      Buffer.from([0x01, 0xbb])
    ]);
    assert.deepStrictEqual(helpers.parseSocks5ConnectResponse(ipv6), { consumed: 22 });

    const host = Buffer.from('example.com');
    const domain = Buffer.concat([
      Buffer.from([0x05, 0x00, 0x00, 0x03, host.length]),
      host,
      Buffer.from([0x01, 0xbb])
    ]);
    assert.deepStrictEqual(helpers.parseSocks5ConnectResponse(domain), { consumed: 18 });

    assert.match(helpers.parseSocks5ConnectResponse(Buffer.from([0x05, 0x05, 0x00, 0x01])).error, /code 5/);
    assert.match(helpers.parseSocks5ConnectResponse(Buffer.from([0x04, 0x00, 0x00, 0x01])).error, /invalid version/);
    assert.strictEqual(helpers.parseSocks5ConnectResponse(Buffer.from([0x05, 0x00, 0x00, 0x01, 1, 2])), null);
    assert.strictEqual(helpers.parseSocks5ConnectResponse(null), null);
  });

  console.log('\n[Test 6] Route health and quota cooldown');
  await test('quota cooldown does not make a route unavailable', () => {
    const route = { type: 'proxy', id: 'test://quota-route' };
    egress.recordSuccess(route);
    assert.strictEqual(egress.getQuotaRetryAfter(route), 0);
    assert.strictEqual(egress.isAvailable(route), true);

    egress.recordFailure(route, 'quota', 60000);
    const remaining = egress.getQuotaRetryAfter(route);
    assert.ok(remaining > 50000 && remaining <= 60000, `unexpected quota cooldown: ${remaining}`);
    assert.strictEqual(egress.isAvailable(route), true, 'quota must not remove the route from readiness');

    egress.recordSuccess(route);
    assert.strictEqual(egress.getQuotaRetryAfter(route), 0);
  });

  await test('quota cooldown always has a minimum delay', () => {
    const route = { type: 'proxy', id: 'test://quota-min-route' };
    egress.recordFailure(route, 'quota', 0);
    assert.ok(egress.getQuotaRetryAfter(route) > 0);
    egress.recordSuccess(route);
  });

  await test('resetRoute clears stale quota and notifies listeners', () => {
    const route = { type: 'proxy', id: 'test://reset-route' };
    let notified = null;
    egress.onRouteReset(id => { notified = id; });
    egress.recordFailure(route, 'quota', 60000);
    assert.ok(egress.getQuotaRetryAfter(route) > 0);
    egress.resetRoute(route, 'test');
    assert.strictEqual(egress.getQuotaRetryAfter(route), 0);
    assert.strictEqual(notified, 'test://reset-route');
  });

  await test('three retryable failures open the circuit and success closes it', () => {
    const route = { type: 'proxy', id: 'test://retry-route' };
    egress.recordFailure(route, 'retry');
    egress.recordFailure(route, 'retry');
    assert.strictEqual(egress.isAvailable(route), true);
    egress.recordFailure(route, 'retry');
    assert.strictEqual(egress.isAvailable(route), false);
    egress.recordSuccess(route);
    assert.strictEqual(egress.isAvailable(route), true);
  });

  await test('proxy transport failure opens the circuit immediately and backs off', () => {
    const route = { type: 'proxy', id: 'test://proxy-down-route' };
    egress.recordSuccess(route);
    egress.recordFailure(route, 'proxy_down');
    const first = egress._health(route).openUntil - Date.now();
    assert.ok(first > 25000 && first <= 31000, `unexpected first backoff: ${first}`);
    assert.strictEqual(egress.isAvailable(route), false);

    egress.recordFailure(route, 'proxy_down');
    const second = egress._health(route).openUntil - Date.now();
    assert.ok(second > 55000 && second <= 61000, `unexpected second backoff: ${second}`);
    egress.recordSuccess(route);
    assert.strictEqual(egress.isAvailable(route), true);
  });

  await test('clamps the background check interval and schedules the next sweep', async () => {
    await withConfig({ proxy_check_interval_minutes: 0 }, () => {
      assert.strictEqual(egress._checkIntervalMs(), 60 * 1000);
    });
    await withConfig({ proxy_check_interval_minutes: 9999 }, () => {
      assert.strictEqual(egress._checkIntervalMs(), 1440 * 60 * 1000);
    });
    await withConfig({ proxy_check_interval_minutes: 30 }, () => {
      assert.strictEqual(egress._checkIntervalMs(), 30 * 60 * 1000);
    });
    await withConfig({ proxy_check_interval_minutes: 1 }, () => {
      egress.stopHealthChecks();
      egress.proxyChecksEnabled = true;
      egress._scheduleNextCheck();
      assert.ok(egress.nextCheckAt > Date.now(), 'next sweep was not scheduled');
      assert.ok(egress.nextCheckAt <= Date.now() + 61 * 1000, 'next sweep exceeds the configured interval');
      egress.stopHealthChecks();
      assert.strictEqual(egress.nextCheckAt, 0);
    });
  });

  await test('fatal failures are recorded without opening the circuit', () => {
    const route = { type: 'proxy', id: 'test://fatal-route' };
    egress.recordFailure(route, 'fatal');
    assert.strictEqual(egress.isAvailable(route), true);
    assert.strictEqual(egress._health(route).lastError, 'fatal');
    egress.recordSuccess(route);
  });

  console.log('\n[Test 7] Egress candidate selection');
  await test('keeps configured proxies and never direct when fallback is disabled', async () => {
    await withConfig({
      proxies: ['http://user:pass@proxy-a.example:8080', 'socks5://proxy-b.example:1080'],
      egress_mode: 'auto',
      allow_direct_fallback: false
    }, () => {
      egress.reload();
      const routes = egress.getCandidates();
      assert.deepStrictEqual(routes.map(r => r.url), [
        'http://proxy-a.example:8080',
        'socks5://proxy-b.example:1080'
      ]);
      assert.strictEqual(new Set(routes.map(r => r.id)).size, 2);
      assert.ok(!routes.some(r => r.type === 'direct'));
    });
    egress.reload();
  });

  await test('includes direct last in auto mode only when explicitly allowed', async () => {
    await withConfig({
      proxies: ['http://proxy-a.example:8080'],
      egress_mode: 'auto',
      allow_direct_fallback: true
    }, () => {
      egress.reload();
      const routes = egress.getCandidates();
      assert.deepStrictEqual(routes.map(r => r.id), [
        'http://proxy-a.example:8080',
        'direct'
      ]);
    });
    egress.reload();
  });

  await test('keeps a quota-limited route in the candidate list', async () => {
    await withConfig({ egress_mode: 'direct', allow_direct_fallback: true }, () => {
      egress.reload();
      const direct = { type: 'direct', id: 'direct' };
      egress.recordFailure(direct, 'quota', 5000);
      assert.deepStrictEqual(egress.getCandidates().map(r => r.id), ['direct']);
      egress.recordSuccess(direct);
    });
    egress.reload();
  });

  await test('proxy_only mode never includes direct egress', async () => {
    await withConfig({
      proxies: ['http://proxy-only.example:8080'],
      egress_mode: 'proxy_only',
      allow_direct_fallback: true
    }, () => {
      egress.reload();
      const routes = egress.getCandidates();
      assert.deepStrictEqual(routes.map(r => r.id), ['http://proxy-only.example:8080']);
    });
    egress.reload();
  });

  console.log('\n[Test 8] Round-robin and quota failover');
  await test('round-robins across routable proxy routes', async () => {
    await withConfig({
      proxies: ['http://rr-a.example:8080', 'http://rr-b.example:8080', 'http://rr-c.example:8080'],
      egress_mode: 'proxy_only',
      allow_direct_fallback: false
    }, () => {
      egress.reload();
      egress.routeCursor = 0;
      const order = [];
      for (let i = 0; i < 6; i++) order.push(egress.selectRoute().id);
      assert.deepStrictEqual(order, [
        'http://rr-a.example:8080',
        'http://rr-b.example:8080',
        'http://rr-c.example:8080',
        'http://rr-a.example:8080',
        'http://rr-b.example:8080',
        'http://rr-c.example:8080'
      ]);
    });
    egress.reload();
  });

  await test('skips quota-cooling routes and reports the earliest retry', async () => {
    await withConfig({
      proxies: ['http://quota-a.example:8080', 'http://quota-b.example:8080'],
      egress_mode: 'proxy_only',
      allow_direct_fallback: false
    }, () => {
      egress.reload();
      const routeA = { type: 'proxy', id: 'http://quota-a.example:8080' };
      const routeB = { type: 'proxy', id: 'http://quota-b.example:8080' };
      egress.recordFailure(routeA, 'quota', 30000);
      egress.recordFailure(routeB, 'quota', 5000);

      assert.strictEqual(egress.selectRoute(), null);
      const earliest = egress.getEarliestQuotaRetryAfter();
      assert.ok(earliest > 3000 && earliest <= 5000, `unexpected earliest retry: ${earliest}`);

      egress.recordSuccess(routeA);
      assert.deepStrictEqual(egress.getRoutableRoutes().map(r => r.id), [routeA.id]);
      egress.recordSuccess(routeB);
    });
    egress.reload();
  });

  await test('uses direct only when no proxy route is routable', async () => {
    await withConfig({
      proxies: ['http://direct-pref.example:8080'],
      egress_mode: 'auto',
      allow_direct_fallback: true
    }, () => {
      egress.reload();
      egress.routeCursor = 0;
      assert.deepStrictEqual(egress.getRoutableRoutes().map(r => r.id), ['http://direct-pref.example:8080']);

      egress.recordFailure({ type: 'proxy', id: 'http://direct-pref.example:8080' }, 'quota', 30000);
      assert.deepStrictEqual(egress.getRoutableRoutes().map(r => r.id), ['direct']);
    });
    egress.reload();
  });

  await test('prefers verified proxies but fails over to unchecked ones', async () => {
    await withConfig({
      proxies: ['http://verified.example:8080', 'http://unchecked.example:8080'],
      egress_mode: 'proxy_only',
      allow_direct_fallback: false
    }, () => {
      egress.reload();
      egress.proxyChecks.set('http://verified.example:8080', {
        healthy: true, passes: 5, checks: 5, latency: 10, lastCheck: Date.now(), error: ''
      });
      assert.deepStrictEqual(egress.getRoutableRoutes().map(r => r.id), ['http://verified.example:8080']);

      const attempted = new Set(['http://verified.example:8080']);
      const next = egress.getNextRoutableRoute(attempted);
      assert.ok(next, 'expected an unchecked proxy fallback');
      assert.strictEqual(next.id, 'http://unchecked.example:8080');
    });
    egress.reload();
  });

  await test('health-check failures quarantine and successes verify', async () => {
    await withConfig({ proxies: ['http://health.example:8080'] }, async () => {
      egress.reload();
      const proxy = egress.proxies[0];
      const route = { type: 'proxy', proxyType: 'http', id: proxy.id };
      const originalProbe = egress.probeProxy;
      try {
        egress.probeProxy = async () => false;
        await egress.checkProxy(proxy);
        const failed = egress.proxyChecks.get(proxy.id);
        assert.strictEqual(failed.healthy, false);
        assert.strictEqual(failed.passes, 0);
        assert.strictEqual(egress.isAvailable(route), false);
        assert.match(egress._health(route).lastError, /health check failed/i);

        // A failed sweep must keep the route out of rotation even after the
        // legacy five-minute quarantine timer would have expired.
        egress._health(route).openUntil = Date.now() - 1;
        assert.strictEqual(egress.isAvailable(route), false);
        assert.strictEqual(egress.getProxyStatus().failedCount, 1);

        egress.probeProxy = async () => true;
        await egress.checkProxy(proxy);
        const passed = egress.proxyChecks.get(proxy.id);
        assert.strictEqual(passed.healthy, true);
        assert.strictEqual(passed.passes, 5);
        assert.strictEqual(egress.isAvailable(route), true);
        assert.strictEqual(egress.getProxyStatus().failedCount, 0);
      } finally {
        egress.probeProxy = originalProbe;
        egress.resetRoute(route, 'test');
        egress.proxyChecks.delete(proxy.id);
      }
    });
    egress.reload();
  });

  await test('manual prune removes only failed entries', async () => {
    await withConfig({
      proxies: ['http://prune-a.example:8080', 'http://prune-b.example:8080'],
      proxy_auto_prune_dead: false
    }, () => {
      egress.reload();
      const failedRoute = egress.getCandidates()[0];
      egress.proxyChecks.set(failedRoute.id, {
        healthy: false, passes: 0, checks: 5, latency: 0, lastCheck: Date.now(), error: 'test failure'
      });
      egress._health(failedRoute).checkFailed = true;

      const originalUpdate = config.update;
      let update = null;
      config.update = (values) => {
        update = values;
        config.config = { ...config.config, ...values };
      };
      try {
        const result = egress.pruneFailed();
        assert.strictEqual(result.removed, 1);
        assert.ok(Array.isArray(update.proxies));
        assert.strictEqual(update.proxies.length, 1);
        assert.strictEqual(update.proxies[0], 'http://prune-b.example:8080');
      } finally {
        config.update = originalUpdate;
      }
    });
    egress.reload();
  });

  await test('auto-prune removes dead entries but keeps one for recovery', async () => {
    await withConfig({
      proxies: ['http://auto-a.example:8080', 'http://auto-b.example:8080'],
      proxy_auto_prune_dead: true
    }, async () => {
      egress.reload();
      for (const proxy of egress.proxies) {
        egress.proxyChecks.set(proxy.id, {
          healthy: false, passes: 0, checks: 5, latency: 0, lastCheck: Date.now(), error: 'dead'
        });
        const health = egress._health({ ...proxy, type: 'proxy', proxyType: proxy.type, id: proxy.id });
        health.checkFailures = 2;
        health.checkFailed = true;
      }

      const originalUpdate = config.update;
      const updates = [];
      config.update = (values) => {
        updates.push(values);
        config.config = { ...config.config, ...values };
      };
      try {
        const removed = await egress._pruneDeadProxies();
        assert.strictEqual(removed, 1);
        assert.strictEqual(updates.length, 1);
        // Config order is preserved and the last entry is retained.
        assert.deepStrictEqual(updates[0].proxies, ['http://auto-b.example:8080']);
      } finally {
        config.update = originalUpdate;
      }
    });
    egress.reload();
  });

  console.log('\n[Test 9] Automatic proxy discovery');
  await test('parses list formats and rejects private or reserved targets', () => {
    const parse = discoveryHelpers.parseCandidateLine;

    const http = parse('8.8.8.8:3128#US', 'http');
    assert.strictEqual(http.proxy.id, 'http://8.8.8.8:3128');
    assert.strictEqual(parse('2.2.2.2:3128,US', 'http').proxy.id, 'http://2.2.2.2:3128');
    const socks = parse('socks5://1.1.1.1:1080', 'socks5');
    assert.strictEqual(socks.proxy.id, 'socks5://1.1.1.1:1080');
    const ipv6 = parse('[2001:4860:4860::8888]:443', 'http');
    assert.strictEqual(ipv6.proxy.host, '2001:4860:4860::8888');

    for (const value of ['10.0.0.1:80', '127.0.0.1:80', '100.64.0.1:80', '169.254.1.1:80', '192.168.1.1:80', '172.16.0.1:80']) {
      assert.strictEqual(parse(value, 'http').reason, 'private', `${value} must be rejected`);
    }
    assert.strictEqual(parse('http://:8080', 'http').reason, 'invalid');
    assert.strictEqual(parse('[fd00::1]:80', 'http').reason, 'private');
    assert.strictEqual(parse('[::1]:80', 'http').reason, 'private');

    assert.strictEqual(discoveryHelpers.isPublicIp('8.8.8.8'), true);
    assert.strictEqual(discoveryHelpers.isPublicIp('100.64.0.1'), false);
    assert.strictEqual(discoveryHelpers.isPublicIp('2001:4860:4860::8888'), true);
    assert.strictEqual(discoveryHelpers.isPublicIp('fd00::1'), false);

    const parsed = discoveryHelpers.parseSourceText(
      '# comment\n1.1.1.1:80\n1.1.1.1:80\n10.0.0.1:80\nhttp://:8080\n2.2.2.2:3128,US\n',
      'http',
      10
    );
    assert.deepStrictEqual(parsed.proxies.map(proxy => proxy.id), [
      'http://1.1.1.1:80',
      'http://2.2.2.2:3128'
    ]);
    assert.strictEqual(parsed.rejectedPrivate, 1);
    assert.strictEqual(parsed.rejectedInvalid, 2);
  });

  await test('adds only routes that pass screening plus five verification probes', async () => {
    const fake = createFakeEgress(40);
    let probeCalls = 0;
    const discovery = new ProxyDiscovery({
      egressManager: fake,
      cfg: { get: key => key === 'auto_proxy_discovery' ? true : undefined },
      fetchText: async () => '1.1.1.1:80\n8.8.8.8:8080\n9.9.9.9:3128\n',
      probe: async () => { probeCalls++; return true; },
      sources: [{ name: 'mock', protocol: 'http', url: 'mock://list', maxLines: 10 }],
      target: 1,
      intervalMs: 60000,
      verbose: false
    });

    await discovery.refreshNow();
    const status = discovery.getStatus();
    assert.strictEqual(status.verifiedCount, 1);
    assert.strictEqual(fake.state.auto.size, 1);
    assert.ok(probeCalls >= 6, `expected a screen probe plus five verification probes, got ${probeCalls}`);
  });

  await test('cools a candidate that fails any verification probe and skips it', async () => {
    const fake = createFakeEgress(40);
    const verdicts = [true, true, true, true, true, false];
    let probeCalls = 0;
    const discovery = new ProxyDiscovery({
      egressManager: fake,
      cfg: { get: key => key === 'auto_proxy_discovery' ? true : undefined },
      fetchText: async () => '1.1.1.1:80\n',
      probe: async () => verdicts[probeCalls++] === true,
      sources: [{ name: 'mock', protocol: 'http', url: 'mock://list', maxLines: 10 }],
      target: 1,
      intervalMs: 60000,
      verbose: false
    });

    await discovery.refreshNow();
    assert.strictEqual(discovery.getStatus().verifiedCount, 0);
    assert.strictEqual(fake.state.auto.size, 0);
    assert.strictEqual(discovery.getStatus().cooldownCount, 1);

    await discovery.refreshNow();
    assert.strictEqual(discovery.getStatus().lastRun.candidatesSeen, 0);
  });

  await test('respects automatic capacity and records source failures', async () => {
    const fake = createFakeEgress(1);
    const discovery = new ProxyDiscovery({
      egressManager: fake,
      cfg: { get: key => key === 'auto_proxy_discovery' ? true : undefined },
      fetchText: async () => '1.1.1.1:80\n8.8.8.8:8080\n9.9.9.9:3128\n',
      probe: async () => true,
      sources: [{ name: 'mock', protocol: 'http', url: 'mock://list', maxLines: 10 }],
      target: 20,
      intervalMs: 60000,
      verbose: false
    });
    await discovery.refreshNow();
    assert.strictEqual(discovery.getStatus().target, 1);
    assert.strictEqual(discovery.getStatus().verifiedCount, 1);
    assert.strictEqual(fake.state.auto.size, 1);

    const failing = new ProxyDiscovery({
      egressManager: createFakeEgress(40),
      cfg: { get: key => key === 'auto_proxy_discovery' ? true : undefined },
      fetchText: async () => { throw new Error('source offline'); },
      probe: async () => true,
      sources: [{ name: 'mock', protocol: 'http', url: 'mock://list', maxLines: 10 }],
      target: 1,
      intervalMs: 60000,
      verbose: false
    });
    await failing.refreshNow();
    assert.strictEqual(failing.getStatus().sourcesOk, 0);
    assert.match(failing.getStatus().lastError, /source offline/);
  });

  await test('stops refilling the pool when discovery is disabled mid-run', async () => {
    let enabled = true;
    const listeners = [];
    const fake = createFakeEgress(40);
    const discovery = new ProxyDiscovery({
      egressManager: fake,
      cfg: {
        get: key => key === 'auto_proxy_discovery' ? enabled : undefined,
        onChange: fn => listeners.push(fn)
      },
      fetchText: async () => '1.1.1.1:80\n8.8.8.8:8080\n9.9.9.9:3128\n',
      probe: async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
        return true;
      },
      sources: [{ name: 'mock', protocol: 'http', url: 'mock://list', maxLines: 10 }],
      target: 3,
      intervalMs: 60000,
      verbose: false
    });

    discovery.start();
    const run = discovery.promise;
    await new Promise(resolve => setTimeout(resolve, 10));
    enabled = false;
    for (const listener of listeners) listener();
    await run;

    assert.strictEqual(discovery.getStatus().verifiedCount, 0);
    assert.strictEqual(fake.state.auto.size, 0);
    assert.strictEqual(discovery.getStatus().enabled, false);
  });

  console.log('\n[Test 10] Manual and automatic pool merging');
  await test('merges automatic routes, keeps manual precedence, and seeds 5/5 health', async () => {
    await withConfig({
      proxies: ['http://manual-a.example:8080'],
      egress_mode: 'proxy_only',
      allow_direct_fallback: false
    }, () => {
      egress.setAutoProxies([]);
      egress.reload();
      const result = egress.setAutoProxies([
        { id: 'http://auto-a.example:8080', url: 'http://auto-a.example:8080', latency: 123 },
        { id: 'http://manual-a.example:8080', url: 'http://manual-a.example:8080' },
        { id: 'http://auto-b.example:8080', url: 'http://auto-b.example:8080', latency: 200 }
      ]);

      const status = egress.getProxyStatus();
      assert.strictEqual(result.added, 2);
      assert.strictEqual(status.manualCount, 1);
      assert.strictEqual(status.autoCount, 2);
      assert.deepStrictEqual(status.proxies.map(entry => entry.endpoint), [
        'http://manual-a.example:8080',
        'http://auto-a.example:8080',
        'http://auto-b.example:8080'
      ]);
      assert.deepStrictEqual(status.proxies.map(entry => entry.source), ['manual', 'auto', 'auto']);
      const auto = status.proxies.find(entry => entry.endpoint === 'http://auto-a.example:8080');
      assert.strictEqual(auto.passes, 5);
      assert.strictEqual(auto.checks, 5);
      assert.strictEqual(auto.healthy, true);
      assert.strictEqual(egress.getCandidates().length, 3);

      egress.setAutoProxies([]);
      assert.strictEqual(egress.getProxyStatus().manualCount, 1);
      assert.strictEqual(egress.getProxyStatus().autoCount, 0);
    });
    egress.reload();
  });

  await test('caps automatic routes below the total pool limit', async () => {
    await withConfig({
      proxies: ['http://manual-a.example:8080', 'http://manual-b.example:8080'],
      egress_mode: 'proxy_only'
    }, () => {
      egress.reload();
      const original = egress.maxAutoPool;
      egress.maxAutoPool = 2;
      try {
        assert.strictEqual(egress.getAutoCapacity(), 2);
        egress.setAutoProxies([
          { id: 'http://auto-a.example:8080', url: 'http://auto-a.example:8080' },
          { id: 'http://auto-b.example:8080', url: 'http://auto-b.example:8080' },
          { id: 'http://auto-c.example:8080', url: 'http://auto-c.example:8080' }
        ]);
        const status = egress.getProxyStatus();
        assert.strictEqual(status.manualCount, 2);
        assert.strictEqual(status.autoCount, 2);
        assert.strictEqual(status.configuredCount, 4);
      } finally {
        egress.maxAutoPool = original;
        egress.setAutoProxies([]);
      }
    });
    egress.reload();
  });

  await test('prunes automatic routes after two failed sweeps without touching manual routes', async () => {
    await withConfig({
      proxies: ['http://manual-a.example:8080', 'http://manual-b.example:8080'],
      proxy_auto_prune_dead: true
    }, async () => {
      egress.reload();
      egress.setAutoProxies([
        { id: 'http://auto-a.example:8080', url: 'http://auto-a.example:8080' },
        { id: 'http://auto-b.example:8080', url: 'http://auto-b.example:8080' }
      ]);
      const route = { type: 'proxy', proxyType: 'http', id: 'http://auto-a.example:8080' };
      egress.proxyChecks.set(route.id, {
        healthy: false, passes: 0, checks: 5, latency: 0, lastCheck: Date.now(), error: 'dead'
      });
      const health = egress._health(route);
      health.checkFailures = 1;
      health.checkFailed = true;
      assert.deepStrictEqual(egress.getFailedAutoProxyIds(), [], 'one failed sweep must not be pruned');
      health.checkFailures = 2;
      assert.deepStrictEqual(egress.getFailedAutoProxyIds(), [route.id]);

      const originalUpdate = config.update;
      let updates = 0;
      config.update = (values) => {
        updates++;
        config.config = { ...config.config, ...values };
      };
      try {
        const removed = await egress._pruneDeadProxies();
        assert.strictEqual(removed, 1);
        assert.strictEqual(updates, 0, 'pruning an automatic route must not rewrite manual config');
        const status = egress.getProxyStatus();
        assert.strictEqual(status.manualCount, 2);
        assert.strictEqual(status.autoCount, 1);
      } finally {
        config.update = originalUpdate;
        egress.setAutoProxies([]);
      }
    });
    egress.reload();
  });

  console.log('\n[Test 11] Bounded admission queue');
  await test('enforces global concurrency and makes release idempotent', async () => {
    await withConfig({ queue_max_concurrent: 1, queue_max_per_key: 1, queue_max_size: 1, queue_wait_ms: 30 }, async () => {
      const queue = new requestQueue.RequestQueue();
      const release = await queue.acquire('a', 0);
      assert.strictEqual(typeof release, 'function');
      assert.strictEqual(queue.getStats().active, 1);

      const keepAlive = setTimeout(() => {}, 500);
      const denied = await queue.acquire('b', 20);
      clearTimeout(keepAlive);
      assert.strictEqual(denied, null);

      release();
      assert.strictEqual(queue.getStats().active, 0);
      release();
      assert.strictEqual(queue.getStats().active, 0);
    });
  });

  await test('drains a waiter when a slot is released', async () => {
    await withConfig({ queue_max_concurrent: 1, queue_max_per_key: 1, queue_max_size: 4, queue_wait_ms: 500 }, async () => {
      const queue = new requestQueue.RequestQueue();
      const first = await queue.acquire('a', 0);
      let second = null;
      const pending = queue.acquire('b', 500).then(release => { second = release; });
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.strictEqual(queue.getStats().queued, 1);

      first();
      await pending;
      assert.strictEqual(typeof second, 'function');
      assert.strictEqual(queue.getStats().active, 1);
      second();
      assert.strictEqual(queue.getStats().active, 0);
    });
  });

  await test('times out queued waiters and removes them', async () => {
    await withConfig({ queue_max_concurrent: 1, queue_max_per_key: 1, queue_max_size: 4, queue_wait_ms: 30 }, async () => {
      const queue = new requestQueue.RequestQueue();
      const release = await queue.acquire('a', 0);
      const keepAlive = setTimeout(() => {}, 500);
      const started = Date.now();
      const denied = await queue.acquire('b', 30);
      clearTimeout(keepAlive);
      const elapsed = Date.now() - started;

      assert.strictEqual(denied, null);
      assert.ok(elapsed >= 20, `wait timeout fired too early: ${elapsed}ms`);
      assert.strictEqual(queue.getStats().queued, 0);
      release();
    });
  });

  await test('enforces per-key concurrency while allowing other keys', async () => {
    await withConfig({ queue_max_concurrent: 4, queue_max_per_key: 1, queue_max_size: 4, queue_wait_ms: 20 }, async () => {
      const queue = new requestQueue.RequestQueue();
      const sameFirst = await queue.acquire('same', 0);
      const keepAlive = setTimeout(() => {}, 500);
      const sameDenied = await queue.acquire('same', 20);
      const other = await queue.acquire('other', 0);
      clearTimeout(keepAlive);

      assert.strictEqual(sameDenied, null);
      assert.strictEqual(typeof other, 'function');
      assert.strictEqual(queue.getStats().active, 2);
      sameFirst();
      other();
      assert.strictEqual(queue.getStats().active, 0);
    });
  });

  await test('rejects immediately when the queue is full', async () => {
    await withConfig({ queue_max_concurrent: 1, queue_max_per_key: 1, queue_max_size: 0, queue_wait_ms: 1000 }, async () => {
      const queue = new requestQueue.RequestQueue();
      const release = await queue.acquire('a', 0);
      const denied = await queue.acquire('b', 1000);
      assert.strictEqual(denied, null);
      assert.strictEqual(queue.getStats().queued, 0);
      release();
    });
  });

  console.log(`\n${failed === 0 ? '🎉' : '❌'} Reliability suite finished: ${passed} passed, ${failed} failed.\n`);
  clearTimeout(watchdog);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥 Reliability suite crashed:', err);
  process.exit(1);
});
