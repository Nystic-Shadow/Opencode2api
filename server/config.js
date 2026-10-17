const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Simple .env parser
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) {
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
  smart_fallback: true, // Auto-failover to healthy equivalent model on 403/429/503
  max_retries: 3, // Auto-retry attempts on transient upstream drops
  request_timeout_ms: 60000,
  upstream_zen_key: process.env.OPENCODE_ZEN_KEY || '',
  proxies: process.env.PROXIES ? process.env.PROXIES.split(',').map(s => s.trim()).filter(Boolean) : [],
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

  load() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        this.config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      } else {
        this.save();
      }
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
    return this.config[key];
  }

  getAll() {
    return { ...this.config };
  }

  update(newVals) {
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
