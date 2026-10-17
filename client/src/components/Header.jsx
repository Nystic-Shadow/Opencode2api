import React, { useState } from 'react';
import { FiBell, FiSun, FiMoon, FiLogOut, FiCheck, FiRefreshCw, FiZap, FiTrash2 } from './Icons';

export default function Header({
  title,
  theme,
  toggleTheme,
  onLogout,
  notifications,
  onMarkNotificationsRead,
  onClearNotifications
}) {
  const [showNotifications, setShowNotifications] = useState(false);
  const unreadCount = (notifications || []).filter(n => !n.read).length;

  return (
    <header style={{
      height: '64px',
      borderBottom: '1px solid var(--border)',
      backgroundColor: 'var(--glass-bg)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 1.5rem',
      position: 'relative',
      zIndex: 30
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <h1 style={{
          fontSize: '1.15rem',
          fontWeight: '700',
          letterSpacing: '-0.02em',
          color: 'var(--card-foreground)'
        }}>
          {title}
        </h1>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        {/* Notification Bell */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => {
              setShowNotifications(!showNotifications);
              if (!showNotifications && unreadCount > 0) {
                onMarkNotificationsRead?.();
              }
            }}
            style={{
              background: 'var(--input)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              color: 'var(--foreground)',
              padding: '0.45rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              transition: 'all 0.15s ease'
            }}
            title="System Notifications"
          >
            <FiBell size={16} />
            {unreadCount > 0 && (
              <span style={{
                position: 'absolute',
                top: '-4px',
                right: '-4px',
                backgroundColor: 'var(--primary)',
                color: 'var(--primary-foreground)',
                fontSize: '0.65rem',
                fontWeight: '700',
                borderRadius: '9999px',
                padding: '0.1rem 0.35rem',
                lineHeight: 1,
                boxShadow: '0 2px 6px rgba(47, 188, 91, 0.4)'
              }}>
                {unreadCount}
              </span>
            )}
          </button>

          {/* Notifications Dropdown */}
          {showNotifications && (
            <div style={{
              position: 'absolute',
              top: '46px',
              right: '0',
              width: '340px',
              maxHeight: '400px',
              overflowY: 'auto',
              backgroundColor: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              boxShadow: '0 16px 36px rgba(0,0,0,0.35)',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              padding: '0.85rem',
              zIndex: 100
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '0.75rem',
                paddingBottom: '0.5rem',
                borderBottom: '1px solid var(--border)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: '700', color: 'var(--foreground)' }}>
                    System Alerts
                  </span>
                  <span style={{
                    fontSize: '0.7rem',
                    padding: '0.05rem 0.4rem',
                    borderRadius: '9999px',
                    backgroundColor: 'var(--muted)',
                    color: 'var(--muted-foreground)'
                  }}>
                    {notifications?.length || 0}
                  </span>
                </div>

                {notifications && notifications.length > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onClearNotifications?.();
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                      background: 'none',
                      border: 'none',
                      color: 'var(--destructive)',
                      fontSize: '0.72rem',
                      fontWeight: '600',
                      cursor: 'pointer',
                      padding: '0.2rem 0.45rem',
                      borderRadius: 'calc(var(--radius) - 4px)',
                      transition: 'background 0.15s ease'
                    }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(242, 42, 54, 0.1)'}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                    title="Clear all alerts"
                  >
                    <FiTrash2 size={12} />
                    <span>Clear</span>
                  </button>
                )}
              </div>

              {(!notifications || notifications.length === 0) ? (
                <div style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)', textAlign: 'center', padding: '1.25rem 0.5rem' }}>
                  No system notifications yet.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {notifications.map(n => (
                    <div key={n.id} style={{
                      padding: '0.65rem',
                      borderRadius: 'var(--radius)',
                      backgroundColor: 'var(--muted)',
                      borderLeft: `3px solid ${n.type === 'update' ? 'var(--chart-2)' : n.type === 'success' ? 'var(--primary)' : 'var(--border)'}`,
                      fontSize: '0.8rem'
                    }}>
                      <div style={{ fontWeight: '600', marginBottom: '0.2rem', color: 'var(--foreground)' }}>
                        {n.title}
                      </div>
                      <div style={{ fontSize: '0.74rem', color: 'var(--muted-foreground)', lineHeight: 1.4 }}>
                        {n.message}
                      </div>
                      <div style={{ fontSize: '0.65rem', color: 'var(--muted-foreground)', marginTop: '0.35rem' }}>
                        {new Date(n.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Theme Toggle */}
        <button
          onClick={toggleTheme}
          style={{
            background: 'var(--input)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--foreground)',
            padding: '0.45rem',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.15s ease'
          }}
          title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        >
          {theme === 'dark' ? <FiSun size={16} /> : <FiMoon size={16} />}
        </button>

        {/* Logout Button */}
        <button
          onClick={onLogout}
          style={{
            background: 'var(--input)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--destructive)',
            padding: '0.45rem',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.15s ease'
          }}
          title="Sign Out"
        >
          <FiLogOut size={16} />
        </button>
      </div>
    </header>
  );
}
