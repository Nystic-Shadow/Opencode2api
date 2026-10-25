const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

function atomicWriteJson(file, value, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
    throw err;
  }
}

class ApiKeyManager {
  constructor() {
    this.keys = [];
    this.rateWindows = new Map(); // keyId -> { timestamps: [], tokenBuckets: [] }
    this.globalReqs = [];
    this.globalTokens = [];
    this.saveTimer = null;
    this.dirty = false;
    this.load();
  }

  createMasterKey() {
    const envKey = (process.env.INITIAL_KEY || process.env.MASTER_KEY || '').trim();
    const initialKey = envKey || ('O2P-' + crypto.randomBytes(20).toString('hex'));
    this.keys = [
      {
        id: 'key_master',
        name: 'Master Admin Key',
        key: initialKey,
        rpm_limit: 0,
        tpm_limit: 0,
        total_tokens_budget: 0,
        is_unlimited: true,
        enabled: true,
        created_at: new Date().toISOString(),
        last_used: null,
        requests_count: 0,
        tokens_count: 0
      }
    ];
    this.save();
    return this.keys[0];
  }

  load() {
    try {
      if (fs.existsSync(KEYS_FILE)) {
        const raw = fs.readFileSync(KEYS_FILE, 'utf8');
        this.keys = JSON.parse(raw);
      }
      if (!Array.isArray(this.keys) || this.keys.length === 0) {
        // Generate a cryptographically secure master key with O2P- prefix
        this.createMasterKey();
      } else {
        // Upgrade legacy insecure default master keys if present and not intentionally configured in env
        const envKey = (process.env.INITIAL_KEY || process.env.MASTER_KEY || '').trim();
        let changed = false;
        for (const k of this.keys) {
          if (k.key === 'O2P-master-key' && envKey !== 'O2P-master-key') {
            k.key = 'O2P-' + crypto.randomBytes(20).toString('hex');
            changed = true;
          }
        }
        if (changed) this.save();
      }
    } catch (e) {
      console.warn('[Keys] Error loading keys, recovering with a new master key:', e.message);
      try {
        if (fs.existsSync(KEYS_FILE)) {
          fs.renameSync(KEYS_FILE, `${KEYS_FILE}.corrupt-${Date.now()}`);
        }
      } catch (backupErr) {}
      this.keys = [];
      this.createMasterKey();
    }
  }

  save() {
    try {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      atomicWriteJson(KEYS_FILE, this.keys);
      this.dirty = false;
    } catch (e) {
      this.dirty = true;
      console.error('[Keys] Error saving keys:', e.message);
    }
  }

  scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 250);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) this.save();
  }

  validateToken(token) {
    if (!token) {
      return { valid: false, status: 401, error: 'Missing API key. Provide Authorization: Bearer O2P-... or x-api-key: O2P-...' };
    }

    const envMaster = (process.env.INITIAL_KEY || process.env.MASTER_KEY || '').trim();
    const key = this.keys.find(k => k.key === token) ||
      (envMaster && token === envMaster
        ? { id: 'key_master', name: 'Master Admin Key', key: token, enabled: true, is_unlimited: true }
        : null);

    if (!key) {
      return { valid: false, status: 401, error: 'Invalid API key.' };
    }

    if (!key.enabled) {
      return { valid: false, status: 403, error: 'API key has been disabled by admin.' };
    }

    if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
      return { valid: false, status: 403, error: `API key expired on ${new Date(key.expires_at).toLocaleDateString()}.` };
    }

    return { valid: true, key };
  }

  getAll() {
    return this.keys.map(k => ({
      id: k.id,
      name: k.name,
      key: k.key,
      rpm_limit: k.rpm_limit || 0,
      tpm_limit: k.tpm_limit || 0,
      total_tokens_budget: k.total_tokens_budget || 0, // 0 = unlimited
      is_unlimited: !!k.is_unlimited,
      expires_at: k.expires_at || null,
      allowed_models: k.allowed_models || [],
      enabled: k.enabled !== false,
      created_at: k.created_at,
      last_used: k.last_used,
      requests_count: k.requests_count || 0,
      tokens_count: k.tokens_count || 0
    }));
  }

  createKey({
    name = 'New Key',
    rpm_limit = 0,
    tpm_limit = 0,
    total_tokens_budget = 0,
    is_unlimited = true,
    expires_at = null,
    allowed_models = [],
    custom_suffix = ''
  }) {
    let keyString = 'O2P-';
    if (custom_suffix && custom_suffix.trim()) {
      keyString += custom_suffix.trim().replace(/[^a-zA-Z0-9_-]/g, '') + '-' + crypto.randomBytes(6).toString('hex');
    } else {
      keyString += crypto.randomBytes(16).toString('hex');
    }

    const newKey = {
      id: 'key_' + crypto.randomUUID(),
      name: name || 'API User',
      key: keyString,
      rpm_limit: is_unlimited ? 0 : (parseInt(rpm_limit, 10) || 0),
      tpm_limit: is_unlimited ? 0 : (parseInt(tpm_limit, 10) || 0),
      total_tokens_budget: is_unlimited ? 0 : (parseInt(total_tokens_budget, 10) || 0),
      is_unlimited: !!is_unlimited,
      expires_at: expires_at || null,
      allowed_models: Array.isArray(allowed_models) ? allowed_models : [],
      enabled: true,
      created_at: new Date().toISOString(),
      last_used: null,
      requests_count: 0,
      tokens_count: 0
    };

    this.keys.push(newKey);
    this.save();
    return newKey;
  }

  updateKey(id, updates) {
    const key = this.keys.find(k => k.id === id);
    if (!key) return null;

    if (updates.name !== undefined) key.name = updates.name;
    if (updates.enabled !== undefined) key.enabled = !!updates.enabled;
    if (updates.is_unlimited !== undefined) key.is_unlimited = !!updates.is_unlimited;
    if (updates.rpm_limit !== undefined) key.rpm_limit = parseInt(updates.rpm_limit, 10) || 0;
    if (updates.tpm_limit !== undefined) key.tpm_limit = parseInt(updates.tpm_limit, 10) || 0;
    if (updates.total_tokens_budget !== undefined) key.total_tokens_budget = parseInt(updates.total_tokens_budget, 10) || 0;
    if (updates.expires_at !== undefined) key.expires_at = updates.expires_at;
    if (updates.allowed_models !== undefined) key.allowed_models = updates.allowed_models;

    this.save();
    return key;
  }

  deleteKey(id) {
    const idx = this.keys.findIndex(k => k.id === id);
    if (idx !== -1) {
      this.keys.splice(idx, 1);
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Validate key and check rate limits, token quotas, and permissions.
   * Returns { valid: true, key } or { valid: false, error, status }
   */
  validateAndCheckLimit(token, requestedModel = null) {
    const tokenResult = this.validateToken(token);
    if (!tokenResult.valid) return tokenResult;
    const key = tokenResult.key;

    // Global rate limits are optional and apply across all keys.
    const now = Date.now();
    const cutoff = now - 60000;
    this.globalReqs = this.globalReqs.filter(t => t > cutoff);
    this.globalTokens = this.globalTokens.filter(e => e.t > cutoff);

    const globalRpm = Math.max(0, parseInt(config.get('global_rpm_limit'), 10) || 0);
    if (globalRpm > 0 && this.globalReqs.length >= globalRpm) {
      return { valid: false, status: 429, error: `Global rate limit exceeded: RPM cap of ${globalRpm} reached.` };
    }

    const globalTpm = Math.max(0, parseInt(config.get('global_tpm_limit'), 10) || 0);
    const globalTokensUsed = this.globalTokens.reduce((acc, curr) => acc + curr.count, 0);
    if (globalTpm > 0 && globalTokensUsed >= globalTpm) {
      return { valid: false, status: 429, error: `Global rate limit exceeded: TPM cap of ${globalTpm} reached.` };
    }

    // Total Token Quota check
    if (!key.is_unlimited && key.total_tokens_budget > 0) {
      if ((key.tokens_count || 0) >= key.total_tokens_budget) {
        return {
          valid: false,
          status: 429,
          error: `Token budget exhausted: key reached limit of ${key.total_tokens_budget.toLocaleString()} tokens.`
        };
      }
    }

    // Model restrictions check
    if (key.allowed_models && key.allowed_models.length > 0 && requestedModel) {
      if (!key.allowed_models.includes(requestedModel)) {
        return {
          valid: false,
          status: 403,
          error: `Access denied: model '${requestedModel}' is not in the allowed models list for this key.`
        };
      }
    }

    // Rate Limiting Check (if not unlimited)
    if (!key.is_unlimited && (key.rpm_limit > 0 || key.tpm_limit > 0)) {
      const now = Date.now();
      let window = this.rateWindows.get(key.id);
      if (!window) {
        window = { reqs: [], tokens: [] };
        this.rateWindows.set(key.id, window);
      }

      // Evict entries older than 60 seconds
      const cutoff = now - 60000;
      window.reqs = window.reqs.filter(t => t > cutoff);
      window.tokens = window.tokens.filter(e => e.t > cutoff);

      if (key.rpm_limit > 0 && window.reqs.length >= key.rpm_limit) {
        return { valid: false, status: 429, error: `Rate limit exceeded: RPM cap of ${key.rpm_limit} reached for this key.` };
      }

      const currentTokens = window.tokens.reduce((acc, curr) => acc + curr.count, 0);
      if (key.tpm_limit > 0 && currentTokens >= key.tpm_limit) {
        return { valid: false, status: 429, error: `Rate limit exceeded: TPM cap of ${key.tpm_limit} reached for this key.` };
      }

      window.reqs.push(now);
    }

    this.globalReqs.push(now);
    return { valid: true, key };
  }

  recordUsage(keyId, tokens = 0) {
    const key = this.keys.find(k => k.id === keyId);
    if (key) {
      key.requests_count = (key.requests_count || 0) + 1;
      key.tokens_count = (key.tokens_count || 0) + tokens;
      key.last_used = new Date().toISOString();
      this.scheduleSave();
    }

    const now = Date.now();
    if (tokens > 0) this.globalTokens.push({ t: now, count: tokens });

    // Record token bucket for rate window
    const window = this.rateWindows.get(keyId);
    if (window && tokens > 0) {
      window.tokens.push({ t: now, count: tokens });
    }
  }
}

module.exports = new ApiKeyManager();
