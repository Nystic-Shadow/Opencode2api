import React, { useState, useEffect, useRef } from 'react';
import { FiSettings, FiRefreshCw, FiCheck, FiSliders, FiCpu, FiZap } from '../components/Icons';
import CustomToggle from '../components/CustomToggle';
import CustomSelect from '../components/CustomSelect';

function formatWhen(timestamp) {
  if (!timestamp) return 'waiting';
  const diffMs = timestamp - Date.now();
  const absMs = Math.abs(diffMs);
  let text;
  if (absMs < 60000) text = `${Math.max(1, Math.round(absMs / 1000))}s`;
  else if (absMs < 3600000) text = `${Math.round(absMs / 60000)}m`;
  else text = `${Math.round(absMs / 3600000)}h`;
  return diffMs >= 0 ? `in ${text}` : `${text} ago`;
}

export default function Settings({ settings = {}, onSaveSettings, onCheckUpdate, isCheckingUpdate }) {
  const [username, setUsername] = useState(settings.admin_username || 'admin');
  const [password, setPassword] = useState('');
  const [discoveryInterval, setDiscoveryInterval] = useState(settings.discovery_interval_seconds || 600);
  const [autoUpdateCli, setAutoUpdateCli] = useState(settings.auto_update_cli !== false);
  const [freeOnly, setFreeOnly] = useState(settings.free_only !== false);
  const [maxRetries, setMaxRetries] = useState(settings.max_retries ?? 2);
  const [proxyQuotaFailovers, setProxyQuotaFailovers] = useState(settings.proxy_quota_failovers ?? 10);
  const [proxyCheckInterval, setProxyCheckInterval] = useState(settings.proxy_check_interval_minutes ?? 30);
  const [proxyAutoPrune, setProxyAutoPrune] = useState(settings.proxy_auto_prune_dead !== false);
  const [autoProxyDiscovery, setAutoProxyDiscovery] = useState(settings.auto_proxy_discovery !== false);
  const [upstreamZenKey, setUpstreamZenKey] = useState(settings.upstream_zen_key || '');
  const [proxies, setProxies] = useState(Array.isArray(settings.proxies) ? settings.proxies.join('\n') : (settings.proxies || ''));
  const [rotatingProxyEnabled, setRotatingProxyEnabled] = useState(settings.rotating_proxy_enabled || false);
  const [rotatingProxyUrl, setRotatingProxyUrl] = useState(settings.rotating_proxy_url || '');
  const [rotatingProxySessionMode, setRotatingProxySessionMode] = useState(settings.rotating_proxy_session_mode || 'auto');
  const [isTestingRotating, setIsTestingRotating] = useState(false);
  const [rotatingTestResult, setRotatingTestResult] = useState(null);
  const [isScrapingNow, setIsScrapingNow] = useState(false);
  const [globalRpm, setGlobalRpm] = useState(settings.global_rpm_limit || 0);
  const [globalTpm, setGlobalTpm] = useState(settings.global_tpm_limit || 0);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [updateMsg, setUpdateMsg] = useState(null);
  const [proxyStatus, setProxyStatus] = useState(null);
  const [isRescanningProxies, setIsRescanningProxies] = useState(false);
  const [isPruningProxies, setIsPruningProxies] = useState(false);
  const [proxyFeedback, setProxyFeedback] = useState(null);

  const initializedRef = useRef(false);

  useEffect(() => {
    // Only initialize form fields once from settings when settings first loads
    if (!initializedRef.current && settings && Object.keys(settings).length > 0) {
      initializedRef.current = true;
      if (settings.rotating_proxy_enabled !== undefined) setRotatingProxyEnabled(!!settings.rotating_proxy_enabled);
      if (settings.rotating_proxy_url !== undefined) setRotatingProxyUrl(settings.rotating_proxy_url || '');
      if (settings.rotating_proxy_session_mode !== undefined) setRotatingProxySessionMode(settings.rotating_proxy_session_mode || 'auto');
    }
  }, [settings]);

  useEffect(() => {
    const fetchProxies = async () => {
      try {
        const token = localStorage.getItem('o2p_token');
        const res = await fetch('/api/proxies/status', {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });
        if (res.ok) {
          const data = await res.json();
          setProxyStatus(data);
        }
      } catch (e) {}
    };
    fetchProxies();
    const proxyTimer = setInterval(fetchProxies, 5000);
    return () => clearInterval(proxyTimer);
  }, []);

  const handleTestRotatingProxy = async () => {
    if (!rotatingProxyUrl) {
      setRotatingTestResult({ ok: false, message: 'Please enter a proxy URL to test.' });
      return;
    }
    setIsTestingRotating(true);
    setRotatingTestResult(null);
    try {
      const token = localStorage.getItem('o2p_token');
      const res = await fetch('/api/proxies/test-rotating', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ url: rotatingProxyUrl })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setRotatingTestResult({ ok: true, message: `Connected successfully! Latency: ${data.latency}ms` });
      } else {
        setRotatingTestResult({ ok: false, message: `Connection failed: ${data.error || 'Timed out'}` });
      }
    } catch (e) {
      setRotatingTestResult({ ok: false, message: `Test error: ${e.message}` });
    } finally {
      setIsTestingRotating(false);
    }
  };

  const handleScrapeNow = async () => {
    setIsScrapingNow(true);
    setProxyFeedback('Triggered instant proxy scraper across 15+ high-speed public sources...');
    try {
      const token = localStorage.getItem('o2p_token');
      const res = await fetch('/api/proxies/scrape-now', {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      const data = await res.json();
      if (res.ok) {
        setProxyStatus(data);
        setProxyFeedback('Proxy scraper active! Screening public candidates and verifying TLS handshakes...');
      } else {
        setProxyFeedback(`Scrape note: ${data.error || 'Failed'}`);
      }
      setTimeout(() => setProxyFeedback(null), 6000);
    } catch (e) {
      setProxyFeedback(`Scrape error: ${e.message}`);
    } finally {
      setIsScrapingNow(false);
    }
  };

  const handleRescanProxies = async () => {
    setIsRescanningProxies(true);
    setProxyFeedback('Refreshing automatic discovery and starting a full 5x health sweep...');
    try {
      const token = localStorage.getItem('o2p_token');
      const res = await fetch('/api/proxies/recheck', {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      if (res.ok) {
        const data = await res.json();
        setProxyStatus(data);
        setProxyFeedback('Refresh started. New routes only enter rotation after five consecutive TLS probes pass; failed routes stay out until a later sweep.');
      }
      setTimeout(() => setProxyFeedback(null), 5000);
    } catch (e) {
      setProxyFeedback('Proxy rescan error: ' + e.message);
    } finally {
      setIsRescanningProxies(false);
    }
  };

  const handlePruneProxies = async () => {
    setIsPruningProxies(true);
    try {
      const token = localStorage.getItem('o2p_token');
      const res = await fetch('/api/proxies/prune', {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to remove failed proxies');
      setProxyStatus(data);
      setProxyFeedback(data.removed > 0
        ? `Removed ${data.removed} failed route${data.removed === 1 ? '' : 's'}. Automatic discovery will refill the pool.`
        : 'No failed routes to remove.');
      setTimeout(() => setProxyFeedback(null), 5000);
    } catch (e) {
      setProxyFeedback('Prune error: ' + e.message);
    } finally {
      setIsPruningProxies(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveSuccess(false);
    try {
      await onSaveSettings({
        admin_username: username,
        admin_password: password || undefined,
        discovery_interval_seconds: parseInt(discoveryInterval, 10),
        auto_update_cli: autoUpdateCli,
        free_only: freeOnly,
        max_retries: parseInt(maxRetries, 10) || 0,
        proxy_quota_failovers: Math.min(20, Math.max(0, parseInt(proxyQuotaFailovers, 10) || 0)),
        proxy_check_interval_minutes: Math.min(1440, Math.max(1, parseInt(proxyCheckInterval, 10) || 30)),
        proxy_auto_prune_dead: proxyAutoPrune,
        auto_proxy_discovery: autoProxyDiscovery,
        rotating_proxy_enabled: rotatingProxyEnabled,
        rotating_proxy_url: rotatingProxyUrl.trim(),
        rotating_proxy_session_mode: rotatingProxySessionMode,
        upstream_zen_key: upstreamZenKey.trim(),
        proxies: proxies.split('\n').map(p => p.trim()).filter(Boolean),
        global_rpm_limit: parseInt(globalRpm, 10),
        global_tpm_limit: parseInt(globalTpm, 10)
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (err) {
      alert('Failed to save settings: ' + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleManualUpdateCheck = async () => {
    setUpdateMsg(null);
    try {
      const res = await onCheckUpdate();
      if (res.updated) {
        setUpdateMsg(`Updated OpenCode CLI to v${res.current} successfully!`);
      } else {
        setUpdateMsg(`Already on latest OpenCode CLI (v${res.current || settings.client_version}).`);
      }
      setTimeout(() => setUpdateMsg(null), 4000);
    } catch (err) {
      setUpdateMsg('Check failed: ' + err.message);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '720px' }}>
      {/* CLI Fingerprint & Auto-Update Card */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: '700' }}>OpenCode CLI Fingerprint</h3>
              <span className="badge badge-success">v{settings.client_version || '2.0.29'}</span>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>
              Gateway transparently matches the latest OpenCode CLI release tag to maintain 95%+ upstream success rate.
            </p>
          </div>
          <button
            className="btn-secondary"
            onClick={handleManualUpdateCheck}
            disabled={isCheckingUpdate}
          >
            <FiRefreshCw size={14} className={isCheckingUpdate ? 'spin' : ''} />
            <span>{isCheckingUpdate ? 'Checking...' : 'Check for CLI Update'}</span>
          </button>
        </div>

        {updateMsg && (
          <div style={{
            padding: '0.65rem',
            backgroundColor: 'var(--muted)',
            borderRadius: 'var(--radius)',
            borderLeft: '3px solid var(--primary)',
            fontSize: '0.8rem',
            marginBottom: '1rem'
          }}>
            {updateMsg}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
          <div>
            <div style={{ fontSize: '0.85rem', fontWeight: '600' }}>Auto-Update CLI Version</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
              Automatically update headers on new releases without restarting containers
            </div>
          </div>
          <CustomToggle
            checked={autoUpdateCli}
            onChange={setAutoUpdateCli}
          />
        </div>
      </div>

      {/* Egress proxy pool card */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem', flexWrap: 'wrap' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: '700', margin: 0 }}>
                Egress Proxy Pool
              </h3>
              <span className={`badge ${proxyStatus?.verifiedCount > 0 ? 'badge-active' : 'badge-idle'}`}>
                {proxyStatus?.isScanning || proxyStatus?.autoDiscovery?.running
                  ? 'Refreshing routes...'
                  : (proxyStatus?.verifiedCount > 0
                    ? `${proxyStatus.verifiedCount} healthy`
                    : ((proxyStatus?.autoDiscovery?.enabled ?? autoProxyDiscovery) ? 'Discovering routes' : 'No routes'))}
              </span>
              {proxyStatus?.rotatingProxy?.enabled && (
                <span className="badge" style={{ backgroundColor: 'rgba(99, 102, 241, 0.15)', color: '#818cf8', border: '1px solid rgba(99, 102, 241, 0.3)' }}>
                  Rotating Proxy Active
                </span>
              )}
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)', margin: 0 }}>
              <strong>Zero-config by default.</strong> The gateway discovers public HTTP/HTTPS/SOCKS5 candidates, probes each one
              directly against the configured upstream with TLS verification, and keeps verified routes fresh. In <strong>Rotating Proxy Mode</strong>, a single backconnect proxy automatically rotates exit IPs on every request, eliminating IP rate limits without locking the gateway.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={handleScrapeNow}
              disabled={isScrapingNow || proxyStatus?.autoDiscovery?.running}
              className="btn btn-secondary"
              style={{ fontSize: '0.78rem', padding: '0.4rem 0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
              title="Scrape and screen fresh public proxy candidates immediately"
            >
              <FiZap size={13} className={isScrapingNow ? 'spin' : ''} />
              <span>{isScrapingNow || proxyStatus?.autoDiscovery?.running ? 'Scraping...' : 'Scrape Proxies Now'}</span>
            </button>
            <button
              type="button"
              onClick={handleRescanProxies}
              disabled={isRescanningProxies || proxyStatus?.isScanning}
              className="btn btn-secondary"
              style={{ fontSize: '0.78rem', padding: '0.4rem 0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
            >
              <FiRefreshCw size={13} className={isRescanningProxies ? 'spin' : ''} />
              <span>{isRescanningProxies || proxyStatus?.isScanning ? 'Checking 5x...' : 'Recheck Pool 5x'}</span>
            </button>
          </div>
        </div>

        {proxyStatus?.upstreamQuota?.blocked && (
          <div style={{
            padding: '0.75rem',
            backgroundColor: 'rgba(224, 85, 85, 0.08)',
            borderRadius: 'var(--radius)',
            borderLeft: '3px solid #e05555',
            fontSize: '0.8rem',
            lineHeight: 1.5
          }}>
            <strong>Upstream free quota exhausted.</strong>{' '}
            OpenCode's anonymous free tier resets at{' '}
            {proxyStatus.upstreamQuota.resetAt
              ? new Date(proxyStatus.upstreamQuota.resetAt).toLocaleString()
              : proxyStatus.upstreamQuota.resetAtUtc}
            {' '}({proxyStatus.upstreamQuota.retryAfterSeconds}s). This is a global upstream limit:
            rotating proxies cannot bypass it. Add an Upstream Zen key and disable free-only, or wait for the reset.
          </div>
        )}

        {proxyStatus?.configuredCount === 0 && (
          <div style={{
            padding: '0.75rem',
            backgroundColor: 'var(--muted)',
            borderRadius: 'var(--radius)',
            borderLeft: '3px solid #f0a500',
            fontSize: '0.8rem',
            lineHeight: 1.5
          }}>
            {(proxyStatus?.autoDiscovery?.enabled ?? autoProxyDiscovery) ? (
              <>
                <strong>Discovering verified egress routes.</strong> The pool is empty while public candidates are screened and
                verified. Only routes that pass five consecutive TLS probes enter rotation, so the first start normally
                takes 2–4 minutes. Automatic refresh runs every {proxyStatus?.autoDiscovery?.intervalMinutes || 10} minutes.
                {proxyStatus?.autoDiscovery?.lastError && (
                  <div style={{ marginTop: '0.35rem', color: 'var(--muted-foreground)' }}>
                    Last discovery note: {proxyStatus.autoDiscovery.lastError}
                  </div>
                )}
              </>
            ) : (
              <>
                <strong>Automatic discovery is off and no manual proxies are configured.</strong> Enable automatic proxy
                discovery below or add explicit routes. Until a route is verified, inference returns
                <code> 503 no_egress_route</code>.
              </>
            )}
            {proxyStatus?.configuredViaEnv && (
              <div style={{ marginTop: '0.35rem', color: 'var(--muted-foreground)' }}>
                <code>PROXIES</code> is present in the environment, but no valid entries were loaded. Check the URL format and restart the gateway.
              </div>
            )}
          </div>
        )}

        {proxyFeedback && (
          <div style={{
            padding: '0.65rem',
            backgroundColor: 'var(--muted)',
            borderRadius: 'var(--radius)',
            borderLeft: '3px solid #2fbc5b',
            fontSize: '0.8rem'
          }}>
            {proxyFeedback}
          </div>
        )}

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '0.75rem',
          padding: '0.75rem',
          backgroundColor: 'var(--background)',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--border)'
        }}>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Healthy / Pool</div>
            <div style={{ fontSize: '1.1rem', fontWeight: '800', color: '#2fbc5b' }}>
              {proxyStatus?.verifiedCount || 0} / {proxyStatus?.configuredCount || 0}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Routable Now</div>
            <div style={{ fontSize: '1.1rem', fontWeight: '800', color: 'var(--foreground)' }}>
              {proxyStatus?.routableCount || 0}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Automatic / Manual</div>
            <div style={{ fontSize: '1.1rem', fontWeight: '800', color: 'var(--foreground)' }}>
              {proxyStatus?.autoCount || 0} / {proxyStatus?.manualCount || 0}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Discovery Verified</div>
            <div style={{ fontSize: '1.1rem', fontWeight: '800', color: 'var(--foreground)' }}>
              {proxyStatus?.autoDiscovery?.verifiedCount || 0} / {proxyStatus?.autoDiscovery?.target || 20}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Proxy Sources</div>
            <div style={{ fontSize: '1.1rem', fontWeight: '800', color: 'var(--foreground)' }}>
              {proxyStatus?.autoDiscovery?.sourcesOk || 0} / {proxyStatus?.autoDiscovery?.sourcesTotal || 0}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Failed / Disabled</div>
            <div style={{ fontSize: '1.1rem', fontWeight: '800', color: (proxyStatus?.failedCount || 0) > 0 ? '#e05555' : 'var(--foreground)' }}>
              {proxyStatus?.failedCount || 0}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Discovery Refresh</div>
            <div style={{ fontSize: '0.82rem', fontWeight: '700', color: 'var(--foreground)' }}>
              {formatWhen(proxyStatus?.autoDiscovery?.lastRefreshAt)} → {formatWhen(proxyStatus?.autoDiscovery?.nextRefreshAt)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Background Sweep</div>
            <div style={{ fontSize: '0.85rem', fontWeight: '700', color: 'var(--foreground)' }}>
              Every {proxyStatus?.checkIntervalMinutes || 30} min
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Fastest Route</div>
            <div style={{ fontSize: '1.1rem', fontWeight: '800', color: 'var(--foreground)' }}>
              {proxyStatus?.fastestProxy ? `${proxyStatus.fastestProxy.latency}ms` : 'None'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Validation</div>
            <div style={{ fontSize: '0.85rem', fontWeight: '700', color: 'var(--foreground)' }}>
              5x TLS, 5s Timeout
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Capacity</div>
            <div style={{ fontSize: '0.85rem', fontWeight: '700', color: 'var(--foreground)' }}>
              {proxyStatus?.maxPool || 100} total / {proxyStatus?.autoDiscovery?.configuredTarget || 20} auto
            </div>
          </div>
        </div>

        {proxyStatus?.topProxies && proxyStatus.topProxies.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--muted-foreground)' }}>
              Healthy Egress Proxies (round-robin):
            </div>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {proxyStatus.topProxies.map((p, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: '0.25rem 0.55rem',
                    backgroundColor: 'var(--muted)',
                    borderRadius: 'var(--radius)',
                    border: '1px solid var(--border)',
                    fontSize: '0.72rem',
                    fontFamily: 'monospace',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem'
                  }}
                >
                  <span style={{ color: '#2fbc5b', fontWeight: '700' }}>{p.latency}ms</span>
                  <span style={{ color: 'var(--foreground)' }}>{p.endpoint}</span>
                  <span style={{ color: 'var(--muted-foreground)', fontSize: '0.65rem' }}>({p.passes}/5 ✓ · {p.source})</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {proxyStatus?.proxies?.some(p => p.healthy === false) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--muted-foreground)' }}>
                Failed / Out of rotation:
              </div>
              <button
                type="button"
                onClick={handlePruneProxies}
                disabled={isPruningProxies}
                className="btn btn-secondary"
                style={{ fontSize: '0.7rem', padding: '0.25rem 0.55rem' }}
              >
                {isPruningProxies ? 'Removing...' : 'Remove failed'}
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              {proxyStatus.proxies.filter(p => p.healthy === false).map(p => (
                <div
                  key={p.id}
                  style={{
                    padding: '0.35rem 0.55rem',
                    backgroundColor: 'var(--muted)',
                    borderRadius: 'var(--radius)',
                    borderLeft: '3px solid #e05555',
                    fontSize: '0.72rem',
                    fontFamily: 'monospace',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                    flexWrap: 'wrap'
                  }}
                >
                  <span style={{ color: 'var(--foreground)' }}>{p.endpoint}</span>
                  <span style={{ color: 'var(--muted-foreground)' }}>
                    {p.passes}/{p.checks} passes · {p.lastError || 'check failed'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <form onSubmit={handleSubmit} className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: '700', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>
          Gateway Configuration
        </h3>

        {/* Admin Credentials */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: '600', display: 'block', marginBottom: '0.35rem' }}>
              Admin Username
            </label>
            <input
              type="text"
              className="input-field"
              style={{ width: '100%' }}
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
            />
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: '600', display: 'block', marginBottom: '0.35rem' }}>
              Admin Password (leave blank to keep current)
            </label>
            <input
              type="password"
              className="input-field"
              style={{ width: '100%' }}
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>
        </div>

        {/* Discovery Interval */}
        <div>
          <label style={{ fontSize: '0.8rem', fontWeight: '600', display: 'block', marginBottom: '0.35rem' }}>
            Model Auto-Discovery Sync Interval (Seconds)
          </label>
          <input
            type="number"
            className="input-field"
            style={{ width: '100%' }}
            value={discoveryInterval}
            onChange={e => setDiscoveryInterval(e.target.value)}
            min="60"
            step="60"
            required
          />
          <span style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)' }}>
            Default: 600s (10 minutes). Re-scans upstream Zen model catalog for new additions.
          </span>
        </div>

        {/* Free Only Toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
          <div>
            <div style={{ fontSize: '0.85rem', fontWeight: '600' }}>Enforce 100% Free Models Only</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
              Restricts /v1/models strictly to models that require zero tokens and zero balance
            </div>
          </div>
          <CustomToggle
            checked={freeOnly}
            onChange={setFreeOnly}
          />
        </div>

        {/* Retry and quota-failover budgets */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: '600', display: 'block', marginBottom: '0.35rem' }}>
              Max Network Failover Attempts
            </label>
            <input
              type="number"
              className="input-field"
              style={{ width: '100%' }}
              value={maxRetries}
              onChange={e => setMaxRetries(e.target.value)}
              min="0"
              max="3"
              required
            />
            <span style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)' }}>
              Retries for connection errors and 5xx responses. Hard-capped at 3.
            </span>
          </div>
          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: '600', display: 'block', marginBottom: '0.35rem' }}>
              Quota Failovers per Request
            </label>
            <input
              type="number"
              className="input-field"
              style={{ width: '100%' }}
              value={proxyQuotaFailovers}
              onChange={e => setProxyQuotaFailovers(e.target.value)}
              min="0"
              max="20"
              required
            />
            <span style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)' }}>
              Extra proxies tried after an upstream 429 before returning the limit. Bounded 0–20; 0 disables quota failover.
            </span>
          </div>
        </div>

        {/* Upstream Zen Key (Optional) */}
        <div style={{ paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
          <label style={{ fontSize: '0.8rem', fontWeight: '600', display: 'block', marginBottom: '0.25rem' }}>
            Upstream Zen Key (Optional)
          </label>
          <input
            type="text"
            className="input-field"
            style={{ width: '100%', fontFamily: 'monospace' }}
            placeholder="Leave empty to use the free lane"
            value={upstreamZenKey}
            onChange={e => setUpstreamZenKey(e.target.value)}
          />
          <span style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)' }}>
            Uses paid upstream capacity when provided and bypasses anonymous free-tier limits. Leave blank to stay on the free lane.
          </span>
        </div>

        {/* Upstream Proxies & Rotating Gateway */}
        <div style={{
          padding: '1rem',
          backgroundColor: rotatingProxyEnabled ? 'rgba(99, 102, 241, 0.05)' : 'var(--background)',
          borderRadius: 'var(--radius)',
          border: rotatingProxyEnabled ? '1px solid rgba(99, 102, 241, 0.35)' : '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.85rem'
        }}>
          {/* Rotating Proxy Mode Toggle */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                <span style={{ fontSize: '0.9rem', fontWeight: '700', color: rotatingProxyEnabled ? '#818cf8' : 'var(--foreground)' }}>
                  Rotating Proxy Mode (Single Gateway)
                </span>
                {rotatingProxyEnabled && (
                  <span className="badge" style={{ backgroundColor: '#818cf8', color: '#fff', fontSize: '0.65rem', padding: '0.1rem 0.4rem' }}>
                    Active
                  </span>
                )}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', lineHeight: 1.45 }}>
                Enable to route all egress through a single rotating/residential proxy service (e.g. Webshare, Smartproxy, Bright Data, Oxylabs, IPRoyal). Instead of adding multiple proxies per line, add a <strong>single rotating proxy URL</strong>. Requests automatically exit through fresh IPs, eliminating IP rate limits without proxy lockouts.
              </div>
            </div>
            <CustomToggle
              checked={rotatingProxyEnabled}
              onChange={setRotatingProxyEnabled}
            />
          </div>

          {rotatingProxyEnabled ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.25rem', paddingTop: '0.75rem', borderTop: '1px solid rgba(99, 102, 241, 0.2)' }}>
              <div>
                <label style={{ fontSize: '0.78rem', fontWeight: '600', display: 'block', marginBottom: '0.3rem' }}>
                  Rotating Proxy URL (Single Endpoint)
                </label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    type="text"
                    className="input-field"
                    style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.82rem' }}
                    placeholder="http://username:password@gate.smartproxy.com:7000"
                    value={rotatingProxyUrl}
                    onChange={e => {
                      setRotatingProxyUrl(e.target.value);
                      setRotatingTestResult(null);
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleTestRotatingProxy}
                    disabled={isTestingRotating || !rotatingProxyUrl}
                    className="btn btn-secondary"
                    style={{ whiteSpace: 'nowrap', fontSize: '0.78rem', padding: '0.4rem 0.8rem' }}
                  >
                    {isTestingRotating ? 'Testing...' : 'Test Connection'}
                  </button>
                </div>
                <span style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)', marginTop: '0.25rem', display: 'block' }}>
                  Supported formats: <code>http://user:pass@host:port</code>, <code>https://...</code>, or <code>socks5://...</code>. Password is automatically masked and encrypted.
                </span>
              </div>

              {rotatingTestResult && (
                <div style={{
                  padding: '0.6rem 0.8rem',
                  borderRadius: 'var(--radius)',
                  fontSize: '0.78rem',
                  backgroundColor: rotatingTestResult.ok ? 'rgba(47, 188, 91, 0.1)' : 'rgba(224, 85, 85, 0.1)',
                  borderLeft: `3px solid ${rotatingTestResult.ok ? '#2fbc5b' : '#e05555'}`,
                  color: rotatingTestResult.ok ? '#2fbc5b' : '#e05555'
                }}>
                  {rotatingTestResult.message}
                </div>
              )}

              <div>
                <label style={{ fontSize: '0.75rem', fontWeight: '600', display: 'block', marginBottom: '0.25rem' }}>
                  IP & Session Switching Strategy
                </label>
                <CustomSelect
                  value={rotatingProxySessionMode}
                  onChange={setRotatingProxySessionMode}
                  options={[
                    { value: 'auto', label: 'Auto (Connection Close per request - Recommended for all providers)' },
                    { value: 'session_suffix', label: 'Append Session Suffix (-session-<rand> for Smartproxy, Bright Data, Oxylabs)' },
                    { value: 'custom', label: 'Custom ({session} or {rand} placeholder in proxy username)' }
                  ]}
                />
                <span style={{ fontSize: '0.68rem', color: 'var(--muted-foreground)', marginTop: '0.2rem', display: 'block' }}>
                  Ensures each outbound connection exits through a new IP address so OpenCode upstream rate limits are never triggered.
                </span>
              </div>
            </div>
          ) : (
            <div>
              <label style={{ fontSize: '0.78rem', fontWeight: '600', display: 'block', marginBottom: '0.25rem' }}>
                Manual Proxies (Pool Mode - One per line)
              </label>
              <textarea
                className="input-field"
                style={{ width: '100%', height: '70px', fontFamily: 'monospace', resize: 'vertical' }}
                placeholder="http://user:pass@host:port (one per line)"
                value={proxies}
                onChange={e => setProxies(e.target.value)}
              />
              <span style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)' }}>
                Explicit HTTP, HTTPS, or SOCKS5 routes (maximum 100). Manual entries take precedence over discovered routes.
              </span>
            </div>
          )}

          {/* Automatic Proxy Discovery controls */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', marginTop: '0.5rem', paddingTop: '0.65rem', borderTop: '1px solid var(--border)' }}>
            <div>
              <div style={{ fontSize: '0.75rem', fontWeight: '600' }}>Automatic Proxy Discovery & Scraper</div>
              <div style={{ fontSize: '0.68rem', color: 'var(--muted-foreground)', lineHeight: 1.4 }}>
                Continuously discover, scrape, test, and rotate verified public egress routes from 15+ verified public sources.
              </div>
            </div>
            <CustomToggle
              checked={autoProxyDiscovery}
              onChange={setAutoProxyDiscovery}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '0.5rem' }}>
            <div>
              <label style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', display: 'block', marginBottom: '0.25rem' }}>
                Pool Recheck Interval (Minutes)
              </label>
              <input
                type="number"
                className="input-field"
                style={{ width: '100%' }}
                value={proxyCheckInterval}
                onChange={e => setProxyCheckInterval(e.target.value)}
                min="1"
                max="1440"
                required
              />
              <span style={{ fontSize: '0.68rem', color: 'var(--muted-foreground)' }}>
                Default 30. Every routed proxy is checked in the background at this interval.
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
              <div>
                <div style={{ fontSize: '0.75rem', fontWeight: '600' }}>Auto-Remove Dead Proxies</div>
                <div style={{ fontSize: '0.68rem', color: 'var(--muted-foreground)', lineHeight: 1.4 }}>
                  After two consecutive failed sweeps. Rotating proxy is never auto-removed.
                </div>
              </div>
              <CustomToggle
                checked={proxyAutoPrune}
                onChange={setProxyAutoPrune}
              />
            </div>
          </div>
        </div>

        {/* Global Rate Limits */}
        <div style={{ paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: '600', marginBottom: '0.5rem' }}>
            Global Rate Limits (0 = Unlimited)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <label style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', display: 'block', marginBottom: '0.25rem' }}>
                Global RPM Cap
              </label>
              <input
                type="number"
                className="input-field"
                style={{ width: '100%' }}
                value={globalRpm}
                onChange={e => setGlobalRpm(e.target.value)}
                min="0"
              />
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', display: 'block', marginBottom: '0.25rem' }}>
                Global TPM Cap
              </label>
              <input
                type="number"
                className="input-field"
                style={{ width: '100%' }}
                value={globalTpm}
                onChange={e => setGlobalTpm(e.target.value)}
                min="0"
                step="5000"
              />
            </div>
          </div>
        </div>

        {/* Submit */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '1rem', marginTop: '0.5rem' }}>
          {saveSuccess && (
            <span style={{ fontSize: '0.8rem', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              <FiCheck size={14} /> Saved successfully
            </span>
          )}
          <button type="submit" className="btn-primary" disabled={isSaving}>
            {isSaving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>
    </div>
  );
}
