import React, { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import Overview from './pages/Overview';
import Playground from './pages/Playground';
import ApiKeys from './pages/ApiKeys';
import Models from './pages/Models';
import Settings from './pages/Settings';
import SparkLattice from './components/originkit/ui/spark-lattice';
import { FiServer, FiKey, FiLock, FiUser, FiZap, FiCheck } from './components/Icons';

// Originkit Spark Lattice & Ambient Floating Background (Mounted once, zero flicker)
const AppBackground = React.memo(({ theme }) => {
  const isDark = theme === 'dark';
  return (
    <div
      className="spark-lattice-bg"
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 0,
        overflow: 'hidden'
      }}
    >
      <SparkLattice
        background={isDark ? '#02080e' : '#f3faff'}
        lineColor={isDark ? '#09151e' : '#d8e5ef'}
        accent={isDark ? '#2fbc5b' : '#00a33d'}
        size={116}
        lights={10}
        speed={48}
        trail={3}
        glow={85}
        hover={100}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          minWidth: 0,
          minHeight: 0
        }}
      />
      <div className="ambient-bg-container" style={{ opacity: isDark ? 0.35 : 0.25 }}>
        <div className="ambient-orb ambient-orb-1" />
        <div className="ambient-orb ambient-orb-2" />
        <div className="ambient-orb ambient-orb-3" />
      </div>
    </div>
  );
});

export default function App() {
  const [activeTab, setActiveTab] = useState('overview');
  const [theme, setTheme] = useState(localStorage.getItem('o2p_theme') || 'dark');
  const [token, setToken] = useState(localStorage.getItem('o2p_token') || '');

  // Login form state
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // App Data States
  const [stats, setStats] = useState(null);
  const [keys, setKeys] = useState([]);
  const [modelsData, setModelsData] = useState({ models: [], last_synced: null });
  const [settings, setSettings] = useState({});
  const [notifications, setNotifications] = useState([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const fetchingRef = useRef(false);

  // Theme Sync
  useEffect(() => {
    document.body.className = theme;
    localStorage.setItem('o2p_theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(t => t === 'dark' ? 'light' : 'dark');
  };

  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  // Login Handler
  const handleLogin = async (e) => {
    e.preventDefault();
    setIsLoggingIn(true);
    setLoginError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUser, password: loginPass })
      });
      const data = await res.json();
      if (res.ok && data.token) {
        setToken(data.token);
        localStorage.setItem('o2p_token', data.token);
      } else {
        setLoginError(data.error || 'Authentication failed');
      }
    } catch (err) {
      setLoginError('Unable to connect to gateway: ' + err.message);
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Logout Handler
  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders });
    } catch (e) {}
    setToken('');
    localStorage.removeItem('o2p_token');
  };

  // Sync All Data
  const fetchAllData = async () => {
    if (!token || fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      // Stats
      const statsRes = await fetch('/api/stats', { headers: authHeaders });
      if (statsRes.status === 401) {
        handleLogout();
        return;
      }
      if (statsRes.ok) setStats(await statsRes.json());

      // Keys
      const keysRes = await fetch('/api/keys', { headers: authHeaders });
      if (keysRes.ok) {
        const kData = await keysRes.json();
        setKeys(Array.isArray(kData) ? kData : (kData ? [kData] : []));
      }

      // Models
      const modelsRes = await fetch('/api/models', { headers: authHeaders });
      if (modelsRes.ok) setModelsData(await modelsRes.json());

      // Settings (refresh periodically unless user is actively on the settings tab)
      if (activeTab !== 'settings') {
        const settingsRes = await fetch('/api/settings', { headers: authHeaders });
        if (settingsRes.ok) setSettings(await settingsRes.json());
      }

      // Notifications
      const notifRes = await fetch('/api/notifications', { headers: authHeaders });
      if (notifRes.ok) {
        const notifData = await notifRes.json();
        setNotifications(notifData.items || []);
      }
    } catch (e) {
      console.warn('Sync error:', e.message);
    } finally {
      fetchingRef.current = false;
    }
  };

  useEffect(() => {
    if (token) {
      fetchAllData();
      const interval = setInterval(fetchAllData, 5000);
      return () => clearInterval(interval);
    }
  }, [token]);

  // Actions
  const handleDiscoverModels = async () => {
    setIsDiscovering(true);
    try {
      const res = await fetch('/api/models/discover', { method: 'POST', headers: authHeaders });
      const data = await res.json();
      if (data.models) {
        setModelsData({ models: data.models, last_synced: data.last_synced });
      }
      fetchAllData();
    } catch (e) {
      alert('Model discovery failed: ' + e.message);
    } finally {
      setIsDiscovering(false);
    }
  };

  const handleCheckUpdate = async () => {
    setIsCheckingUpdate(true);
    try {
      const res = await fetch('/api/settings/check-update', { method: 'POST', headers: authHeaders });
      const data = await res.json();
      if (data.updated) {
        alert(`Upgraded OpenCode CLI from v${data.previous} to v${data.current}`);
      } else {
        alert(data.message || 'Already running latest OpenCode CLI');
      }
      fetchAllData();
      return data;
    } catch (e) {
      alert('Update check failed: ' + e.message);
      throw e;
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const handleCreateKey = async (payload) => {
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to create key');
    }
    fetchAllData();
  };

  const handleUpdateKey = async (id, updates) => {
    await fetch(`/api/keys/${id}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify(updates)
    });
    fetchAllData();
  };

  const handleDeleteKey = async (id) => {
    await fetch(`/api/keys/${id}`, {
      method: 'DELETE',
      headers: authHeaders
    });
    fetchAllData();
  };

  const handleSaveSettings = async (updates) => {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(updates)
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error || 'Failed to save settings');
    }
    const settingsRes = await fetch('/api/settings', { headers: authHeaders });
    if (settingsRes.ok) setSettings(await settingsRes.json());
  };

  const handleMarkNotificationsRead = async () => {
    await fetch('/api/notifications/read', { method: 'POST', headers: authHeaders });
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  };

  const handleClearNotifications = async () => {
    try {
      await fetch('/api/notifications/clear', { method: 'POST', headers: authHeaders });
    } catch (e) {}
    setNotifications([]);
  };

  // If Not Authenticated, Render Modern Glassmorphism Login View
  if (!token) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        position: 'relative'
      }}>
        <AppBackground theme={theme} />

        <div className="glass-card" style={{ width: '100%', maxWidth: '420px', padding: '2rem', position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', marginBottom: '1.5rem' }}>
            <div style={{
              width: '44px',
              height: '44px',
              borderRadius: 'var(--radius)',
              background: 'linear-gradient(135deg, var(--chart-1), var(--accent))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--primary-foreground)',
              boxShadow: '0 4px 16px rgba(47, 188, 91, 0.4)'
            }}>
              <FiServer size={22} />
            </div>
            <div>
              <h2 style={{ fontSize: '1.25rem', fontWeight: '800', letterSpacing: '-0.02em' }}>
                OpenCode2API
              </h2>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
                Gateway Control Plane & Playground
              </div>
            </div>
          </div>

          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '1.15rem' }}>
            {loginError && (
              <div style={{
                padding: '0.6rem 0.85rem',
                backgroundColor: 'rgba(242, 42, 54, 0.1)',
                border: '1px solid var(--destructive)',
                borderRadius: 'var(--radius)',
                color: 'var(--destructive)',
                fontSize: '0.82rem'
              }}>
                {loginError}
              </div>
            )}

            <div>
              <label style={{ fontSize: '0.8rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.4rem' }}>
                <FiUser size={13} style={{ color: 'var(--primary)' }} />
                <span>Admin Username</span>
              </label>
              <input
                type="text"
                className="input-field"
                style={{ width: '100%' }}
                value={loginUser}
                onChange={e => setLoginUser(e.target.value)}
                placeholder="Enter admin username..."
                autoComplete="username"
                required
              />
            </div>

            <div>
              <label style={{ fontSize: '0.8rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.4rem' }}>
                <FiLock size={13} style={{ color: 'var(--primary)' }} />
                <span>Admin Password</span>
              </label>
              <input
                type="password"
                className="input-field"
                style={{ width: '100%' }}
                value={loginPass}
                onChange={e => setLoginPass(e.target.value)}
                placeholder="Enter admin password..."
                autoComplete="current-password"
                required
              />
            </div>

            <button type="submit" className="btn-primary" style={{ width: '100%', marginTop: '0.5rem', padding: '0.7rem' }} disabled={isLoggingIn}>
              <FiZap size={16} />
              <span>{isLoggingIn ? 'Authenticating...' : 'Sign In to Gateway'}</span>
            </button>
          </form>
        </div>
      </div>
    );
  }

  const tabTitles = {
    overview: 'System Telemetry & Performance',
    playground: 'Interactive Model Playground & Vision Studio',
    keys: 'Multi-User API Keys & Quotas',
    models: 'Auto-Discovered Zen Models',
    settings: 'Gateway Configuration & Upstream Fingerprint'
  };

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', position: 'relative' }}>
      <AppBackground theme={theme} />

      {/* Sidebar */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        cliVersion={settings.client_version}
        egressMode={settings.egress_mode}
        rotatingEnabled={settings.rotating_proxy_enabled}
      />

      {/* Main Content Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100vh', overflow: 'hidden', position: 'relative', zIndex: 1 }}>
        <Header
          title={tabTitles[activeTab]}
          theme={theme}
          toggleTheme={toggleTheme}
          onLogout={handleLogout}
          notifications={notifications}
          onMarkNotificationsRead={handleMarkNotificationsRead}
          onClearNotifications={handleClearNotifications}
        />

        <main style={{ flex: 1, padding: '1.75rem', overflowY: 'auto' }}>
          {activeTab === 'overview' && (
            <Overview stats={stats} onRefresh={fetchAllData} />
          )}

          {activeTab === 'playground' && (
            <Playground
              models={modelsData.models}
              token={token}
            />
          )}

          {activeTab === 'keys' && (
            <ApiKeys
              keys={keys}
              models={modelsData.models}
              onCreateKey={handleCreateKey}
              onUpdateKey={handleUpdateKey}
              onDeleteKey={handleDeleteKey}
            />
          )}

          {activeTab === 'models' && (
            <Models
              models={modelsData.models}
              lastSynced={modelsData.last_synced}
              onDiscoverModels={handleDiscoverModels}
              isDiscovering={isDiscovering}
            />
          )}

          {activeTab === 'settings' && (
            <Settings
              settings={settings}
              onSaveSettings={handleSaveSettings}
              onCheckUpdate={handleCheckUpdate}
              isCheckingUpdate={isCheckingUpdate}
            />
          )}
        </main>
      </div>
    </div>
  );
}
