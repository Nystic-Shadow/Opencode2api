import React, { useState, useEffect } from 'react';
import { FiSettings, FiRefreshCw, FiCheck, FiSliders, FiCpu } from '../components/Icons';
import CustomToggle from '../components/CustomToggle';
import CustomSelect from '../components/CustomSelect';

export default function Settings({ settings = {}, onSaveSettings, onCheckUpdate, isCheckingUpdate }) {
  const [username, setUsername] = useState(settings.admin_username || 'admin');
  const [password, setPassword] = useState('');
  const [discoveryInterval, setDiscoveryInterval] = useState(settings.discovery_interval_seconds || 600);
  const [autoUpdateCli, setAutoUpdateCli] = useState(settings.auto_update_cli !== false);
  const [freeOnly, setFreeOnly] = useState(settings.free_only !== false);
  const [maxRetries, setMaxRetries] = useState(settings.max_retries ?? 2);
  const [upstreamZenKey, setUpstreamZenKey] = useState(settings.upstream_zen_key || '');
  const [proxies, setProxies] = useState(Array.isArray(settings.proxies) ? settings.proxies.join('\n') : (settings.proxies || ''));
  const [globalRpm, setGlobalRpm] = useState(settings.global_rpm_limit || 0);
  const [globalTpm, setGlobalTpm] = useState(settings.global_tpm_limit || 0);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [updateMsg, setUpdateMsg] = useState(null);
  const [proxyStatus, setProxyStatus] = useState(null);
  const [isRescanningProxies, setIsRescanningProxies] = useState(false);
  const [proxyFeedback, setProxyFeedback] = useState(null);

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

  const handleRescanProxies = async () => {
    setIsRescanningProxies(true);
    setProxyFeedback('Proxy sweep initiated! Checking candidate endpoints directly against opencode.ai with strict 5x tests...');
    try {
      const token = localStorage.getItem('o2p_token');
      const res = await fetch('/api/proxies/recheck', {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      if (res.ok) {
        const data = await res.json();
        setProxyStatus(data);
        setProxyFeedback('5x health checks running in background. Proxies that fail are quarantined for five minutes.');
      }
      setTimeout(() => setProxyFeedback(null), 5000);
    } catch (e) {
      setProxyFeedback('Proxy rescan error: ' + e.message);
    } finally {
      setIsRescanningProxies(false);
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: '700', margin: 0 }}>
                Egress Proxy Pool
              </h3>
              <span className={`badge ${proxyStatus?.verifiedCount > 0 ? 'badge-active' : 'badge-idle'}`}>
                {proxyStatus?.isScanning ? '5x health check...' : (proxyStatus?.verifiedCount > 0 ? `${proxyStatus.verifiedCount} healthy` : 'No healthy proxies')}
              </span>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)', margin: 0 }}>
              Explicit <code>PROXIES</code> only, maximum 100. Each proxy must pass five consecutive checks with a 5-second timeout. Failed proxies are quarantined for five minutes. A 429 is treated as upstream quota, not proxy death.
            </p>
          </div>

          <button
            type="button"
            onClick={handleRescanProxies}
            disabled={isRescanningProxies || proxyStatus?.isScanning}
            className="btn btn-secondary"
            style={{ fontSize: '0.78rem', padding: '0.4rem 0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
          >
            <span>{isRescanningProxies || proxyStatus?.isScanning ? 'Checking 5x...' : 'Recheck Pool 5x'}</span>
          </button>
        </div>

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
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Healthy / Configured</div>
            <div style={{ fontSize: '1.1rem', fontWeight: '800', color: '#2fbc5b' }}>
              {proxyStatus?.verifiedCount || 0} / {proxyStatus?.configuredCount || 0}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Fastest Proxy Latency</div>
            <div style={{ fontSize: '1.1rem', fontWeight: '800', color: 'var(--foreground)' }}>
              {proxyStatus?.fastestProxy ? `${proxyStatus.fastestProxy.latency}ms` : 'None'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Validation Strictness</div>
            <div style={{ fontSize: '0.85rem', fontWeight: '700', color: 'var(--foreground)' }}>
              5x Passes, 5s Timeout
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Pool Limit</div>
            <div style={{ fontSize: '0.85rem', fontWeight: '700', color: 'var(--foreground)' }}>
              {proxyStatus?.maxPool || 100} explicit proxies
            </div>
          </div>
        </div>

        {proxyStatus?.topProxies && proxyStatus.topProxies.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--muted-foreground)' }}>
              Healthy Egress Proxies (transport failover only):
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
                  <span style={{ color: 'var(--muted-foreground)', fontSize: '0.65rem' }}>({p.passes}/5 ✓)</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Settings Form */}
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

        {/* Max Retries */}
        <div>
          <label style={{ fontSize: '0.8rem', fontWeight: '600', display: 'block', marginBottom: '0.35rem' }}>
            Max Automatic Failover Attempts
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
            Number of transparent upstream retry and fallback hops before returning an error.
          </span>
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
            placeholder="Leave empty for 100% Free Anonymous Lane"
            value={upstreamZenKey}
            onChange={e => setUpstreamZenKey(e.target.value)}
          />
          <span style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)' }}>
            Bypasses anonymous IP quotas completely when provided. Leave blank to stay 100% anonymous & free.
          </span>
        </div>

        {/* Upstream Proxies (Optional) */}
        <div>
          <label style={{ fontSize: '0.8rem', fontWeight: '600', display: 'block', marginBottom: '0.25rem' }}>
            Upstream Proxies / Rotating Pool (Optional)
          </label>
          <textarea
            className="input-field"
            style={{ width: '100%', height: '70px', fontFamily: 'monospace', resize: 'vertical' }}
            placeholder="http://user:pass@host:port (one per line, supports rotating proxy pools)"
            value={proxies}
            onChange={e => setProxies(e.target.value)}
          />
          <span style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)' }}>
            Explicit HTTP, HTTPS, or SOCKS5 proxies used in order. The gateway does not rotate identities on 429/403; a proxy is marked unhealthy only for transport/5xx failures.
          </span>
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
