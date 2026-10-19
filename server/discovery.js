const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const notifications = require('./notifications');

const MODELS_CACHE_FILE = path.join(__dirname, '..', 'data', 'models.json');

// Strict check: only genuine OpenCode free models have -free or are big-pickle
function isUpstreamFreeModel(rawId) {
  if (!rawId) return false;
  const lower = rawId.toLowerCase();
  return lower.endsWith('-free') || lower === 'big-pickle';
}

// Suffix removal helper: ONLY strips -free at the end for models that are actually free
function cleanModelId(rawId) {
  if (!rawId) return rawId;
  if (rawId.toLowerCase().endsWith('-free')) {
    return rawId.slice(0, -5);
  }
  return rawId;
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
      // Also map upstream ID to itself
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
        family: 4,
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

      // Models known to have non-standard/unsupported/deprecated protocols
      const BLACKLISTED = new Set(['jev-1.13-free', 'test', 'jev-1.13', 'claude-opus-5-5-backup']);

      const modelMap = new Map();

      for (const raw of rawZenList) {
        const rawId = raw.id;
        if (BLACKLISTED.has(rawId)) continue;

        const meta = metaMap[rawId] || {};
        const isDeprecated = meta.status === 'deprecated';
        if (isDeprecated) continue;

        // A model is Free strictly if it ends with -free or is big-pickle
        const isFree = isUpstreamFreeModel(rawId);

        if (freeOnly && !isFree) {
          continue; // Skip paid models in free-only mode
        }

        const cleanId = isFree ? cleanModelId(rawId) : rawId;
        const actualUpstream = rawId; // Exactly match Zen upstream ID!

        // If this cleanId is already mapped, prioritize the -free variant
        if (modelMap.has(cleanId)) {
          const existing = modelMap.get(cleanId);
          if (isFree && !existing.is_free) {
            existing.upstream_id = actualUpstream;
            existing.is_free = true;
          }
          continue;
        }

        modelMap.set(cleanId, {
          id: cleanId,
          upstream_id: actualUpstream,
          name: meta.name || cleanId,
          description: meta.description || (isFree ? 'OpenCode Zen High-Performance Free Model' : 'OpenCode Zen Enterprise Model (Zen Key required)'),
          context_window: meta.limit?.context || (cleanId.includes('1m') || cleanId.includes('vl') ? 1048576 : 200000),
          max_output: meta.limit?.output || 32000,
          modalities: meta.modalities?.input || (cleanId.includes('vl') || cleanId.includes('flash') ? ['text', 'image'] : ['text']),
          supports_vision: (meta.modalities?.input || []).includes('image') || cleanId.includes('vl'),
          supports_reasoning: meta.reasoning !== false,
          supports_tools: meta.tool_call !== false,
          is_free: isFree,
          cost: meta.cost || null,
          family: meta.family || (cleanId.startsWith('claude') ? 'anthropic' : cleanId.startsWith('gpt') ? 'openai' : 'opencode')
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

      console.log(`[Discovery] Successfully discovered ${this.models.length} active Zen model(s) (${this.models.filter(m => m.is_free).length} free, ${this.models.filter(m => !m.is_free).length} paid).`);
      return this.models;
    } catch (err) {
      console.error('[Discovery] Model discovery failed:', err.message);
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

    // 1. Direct match in cleanToRaw map
    if (this.cleanedToRaw.has(requestedId)) {
      return this.cleanedToRaw.get(requestedId);
    }

    // 2. Direct match in models list
    const found = this.models.find(m => m.id === requestedId || m.upstream_id === requestedId);
    if (found) {
      return found.upstream_id;
    }

    // 3. Try clean form of requestedId in cleanToRaw
    const cleaned = cleanModelId(requestedId);
    if (this.cleanedToRaw.has(cleaned)) {
      return this.cleanedToRaw.get(cleaned);
    }

    // 4. If requestedId already ends with -free, return directly
    if (requestedId.endsWith('-free')) {
      return requestedId;
    }

    // 5. If requestedId is big-pickle, it has no suffix upstream
    if (requestedId === 'big-pickle' || cleaned === 'big-pickle') {
      return 'big-pickle';
    }

    // 6. If it's a known free model base name, map to -free
    const FREE_BASE_NAMES = new Set([
      'beam', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'mimo-v2.6-flash',
      'nemotron-3.5-super-vl', 'space-bunny', 'big-pickle', 'longcat-2.5-preview',
      'nemotron-3.5-lightning', 'nemotron-3-ultra'
    ]);
    if (FREE_BASE_NAMES.has(cleaned)) {
      return cleaned === 'big-pickle' ? 'big-pickle' : (cleaned + '-free');
    }

    // 7. For ANY other model (e.g. claude-opus-5-5, gpt-5.3-codex-spark, etc.):
    // Return EXACT requestedId! NEVER append -free!
    return requestedId;
  }

  isModelFree(requestedId) {
    if (!requestedId) return false;
    const lower = requestedId.toLowerCase();
    if (lower.endsWith('-free') || lower === 'big-pickle') return true;
    const cleaned = cleanModelId(requestedId);
    const FREE_BASE_NAMES = new Set([
      'beam', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'mimo-v2.6-flash',
      'nemotron-3.5-super-vl', 'space-bunny', 'big-pickle', 'longcat-2.5-preview',
      'nemotron-3.5-lightning', 'nemotron-3-ultra'
    ]);
    if (FREE_BASE_NAMES.has(cleaned)) return true;
    const found = this.models.find(m => m.id === requestedId || m.upstream_id === requestedId || m.id === cleaned);
    return found ? Boolean(found.is_free) : false;
  }

  getAllModels() {
    return [...this.models];
  }

  getModels() {
    return [...this.models];
  }

  getModel(id) {
    const cleaned = cleanModelId(id);
    return this.models.find(m => m.id === cleaned || m.upstream_id === id);
  }
}

module.exports = new ModelDiscoveryService();
