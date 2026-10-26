#!/usr/bin/env node
/**
 * Verify the egress pool, including automatic zero-config discovery.
 *
 * Manual proxies are checked with five sequential CONNECT + TLS probes to the
 * configured upstream host, with a 5-second timeout per probe. When automatic
 * discovery is enabled, the same CLI also fetches public candidates and only
 * reports those that survive screening plus five consecutive TLS probes.
 *
 * This CLI is read-only: it never prunes or rewrites the saved pool.
 *
 * Usage: npm run check:proxies
 */
process.env.O2P_CONFIG_READONLY = '1';
const config = require('../server/config');
const egress = require('../server/egress');
const proxyDiscovery = require('../server/proxyDiscovery');

async function main() {
  const configured = config.get('proxies');
  const manual = Array.isArray(configured)
    ? configured
    : (typeof configured === 'string' ? configured.split(/[\n,]/).map(value => value.trim()).filter(Boolean) : []);
  const autoEnabled = config.get('auto_proxy_discovery') !== false;

  if (manual.length === 0 && !autoEnabled) {
    console.error('No manual proxies configured and automatic discovery is disabled.');
    console.error('Enable automatic discovery (AUTO_PROXY_DISCOVERY=true) or set PROXIES.');
    process.exitCode = 1;
    return;
  }

  const target = config.get('upstream_inference_url') || 'https://opencode.ai';
  console.log(`Egress target: ${target}`);
  if (autoEnabled) {
    console.log('Policy: automatic discovery, 5 consecutive TLS probes per route, 5s timeout.');
  }
  if (manual.length > 0) {
    console.log(`Policy: ${manual.length} manual prox${manual.length === 1 ? 'y' : 'ies'}, 5 probes each, 5s timeout.`);
  }
  console.log('');

  const started = Date.now();
  if (autoEnabled) {
    console.log('Discovering and verifying automatic routes...');
    const statusTimer = setInterval(() => {
      const current = proxyDiscovery.getStatus();
      const run = current.lastRun || {};
      console.log(
        `  ... ${current.verifiedCount}/${current.target} verified | ` +
        `${run.screened || 0}${run.candidatesSeen ? `/${run.candidatesSeen}` : ''} screened | ` +
        `${current.sourcesOk}/${current.sourcesTotal} sources`
      );
    }, 15000);
    if (typeof statusTimer.unref === 'function') statusTimer.unref();
    try {
      await proxyDiscovery.refreshNow();
    } finally {
      clearInterval(statusTimer);
    }
  }
  if (manual.length > 0) {
    console.log('Rechecking manual routes...');
    await egress.runProxyChecks();
  }

  const status = egress.getProxyStatus();
  const auto = proxyDiscovery.getStatus();

  if (autoEnabled) {
    console.log('');
    console.log(
      `Automatic: ${auto.verifiedCount}/${auto.target} verified | ` +
      `${auto.sourcesOk}/${auto.sourcesTotal} sources | ` +
      `${auto.lastRun?.candidatesSeen || 0} candidates, ${auto.lastRun?.screened || 0} screened`
    );
    if (auto.lastError) console.warn(`Automatic discovery note: ${auto.lastError}`);
    const failedSources = (auto.sources || []).filter(source => !source.ok);
    for (const source of failedSources) {
      console.warn(`  source ${source.name} failed: ${source.error}`);
    }
  }

  const rows = status.proxies.map(proxy => ({
    endpoint: proxy.endpoint,
    source: proxy.source,
    result: proxy.healthy === true ? 'PASS' : 'FAIL',
    probes: `${proxy.passes}/${proxy.checks}`,
    latency: proxy.latency ? `${proxy.latency}ms` : '-',
    error: proxy.healthy === true ? '' : (proxy.lastError || 'unreachable')
  }));

  if (rows.length > 0) {
    const endpointWidth = Math.max('ENDPOINT'.length, ...rows.map(row => row.endpoint.length));
    console.log('');
    console.log(`${'ENDPOINT'.padEnd(endpointWidth)}  SOURCE  RESULT  PROBES  LATENCY  ERROR`);
    for (const row of rows) {
      console.log(
        `${row.endpoint.padEnd(endpointWidth)}  ${row.source.padEnd(6)}  ${row.result.padEnd(6)}  ` +
        `${row.probes.padEnd(6)}  ${row.latency.padEnd(7)}  ${row.error}`
      );
    }
  }

  const healthy = status.proxies.filter(proxy => proxy.healthy === true).length;
  const routable = status.proxies.filter(proxy => proxy.routable).length;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log('');
  console.log(
    `Healthy: ${healthy}/${status.configuredCount}  ` +
    `Automatic: ${status.autoCount}  Manual: ${status.manualCount}  ` +
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
