import React, { useState } from 'react';
import { FiSettings, FiShield, FiRefreshCw, FiCheck, FiSliders, FiCpu } from '../components/Icons';
import CustomToggle from '../components/CustomToggle';

export default function Settings({ settings = {}, onSaveSettings, onCheckUpdate, isCheckingUpdate }) {
  const [username, setUsername] = useState(settings.admin_username || 'admin');
  const [password, setPassword] = useState('');
  const [discoveryInterval, setDiscoveryInterval] = useState(settings.discovery_interval_seconds || 600);
  const [autoUpdateCli, setAutoUpdateCli] = useState(settings.auto_update_cli !== false);
  const [freeOnly, setFreeOnly] = useState(settings.free_only !== false);
  const [smartFallback, setSmartFallback] = useState(settings.smart_fallback !== false);
  const [maxRetries, setMaxRetries] = useState(settings.max_retries || 3);
  const [upstreamZenKey, setUpstreamZenKey] = useState(settings.upstream_zen_key || '');
  const [proxies, setProxies] = useState(Array.isArray(settings.proxies) ? settings.proxies.join('\n') : (settings.proxies || ''));
  const [globalRpm, setGlobalRpm] = useState(settings.global_rpm_limit || 0);
  const [globalTpm, setGlobalTpm] = useState(settings.global_tpm_limit || 0);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [updateMsg, setUpdateMsg] = useState(null);

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
        smart_fallback: smartFallback,
        max_retries: parseInt(maxRetries, 10) || 3,
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

        {/* Smart Failover Toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
          <div>
            <div style={{ fontSize: '0.85rem', fontWeight: '600' }}>Zero-Drop Smart Failover</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
              Automatically fails over to active equivalent models on 403 / 429 / 5xx upstream hiccups
            </div>
          </div>
          <CustomToggle
            checked={smartFallback}
            onChange={setSmartFallback}
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
            min="1"
            max="6"
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
            Rotates exit IPs on rate limits or failures. Supports HTTP, HTTPS, and rotating pools.
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
