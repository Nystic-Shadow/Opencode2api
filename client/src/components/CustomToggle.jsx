import React from 'react';

export default function CustomToggle({
  checked = false,
  onChange,
  disabled = false,
  label = null,
  description = null,
  style = {}
}) {
  const handleToggle = () => {
    if (!disabled && onChange) {
      onChange(!checked);
    }
  };

  return (
    <div
      onClick={handleToggle}
      style={{
        display: 'inline-flex',
        alignItems: description ? 'flex-start' : 'center',
        gap: '0.75rem',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        userSelect: 'none',
        ...style
      }}
    >
      <div
        role="switch"
        aria-checked={checked}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handleToggle();
          }
        }}
        style={{
          width: '38px',
          height: '22px',
          borderRadius: '9999px',
          backgroundColor: checked ? 'var(--primary)' : 'var(--input)',
          border: '1px solid var(--border)',
          position: 'relative',
          transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
          boxShadow: checked ? '0 0 12px rgba(47, 188, 91, 0.35)' : 'none',
          flexShrink: 0,
          marginTop: description ? '2px' : 0
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: '2px',
            left: checked ? '18px' : '2px',
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            backgroundColor: checked ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
            boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)'
          }}
        />
      </div>

      {(label || description) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
          {label && (
            <span style={{ fontSize: '0.85rem', fontWeight: checked ? '600' : '500', color: 'var(--foreground)' }}>
              {label}
            </span>
          )}
          {description && (
            <span style={{ fontSize: '0.74rem', color: 'var(--muted-foreground)', lineHeight: 1.35 }}>
              {description}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
