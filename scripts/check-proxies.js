#!/usr/bin/env node
/**
 * Verify the configured egress proxy pool.
 *
 * Every proxy must survive 5 sequential CONNECT + TLS probes to the configured
 * upstream host, with a 5-second timeout per probe. A proxy that fails a sweep
 * is kept out of rotation by the gateway until a later sweep passes. This CLI
 * is read-only: it never prunes or rewrites the configured pool.
 *
 * Usage: npm run check:proxies
 */
process.env.O2P_CONFIG_READONLY = '1';
const config = require('../server/config');
const egress = require('../server/egress');

async function main() {
  const configured = config.get('proxies');
  const proxies = Array.isArray(configured)
    ? configured
    : (typeof configured === 'string' ? configured.split(/[\n,]/).map(value => value.trim()).filter(Boolean) : []);
  if (proxies.length === 0) {
    console.error('No proxies configured.');
    console.error('Set PROXIES in .env, for example:');
    console.error('  PROXIES=http://user:pass@proxy.example:8080,socks5://proxy.example:1080');
    process.exitCode = 1;
    return;
  }

  const target = config.get('upstream_inference_url') || 'https://opencode.ai';
  console.log(`Checking ${proxies.length} prox${proxies.length === 1 ? 'y' : 'ies'} against ${target}`);
  console.log('Policy: 5 sequential probes per proxy, 5s timeout per probe.\n');

  const started = Date.now();
  await egress.runProxyChecks();

  const status = egress.getProxyStatus();
  const rows = status.proxies.map(proxy => ({
    endpoint: proxy.endpoint,
    result: proxy.healthy === true ? 'PASS' : 'FAIL',
    probes: `${proxy.passes}/${proxy.checks}`,
    latency: proxy.latency ? `${proxy.latency}ms` : '-',
    error: proxy.healthy === true ? '' : (proxy.lastError || 'unreachable')
  }));

  const endpointWidth = Math.max(
    'ENDPOINT'.length,
    ...rows.map(row => row.endpoint.length)
  );

  console.log(`${'ENDPOINT'.padEnd(endpointWidth)}  RESULT  PROBES  LATENCY  ERROR`);
  for (const row of rows) {
    console.log(
      `${row.endpoint.padEnd(endpointWidth)}  ${row.result.padEnd(6)}  ` +
      `${row.probes.padEnd(6)}  ${row.latency.padEnd(7)}  ${row.error}`
    );
  }

  const healthy = status.proxies.filter(proxy => proxy.healthy === true).length;
  const routable = status.proxies.filter(proxy => proxy.routable).length;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log('');
  console.log(
    `Healthy: ${healthy}/${status.configuredCount}  ` +
    `Routable: ${routable}  Elapsed: ${elapsed}s`
  );

  if (healthy === 0) {
    console.error('\nNo proxy passed the health check. The gateway will report no_egress_route.');
    process.exitCode = 1;
  } else if (healthy < status.configuredCount) {
    console.warn('\nSome proxies failed this sweep and stay out of rotation until a later sweep passes. Traffic uses the healthy remainder.');
  }
}

main().catch(err => {
  console.error(`Proxy check failed: ${err.message}`);
  process.exitCode = 1;
});
