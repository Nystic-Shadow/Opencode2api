import React, { useState } from 'react';
import { FiRefreshCw, FiSearch, FiCopy, FiCheck, FiCpu, FiEye, FiActivity, FiLayers } from '../components/Icons';

export default function Models({ models = [], lastSynced, onDiscoverModels, isDiscovering }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [copiedId, setCopiedId] = useState(null);

  const handleCopy = (id) => {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const filtered = (models || []).filter(m => {
    const term = searchTerm.toLowerCase();
    return m.id.toLowerCase().includes(term) ||
           (m.name && m.name.toLowerCase().includes(term)) ||
           (m.upstream_id && m.upstream_id.toLowerCase().includes(term));
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Top Banner & Action */}
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: '700' }}>OpenCode Zen Models Roster</h2>
            <span className="badge badge-success">{models.length} Discovered</span>
          </div>
          <p style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>
            All free suffixes have been automatically stripped so you can address models directly without the <code>-free</code> keyword.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {lastSynced && (
            <span style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
              Synced {new Date(lastSynced).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            className="btn-primary"
            onClick={onDiscoverModels}
            disabled={isDiscovering}
          >
            <FiRefreshCw size={15} className={isDiscovering ? 'spin' : ''} />
            <span>{isDiscovering ? 'Discovering Models...' : 'Discover Models'}</span>
          </button>
        </div>
      </div>

      {/* Search Filter Bar */}
      <div style={{ position: 'relative' }}>
        <FiSearch size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-foreground)' }} />
        <input
          type="text"
          className="input-field"
          style={{ width: '100%', paddingLeft: '2.5rem' }}
          placeholder="Filter discovered models by name or capability..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
        />
      </div>

      {/* Models Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        gap: '1rem'
      }}>
        {filtered.map((m) => (
          <div key={m.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: '0.95rem', fontWeight: '700', color: 'var(--card-foreground)' }}>
                  {m.name || m.id}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.2rem' }}>
                  <code style={{ fontSize: '0.8rem', color: 'var(--primary)', fontWeight: '600' }}>
                    {m.id}
                  </code>
                  <button
                    onClick={() => handleCopy(m.id)}
                    style={{ background: 'none', border: 'none', color: copiedId === m.id ? 'var(--primary)' : 'var(--muted-foreground)', cursor: 'pointer' }}
                    title="Copy Model ID"
                  >
                    {copiedId === m.id ? <FiCheck size={13} /> : <FiCopy size={13} />}
                  </button>
                </div>
              </div>

              <span className="badge badge-success">Free Tier</span>
            </div>

            <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', lineHeight: 1.4 }}>
              {m.description || 'OpenCode Zen high-performance free model.'}
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: 'auto', paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
              <span className="badge badge-muted" title="Context Length">
                <FiLayers size={11} style={{ marginRight: '4px' }} />
                {(m.context_window || 200000).toLocaleString()} ctx
              </span>

              {m.supports_vision && (
                <span className="badge badge-muted" style={{ borderColor: 'rgba(0, 131, 224, 0.4)', color: 'var(--chart-2)' }} title="Vision / Multimodal Supported">
                  <FiEye size={11} style={{ marginRight: '4px' }} />
                  Vision
                </span>
              )}

              {m.supports_reasoning && (
                <span className="badge badge-muted" style={{ borderColor: 'rgba(162, 100, 246, 0.4)', color: 'var(--chart-4)' }} title="Thinking / Reasoning Stream Supported">
                  <FiActivity size={11} style={{ marginRight: '4px' }} />
                  Thinking
                </span>
              )}

              {m.supports_tools && (
                <span className="badge badge-muted" style={{ borderColor: 'rgba(244, 104, 0, 0.4)', color: 'var(--chart-3)' }} title="Function Tool Calling Supported">
                  <FiCpu size={11} style={{ marginRight: '4px' }} />
                  Tools
                </span>
              )}
            </div>

            <div style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)', display: 'flex', justifyContent: 'space-between' }}>
              <span>Upstream: <code>{m.upstream_id}</code></span>
            </div>
          </div>
        ))}
      </div>

      <style>{`
        .spin {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
