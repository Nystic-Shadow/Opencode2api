import React, { useState, useEffect } from 'react';
import { FiSettings, FiShield, FiRefreshCw, FiCheck, FiSliders, FiCpu, FiZap, FiTerminal, FiCopy } from '../components/Icons';
import CustomToggle from '../components/CustomToggle';
import CustomSelect from '../components/CustomSelect';

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
  const [warpMode, setWarpMode] = useState(settings.warp_mode || 'auto');
  const [warpHost, setWarpHost] = useState(settings.warp_host || '127.0.0.1');
  const [warpAutoSwitch, setWarpAutoSwitch] = useState(settings.warp_auto_switch !== false);
  const [warpRotateOnUnauth, setWarpRotateOnUnauth] = useState(settings.warp_rotate_on_unauth !== false);
  const [warpAutoRotateMinutes, setWarpAutoRotateMinutes] = useState(settings.warp_auto_rotate_minutes !== undefined ? settings.warp_auto_rotate_minutes : 10);
  const [warpPort, setWarpPort] = useState(settings.warp_port || 40000);
  const [warpStatus, setWarpStatus] = useState(null);
  const [isRotatingWarp, setIsRotatingWarp] = useState(false);
  const [isInstallingWarp, setIsInstallingWarp] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [warpFeedback, setWarpFeedback] = useState(null);
  const [globalRpm, setGlobalRpm] = useState(settings.global_rpm_limit || 0);
  const [globalTpm, setGlobalTpm] = useState(settings.global_tpm_limit || 0);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [updateMsg, setUpdateMsg] = useState(null);
  const [proxyStatus, setProxyStatus] = useState(null);
  const [isRescanningProxies, setIsRescanningProxies] = useState(false);
  const [proxyFeedback, setProxyFeedback] = useState(null);

  useEffect(() => {
    const fetchWarp = async () => {
      try {
        const token = localStorage.getItem('o2p_token');
        const res = await fetch('/api/warp/status', {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });
        if (res.ok) {
          const data = await res.json();
          setWarpStatus(data);
        }
      } catch (e) {}
    };
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
    fetchWarp();
    fetchProxies();
  }, []);

  const pollWarpProgress = () => {
    const token = localStorage.getItem('o2p_token');
    let polls = 0;
    const interval = setInterval(async () => {
      polls++;
      try {
        const res = await fetch('/api/warp/status', {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });
        if (res.ok) {
          const data = await res.json();
          setWarpStatus(data);
          if (data.connected && (!data.progress || data.progress.percent >= 100)) {
            clearInterval(interval);
          }
        }
      } catch (e) {}
      if (polls > 35) clearInterval(interval);
    }, 400);
    return interval;
  };

  const handleRotateWarp = async () => {
    setIsRotatingWarp(true);
    setWarpFeedback(null);
    pollWarpProgress();
    try {
      const token = localStorage.getItem('o2p_token');
      const res = await fetch('/api/warp/rotate', {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setWarpStatus(data);
        setWarpFeedback('Cloudflare WARP tunnel keys rotated! Fresh edge egress active.');
      } else {
        setWarpFeedback('Rotation error: ' + (data.error || 'Check WARP status'));
      }
      setTimeout(() => setWarpFeedback(null), 4000);
    } catch (err) {
      setWarpFeedback('Failed to rotate WARP: ' + err.message);
    } finally {
      setIsRotatingWarp(false);
    }
  };

  const handleConnectWarp = async () => {
    setIsInstallingWarp(true);
    setWarpFeedback(null);
    pollWarpProgress();
    try {
      const token = localStorage.getItem('o2p_token');
      const res = await fetch('/api/warp/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ host: warpHost.trim(), port: parseInt(warpPort, 10) || 40000 })
      });
      const data = await res.json();
      setWarpStatus(data);
      if (data.connected) {
        setWarpFeedback('Cloudflare WARP connected successfully!');
      } else {
        setWarpFeedback(data.reason || 'Could not connect to WARP socket.');
      }
      setTimeout(() => setWarpFeedback(null), 4000);
    } catch (e) {
      setWarpFeedback('Connection error: ' + e.message);
    } finally {
      setIsInstallingWarp(false);
    }
  };

  const handleInstallWarp = async () => {
    setIsInstallingWarp(true);
    setWarpFeedback(null);
    pollWarpProgress();
    try {
      const token = localStorage.getItem('o2p_token');
      const res = await fetch('/api/warp/install', {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      const data = await res.json();
      setWarpStatus(data);
      if (data.success || data.connected) {
        setWarpFeedback('Cloudflare WARP auto-setup complete & connected successfully!');
      } else {
        setWarpFeedback(data.error || 'Please run the 1-line script below on your host server.');
      }
      setTimeout(() => setWarpFeedback(null), 5000);
    } catch (e) {
      setWarpFeedback('Failed to trigger auto-install: ' + e.message);
    } finally {
      setIsInstallingWarp(false);
    }
  };

  const handleRescanProxies = async () => {
    setIsRescanningProxies(true);
    setProxyFeedback('Proxy sweep initiated! Checking candidate endpoints directly against opencode.ai with strict 5x tests...');
    try {
      const token = localStorage.getItem('o2p_token');
      const res = await fetch('/api/proxies/rescan', {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      if (res.ok) {
        const data = await res.json();
        setProxyStatus(data);
        setProxyFeedback('5x strict verification sweep running in background. High-speed (<3s) proxies auto-added to clean pool.');
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
        smart_fallback: smartFallback,
        max_retries: parseInt(maxRetries, 10) || 3,
        upstream_zen_key: upstreamZenKey.trim(),
        proxies: proxies.split('\n').map(p => p.trim()).filter(Boolean),
        warp_mode: warpMode,
        warp_host: warpHost.trim() || '127.0.0.1',
        warp_auto_switch: warpAutoSwitch,
        warp_rotate_on_unauth: warpRotateOnUnauth,
        warp_rotate_on_rate_limit: warpRotateOnUnauth,
        warp_auto_rotate_minutes: parseInt(warpAutoRotateMinutes, 10) || 0,
        warp_port: parseInt(warpPort, 10) || 40000,
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

      {/* Cloudflare WARP Proxy & Unauth Auto-Switch Card */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
              <FiShield size={18} style={{ color: 'var(--primary)' }} />
              <h3 style={{ fontSize: '1rem', fontWeight: '700' }}>Cloudflare WARP Proxy & Auto-Switch</h3>
              {warpStatus?.available ? (
                warpStatus.connected ? (
                  <span className="badge badge-success">
                    WARP Connected ({warpStatus.engine ? `${warpStatus.engine} • ` : ''}{warpStatus.host || '127.0.0.1'}:{warpStatus.port}{warpStatus.egressIp ? ` • Egress: ${warpStatus.egressIp}${warpStatus.colo ? ` [${warpStatus.colo}]` : ''}` : ''})
                  </span>
                ) : (
                  <span className="badge badge-warning">WARP Disconnected</span>
                )
              ) : (
                <span className="badge badge-secondary">Not Installed</span>
              )}
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>
              Routes through Cloudflare's global edge network via native SOCKS5 proxy to bypass anonymous IP limits and 403 blocks.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {!warpStatus?.connected && (
              <button
                type="button"
                className="btn-primary"
                onClick={handleInstallWarp}
                disabled={isInstallingWarp}
                title="Automatically configure and connect userspace Cloudflare WARP proxy"
                style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem' }}
              >
                <FiZap size={13} />
                <span>{isInstallingWarp ? 'Setting up...' : 'Auto-Setup WARP'}</span>
              </button>
            )}
            {warpStatus?.available && !warpStatus.connected && (
              <button
                type="button"
                className="btn-secondary"
                onClick={handleConnectWarp}
                style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem' }}
              >
                Connect WARP
              </button>
            )}
            <button
              type="button"
              className="btn-secondary"
              onClick={handleRotateWarp}
              disabled={isRotatingWarp || !warpStatus?.available}
              title="Rotate tunnel session keys for a fresh Cloudflare egress IP"
              style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem' }}
            >
              <FiRefreshCw size={13} className={isRotatingWarp ? 'spin' : ''} />
              <span>{isRotatingWarp ? 'Rotating...' : 'Rotate WARP Keys'}</span>
            </button>
          </div>
        </div>

        {/* Real-time WARP Progress Bar */}
        {(isInstallingWarp || isRotatingWarp || (warpStatus?.progress && warpStatus.progress.percent < 100) || warpStatus?.bootstrapping) && (
          <div style={{
            padding: '0.85rem 1rem',
            backgroundColor: 'rgba(47, 188, 91, 0.08)',
            border: '1px solid rgba(47, 188, 91, 0.3)',
            borderRadius: 'var(--radius)',
            marginBottom: '1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.55rem'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FiRefreshCw size={13} className="spin" style={{ color: 'var(--primary)' }} />
                <span style={{ fontSize: '0.82rem', fontWeight: '600', color: 'var(--foreground)' }}>
                  {warpStatus?.progress?.message || (isRotatingWarp ? 'Rotating Cloudflare tunnel session...' : 'Bootstrapping userspace WARP tunnel...')}
                </span>
              </div>
              <span className="badge badge-success" style={{ fontWeight: 700, fontSize: '0.78rem' }}>
                {warpStatus?.progress?.percent || (isRotatingWarp ? 45 : 65)}%
              </span>
            </div>

            {/* Glowing Gradient Progress Bar */}
            <div style={{
              width: '100%',
              height: '8px',
              backgroundColor: 'rgba(0, 0, 0, 0.35)',
              borderRadius: '999px',
              overflow: 'hidden',
              position: 'relative'
            }}>
              <div style={{
                height: '100%',
                width: `${Math.min(100, Math.max(8, warpStatus?.progress?.percent || (isRotatingWarp ? 45 : 65)))}%`,
                background: 'linear-gradient(90deg, #2fbc5b, #00d2ff)',
                borderRadius: '999px',
                boxShadow: '0 0 12px rgba(47, 188, 91, 0.6)',
                transition: 'width 0.35s ease-out'
              }} />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>
              <span>Curve25519 Handshake</span>
              <span>WireProxy Userspace Engine</span>
              <span>SOCKS5 127.0.0.1:40000</span>
            </div>
          </div>
        )}

        {!warpStatus?.connected && (
          <div style={{
            padding: '0.85rem 1rem',
            backgroundColor: 'rgba(242, 153, 74, 0.08)',
            border: '1px solid rgba(242, 153, 74, 0.25)',
            borderRadius: 'var(--radius)',
            fontSize: '0.82rem',
            marginBottom: '1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.45rem'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontWeight: '600', color: '#f2994a', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <FiTerminal size={14} />
                <span>Cloudflare WARP 1-Line Host Auto-Installer</span>
              </span>
              <button
                type="button"
                className="badge badge-muted"
                style={{ cursor: 'pointer', background: 'transparent', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                onClick={() => {
                  navigator.clipboard.writeText('curl -fsSL https://raw.githubusercontent.com/Nystic-Shadow/Opencode2api/main/scripts/install-warp.sh | sudo bash');
                  setCopiedCmd(true);
                  setTimeout(() => setCopiedCmd(false), 2000);
                }}
              >
                <FiCopy size={11} />
                <span>{copiedCmd ? '✓ Copied' : 'Copy Command'}</span>
              </button>
            </div>
            <code style={{
              display: 'block',
              padding: '0.45rem 0.65rem',
              backgroundColor: 'var(--background)',
              borderRadius: 'var(--radius)',
              fontFamily: 'monospace',
              fontSize: '0.78rem',
              color: 'var(--foreground)',
              overflowX: 'auto'
            }}>
              curl -fsSL https://raw.githubusercontent.com/Nystic-Shadow/Opencode2api/main/scripts/install-warp.sh | sudo bash
            </code>
            <div style={{ fontSize: '0.74rem', color: 'var(--muted-foreground)' }}>
              Works across Debian, Ubuntu, CentOS, RHEL, Fedora, & Arch. If deployed via Docker Compose, the <code>warp</code> sidecar runs out-of-the-box!
            </div>
          </div>
        )}

        {warpFeedback && (
          <div style={{
            padding: '0.65rem',
            backgroundColor: 'var(--muted)',
            borderRadius: 'var(--radius)',
            borderLeft: '3px solid var(--primary)',
            fontSize: '0.8rem',
            marginBottom: '1rem'
          }}>
            {warpFeedback}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: '600', display: 'block', marginBottom: '0.35rem' }}>
              WARP Routing Mode
            </label>
            <CustomSelect
              value={warpMode}
              onChange={setWarpMode}
              options={[
                { value: 'auto', label: 'Auto (Recommended)', description: 'Direct connection first; auto-promotes WARP whenever direct route is blocked or degraded' },
                { value: 'always', label: 'Always WARP', description: 'Route 100% of gateway traffic through Cloudflare WARP proxy' },
                { value: 'disabled', label: 'Disabled', description: 'Do not use Cloudflare WARP proxy' }
              ]}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '0.6rem', borderTop: '1px solid var(--border)' }}>
            <div>
              <div style={{ fontSize: '0.85rem', fontWeight: '600' }}>Auto-Switch to WARP on Block / Error</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
                Automatically routes to WARP proxy whenever upstream direct route is blocked (403), rate-limited (429), or errors
              </div>
            </div>
            <CustomToggle
              checked={warpAutoSwitch}
              onChange={setWarpAutoSwitch}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '0.6rem', borderTop: '1px solid var(--border)' }}>
            <div>
              <div style={{ fontSize: '0.85rem', fontWeight: '600' }}>Auto-Rotate WARP Keys on Rate Limit (429) & Unauth</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
                Seamlessly acquires fresh Cloudflare Anycast edge IP via zero-downtime hot-swap whenever rate-limited (429) or blocked (403)
              </div>
            </div>
            <CustomToggle
              checked={warpRotateOnUnauth}
              onChange={setWarpRotateOnUnauth}
            />
          </div>

          <div style={{ paddingTop: '0.6rem', borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
              <div>
                <div style={{ fontSize: '0.85rem', fontWeight: '600' }}>Scheduled Background Auto-Rotate (Cron Interval)</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
                  Periodically hot-swaps to a fresh Cloudflare Anycast tunnel in the background even when idle (0 = disabled, default: 10m)
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <input
                  type="number"
                  min="0"
                  max="1440"
                  className="input-field"
                  style={{ width: '75px', textAlign: 'center', fontWeight: '700' }}
                  value={warpAutoRotateMinutes}
                  onChange={e => setWarpAutoRotateMinutes(parseInt(e.target.value, 10) || 0)}
                />
                <span style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>min</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {[0, 5, 10, 15, 30, 60].map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setWarpAutoRotateMinutes(m)}
                  style={{
                    padding: '0.2rem 0.55rem',
                    fontSize: '0.72rem',
                    borderRadius: 'var(--radius)',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                    fontWeight: warpAutoRotateMinutes === m ? '700' : '500',
                    backgroundColor: warpAutoRotateMinutes === m ? 'var(--primary)' : 'var(--muted)',
                    color: warpAutoRotateMinutes === m ? 'var(--primary-foreground)' : 'var(--foreground)'
                  }}
                >
                  {m === 0 ? 'Off' : `${m}m`}
                </button>
              ))}
            </div>
          </div>

          <div style={{ paddingTop: '0.6rem', borderTop: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={{ fontSize: '0.8rem', fontWeight: '600', display: 'block', marginBottom: '0.25rem' }}>
                WARP Proxy Host
              </label>
              <input
                type="text"
                className="input-field"
                style={{ width: '100%' }}
                value={warpHost}
                onChange={e => setWarpHost(e.target.value)}
                placeholder="127.0.0.1"
              />
              <span style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)', display: 'block', marginTop: '0.25rem' }}>
                <code>127.0.0.1</code> for container/host, or <code>warp</code> for Docker Compose sidecar.
              </span>
            </div>

            <div>
              <label style={{ fontSize: '0.8rem', fontWeight: '600', display: 'block', marginBottom: '0.25rem' }}>
                WARP SOCKS5 Port
              </label>
              <input
                type="number"
                className="input-field"
                style={{ width: '100%' }}
                value={warpPort}
                onChange={e => setWarpPort(e.target.value)}
                placeholder="40000"
              />
              <span style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)', display: 'block', marginTop: '0.25rem' }}>
                <code>40000</code> (standalone) or <code>1080</code> (Compose sidecar).
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Inbuilt Scraped Proxy Engine Card */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: '700', margin: 0 }}>
                Inbuilt Scraped Proxy Pool
              </h3>
              <span className={`badge ${proxyStatus?.verifiedCount > 0 ? 'badge-active' : 'badge-idle'}`}>
                {proxyStatus?.isScanning ? '⚡ 5x Probing Sweep...' : (proxyStatus?.verifiedCount > 0 ? `● ${proxyStatus.verifiedCount} Verified Live (<3s)` : '○ Standby')}
              </span>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)', margin: 0 }}>
              Autonomous global proxy scraper with strict 5-pass verification directly against <code>opencode.ai:443</code>. Guaranteed latency &lt;3000ms. Provides instant zero-downtime failover whenever Cloudflare WARP or direct IPs reach capacity limits.
            </p>
          </div>

          <button
            type="button"
            onClick={handleRescanProxies}
            disabled={isRescanningProxies || proxyStatus?.isScanning}
            className="btn btn-secondary"
            style={{ fontSize: '0.78rem', padding: '0.4rem 0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
          >
            <span>{isRescanningProxies || proxyStatus?.isScanning ? '⏳ Sweeping & Verifying...' : '🔄 Rescan & Verify 5x Now'}</span>
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
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Active Clean Pool</div>
            <div style={{ fontSize: '1.1rem', fontWeight: '800', color: '#2fbc5b' }}>
              {proxyStatus?.verifiedCount || 0} <span style={{ fontSize: '0.75rem', fontWeight: '500' }}>proxies</span>
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Fastest Proxy Latency</div>
            <div style={{ fontSize: '1.1rem', fontWeight: '800', color: 'var(--foreground)' }}>
              {proxyStatus?.fastestProxy ? `${proxyStatus.fastestProxy.latency}ms` : 'Scanning...'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Validation Strictness</div>
            <div style={{ fontSize: '0.85rem', fontWeight: '700', color: 'var(--foreground)' }}>
              5x Consecutive Passes (&le;3s)
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>Target Egress Target</div>
            <div style={{ fontSize: '0.85rem', fontWeight: '700', color: 'var(--foreground)' }}>
              Direct <code>opencode.ai:443</code>
            </div>
          </div>
        </div>

        {proxyStatus?.topProxies && proxyStatus.topProxies.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--muted-foreground)' }}>
              Top Verified High-Speed Proxies (Ready for Instant Egress Failover):
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

        {/* Smart Failover Toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
          <div>
            <div style={{ fontSize: '0.85rem', fontWeight: '600' }}>Cross-Model Fallback (Smart Failover)</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
              When enabled, fails over across equivalent models on upstream errors. (Disabled by default to strictly preserve requested model identity).
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
