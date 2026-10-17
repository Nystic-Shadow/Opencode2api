import React, { useState } from 'react';
import {
  FiPlus,
  FiKey,
  FiCopy,
  FiTrash2,
  FiCheck,
  FiSliders,
  FiClock,
  FiActivity,
  FiShield,
  FiLock,
  FiUnlock,
  FiCheckSquare,
  FiCalendar,
  FiX
} from '../components/Icons';

import CustomSelect from '../components/CustomSelect';
import CustomCheckbox from '../components/CustomCheckbox';
import CustomToggle from '../components/CustomToggle';

export default function ApiKeys({ keys = [], models = [], onCreateKey, onUpdateKey, onDeleteKey }) {
  const [showModal, setShowModal] = useState(false);
  const [copiedId, setCopiedId] = useState(null);

  // New key form state
  const [keyName, setKeyName] = useState('');
  const [customSuffix, setCustomSuffix] = useState('');
  
  // Token Quota controls
  const [isUnlimitedTokens, setIsUnlimitedTokens] = useState(true);
  const [tokenUnit, setTokenUnit] = useState('M'); // 'K' or 'M'
  const [tokenValue, setTokenValue] = useState(1); // 1 M or 500 K
  
  // Rate Limiting controls
  const [isUnlimitedRate, setIsUnlimitedRate] = useState(true);
  const [rpmLimit, setRpmLimit] = useState(60);
  const [tpmUnit, setTpmUnit] = useState('K');
  const [tpmValue, setTpmValue] = useState(100);

  // Expiration & Model Scoping
  const [expirationOption, setExpirationOption] = useState('never'); // 'never', '7d', '30d', '90d'
  const [allowedModels, setAllowedModels] = useState([]); // Empty = all allowed
  const [restrictModels, setRestrictModels] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCopy = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Compute total raw tokens from unit and value
  const computeTotalBudget = () => {
    if (isUnlimitedTokens) return 0;
    const multiplier = tokenUnit === 'M' ? 1000000 : 1000;
    return Math.round((parseFloat(tokenValue) || 0) * multiplier);
  };

  // Compute raw TPM
  const computeTpmLimit = () => {
    if (isUnlimitedRate) return 0;
    const multiplier = tpmUnit === 'M' ? 1000000 : 1000;
    return Math.round((parseFloat(tpmValue) || 0) * multiplier);
  };

  const computeExpiresAt = () => {
    if (expirationOption === 'never') return null;
    const now = new Date();
    if (expirationOption === '7d') now.setDate(now.getDate() + 7);
    if (expirationOption === '30d') now.setDate(now.getDate() + 30);
    if (expirationOption === '90d') now.setDate(now.getDate() + 90);
    return now.toISOString();
  };

  const handleModelToggle = (modelId) => {
    setAllowedModels(prev => 
      prev.includes(modelId) ? prev.filter(m => m !== modelId) : [...prev, modelId]
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const budget = computeTotalBudget();
      const tpm = computeTpmLimit();
      const expiresAt = computeExpiresAt();

      await onCreateKey({
        name: keyName || 'API Key',
        custom_suffix: customSuffix,
        is_unlimited: isUnlimitedTokens && isUnlimitedRate,
        total_tokens_budget: budget,
        rpm_limit: isUnlimitedRate ? 0 : rpmLimit,
        tpm_limit: tpm,
        expires_at: expiresAt,
        allowed_models: restrictModels ? allowedModels : []
      });

      setShowModal(false);
      // Reset defaults
      setKeyName('');
      setCustomSuffix('');
      setIsUnlimitedTokens(true);
      setTokenUnit('M');
      setTokenValue(1);
      setIsUnlimitedRate(true);
      setExpirationOption('never');
      setRestrictModels(false);
      setAllowedModels([]);
    } catch (err) {
      alert('Failed to create key: ' + err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Top action bar */}
      <div className="glass-card" style={{ padding: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.15rem', fontWeight: '700' }}>Multi-User API Keys Management</h2>
          <p style={{ fontSize: '0.82rem', color: 'var(--muted-foreground)', marginTop: '0.2rem' }}>
            All keys carry the mandatory <code>O2P-</code> prefix with granular token budgets (K/M), sliding rate windows, and model permissions.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowModal(true)}>
          <FiPlus size={16} />
          <span>Create New API Key</span>
        </button>
      </div>

      {/* Keys Table Card */}
      <div className="glass-card" style={{ padding: '1.25rem', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--muted-foreground)' }}>
              <th style={{ padding: '0.75rem', fontWeight: '600' }}>Name & Key</th>
              <th style={{ padding: '0.75rem', fontWeight: '600' }}>Token Quota & Usage</th>
              <th style={{ padding: '0.75rem', fontWeight: '600' }}>Rate Limits</th>
              <th style={{ padding: '0.75rem', fontWeight: '600' }}>Model Scope</th>
              <th style={{ padding: '0.75rem', fontWeight: '600' }}>Expiration</th>
              <th style={{ padding: '0.75rem', fontWeight: '600' }}>Status</th>
              <th style={{ padding: '0.75rem', fontWeight: '600', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: '3rem', textAlign: 'center', color: 'var(--muted-foreground)' }}>
                  No API keys created yet. Click "Create New API Key" above to generate your first key.
                </td>
              </tr>
            ) : (
              keys.map((k) => {
                const used = k.tokens_count || 0;
                const budget = k.total_tokens_budget || 0;
                const percent = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
                const isExpired = k.expires_at && new Date(k.expires_at).getTime() < Date.now();

                return (
                  <tr key={k.id} style={{ borderBottom: '1px solid var(--border)', transition: 'background 0.15s ease' }}>
                    {/* Name & Key */}
                    <td style={{ padding: '0.85rem 0.75rem' }}>
                      <div style={{ fontWeight: '600', marginBottom: '0.2rem' }}>{k.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <code className="font-mono" style={{ background: 'var(--secondary)', padding: '0.15rem 0.4rem', borderRadius: '4px', fontSize: '0.75rem' }}>
                          {k.key.slice(0, 16)}...
                        </code>
                        <button
                          onClick={() => handleCopy(k.key, k.id)}
                          style={{ background: 'transparent', border: 'none', color: 'var(--muted-foreground)', cursor: 'pointer', display: 'flex' }}
                          title="Copy key"
                        >
                          {copiedId === k.id ? <FiCheck size={13} style={{ color: 'var(--primary)' }} /> : <FiCopy size={13} />}
                        </button>
                      </div>
                    </td>

                    {/* Token Quota & Usage Progress */}
                    <td style={{ padding: '0.85rem 0.75rem', minWidth: '180px' }}>
                      {budget === 0 ? (
                        <div>
                          <span className="badge badge-success" style={{ marginBottom: '0.25rem' }}>Unlimited Tokens</span>
                          <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
                            Used: {used.toLocaleString()} tokens
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '0.3rem' }}>
                            <span className="font-mono">{used.toLocaleString()}</span>
                            <span className="font-mono" style={{ color: 'var(--muted-foreground)' }}>
                              / {budget >= 1000000 ? `${(budget / 1000000).toFixed(1)}M` : `${Math.round(budget / 1000)}K`} ({percent}%)
                            </span>
                          </div>
                          <div className="liquid-progress-track">
                            <div
                              className="liquid-progress-fill"
                              style={{
                                width: `${percent}%`,
                                background: percent > 90 ? 'var(--destructive)' : 'linear-gradient(90deg, var(--chart-1), var(--accent))'
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </td>

                    {/* Rate Limits */}
                    <td style={{ padding: '0.85rem 0.75rem' }}>
                      {k.is_unlimited && (!k.rpm_limit && !k.tpm_limit) ? (
                        <span className="badge badge-muted">Unlimited Rate</span>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.75rem' }}>
                          {k.rpm_limit > 0 && <span className="font-mono">{k.rpm_limit} RPM</span>}
                          {k.tpm_limit > 0 && (
                            <span className="font-mono">
                              {k.tpm_limit >= 1000000 ? `${(k.tpm_limit / 1000000).toFixed(1)}M` : `${Math.round(k.tpm_limit / 1000)}K`} TPM
                            </span>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Model Scope */}
                    <td style={{ padding: '0.85rem 0.75rem' }}>
                      {k.allowed_models && k.allowed_models.length > 0 ? (
                        <span className="badge badge-info" title={k.allowed_models.join(', ')}>
                          {k.allowed_models.length} Model{k.allowed_models.length > 1 ? 's' : ''} Scoped
                        </span>
                      ) : (
                        <span className="badge badge-muted">All Free Models</span>
                      )}
                    </td>

                    {/* Expiration */}
                    <td style={{ padding: '0.85rem 0.75rem', fontSize: '0.75rem' }}>
                      {k.expires_at ? (
                        <span style={{ color: isExpired ? 'var(--destructive)' : 'inherit', fontWeight: isExpired ? '700' : 'normal' }}>
                          {isExpired ? 'Expired' : new Date(k.expires_at).toLocaleDateString()}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--muted-foreground)' }}>Never</span>
                      )}
                    </td>

                    {/* Status Toggle Switch */}
                    <td style={{ padding: '0.85rem 0.75rem' }}>
                      <CustomToggle
                        checked={k.enabled}
                        onChange={(val) => onUpdateKey(k.id, { enabled: val })}
                      />
                    </td>

                    {/* Delete Action */}
                    <td style={{ padding: '0.85rem 0.75rem', textAlign: 'right' }}>
                      <button
                        onClick={() => {
                          if (confirm(`Revoke and permanently delete key "${k.name}"?`)) {
                            onDeleteKey(k.id);
                          }
                        }}
                        style={{ background: 'transparent', border: 'none', color: 'var(--destructive)', cursor: 'pointer', padding: '0.3rem' }}
                        title="Delete Key"
                      >
                        <FiTrash2 size={16} />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Advanced Create Key Modal */}
      {showModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}>
          <div className="glass-card" style={{ maxWidth: '560px', width: '100%', maxHeight: '90vh', overflowY: 'auto', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FiKey size={18} style={{ color: 'var(--primary)' }} />
                <h3 style={{ fontSize: '1.15rem', fontWeight: '700' }}>Create Advanced API Key</h3>
              </div>
              <button
                onClick={() => setShowModal(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--muted-foreground)', cursor: 'pointer' }}
              >
                <FiX size={18} />
              </button>
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {/* Key Name & Suffix */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: '600', marginBottom: '0.4rem' }}>Key Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Production Agent"
                    className="input-field"
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: '600', marginBottom: '0.4rem' }}>
                    Custom Tag (Prefix: <code>O2P-</code>)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. dev or agent"
                    className="input-field"
                    value={customSuffix}
                    onChange={(e) => setCustomSuffix(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>

              {/* Token Quota Section (K / M Slider & Custom Number) */}
              <div style={{ background: 'var(--secondary)', padding: '1rem', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                  <div>
                    <div style={{ fontSize: '0.85rem', fontWeight: '700' }}>Token Allocation Budget</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
                      Set maximum total tokens this key can consume.
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.78rem', fontWeight: '600' }}>{isUnlimitedTokens ? 'Unlimited' : 'Budgeted'}</span>
                    <CustomToggle
                      checked={!isUnlimitedTokens}
                      onChange={(val) => setIsUnlimitedTokens(!val)}
                    />
                  </div>
                </div>

                {!isUnlimitedTokens && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', marginTop: '0.5rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <input
                        type="number"
                        min="1"
                        step={tokenUnit === 'M' ? '0.5' : '10'}
                        value={tokenValue}
                        onChange={(e) => setTokenValue(parseFloat(e.target.value) || 1)}
                        className="input-field"
                        style={{ width: '110px', fontWeight: '700', fontSize: '1rem' }}
                      />

                      {/* Unit Selector (K / M) */}
                      <div className="unit-pill-group">
                        <button
                          type="button"
                          className={`unit-pill-btn ${tokenUnit === 'K' ? 'active' : ''}`}
                          onClick={() => { setTokenUnit('K'); if (tokenValue < 10) setTokenValue(500); }}
                        >
                          K (Thousands)
                        </button>
                        <button
                          type="button"
                          className={`unit-pill-btn ${tokenUnit === 'M' ? 'active' : ''}`}
                          onClick={() => { setTokenUnit('M'); if (tokenValue > 100) setTokenValue(5); }}
                        >
                          M (Millions)
                        </button>
                      </div>

                      <div className="badge badge-success font-mono" style={{ marginLeft: 'auto', fontSize: '0.8rem' }}>
                        {computeTotalBudget().toLocaleString()} Tokens
                      </div>
                    </div>

                    {/* Interactive Slider */}
                    <div>
                      <input
                        type="range"
                        min={tokenUnit === 'M' ? 1 : 10}
                        max={tokenUnit === 'M' ? 100 : 1000}
                        step={tokenUnit === 'M' ? 1 : 10}
                        value={tokenValue}
                        onChange={(e) => setTokenValue(parseFloat(e.target.value))}
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--muted-foreground)', marginTop: '0.25rem' }}>
                        <span>{tokenUnit === 'M' ? '1M' : '10K'}</span>
                        <span>{tokenUnit === 'M' ? '50M' : '500K'}</span>
                        <span>{tokenUnit === 'M' ? '100M' : '1000K'}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Rate Limits Section (RPM & TPM) */}
              <div style={{ background: 'var(--secondary)', padding: '1rem', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                  <div>
                    <div style={{ fontSize: '0.85rem', fontWeight: '700' }}>Sliding Rate Window Limits</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
                      Enforce per-minute request and token limits.
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.78rem', fontWeight: '600' }}>{isUnlimitedRate ? 'Unlimited' : 'Limited'}</span>
                    <CustomToggle
                      checked={!isUnlimitedRate}
                      onChange={(val) => setIsUnlimitedRate(!val)}
                    />
                  </div>
                </div>

                {!isUnlimitedRate && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '0.5rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: '600', marginBottom: '0.3rem' }}>Requests / Min (RPM)</label>
                      <input
                        type="number"
                        min="1"
                        max="1000"
                        value={rpmLimit}
                        onChange={(e) => setRpmLimit(parseInt(e.target.value, 10) || 60)}
                        className="input-field"
                        style={{ width: '100%' }}
                      />
                    </div>

                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
                        <label style={{ fontSize: '0.78rem', fontWeight: '600' }}>Tokens / Min (TPM)</label>
                        <div className="unit-pill-group" style={{ height: '22px' }}>
                          <button
                            type="button"
                            className={`unit-pill-btn ${tpmUnit === 'K' ? 'active' : ''}`}
                            style={{ padding: '0 0.4rem', fontSize: '0.7rem' }}
                            onClick={() => setTpmUnit('K')}
                          >K</button>
                          <button
                            type="button"
                            className={`unit-pill-btn ${tpmUnit === 'M' ? 'active' : ''}`}
                            style={{ padding: '0 0.4rem', fontSize: '0.7rem' }}
                            onClick={() => setTpmUnit('M')}
                          >M</button>
                        </div>
                      </div>
                      <input
                        type="number"
                        min="1"
                        value={tpmValue}
                        onChange={(e) => setTpmValue(parseFloat(e.target.value) || 1)}
                        className="input-field"
                        style={{ width: '100%' }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Expiration Policy */}
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: '600', marginBottom: '0.4rem' }}>
                  Expiration Policy
                </label>
                <CustomSelect
                  value={expirationOption}
                  onChange={setExpirationOption}
                  options={[
                    { value: 'never', label: 'Never Expire (Permanent)' },
                    { value: '7d', label: 'Expire in 7 Days' },
                    { value: '30d', label: 'Expire in 30 Days' },
                    { value: '90d', label: 'Expire in 90 Days' }
                  ]}
                  searchable={false}
                />
              </div>

              {/* Model Restrictions */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                  <label style={{ fontSize: '0.8rem', fontWeight: '600' }}>Model Access Control</label>
                  <CustomCheckbox
                    checked={restrictModels}
                    onChange={setRestrictModels}
                    label="Restrict to specific models"
                  />
                </div>

                {restrictModels && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', maxHeight: '110px', overflowY: 'auto', padding: '0.5rem', background: 'var(--secondary)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                    {models.map(m => (
                      <button
                        type="button"
                        key={m.id}
                        onClick={() => handleModelToggle(m.id)}
                        className={`badge ${allowedModels.includes(m.id) ? 'badge-success' : 'badge-muted'}`}
                        style={{ cursor: 'pointer', padding: '0.3rem 0.6rem' }}
                      >
                        {m.id}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Modal Buttons */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Generating...' : 'Create O2P Key'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
