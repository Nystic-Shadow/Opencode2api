const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function atomicWriteJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
    throw err;
  }
}

const DEFAULT_UPSTREAM_INFERENCE_URL = 'https://opencode.ai/inference/v1/chat/completions';
// This path was stored by older builds but was never used. Migrate it instead
// of letting a stale cache point inference at a non-existent endpoint.
const LEGACY_UPSTREAM_INFERENCE_URL = 'https://opencode.ai/inference/openai/v1/chat/completions';

// Clean and strip quotes from .env values
function parseEnvVal(val) {
  let v = (val || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

// A weak or known-default dashboard password must never win over the
// generated secret, even when it arrives through DASHBOARD_PASS.
function sanitizeAdminPasswordEnv() {
  const pass = (process.env.DASHBOARD_PASS || '').trim();
  if (!pass) return;
  if (pass === 'admin123' || pass.length < 12) {
    console.warn('[Config] DASHBOARD_PASS is a known default or shorter than 12 characters; ignoring it. Set a strong password or read the generated value from data/admin-password.txt.');
    delete process.env.DASHBOARD_PASS;
  }
}

// Read an integer from env first, then the current config value. Explicit zero
// is preserved for settings where zero is meaningful (queue size / wait time).
function envOrConfigInt(envName, current, fallback, min) {
  const raw = process.env[envName] !== undefined && process.env[envName] !== ''
    ? process.env[envName]
    : current;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

// Capture the real process environment before .env is read. Explicit shell or
// container variables must always win over values from a local .env file.
const EXPLICIT_ENV_KEYS = new Set(Object.keys(process.env));

// Simple .env parser - dynamic reloader
function loadEnv(force = false) {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = parseEnvVal(trimmed.slice(idx + 1));
        if (EXPLICIT_ENV_KEYS.has(key)) continue;
        if (force || process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv();

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

const DEFAULT_CONFIG = {
  port: parseInt(process.env.PORT, 10) || 8080,
  admin_username: process.env.DASHBOARD_USER || 'admin',
  admin_password: process.env.DASHBOARD_PASS || '',
  client_version: '2.1.4',
  discovery_interval_seconds: 600,
  auto_update_cli: true,
  free_only: true,
  global_rpm_limit: 0, // 0 = unlimited
  global_tpm_limit: 0, // 0 = unlimited
  smart_fallback: process.env.SMART_FALLBACK !== 'false',
  max_retries: parseInt(process.env.MAX_RETRIES, 10) || 2, // hard-capped at 3 below
  proxy_quota_failovers: parseInt(process.env.PROXY_QUOTA_FAILOVERS, 10) || 10,
  proxy_check_interval_minutes: parseInt(process.env.PROXY_CHECK_INTERVAL_MINUTES, 10) || 30,
  proxy_auto_prune_dead: process.env.PROXY_AUTO_PRUNE_DEAD !== 'false',
  auto_proxy_discovery: process.env.AUTO_PROXY_DISCOVERY !== 'false',
  request_timeout_ms: parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 30000,
  request_deadline_ms: parseInt(process.env.REQUEST_DEADLINE_MS, 10) || 90000,
  queue_max_concurrent: parseInt(process.env.QUEUE_MAX_CONCURRENT, 10) || 8,
  queue_max_per_key: parseInt(process.env.QUEUE_MAX_PER_KEY, 10) || 4,
  queue_max_size: parseInt(process.env.QUEUE_MAX_SIZE, 10) || 100,
  queue_wait_ms: parseInt(process.env.QUEUE_WAIT_MS, 10) || 15000,
  upstream_zen_key: process.env.OPENCODE_ZEN_KEY || '',
  proxies: process.env.PROXIES ? process.env.PROXIES.split(',').map(s => s.trim()).filter(Boolean) : [],
  egress_mode: process.env.EGRESS_MODE || 'proxy_only',
  allow_direct_fallback: process.env.ALLOW_DIRECT_FALLBACK === 'true',
  upstream_models_url: 'https://opencode.ai/zen/v1/models',
  upstream_metadata_url: 'https://models.opencode.ai/api.json',
  upstream_inference_url: process.env.UPSTREAM_INFERENCE_URL || DEFAULT_UPSTREAM_INFERENCE_URL
};

class ConfigManager {
  constructor({ persist = true } = {}) {
    this.persist = persist;
    this.config = { ...DEFAULT_CONFIG };
    this.listeners = [];
    this.load();
  }

  ensureAdminPassword() {
    if (this.config.admin_password && this.config.admin_password !== 'admin123') return;
    const generated = crypto.randomBytes(18).toString('base64url');
    this.config.admin_password = generated;
    this.config._admin_password_generated = true;
    try {
      if (this.persist !== false) {
        fs.writeFileSync(path.join(DATA_DIR, 'admin-password.txt'), generated + '\n', { mode: 0o600 });
      }
    } catch (e) {}
    console.warn('[Config] Generated a random admin password. Set DASHBOARD_PASS to choose your own; the generated value is in data/admin-password.txt.');
  }

  refreshFromEnv() {
    loadEnv(true);
    sanitizeAdminPasswordEnv();
    if (process.env.DASHBOARD_USER && process.env.DASHBOARD_USER.trim()) {
      this.config.admin_username = process.env.DASHBOARD_USER.trim();
    }
    if (process.env.DASHBOARD_PASS && process.env.DASHBOARD_PASS.trim()) {
      this.config.admin_password = process.env.DASHBOARD_PASS.trim();
    }
  }

  load() {
    loadEnv(true);
    sanitizeAdminPasswordEnv();
    try {
      let fileConfig = {};
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        try {
          fileConfig = JSON.parse(raw);
        } catch (e) {
          fileConfig = {};
        }
      }

      this.config = { ...DEFAULT_CONFIG, ...fileConfig };

      // WARP was removed. Drop any legacy warp_* keys persisted by older
      // builds so they are not exposed through /api/settings or reused.
      for (const key of Object.keys(this.config)) {
        if (key.startsWith('warp_')) delete this.config[key];
      }
      // The old scraper controls were never wired to the request path. They are
      // superseded by the verified automatic discovery lifecycle.
      for (const key of Object.keys(this.config)) {
        if (key.startsWith('proxy_scraper_')) delete this.config[key];
      }

      // Explicit environment / .env variables ALWAYS take strict precedence over cached disk values:
      if (process.env.DASHBOARD_USER && process.env.DASHBOARD_USER.trim()) {
        this.config.admin_username = process.env.DASHBOARD_USER.trim();
      }
      if (process.env.DASHBOARD_PASS && process.env.DASHBOARD_PASS.trim()) {
        this.config.admin_password = process.env.DASHBOARD_PASS.trim();
      }
      if (process.env.PORT) {
        this.config.port = parseInt(process.env.PORT, 10);
      }
      if (process.env.OPENCODE_ZEN_KEY) {
        this.config.upstream_zen_key = process.env.OPENCODE_ZEN_KEY.trim();
      }
      if (process.env.UPSTREAM_INFERENCE_URL) {
        this.config.upstream_inference_url = process.env.UPSTREAM_INFERENCE_URL.trim();
      } else if (!this.config.upstream_inference_url || this.config.upstream_inference_url === LEGACY_UPSTREAM_INFERENCE_URL) {
        this.config.upstream_inference_url = DEFAULT_UPSTREAM_INFERENCE_URL;
      }
      if (process.env.EGRESS_MODE) {
        this.config.egress_mode = process.env.EGRESS_MODE.trim();
      }
      if (process.env.PROXIES) {
        this.config.proxies = process.env.PROXIES.split(',').map(s => s.trim()).filter(Boolean);
      }
      if (process.env.ALLOW_DIRECT_FALLBACK !== undefined) {
        this.config.allow_direct_fallback = process.env.ALLOW_DIRECT_FALLBACK === 'true';
      }

      // 'warp_only' and other legacy modes fail closed to proxy_only instead
      // of silently falling through to a different egress policy.
      const egressMode = String(this.config.egress_mode || 'proxy_only').toLowerCase();
      this.config.egress_mode = ['auto', 'proxy_only', 'direct'].includes(egressMode)
        ? egressMode
        : 'proxy_only';

      // Retry budget: fail fast instead of spending minutes per request.
      const envRetries = process.env.MAX_RETRIES !== undefined ? parseInt(process.env.MAX_RETRIES, 10) : NaN;
      if (Number.isFinite(envRetries)) {
        this.config.max_retries = envRetries;
      } else if (fileConfig.max_retries === undefined || fileConfig.max_retries > 3) {
        this.config.max_retries = 2;
      }
      this.config.max_retries = Math.min(Math.max(0, parseInt(this.config.max_retries, 10) || 0), 3);
      this.config.proxy_quota_failovers = Math.min(
        20,
        envOrConfigInt('PROXY_QUOTA_FAILOVERS', this.config.proxy_quota_failovers, 10, 0)
      );
      this.config.proxy_check_interval_minutes = Math.min(
        1440,
        Math.max(1, envOrConfigInt('PROXY_CHECK_INTERVAL_MINUTES', this.config.proxy_check_interval_minutes, 30, 1))
      );
      this.config.proxy_auto_prune_dead = process.env.PROXY_AUTO_PRUNE_DEAD !== undefined
        ? process.env.PROXY_AUTO_PRUNE_DEAD !== 'false'
        : this.config.proxy_auto_prune_dead !== false;
      this.config.auto_proxy_discovery = process.env.AUTO_PROXY_DISCOVERY !== undefined
        ? !/^(false|0|no|off)$/i.test(String(process.env.AUTO_PROXY_DISCOVERY).trim())
        : this.config.auto_proxy_discovery !== false;

      this.config.request_timeout_ms = Math.max(
        5000,
        parseInt(process.env.REQUEST_TIMEOUT_MS || this.config.request_timeout_ms, 10) || 30000
      );
      this.config.request_deadline_ms = Math.max(
        this.config.request_timeout_ms,
        parseInt(process.env.REQUEST_DEADLINE_MS || this.config.request_deadline_ms, 10) || 90000
      );
      this.config.queue_max_concurrent = envOrConfigInt('QUEUE_MAX_CONCURRENT', this.config.queue_max_concurrent, 8, 1);
      this.config.queue_max_per_key = envOrConfigInt('QUEUE_MAX_PER_KEY', this.config.queue_max_per_key, 4, 1);
      this.config.queue_max_size = envOrConfigInt('QUEUE_MAX_SIZE', this.config.queue_max_size, 100, 0);
      this.config.queue_wait_ms = envOrConfigInt('QUEUE_WAIT_MS', this.config.queue_wait_ms, 15000, 0);

      // Auto-migrate legacy config: enable smart_fallback by default for high availability
      if (!this.config.client_version || this.config.client_version.startsWith('1.') || this.config.client_version === '2.0.32') {
        this.config.client_version = '2.1.4';
      }

      if (fileConfig._smart_fallback_migrated !== true) {
        this.config.smart_fallback = process.env.SMART_FALLBACK !== 'false';
        this.config._smart_fallback_migrated = true;
      }
      if (process.env.SMART_FALLBACK !== undefined) {
        this.config.smart_fallback = process.env.SMART_FALLBACK !== 'false';
      }

      this.ensureAdminPassword();

      this.save();
    } catch (err) {
      console.error('[Config] Error loading config:', err.message);
      this.config = { ...DEFAULT_CONFIG };
      this.ensureAdminPassword();
    }
  }

  save() {
    if (this.persist === false) return;
    try {
      atomicWriteJson(CONFIG_FILE, this.config);
    } catch (err) {
      console.error('[Config] Error saving config:', err.message);
    }
  }

  get(key) {
    if (key === 'admin_username') {
      return (process.env.DASHBOARD_USER && process.env.DASHBOARD_USER.trim()) || this.config.admin_username || 'admin';
    }
    if (key === 'admin_password') {
      return (process.env.DASHBOARD_PASS && process.env.DASHBOARD_PASS.trim()) || this.config.admin_password || '';
    }
    return this.config[key];
  }

  getAll() {
    return {
      ...this.config,
      admin_username: this.get('admin_username'),
      admin_password: this.get('admin_password')
    };
  }

  update(newVals) {
    if (newVals.admin_username) {
      process.env.DASHBOARD_USER = newVals.admin_username;
      EXPLICIT_ENV_KEYS.add('DASHBOARD_USER');
    }
    if (newVals.admin_password) {
      process.env.DASHBOARD_PASS = newVals.admin_password;
      EXPLICIT_ENV_KEYS.add('DASHBOARD_PASS');
    }
    this.config = { ...this.config, ...newVals };
    this.save();
    for (const listener of this.listeners) {
      try { listener(this.config); } catch (e) {}
    }
  }

  onChange(fn) {
    this.listeners.push(fn);
  }
}

module.exports = new ConfigManager({
  // The proxy verification CLI must be able to inspect an env-supplied pool
  // without persisting those temporary values into data/config.json.
  persist: process.env.O2P_CONFIG_READONLY !== '1'
});
