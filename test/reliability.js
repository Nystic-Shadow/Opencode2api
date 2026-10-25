const assert = require('assert');

console.log('🧪 Starting OpenCode2API Reliability Verification Suite...\n');

const config = require('../server/config');
const egress = require('../server/egress');
const requestQueue = require('../server/requestQueue');

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

async function main() {
  const helpers = egress._test;

  console.log('[Test 1] Proxy URL parsing');
  await test('parses HTTP proxy credentials and default ports', () => {
    const proxy = helpers.parseProxyUrl('http://user:p%40ss@proxy.example:8080');
    assert.deepStrictEqual(proxy, {
      type: 'http',
      host: 'proxy.example',
      port: 8080,
      username: 'user',
      password: 'p@ss',
      url: 'http://proxy.example:8080',
      id: 'http://proxy.example:8080'
    });
    assert.strictEqual(helpers.parseProxyUrl('proxy.example:3128').port, 3128);
    assert.strictEqual(helpers.parseProxyUrl('proxy.example:3128').type, 'http');
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

  await test('rejects malformed or unsupported proxy URLs', () => {
    assert.strictEqual(helpers.parseProxyUrl(''), null);
    assert.strictEqual(helpers.parseProxyUrl(null), null);
    assert.strictEqual(helpers.parseProxyUrl(42), null);
    assert.strictEqual(helpers.parseProxyUrl('ftp://proxy.example:21'), null);
    assert.strictEqual(helpers.parseProxyUrl('http://'), null);
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

  await test('falls back to standard proxy environment variables', async () => {
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
        const list = helpers.parseProxyList();
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].id, 'http://env-proxy.example:9000');
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

  await test('fatal failures are recorded without opening the circuit', () => {
    const route = { type: 'proxy', id: 'test://fatal-route' };
    egress.recordFailure(route, 'fatal');
    assert.strictEqual(egress.isAvailable(route), true);
    assert.strictEqual(egress._health(route).lastError, 'fatal');
    egress.recordSuccess(route);
  });

  console.log('\n[Test 7] Egress candidate selection');
  await test('uses configured proxies in order and never direct when fallback is disabled', async () => {
    await withConfig({
      proxies: ['http://user:pass@proxy-a.example:8080', 'socks5://proxy-b.example:1080'],
      egress_mode: 'auto',
      allow_direct_fallback: false
    }, () => {
      egress.reload();
      const routes = egress.getCandidates();
      assert.deepStrictEqual(routes.map(r => r.id), [
        'http://proxy-a.example:8080',
        'socks5://proxy-b.example:1080'
      ]);
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

  console.log('\n[Test 8] Bounded admission queue');
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
