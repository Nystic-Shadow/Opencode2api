import React from 'react';
import { FiActivity, FiKey, FiBox, FiSettings, FiServer, FiShield, FiPlay } from './Icons';

export default function Sidebar({ activeTab, setActiveTab, cliVersion }) {
  const tabs = [
    { id: 'overview', label: 'Overview', icon: FiActivity },
    { id: 'playground', label: 'Playground', icon: FiPlay },
    { id: 'keys', label: 'API Keys', icon: FiKey },
    { id: 'models', label: 'Models Roster', icon: FiBox },
    { id: 'settings', label: 'Settings', icon: FiSettings }
  ];

  return (
    <aside style={{
      width: '260px',
      backgroundColor: 'var(--sidebar)',
      borderRight: '1px solid var(--sidebar-border)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      position: 'sticky',
      top: 0,
      height: '100vh',
      zIndex: 40
    }}>
      {/* Brand Header */}
      <div style={{
        padding: '1.5rem',
        borderBottom: '1px solid var(--sidebar-border)',
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem'
      }}>
        <div style={{
          width: '32px',
          height: '32px',
          borderRadius: 'var(--radius)',
          backgroundColor: 'var(--primary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--primary-foreground)'
        }}>
          <FiServer size={18} />
        </div>
        <div>
          <div style={{ fontSize: '0.95rem', fontWeight: '700', letterSpacing: '-0.02em', color: 'var(--sidebar-foreground)' }}>
            OPENCODE2API
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: 'var(--accent)' }}></span>
            CLI v{cliVersion || '2.1.4'} <span className="badge badge-success" style={{ padding: '0.1rem 0.35rem', fontSize: '0.62rem', marginLeft: '0.2rem' }}>v3.1.0</span>
          </div>
        </div>
      </div>

      {/* Nav List */}
      <nav style={{ padding: '1rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.35rem', flex: 1 }}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.65rem 0.85rem',
                borderRadius: 'var(--radius)',
                border: 'none',
                backgroundColor: isActive ? 'var(--sidebar-accent)' : 'transparent',
                color: isActive ? 'var(--sidebar-accent-foreground)' : 'var(--muted-foreground)',
                fontWeight: isActive ? '600' : '500',
                fontSize: '0.875rem',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s ease'
              }}
            >
              <Icon size={16} color={isActive ? 'var(--primary)' : 'currentColor'} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Footer Info */}
      <div style={{
        padding: '0.85rem 1rem',
        borderTop: '1px solid var(--sidebar-border)',
        fontSize: '0.72rem',
        color: 'var(--muted-foreground)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.2rem' }}>
          <FiShield size={12} color="var(--primary)" />
          <span style={{ fontWeight: '600', color: 'var(--sidebar-foreground)' }}>Proxy Egress</span>
        </div>
        <div style={{ marginBottom: '0.5rem' }}>Explicit pool, fail-closed routing</div>
        <div style={{ 
          fontSize: '0.62rem', 
          color: 'var(--muted-foreground)', 
          opacity: 0.8,
          borderTop: '1px solid var(--sidebar-border)',
          paddingTop: '0.4rem'
        }}>
          ⚠️ For Educational &amp; Research Use Only
        </div>
      </div>
    </aside>
  );
}
