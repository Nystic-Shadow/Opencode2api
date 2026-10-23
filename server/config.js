const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Clean and strip quotes from .env values
function parseEnvVal(val) {
  let v = (val || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

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
        if (force || process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv();

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DEFAULT_CONFIG = {
  port: parseInt(process.env.PORT, 10) || 8080,
  admin_username: process.env.DASHBOARD_USER || 'admin',
  admin_password: process.env.DASHBOARD_PASS || 'admin123',
  client_version: '2.0.32',
  discovery_interval_seconds: 600,
  auto_update_cli: true,
  free_only: true,
  global_rpm_limit: 0, // 0 = unlimited
  global_tpm_limit: 0, // 0 = unlimited
  smart_fallback: process.env.SMART_FALLBACK !== 'false', // Default: true for zero-drop high resilience (auto failovers across free models if one hits capacity)
  max_retries: 3, // Auto-retry attempts on transient upstream drops
  request_timeout_ms: 60000,
  upstream_zen_key: process.env.OPENCODE_ZEN_KEY || '',
  proxies: process.env.PROXIES ? process.env.PROXIES.split(',').map(s => s.trim()).filter(Boolean) : [],
  warp_mode: process.env.WARP_MODE || 'auto', // 'auto' | 'always' | 'disabled'
  warp_host: process.env.WARP_HOST || '127.0.0.1',
  warp_auto_switch: process.env.WARP_AUTO_SWITCH !== 'false',
  warp_rotate_on_unauth: process.env.WARP_ROTATE_ON_UNAUTH !== 'false', // true by default: auto-rotates WireGuard keys on rate limits/429
  warp_rotate_on_rate_limit: process.env.WARP_ROTATE_ON_RATE_LIMIT !== 'false',
  warp_auto_rotate_minutes: parseInt(process.env.WARP_AUTO_ROTATE_MINUTES, 10) || 10, // 0 = disabled, default: every 10 minutes
  warp_port: parseInt(process.env.WARP_PORT, 10) || 40000,
  upstream_models_url: 'https://opencode.ai/zen/v1/models',
  upstream_metadata_url: 'https://models.opencode.ai/api.json',
  upstream_inference_url: 'https://opencode.ai/inference/openai/v1/chat/completions'
};

class ConfigManager {
  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.listeners = [];
    this.load();
  }

  refreshFromEnv() {
    loadEnv(true);
    if (process.env.DASHBOARD_USER && process.env.DASHBOARD_USER.trim()) {
      this.config.admin_username = process.env.DASHBOARD_USER.trim();
    }
    if (process.env.DASHBOARD_PASS && process.env.DASHBOARD_PASS.trim()) {
      this.config.admin_password = process.env.DASHBOARD_PASS.trim();
    }
  }

  load() {
    loadEnv(true);
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
      if (process.env.WARP_MODE) {
        this.config.warp_mode = process.env.WARP_MODE.trim();
      }
      if (process.env.WARP_HOST) {
        this.config.warp_host = process.env.WARP_HOST.trim();
      }
      if (process.env.WARP_PORT) {
        this.config.warp_port = parseInt(process.env.WARP_PORT, 10);
      }
      if (process.env.SMART_FALLBACK !== undefined) {
        this.config.smart_fallback = process.env.SMART_FALLBACK !== 'false';
      }

      this.save();
    } catch (err) {
      console.error('[Config] Error loading config:', err.message);
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  save() {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (err) {
      console.error('[Config] Error saving config:', err.message);
    }
  }

  get(key) {
    if (key === 'admin_username') {
      return (process.env.DASHBOARD_USER && process.env.DASHBOARD_USER.trim()) || this.config.admin_username || 'admin';
    }
    if (key === 'admin_password') {
      return (process.env.DASHBOARD_PASS && process.env.DASHBOARD_PASS.trim()) || this.config.admin_password || 'admin123';
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
    }
    if (newVals.admin_password) {
      process.env.DASHBOARD_PASS = newVals.admin_password;
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

module.exports = new ConfigManager();
