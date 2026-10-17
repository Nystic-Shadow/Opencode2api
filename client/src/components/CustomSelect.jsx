import React, { useState, useRef, useEffect } from 'react';
import { FiChevronDown, FiCheck, FiSearch } from './Icons';

export default function CustomSelect({
  value,
  onChange,
  options = [],
  placeholder = 'Select option...',
  icon: Icon = null,
  disabled = false,
  searchable = null,
  style = {},
  dropdownStyle = {},
  renderOption = null
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef(null);
  const searchInputRef = useRef(null);

  // Normalize options into standard { value, label, badge, description, icon } format
  const normalizedOptions = options.map(opt => {
    if (typeof opt === 'string' || typeof opt === 'number') {
      return { value: opt, label: String(opt) };
    }
    return {
      value: opt.value ?? opt.id,
      label: opt.label ?? opt.name ?? opt.id ?? String(opt.value),
      badge: opt.badge,
      description: opt.description,
      icon: opt.icon
    };
  });

  const selectedOption = normalizedOptions.find(opt => String(opt.value) === String(value));
  const isSearchable = searchable !== null ? searchable : normalizedOptions.length > 8;

  // Filter options based on search
  const filteredOptions = isSearchable && search.trim()
    ? normalizedOptions.filter(opt =>
        opt.label.toLowerCase().includes(search.toLowerCase()) ||
        String(opt.value).toLowerCase().includes(search.toLowerCase()) ||
        (opt.description && opt.description.toLowerCase().includes(search.toLowerCase()))
      )
    : normalizedOptions;

  // Close when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && isSearchable && searchInputRef.current) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
    if (!isOpen) {
      setSearch('');
    }
  }, [isOpen, isSearchable]);

  const handleSelect = (optVal) => {
    onChange?.(optVal);
    setIsOpen(false);
  };

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        userSelect: 'none',
        ...style,
        zIndex: isOpen ? 100 : (style?.zIndex || 'auto')
      }}
    >
      {/* Trigger Button */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setIsOpen(prev => !prev)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.6rem',
          padding: '0.55rem 0.85rem',
          backgroundColor: 'var(--input)',
          border: isOpen ? '1px solid var(--ring)' : '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          color: selectedOption ? 'var(--foreground)' : 'var(--muted-foreground)',
          fontSize: '0.85rem',
          fontWeight: '500',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          transition: 'all 0.15s ease',
          boxShadow: isOpen ? '0 0 0 3px rgba(47, 188, 91, 0.2)' : 'none',
          outline: 'none',
          textAlign: 'left'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0, flex: 1 }}>
          {Icon && <Icon size={14} style={{ color: 'var(--primary)', flexShrink: 0 }} />}
          {selectedOption?.icon && (
            <selectedOption.icon size={14} style={{ color: 'var(--primary)', flexShrink: 0 }} />
          )}
          <span style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1
          }}>
            {selectedOption ? selectedOption.label : placeholder}
          </span>
          {selectedOption?.badge && (
            <span style={{
              fontSize: '0.7rem',
              padding: '0.1rem 0.4rem',
              borderRadius: '9999px',
              backgroundColor: 'rgba(47, 188, 91, 0.15)',
              color: 'var(--primary)',
              fontWeight: '600',
              flexShrink: 0
            }}>
              {selectedOption.badge}
            </span>
          )}
        </div>

        <FiChevronDown
          size={14}
          style={{
            color: 'var(--muted-foreground)',
            transition: 'transform 0.2s ease',
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            flexShrink: 0
          }}
        />
      </button>

      {/* Popover Dropdown */}
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 5px)',
            left: 0,
            right: 0,
            zIndex: 999,
            backgroundColor: 'var(--popover)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            boxShadow: '0 16px 36px rgba(0, 0, 0, 0.35)',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            maxHeight: '280px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            animation: 'fadeIn 0.15s ease-out',
            ...dropdownStyle
          }}
        >
          {/* Search Box when searchable */}
          {isSearchable && (
            <div style={{
              padding: '0.5rem',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.45rem',
              backgroundColor: 'rgba(0, 0, 0, 0.05)'
            }}>
              <FiSearch size={13} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                onClick={e => e.stopPropagation()}
                style={{
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--foreground)',
                  fontSize: '0.8rem',
                  padding: '0.2rem 0'
                }}
              />
            </div>
          )}

          {/* Options List */}
          <div style={{
            overflowY: 'auto',
            padding: '0.35rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.15rem'
          }}>
            {filteredOptions.length === 0 ? (
              <div style={{
                padding: '0.75rem',
                fontSize: '0.8rem',
                color: 'var(--muted-foreground)',
                textAlign: 'center'
              }}>
                No matches found
              </div>
            ) : (
              filteredOptions.map(opt => {
                const isSelected = String(opt.value) === String(value);
                return (
                  <div
                    key={String(opt.value)}
                    onClick={() => handleSelect(opt.value)}
                    style={{
                      padding: '0.45rem 0.65rem',
                      borderRadius: 'calc(var(--radius) - 2px)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '0.5rem',
                      cursor: 'pointer',
                      fontSize: '0.82rem',
                      color: isSelected ? 'var(--primary)' : 'var(--foreground)',
                      backgroundColor: isSelected ? 'rgba(47, 188, 91, 0.12)' : 'transparent',
                      fontWeight: isSelected ? '600' : '400',
                      transition: 'all 0.12s ease'
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = 'var(--muted)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    {renderOption ? (
                      renderOption(opt, isSelected)
                    ) : (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', minWidth: 0, flex: 1 }}>
                          {opt.icon && <opt.icon size={13} style={{ flexShrink: 0, color: 'var(--primary)' }} />}
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {opt.label}
                          </span>
                          {opt.badge && (
                            <span style={{
                              fontSize: '0.68rem',
                              padding: '0.05rem 0.35rem',
                              borderRadius: '9999px',
                              backgroundColor: 'rgba(47, 188, 91, 0.12)',
                              color: 'var(--primary)',
                              fontWeight: '600',
                              flexShrink: 0
                            }}>
                              {opt.badge}
                            </span>
                          )}
                        </div>
                        {isSelected && (
                          <FiCheck size={14} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                        )}
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
