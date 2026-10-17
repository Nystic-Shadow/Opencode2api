import React from 'react';
import { FiCheck } from './Icons';

export default function CustomCheckbox({
  checked = false,
  onChange,
  label,
  description,
  disabled = false,
  style = {},
  id
}) {
  const handleClick = (e) => {
    e.stopPropagation();
    if (!disabled && onChange) {
      onChange(!checked);
    }
  };

  return (
    <div
      onClick={handleClick}
      style={{
        display: 'inline-flex',
        alignItems: description ? 'flex-start' : 'center',
        gap: '0.65rem',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        userSelect: 'none',
        ...style
      }}
    >
      {/* Custom Box */}
      <div
        role="checkbox"
        aria-checked={checked}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handleClick(e);
          }
        }}
        style={{
          width: '18px',
          height: '18px',
          borderRadius: 'calc(var(--radius) - 4px)',
          border: checked ? '1.5px solid var(--primary)' : '1.5px solid var(--border)',
          backgroundColor: checked ? 'var(--primary)' : 'var(--input)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          marginTop: description ? '2px' : '0px',
          transition: 'all 0.15s cubic-bezier(0.4, 0, 0.2, 1)',
          boxShadow: checked ? '0 0 10px rgba(47, 188, 91, 0.35)' : 'none',
          outline: 'none'
        }}
      >
        <FiCheck
          size={12}
          style={{
            color: 'var(--primary-foreground)',
            strokeWidth: 3,
            transform: checked ? 'scale(1)' : 'scale(0)',
            opacity: checked ? 1 : 0,
            transition: 'all 0.15s cubic-bezier(0.4, 0, 0.2, 1)'
          }}
        />
      </div>

      {/* Label & Description */}
      {(label || description) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
          {label && (
            <span style={{
              fontSize: '0.85rem',
              fontWeight: checked ? '600' : '500',
              color: 'var(--foreground)',
              transition: 'color 0.15s ease'
            }}>
              {label}
            </span>
          )}
          {description && (
            <span style={{
              fontSize: '0.74rem',
              color: 'var(--muted-foreground)',
              lineHeight: 1.35
            }}>
              {description}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
