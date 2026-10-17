const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const notifications = require('./notifications');

const MODELS_CACHE_FILE = path.join(__dirname, '..', 'data', 'models.json');

// Suffix removal helper: strips -free, _free, or free at the end
function cleanModelId(rawId) {
  if (!rawId) return rawId;
  const cleaned = rawId.replace(/[-_]?free$/i, '');
  return cleaned || rawId;
}

class ModelDiscoveryService {
  constructor() {
    this.models = [];
    this.cleanedToRaw = new Map();
    this.rawToCleaned = new Map();
    this.lastSynced = null;
    this.isSyncing = false;
    this.timer = null;

    this.loadCache();
    this.startAutoRefresh();
    config.onChange(() => {
      this.startAutoRefresh();
    });
  }

  loadCache() {
    try {
      if (fs.existsSync(MODELS_CACHE_FILE)) {
        const raw = fs.readFileSync(MODELS_CACHE_FILE, 'utf8');
        const data = JSON.parse(raw);
        this.models = data.models || [];
        this.lastSynced = data.last_synced || null;
        this.rebuildMaps();
      }
    } catch (e) {
      console.warn('[Discovery] Failed to load models cache:', e.message);
    }
  }

  saveCache() {
    try {
      fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify({
        last_synced: this.lastSynced,
        count: this.models.length,
        models: this.models
      }, null, 2), 'utf8');
    } catch (e) {
      console.error('[Discovery] Failed to save models cache:', e.message);
    }
  }

  rebuildMaps() {
    this.cleanedToRaw.clear();
    this.rawToCleaned.clear();

    for (const m of this.models) {
      this.cleanedToRaw.set(m.id, m.upstream_id);
      this.rawToCleaned.set(m.upstream_id, m.id);
      // Also map raw ID to raw ID for backward compatibility
      this.cleanedToRaw.set(m.upstream_id, m.upstream_id);
    }
  }

  startAutoRefresh() {
    if (this.timer) clearInterval(this.timer);
    const intervalSec = config.get('discovery_interval_seconds') || 600;
    this.timer = setInterval(() => {
      this.sync().catch(err => console.error('[Discovery] Auto-sync error:', err.message));
    }, intervalSec * 1000);
  }

  /**
   * Fetch JSON from HTTPS endpoint.
   */
  async fetchJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': `opencode/latest/${config.get('client_version')}/cli`,
          ...headers
        },
        timeout: 15000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error(`Invalid JSON from ${url}: ${err.message}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Timeout fetching ${url}`));
      });
      req.end();
    });
  }

  /**
   * Perform discovery from upstream endpoints.
   */
  async sync() {
    if (this.isSyncing) return this.models;
    this.isSyncing = true;

    try {
      console.log('[Discovery] Discovering models from OpenCode Zen...');
      const zenModelsUrl = config.get('upstream_models_url') || 'https://opencode.ai/zen/v1/models';
      const metadataUrl = config.get('upstream_metadata_url') || 'https://models.opencode.ai/api.json';

      // 1. Fetch raw list from Zen models endpoint
      const zenRes = await this.fetchJson(zenModelsUrl, { 'Authorization': 'Bearer public' });
      const rawZenList = Array.isArray(zenRes?.data) ? zenRes.data : [];

      // 2. Fetch rich metadata catalog
      let catalog = null;
      try {
        catalog = await this.fetchJson(metadataUrl);
      } catch (catErr) {
        console.warn('[Discovery] Metadata catalog unreachable, using Zen list only:', catErr.message);
      }

      // Extract metadata map from catalog
      const metaMap = {};
      if (catalog) {
        for (const [provKey, provVal] of Object.entries(catalog)) {
          if (provVal && provVal.models) {
            for (const [mId, mVal] of Object.entries(provVal.models)) {
              metaMap[mId] = mVal;
              // Also map without provider prefix if any
              const slashIdx = mId.lastIndexOf('/');
              if (slashIdx !== -1) {
                metaMap[mId.slice(slashIdx + 1)] = mVal;
              }
            }
          }
        }
      }

      // 3. Process and filter Zen models
      const oldModelIds = new Set(this.models.map(m => m.id));
      const newModels = [];
      const freeOnly = config.get('free_only') !== false;

      // Models known to have non-standard/unsupported protocols
      const BLACKLISTED = new Set(['jev-1.13-free', 'test']);

      // Deduplicated Map by cleanId, strictly preferring -free variant
      const modelMap = new Map();

      for (const raw of rawZenList) {
        const rawId = raw.id;
        if (BLACKLISTED.has(rawId)) continue;

        const meta = metaMap[rawId] || {};
        const isDeprecated = meta.status === 'deprecated';
        if (isDeprecated) continue;

        const isFree = rawId.toLowerCase().includes('free') ||
                       rawId === 'big-pickle' ||
                       (meta.cost && meta.cost.input === 0 && meta.cost.output === 0);

        if (freeOnly && !isFree) {
          continue; // Skip paid models in free-only mode
        }

        // Clean the model ID (remove the -free / free suffix)
        const cleanId = cleanModelId(rawId);

        // If this cleanId is already mapped, only replace if this rawId is explicitly -free
        if (modelMap.has(cleanId)) {
          const existing = modelMap.get(cleanId);
          if (rawId.endsWith('-free') && !existing.upstream_id.endsWith('-free')) {
            existing.upstream_id = rawId;
            existing.is_free = true;
          }
          continue;
        }

        const actualUpstream = (rawId.endsWith('-free') || rawId === 'big-pickle') ? rawId : (rawId + '-free');

        modelMap.set(cleanId, {
          id: cleanId,
          upstream_id: actualUpstream,
          name: meta.name || cleanId.toUpperCase(),
          description: meta.description || 'OpenCode Zen High-Performance Free Coding & Reasoning Model',
          context_window: meta.limit?.context || (cleanId.includes('1m') || cleanId.includes('vl') ? 1048576 : 200000),
          max_output: meta.limit?.output || 32000,
          modalities: meta.modalities?.input || (cleanId.includes('vl') || cleanId.includes('flash') ? ['text', 'image'] : ['text']),
          supports_vision: (meta.modalities?.input || []).includes('image') || cleanId.includes('vl'),
          supports_reasoning: meta.reasoning !== false,
          supports_tools: meta.tool_call !== false,
          is_free: true,
          family: meta.family || 'opencode'
        });
      }

      for (const m of modelMap.values()) {
        newModels.push(m);
      }

      // Check for added/removed models for notifications
      const addedModels = newModels.filter(m => !oldModelIds.has(m.id));
      if (addedModels.length > 0 && oldModelIds.size > 0) {
        notifications.add(
          'Model Discovery Updated',
          `Discovered ${addedModels.length} new Zen model(s): ${addedModels.map(m => m.id).join(', ')}`,
          'success'
        );
      }

      this.models = newModels;
      this.lastSynced = new Date().toISOString();
      this.rebuildMaps();
      this.saveCache();

      console.log(`[Discovery] Successfully discovered ${this.models.length} active Zen model(s) (clean IDs).`);
      return this.models;
    } catch (err) {
      console.error('[Discovery] Model discovery failed:', err.message);
      // Fallback to cache or fallback models if empty
      if (this.models.length === 0) {
        this.fallbackBootstrap();
      }
      throw err;
    } finally {
      this.isSyncing = false;
    }
  }

  fallbackBootstrap() {
    console.log('[Discovery] Bootstrapping verified fallback models roster.');
    const fallback = [
      { id: "nemotron-3.5-super-vl", upstream_id: "nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL (1M)", context_window: 1048576, modalities: ["text", "image"], supports_vision: true, supports_reasoning: true, supports_tools: true, is_free: true },
      { id: "deepseek-v4.1-flash", upstream_id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash", context_window: 200000, modalities: ["text", "image"], supports_vision: true, supports_reasoning: true, supports_tools: true, is_free: true },
      { id: "glm-5.3-flash", upstream_id: "glm-5.3-flash-free", name: "GLM-5.3 Flash", context_window: 200000, modalities: ["text", "image", "video", "pdf"], supports_vision: true, supports_reasoning: true, supports_tools: true, is_free: true },
      { id: "beam", upstream_id: "beam-free", name: "Beam (1M)", context_window: 1048576, modalities: ["text"], supports_vision: false, supports_reasoning: true, supports_tools: true, is_free: true },
      { id: "mimo-v2.6-flash", upstream_id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash", context_window: 1048576, modalities: ["text", "image"], supports_vision: true, supports_reasoning: true, supports_tools: true, is_free: true },
      { id: "space-bunny", upstream_id: "space-bunny-free", name: "Space Bunny", context_window: 262144, modalities: ["text", "image"], supports_vision: true, supports_reasoning: true, supports_tools: true, is_free: true },
      { id: "big-pickle", upstream_id: "big-pickle", name: "Big Pickle", context_window: 200000, modalities: ["text"], supports_vision: false, supports_reasoning: true, supports_tools: true, is_free: true },
      { id: "nemotron-3.5-lightning", upstream_id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning", context_window: 262144, modalities: ["text"], supports_vision: false, supports_reasoning: true, supports_tools: true, is_free: true },
      { id: "longcat-2.5-preview", upstream_id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview", context_window: 1000000, modalities: ["text", "image"], supports_vision: true, supports_reasoning: true, supports_tools: true, is_free: true }
    ];
    this.models = fallback;
    this.lastSynced = new Date().toISOString();
    this.rebuildMaps();
    this.saveCache();
  }

  /**
   * Resolves requested model ID (clean ID or raw ID or alias) to upstream ID.
   */
  resolveUpstreamModel(requestedId) {
    if (!requestedId) return this.models[0]?.upstream_id || 'nemotron-3.5-super-vl-free';

    // 1. If requestedId already ends with -free, return directly
    if (requestedId.endsWith('-free')) {
      return requestedId;
    }

    // 2. Direct match in cleanToRaw map
    let upstream = this.cleanedToRaw.get(requestedId);
    if (upstream && (upstream.endsWith('-free') || upstream === 'big-pickle')) {
      return upstream;
    }

    // 3. Try clean form of requestedId
    const cleaned = cleanModelId(requestedId);
    upstream = this.cleanedToRaw.get(cleaned);
    if (upstream && (upstream.endsWith('-free') || upstream === 'big-pickle')) {
      return upstream;
    }

    // 4. If requestedId is big-pickle, it has no suffix upstream
    if (requestedId === 'big-pickle' || cleaned === 'big-pickle') {
      return 'big-pickle';
    }

    // 5. Default: Append -free so opencode.ai free-tier gateway accepts it
    return requestedId + '-free';
  }

  getAllModels() {
    return [...this.models];
  }

  getModel(id) {
    const cleaned = cleanModelId(id);
    return this.models.find(m => m.id === cleaned || m.upstream_id === id);
  }
}

module.exports = new ModelDiscoveryService();
