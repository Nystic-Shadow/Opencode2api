const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const https = require('https');
const crypto = require('crypto');
const config = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ACCOUNT_FILE = path.join(DATA_DIR, 'warp_account.json');
const POOL_FILE = path.join(DATA_DIR, 'warp_pool.json');
const WIREPROXY_CONF = path.join(DATA_DIR, 'wireproxy.conf');

const WARP_ENDPOINTS = [
  '162.159.192.1:2408',
  '162.159.193.1:2408',
  '162.159.195.1:2408',
  '162.159.204.1:2408',
  '188.114.96.1:2408',
  '188.114.97.1:2408',
  '188.114.98.1:2408',
  '188.114.99.1:2408',
  'engage.cloudflareclient.com:2408'
];

const OPENCODE_IPV6_TARGETS = [
  '2606:4700:78::90:0:140',
  '2606:4700:78::90:0:141',
  '2606:4700:78::90:0:142',
  '2606:4700:78::90:0:143'
];

function parseIpv6Address(ip) {
  let parts = ip.split(':');
  if (ip.includes('::')) {
    const emptyIdx = parts.indexOf('');
    const before = parts.slice(0, emptyIdx).filter(Boolean);
    const after = parts.slice(emptyIdx + 1).filter(Boolean);
    const missing = 8 - (before.length + after.length);
    const zeroes = new Array(missing).fill('0');
    parts = [...before, ...zeroes, ...after];
  }
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    buf.writeUInt16BE(parseInt(parts[i] || '0', 16), i * 2);
  }
  return buf;
}

class CloudflareWarpManager {
  constructor() {
    this.wireproxyPath = this.detectWireproxyPath();
    this.cliPath = this.detectCliPath();
    this.basePort = config.get('warp_port') || parseInt(process.env.WARP_PORT, 10) || 40000;
    this.activePort = this.basePort;
    // Map of port -> { proc, startedAt }
    this.portProcesses = new Map();
    // Map of port -> drainTimeout
    this.drainingTimers = new Map();
    // Map of port -> active Promise lock to eliminate concurrent port binding collisions
    this.portMutex = new Map();
    this.lastRotationTime = 0;
    this.rotationCooldownMs = 1500;
    this.isRotating = false;
    this.activeRotationPromise = null;
    this.cachedAgent = null;
    this.cachedKey = '';
    this.cachedAgents = new Map();
    this.roundRobinIndex = 0;
    this.statusCache = null;
    this.socketAlive = false;
    this.sidecarReady = false;
    this.sidecarTimer = null;
    this.lastStatusCheck = 0;
    this.isBootstrapping = false;
    this.accountPool = [];
    this.isPoolInitializing = false;
    this.cronTimer = null;
    this.regCooldownUntil = 0;
    this.lastRegTime = 0;
    this.poolAccountIndex = 0;
    this.progress = {
      percent: 0,
      stage: 'idle',
      message: 'WARP Engine Idle'
    };

    // Fast initial background probe so socketAlive state is immediately populated
    this.probeSocks5().catch(() => {});
    this.startAutoRotateCron();
  }

  startAutoRotateCron() {
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }
    const minutes = config.get('warp_auto_rotate_minutes');
    const intervalMinutes = typeof minutes === 'number' ? minutes : 10;
    if (intervalMinutes <= 0) {
      console.log('[WARP Cron] Periodic background rotation is disabled (warp_auto_rotate_minutes = 0).');
      return;
    }

    console.log(`[WARP Cron] Background auto-rotation active: rotating tunnel every ${intervalMinutes} minute(s).`);
    this.cronTimer = setInterval(async () => {
      console.log(`[WARP Cron] Scheduled periodic tunnel rotation triggered (${intervalMinutes}m interval)...`);
      try {
        await this.rotateKeys('scheduled_cron');
      } catch (err) {
        console.warn('[WARP Cron] Periodic rotation notice:', err.message);
      }
    }, intervalMinutes * 60 * 1000);
  }

  getActivePort() {
    return this.activePort || this.basePort || 40000;
  }

  /**
   * Resolve the configured WARP engine.
   *
   * sidecar  - an external WARP/SOCKS5 container owns the endpoint; this
   *            process must never spawn wireproxy.
   * embedded - this process spawns and supervises wireproxy on loopback.
   * cli      - this process drives the official warp-cli daemon.
   * disabled - no WARP transport.
   *
   * auto picks sidecar when WARP_HOST is remote, otherwise prefers the
   * embedded engine (Docker image ships wireproxy) and falls back to CLI.
   */
  getEngineMode() {
    const raw = String(config.get('warp_engine') || 'auto').toLowerCase();
    const aliases = {
      external: 'sidecar',
      proxy: 'sidecar',
      socks5: 'sidecar',
      wireproxy: 'embedded',
      'warp-cli': 'cli',
      off: 'disabled',
      none: 'disabled'
    };
    const configured = aliases[raw] || raw;
    if (['sidecar', 'embedded', 'cli', 'disabled'].includes(configured)) {
      return configured;
    }

    const host = String(config.get('warp_host') || process.env.WARP_HOST || '').toLowerCase();
    if (host && !['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host)) {
      return 'sidecar';
    }
    if (this.wireproxyPath) return 'embedded';
    if (this.cliPath) return 'cli';
    return 'sidecar';
  }

  isSidecarMode() {
    return this.getEngineMode() === 'sidecar';
  }

  getBestPort(excludePorts = []) {
    if (this.isSidecarMode()) {
      const sidecarPort = this.getActivePort();
      if (Array.isArray(excludePorts) && excludePorts.includes(sidecarPort)) return null;
      return sidecarPort;
    }

    const ports = [this.basePort, this.basePort + 1, this.basePort + 2, this.basePort + 3];
    const livePorts = ports.filter(p => this.portProcesses.has(p));
    if (livePorts.length === 0) return this.getActivePort();

    const now = Date.now();
    // 1. Live ports not on cooldown and not in exclude list
    const healthyUnexcluded = livePorts.filter(p => {
      if (Array.isArray(excludePorts) && excludePorts.includes(p)) return false;
      const acc = this.portProcesses.get(p)?.account;
      return !acc?._cooldownUntil || now > acc._cooldownUntil;
    });

    if (healthyUnexcluded.length > 0) {
      this.roundRobinIndex = ((this.roundRobinIndex || 0) + 1) % healthyUnexcluded.length;
      return healthyUnexcluded[this.roundRobinIndex];
    }

    // 2. If caller specifically requested exclusion of already-tried ports and none are healthy,
    // return null so caller knows all available tunnel ports were attempted for this request
    if (Array.isArray(excludePorts) && excludePorts.length > 0) {
      return null;
    }

    // 3. Fallback for new requests with no exclusions: least recently cooled down port
    let lowestPort = livePorts[0];
    let lowestCd = Infinity;
    for (const p of livePorts) {
      const acc = this.portProcesses.get(p)?.account;
      const cd = acc?._cooldownUntil || 0;
      if (cd < lowestCd) {
        lowestCd = cd;
        lowestPort = p;
      }
    }
    return lowestPort;
  }

  getNextPort(currentPort) {
    const portPool = [
      this.basePort,
      this.basePort + 1,
      this.basePort + 2,
      this.basePort + 3
    ];
    const idx = portPool.indexOf(currentPort);
    if (idx === -1) return this.basePort;
    return portPool[(idx + 1) % portPool.length];
  }

  _resolveWarpHost(port, host = null) {
    if (host) return host;
    // Multi-port embedded wireproxy pool (40000..40009) always runs on container loopback (H6)
    if (!this.isSidecarMode() && port >= 40000 && port <= 40009) return '127.0.0.1';
    return config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
  }

  clearAgent(port) {
    const targetHost = this._resolveWarpHost(port);
    const cacheKey = `${targetHost}:${port}`;
    if (this.cachedAgents && this.cachedAgents.has(cacheKey)) {
      const agent = this.cachedAgents.get(cacheKey);
      try { agent.destroy(); } catch (e) {}
      this.cachedAgents.delete(cacheKey);
    }
  }

  async forceKillPort(port) {
    this.clearAgent(port);
    if (this.drainingTimers.has(port)) {
      clearTimeout(this.drainingTimers.get(port));
      this.drainingTimers.delete(port);
    }

    const procInfo = this.portProcesses.get(port);
    if (procInfo && procInfo.proc) {
      try {
        procInfo.proc.removeAllListeners('exit');
        procInfo.proc.kill('SIGKILL');
      } catch (e) {}
      this.portProcesses.delete(port);
    }

    // On Linux: ruthlessly terminate any orphaned wireproxy process holding this port or config
    if (process.platform === 'linux') {
      try {
        const { execSync } = require('child_process');
        execSync(`pkill -9 -f wireproxy_${port}.conf 2>/dev/null || true`);
        execSync(`fuser -k ${port}/tcp 2>/dev/null || true`);
      } catch (e) {}
    }

    // Wait and verify socket is truly closed so no EADDRINUSE happens
    let attempts = 0;
    while (attempts < 5) {
      const isAlive = await this.probeSocks5('127.0.0.1', port);
      if (!isAlive) break;
      if (procInfo?.proc?.pid) {
        try { process.kill(procInfo.proc.pid, 'SIGKILL'); } catch (e) {}
      }
      await new Promise(r => setTimeout(r, 150));
      attempts++;
    }
  }

  scheduleDraining(port) {
    if (this.drainingTimers.has(port)) {
      clearTimeout(this.drainingTimers.get(port));
    }

    const timer = setTimeout(async () => {
      try {
        await this.forceKillPort(port);
        console.log(`[WARP] Previous WireProxy process on port ${port} drained and closed.`);
      } catch (e) {}
      this.drainingTimers.delete(port);
    }, 12000);

    this.drainingTimers.set(port, timer);
  }

  setProgress(percent, stage, message) {
    this.progress = { percent, stage, message, timestamp: Date.now() };
    if (this.statusCache) {
      this.statusCache.progress = this.progress;
      this.statusCache.bootstrapping = this.isBootstrapping;
    }
  }

  detectWireproxyPath() {
    if (process.env.WIREPROXY_PATH && fs.existsSync(process.env.WIREPROXY_PATH)) {
      return process.env.WIREPROXY_PATH;
    }

    const candidatePaths = [
      '/usr/local/bin/wireproxy',
      '/usr/bin/wireproxy',
      path.join(__dirname, '..', 'wireproxy'),
      path.join(__dirname, '..', 'wireproxy.exe')
    ];

    for (const p of candidatePaths) {
      try {
        if (fs.existsSync(p)) return p;
      } catch (e) {}
    }

    return null;
  }

  detectCliPath() {
    if (process.env.WARP_CLI_PATH && fs.existsSync(process.env.WARP_CLI_PATH)) {
      return process.env.WARP_CLI_PATH;
    }

    const candidatePaths = [
      'C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe',
      'C:\\Program Files (x86)\\Cloudflare\\Cloudflare WARP\\warp-cli.exe',
      '/usr/bin/warp-cli',
      '/usr/local/bin/warp-cli',
      '/opt/cloudflare/warp/warp-cli'
    ];

    for (const p of candidatePaths) {
      try {
        if (fs.existsSync(p)) return p;
      } catch (e) {}
    }

    return null;
  }

  isAvailable() {
    return Boolean(
      this.wireproxyPath ||
      (this.cliPath && fs.existsSync(this.cliPath)) ||
      (this.statusCache && this.statusCache.socketAlive)
    );
  }

  isReady() {
    const engine = this.getEngineMode();
    if (engine === 'disabled') return false;
    if (engine === 'sidecar') {
      if (this.sidecarReady === true) return true;
      return this.socketAlive === true;
    }
    if (this.portProcesses && this.portProcesses.size > 0) {
      return true;
    }
    if (this.statusCache && typeof this.statusCache.socketAlive === 'boolean') {
      return this.statusCache.socketAlive;
    }
    return this.socketAlive === true;
  }

  /**
   * Generates Curve25519 keypair and registers a free Cloudflare WARP account via official REST API
   */
  async registerCloudflareAccount() {
    // Check if Cloudflare API recently returned 1015 ("You are being rate limited")
    if (this.regCooldownUntil && Date.now() < this.regCooldownUntil) {
      const waitMin = Math.ceil((this.regCooldownUntil - Date.now()) / 60000);
      throw new Error(`Cloudflare registration paused due to earlier 1015 rate limit (${waitMin}m remaining). Using pool.`);
    }

    // Throttle registrations to at most once per 12 seconds to prevent Cloudflare Error 1015
    const now = Date.now();
    if (this.lastRegTime && (now - this.lastRegTime < 12000)) {
      const waitMs = 12000 - (now - this.lastRegTime);
      console.log(`[WARP] Throttling Cloudflare registration to prevent 1015 rate limit (waiting ${Math.round(waitMs / 1000)}s)...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
    this.lastRegTime = Date.now();

    console.log('[WARP] Generating fresh X25519 keypair & registering with Cloudflare WARP API...');
    this.setProgress(30, 'generating_keys', 'Generating Curve25519 (X25519) cryptographic keypair...');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    const pubKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    const privKey = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64');

    const regBody = JSON.stringify({
      key: pubKey,
      install_id: '',
      fcm_token: '',
      tos: new Date().toISOString(),
      model: 'PC',
      serial_number: '',
      locale: 'en_US'
    });

    this.setProgress(50, 'registering', 'Negotiating secure session with Cloudflare Edge API...');

    return new Promise((resolve, reject) => {
      const req = https.request('https://api.cloudflareclient.com/v0a3371/reg', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'User-Agent': 'okhttp/3.12.1',
          'Content-Length': Buffer.byteLength(regBody)
        },
        timeout: 10000
      }, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            if (res.statusCode === 429 || body.includes('1015')) {
              this.regCooldownUntil = Date.now() + (15 * 60 * 1000); // 15-minute backoff
              console.warn('[WARP] Cloudflare registration rate limit (1015) detected. Pausing new registrations for 15 minutes.');
            }
            return reject(new Error(`Cloudflare registration failed with HTTP ${res.statusCode}: ${body}`));
          }
          try {
            const json = JSON.parse(body);
            const account = {
              privateKey: privKey,
              publicKey: pubKey,
              accountId: json.id,
              token: json.token,
              addressV4: json.config?.interface?.addresses?.v4 || '172.16.0.2',
              addressV6: json.config?.interface?.addresses?.v6 || '',
              peerPublicKey: json.config?.peers?.[0]?.public_key || 'bmXOC+F1FxEMF9dyiK2H5/1SUtzHP0JyV5VC9G3ZDio=',
              endpoint: json.config?.peers?.[0]?.endpoint?.host || '162.159.192.1:2408',
              registeredAt: new Date().toISOString()
            };

            try {
              if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
              fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(account, null, 2));
            } catch (fsErr) {
              console.warn('[WARP] Warning saving account file:', fsErr.message);
            }

            console.log(`[WARP] Successfully registered Cloudflare WARP account (ID: ${account.accountId}, v6: ${account.addressV6 ? 'enabled' : 'none'})`);
            resolve(account);
          } catch (parseErr) {
            reject(new Error('Failed to parse Cloudflare registration response: ' + parseErr.message));
          }
        });
      });

      req.on('error', err => reject(new Error('Cloudflare registration request error: ' + err.message)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Cloudflare registration request timed out'));
      });
      req.write(regBody);
      req.end();
    });
  }

  sanitizeEndpoint(ep) {
    if (!ep || typeof ep !== 'string') return '162.159.192.1:2408';
    return ep.trim();
  }

  queueSlotReplacement(idx, port = null) {
    if (!this.replacementQueue) this.replacementQueue = [];
    if (this.replacementQueue.some(item => item.idx === idx)) return;
    this.replacementQueue.push({ idx, port, requestedAt: Date.now() });
    this.processReplacementQueue().catch(() => {});
  }

  async processReplacementQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;
    try {
      while (this.replacementQueue && this.replacementQueue.length > 0) {
        const item = this.replacementQueue.shift();
        if (this.regCooldownUntil && Date.now() < this.regCooldownUntil) {
          const waitMin = Math.ceil((this.regCooldownUntil - Date.now()) / 60000);
          console.log(`[WARP Pool] Postponing replacement for slot ${item.idx + 1}: Cloudflare API registration cooldown (${waitMin}m).`);
          break;
        }

        try {
          console.log(`[WARP Pool] Purging burned slot ${item.idx + 1} and registering fresh account...`);
          const freshAcc = await this.registerCloudflareAccount();
          freshAcc.endpoint = WARP_ENDPOINTS[item.idx % WARP_ENDPOINTS.length];
          freshAcc.ipv4Only = (item.idx % 2 === 0);
          freshAcc._burnCount = 0;
          freshAcc._cooldownUntil = 0;
          if (this.accountPool && this.accountPool.length > item.idx) {
            this.accountPool[item.idx] = freshAcc;
          } else {
            this.accountPool.push(freshAcc);
          }
          this.saveAccountPool();

          const validPorts = [this.basePort, this.basePort + 1, this.basePort + 2, this.basePort + 3];
          const targetPort = (item.idx < 4) ? (this.basePort + item.idx) : item.port;
          if (validPorts.includes(targetPort)) {
            await this.startWireproxy(freshAcc, targetPort).catch(err =>
              console.warn(`[WARP Pool] Port ${targetPort} startup notice:`, err.message)
            );
          }
        } catch (err) {
          console.warn(`[WARP Pool] Slot ${item.idx + 1} replacement notice:`, err.message);
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  async replaceBadAccount(idx) {
    this.queueSlotReplacement(idx, null);
    return null;
  }

  loadCachedAccount() {
    try {
      if (fs.existsSync(ACCOUNT_FILE)) {
        const raw = fs.readFileSync(ACCOUNT_FILE, 'utf-8');
        const acc = JSON.parse(raw);
        if (!acc.privateKey || !acc.peerPublicKey) return null;
        const regTime = new Date(acc.registeredAt || 0).getTime();
        // Discard cached account if older than 30 minutes
        if (Date.now() - regTime > (30 * 60 * 1000)) return null;
        acc.endpoint = this.sanitizeEndpoint(acc.endpoint);
        return acc;
      }
    } catch (e) {}
    return null;
  }

  async purgeAndRegeneratePool() {
    console.log('[WARP] Purging all cached WARP credentials and regenerating fresh identity pool...');
    try { if (fs.existsSync(ACCOUNT_FILE)) fs.unlinkSync(ACCOUNT_FILE); } catch (e) {}
    try { if (fs.existsSync(POOL_FILE)) fs.unlinkSync(POOL_FILE); } catch (e) {}
    for (let p = this.basePort; p < this.basePort + 4; p++) {
      const conf = path.join(DATA_DIR, `wireproxy_${p}.conf`);
      try { if (fs.existsSync(conf)) fs.unlinkSync(conf); } catch (e) {}
      await this.forceKillPort(p);
    }
    this.accountPool = [];
    this.statusCache = null;
    return await this.autoBootstrap(true);
  }

  async ensureAccountPool() {
    if (this.accountPool && this.accountPool.length >= 8) {
      return this.accountPool;
    }

    // 1. Try reading existing pool from data/warp_pool.json
    try {
      if (fs.existsSync(POOL_FILE)) {
        const raw = fs.readFileSync(POOL_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.accounts) && parsed.accounts.length > 0) {
          const now = Date.now();
          const MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes max age: automatically prune stale accounts
          const freshAccounts = parsed.accounts
            .filter(a => {
              if (!a || !a.privateKey || !a.peerPublicKey) return false;
              const regTime = new Date(a.registeredAt || 0).getTime();
              if (now - regTime > MAX_AGE_MS) return false; // Auto-prune accounts older than 15m
              if ((a._burnCount || 0) >= 1) return false; // Auto-prune accounts burned even once on reload
              if (a._cooldownUntil && now < a._cooldownUntil) return false; // Discard accounts on cooldown
              return true;
            })
            .map((a, idx) => {
              a.endpoint = this.sanitizeEndpoint(WARP_ENDPOINTS[idx % WARP_ENDPOINTS.length]);
              a.ipv4Only = (idx % 2 === 0); // Alternate IPv4-Only (even slots) and Dual-Stack IPv6 (odd slots)
              return a;
            });
          this.accountPool = freshAccounts;
          this.saveAccountPool();
          if (this.accountPool.length >= 8) return this.accountPool;
        }
      }
    } catch (e) {}

    // 2. Check legacy ACCOUNT_FILE
    const cached = this.loadCachedAccount();
    if (cached && !this.accountPool.some(a => a.accountId === cached.accountId)) {
      cached.endpoint = WARP_ENDPOINTS[0];
      cached.ipv4Only = true;
      this.accountPool.push(cached);
    }

    // 3. If we have at least 1 account, return immediately and fill pool in background
    if (this.accountPool.length > 0) {
      this.populatePoolInBackground();
      return this.accountPool;
    }

    // 4. Otherwise register first account synchronously
    const firstAcc = await this.registerCloudflareAccount();
    firstAcc.endpoint = WARP_ENDPOINTS[0];
    firstAcc.ipv4Only = true;
    this.accountPool.push(firstAcc);
    this.saveAccountPool();
    this.populatePoolInBackground();
    return this.accountPool;
  }

  saveAccountPool() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(POOL_FILE, JSON.stringify({
        updatedAt: new Date().toISOString(),
        accounts: this.accountPool
      }, null, 2));
    } catch (e) {
      console.warn('[WARP Pool] Warning saving account pool:', e.message);
    }
  }

  async populatePoolInBackground() {
    if (this.isPoolInitializing) return;
    this.isPoolInitializing = true;

    try {
      while (this.accountPool.length < 8) {
        if (this.regCooldownUntil && Date.now() < this.regCooldownUntil) {
          break;
        }
        // Enforce safe 12-second delay so Cloudflare API error 1015 never occurs
        await new Promise(r => setTimeout(r, 12000));
        if (this.regCooldownUntil && Date.now() < this.regCooldownUntil) {
          break;
        }
        try {
          const idx = this.accountPool.length;
          console.log(`[WARP Pool] Pre-registering account ${idx + 1}/8 for zero-downtime pool...`);
          const acc = await this.registerCloudflareAccount();
          acc.endpoint = WARP_ENDPOINTS[idx % WARP_ENDPOINTS.length];
          acc.ipv4Only = (idx % 2 === 0);
          this.accountPool.push(acc);
          this.saveAccountPool();
          const modeLabel = acc.ipv4Only ? 'IPv4-Only' : `Dual-Stack IPv6: ${acc.addressV6}`;
          console.log(`[WARP Pool] Account ${idx + 1}/8 pre-warmed on endpoint ${acc.endpoint} (${modeLabel})`);

          // If this account maps to one of our 4 ports (40000..40003) and that port is not yet running, boot it now!
          const slotPort = this.basePort + idx;
          if (idx < 4 && !this.portProcesses.has(slotPort)) {
            this.startWireproxy(acc, slotPort)
              .then(() => console.log(`[WARP Pool] Pre-warmed tunnel is LIVE on port ${slotPort} (${acc.ipv4Only ? 'IPv4-Only' : 'Dual-Stack IPv6'})`))
              .catch(err => console.warn(`[WARP Pool] Port ${slotPort} startup notice:`, err.message));
          }
        } catch (err) {
          console.warn('[WARP Pool] Pre-warm notice in background pool builder:', err.message);
          break; // Stop if rate limited, will retry on next cycle
        }
      }
    } finally {
      this.isPoolInitializing = false;
    }
  }

  /**
   * Starts WireProxy userspace SOCKS5 engine with strict per-port serialization
   */
  async startWireproxy(account, targetPort = null) {
    const engine = this.getEngineMode();
    if (engine === 'sidecar') {
      throw new Error('Embedded wireproxy is disabled while WARP_ENGINE=sidecar (an external WARP sidecar owns the endpoint)');
    }
    if (engine === 'disabled') {
      throw new Error('WARP is disabled by configuration');
    }
    if (!this.wireproxyPath) {
      throw new Error('wireproxy binary not found on system');
    }

    const port = targetPort || this.getActivePort();

    // Acquire per-port lock to prevent concurrent bind collisions
    while (this.portMutex.has(port)) {
      await this.portMutex.get(port);
    }
    let releaseLock;
    const lockPromise = new Promise(resolve => { releaseLock = resolve; });
    this.portMutex.set(port, lockPromise);

    try {
      return await this._doStartWireproxy(account, port);
    } finally {
      this.portMutex.delete(port);
      if (typeof releaseLock === 'function') releaseLock();
    }
  }

  async _doStartWireproxy(account, port) {
    // Embedded WireProxy daemon must strictly bind to loopback inside container (H6)
    const bindHost = '127.0.0.1';
    const confPath = path.join(DATA_DIR, `wireproxy_${port}.conf`);

    // Ensure port is completely free and clean before spawning!
    await this.forceKillPort(port);

    // Diversified Dual-Pool Architecture:
    // Even ports (40000, 40002) = Dual-Stack IPv6 (AllowedIPs = 0.0.0.0/0, ::/0 with dedicated IPv6 address)
    // Odd ports (40001, 40003) = Pure IPv4 (AllowedIPs = 0.0.0.0/0 to route via Cloudflare's 104.28.x.x IPv4 pool)
    const isIpv4Only = (port % 2 !== 0);
    this.setProgress(65, 'configuring_tunnel', `Configuring WireGuard profile for ${bindHost}:${port} (${isIpv4Only ? 'Pure IPv4' : 'Dual-Stack IPv6'})...`);

    const addresses = [];
    if (account.addressV4) addresses.push(`${account.addressV4}/32`);
    if (!isIpv4Only && account.addressV6) addresses.push(`${account.addressV6}/128`);
    if (addresses.length === 0) addresses.push('172.16.0.2/32');

    const endpointHost = this.sanitizeEndpoint(account.endpoint) || '162.159.192.1:2408';
    const dnsServers = isIpv4Only ? '1.1.1.1, 8.8.8.8' : '1.1.1.1, 8.8.8.8, 2606:4700:4700::1111';
    const allowedIps = isIpv4Only ? '0.0.0.0/0' : '0.0.0.0/0, ::/0';

    const confContent = `[Interface]
PrivateKey = ${account.privateKey}
Address = ${addresses.join(', ')}
DNS = ${dnsServers}

[Peer]
PublicKey = ${account.peerPublicKey}
Endpoint = ${endpointHost}
AllowedIPs = ${allowedIps}
KeepAlive = 25

[Socks5]
BindAddress = ${bindHost}:${port}
`;

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(confPath, confContent);

    this.setProgress(75, 'launching_tunnel', `Starting userspace WireProxy SOCKS5 daemon on ${bindHost}:${port}...`);
    console.log(`[WARP] Starting userspace WireProxy SOCKS5 daemon on ${bindHost}:${port} (${endpointHost})...`);

    let procExited = false;
    let procExitCode = null;
    let procExitSignal = null;

    const proc = spawn(this.wireproxyPath, ['-c', confPath], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let lastStdout = '';
    let lastStderr = '';

    proc.stdout.on('data', d => {
      const msg = d.toString().trim();
      lastStdout = msg;
      if (msg.includes('bind:') || msg.includes('error') || msg.includes('fatal')) console.warn(`[WireProxy:${port}]`, msg);
    });

    proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      lastStderr = msg;
      if (msg.includes('Interface state was Down, requested Up, now Up')) {
        console.log(`[WireProxy:${port}] Tunnel connected to Cloudflare Edge (warp=on)`);
      } else if (msg.includes('error') || msg.includes('fatal') || msg.includes('bind:')) {
        console.warn(`[WireProxy:${port}]`, msg);
      }
    });

    proc.on('exit', (code, sig) => {
      procExited = true;
      procExitCode = code;
      procExitSignal = sig;
      if (code !== 0 && code !== null) {
        console.warn(`[WireProxy:${port}] Process exited (code: ${code}, signal: ${sig}) - last stderr: "${lastStderr}", last stdout: "${lastStdout}"`);
      } else {
        console.log(`[WireProxy:${port}] Process exited (code: ${code}, signal: ${sig})`);
      }
      const current = this.portProcesses.get(port);
      if (current && current.proc === proc) {
        this.portProcesses.delete(port);
      }
      if (port === this.getActivePort()) {
        this.socketAlive = false;
        this.statusCache = null;
      }
    });

    this.setProgress(85, 'verifying_socket', `Probing SOCKS5 handshake on ${bindHost}:${port}...`);

    // 1. Poll until local SOCKS5 socket answers handshake (up to 8 seconds)
    const startTime = Date.now();
    let socketLive = false;
    while (Date.now() - startTime < 8000) {
      if (procExited) {
        throw new Error(`WireProxy process for port ${port} exited prematurely with code ${procExitCode} (signal: ${procExitSignal})`);
      }
      await new Promise(r => setTimeout(r, 200));
      if (procExited) {
        throw new Error(`WireProxy process for port ${port} exited prematurely with code ${procExitCode} (signal: ${procExitSignal})`);
      }
      const alive = await this.probeSocks5(bindHost, port);
      if (alive) {
        socketLive = true;
        break;
      }
    }

    if (!socketLive) {
      try { proc.kill('SIGTERM'); } catch (e) {}
      throw new Error(`WireProxy launched on ${bindHost}:${port} but SOCKS5 port failed to answer within 8s`);
    }

    // 2. Poll for genuine Cloudflare Edge egress verification (trace)
    this.setProgress(90, 'verifying_tunnel', `Verifying edge egress connectivity on ${bindHost}:${port} (${endpointHost})...`);
    let trace = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (procExited) break;
      trace = await this.probeEgressTrace(port, 5000);
      if (trace && trace.ip) break;
      await new Promise(r => setTimeout(r, 500));
    }

    if (trace && trace.ip) {
      const ipFamily = trace.ip.includes(':') ? 'IPv6' : 'IPv4';
      console.log(`[WARP] WireProxy SOCKS5 engine is LIVE on ${bindHost}:${port} (warp=on • Egress: ${trace.ip} [${ipFamily} • ${trace.colo || 'Edge'}])`);
      this.setProgress(100, 'connected', `Cloudflare WARP Egress Active on ${bindHost}:${port} (warp=on • ${trace.ip})`);
      this.portProcesses.set(port, { proc, startedAt: Date.now(), account, egressIp: trace.ip });
      this.socketAlive = true;
      this.statusCache = null;
      return proc;
    }

    // If edge trace timed out on this endpoint, cleanly stop process and propagate error so caller can try next candidate endpoint
    try { proc.kill('SIGKILL'); } catch (e) {}
    throw new Error(`WireProxy on port ${port} connected to SOCKS5 but failed Cloudflare edge handshake on endpoint ${endpointHost}`);
  }

  /**
   * Fast SOCKS5 socket probe (RFC 1928) to test if proxy is answering on host:port
   */
  probeSocks5(host, port) {
    const targetPort = port || this.getActivePort();
    const targetHost = this._resolveWarpHost(targetPort, host);

    return new Promise((resolve) => {
      const socket = net.connect({ host: targetHost, port: targetPort, timeout: 2000 }, () => {
        // Send SOCKS5 handshake: VER=5, NMETHODS=1, METHOD=0
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      socket.on('data', (data) => {
        socket.destroy();
        const ok = data.length >= 2 && data[0] === 0x05 && data[1] === 0x00;
        if (targetPort === this.getActivePort()) {
          this.socketAlive = ok;
        }
        resolve(ok);
      });

      socket.on('error', () => {
        socket.destroy();
        if (targetPort === this.getActivePort()) {
          this.socketAlive = false;
        }
        resolve(false);
      });

      socket.on('timeout', () => {
        socket.destroy();
        if (targetPort === this.getActivePort()) {
          this.socketAlive = false;
        }
        resolve(false);
      });
    });
  }

  /**
   * Waits for an external WARP sidecar (for example caomingjun/warp) to answer
   * SOCKS5 on the configured endpoint. The gateway never spawns its own tunnel
   * in this mode, so a sidecar restart cannot collide with an embedded process.
   */
  async bootstrapSidecar() {
    const port = this.getActivePort();
    const host = this._resolveWarpHost(port);

    this.setProgress(20, 'checking_sidecar', `Probing WARP sidecar on ${host}:${port}...`);
    const alive = await this.probeSocks5(host, port);
    if (!alive) {
      this.sidecarReady = false;
      this.socketAlive = false;
      this.statusCache = null;
      this.setProgress(0, 'waiting_sidecar', `Waiting for WARP sidecar at ${host}:${port}`);
      console.warn(`[WARP] Sidecar is not answering on ${host}:${port} yet. The gateway will keep serving and retry in the background.`);
      this.startSidecarMonitor();
      return false;
    }

    // Verify that the SOCKS5 endpoint really reaches Cloudflare. The trace is
    // allowed to fail transiently; it only affects the reported egress IP.
    const trace = await this.probeEgressTrace(port, 6000);
    if (trace && trace.warp && !['on', 'plus'].includes(trace.warp)) {
      console.warn(`[WARP] Sidecar SOCKS5 is reachable but reports warp=${trace.warp}; traffic may not be tunneled through WARP. Check the sidecar logs.`);
    }
    this.sidecarReady = true;
    this.socketAlive = true;
    this.activePort = port;
    this.statusCache = null;
    const egress = trace?.ip
      ? ` • Egress: ${trace.ip}${trace.colo ? ` (${trace.colo})` : ''}${trace.warp ? ` • warp=${trace.warp}` : ''}`
      : '';
    this.setProgress(100, 'connected', `Cloudflare WARP sidecar active on ${host}:${port}${egress}`);
    console.log(`[WARP] Sidecar SOCKS5 engine is LIVE on ${host}:${port}${egress}`);
    this.startSidecarMonitor();
    return true;
  }

  startSidecarMonitor() {
    if (this.sidecarTimer) return;
    let misses = 0;
    this.sidecarTimer = setInterval(async () => {
      if (this.getEngineMode() !== 'sidecar') {
        clearInterval(this.sidecarTimer);
        this.sidecarTimer = null;
        return;
      }
      const port = this.getActivePort();
      const host = this._resolveWarpHost(port);
      const alive = await this.probeSocks5(host, port);
      if (alive) {
        misses = 0;
        this.sidecarReady = true;
      } else {
        misses++;
        if (misses >= 2) {
          this.sidecarReady = false;
          this.socketAlive = false;
          this.statusCache = null;
          this.setProgress(0, 'waiting_sidecar', `WARP sidecar unreachable at ${host}:${port}`);
        }
      }
    }, 15000);
    if (typeof this.sidecarTimer.unref === 'function') this.sidecarTimer.unref();
  }

  /**
   * Auto-bootstraps Cloudflare WARP:
   * 1. Checks if SOCKS5 proxy is already live.
   * 2. If not, boots wireproxy (userspace WireGuard) or warp-cli.
   */
  async autoBootstrap(forceRestart = false) {
    if (this.isBootstrapping && !forceRestart) return false;
    this.isBootstrapping = true;
    this.setProgress(10, 'initializing', 'Initializing Cloudflare WARP engine...');

    const engine = this.getEngineMode();
    if (engine === 'disabled') {
      this.isBootstrapping = false;
      this.setProgress(0, 'idle', 'WARP is disabled by configuration');
      return false;
    }
    if (engine === 'sidecar') {
      try {
        return await this.bootstrapSidecar();
      } catch (err) {
        console.warn('[WARP] Sidecar bootstrap notice:', err.message);
        this.setProgress(0, 'waiting_sidecar', 'Sidecar bootstrap notice: ' + err.message);
        return false;
      } finally {
        this.isBootstrapping = false;
      }
    }

    const port = this.getActivePort();
    const host = this._resolveWarpHost(port);

    try {
      // 1. Check if SOCKS5 port is already answering
      this.setProgress(20, 'checking_socket', `Probing SOCKS5 proxy on ${host}:${port}...`);
      const alreadyAlive = await this.probeSocks5(host, port);
      if (alreadyAlive && !forceRestart) {
        console.log(`[WARP] SOCKS5 proxy already active and answering on ${host}:${port}`);
        this.setProgress(100, 'connected', `Cloudflare WARP active on ${host}:${port} (warp=on)`);
        this.statusCache = null;
        return true;
      }

      // 2. Prioritize userspace WireProxy (runs without root/capabilities in Docker)
      if (this.wireproxyPath) {
        console.log('[WARP] Auto-bootstrapping userspace Cloudflare WARP engine...');
        this.setProgress(30, 'preparing_keys', 'Loading pre-warmed tunnel pool credentials...');
        const pool = await this.ensureAccountPool();
        const account = pool[0];
        const candidateEndpoints = [
          this.sanitizeEndpoint(account.endpoint),
          '162.159.192.1:2408',
          '162.159.193.1:2408',
          '188.114.97.1:2408',
          '162.159.195.1:2408',
          'engage.cloudflareclient.com:2408'
        ].filter((v, i, a) => v && a.indexOf(v) === i);

        let started = false;
        let lastErr = null;
        for (const ep of candidateEndpoints) {
          account.endpoint = ep;
          try {
            await this.startWireproxy(account, this.basePort);
            started = true;
            break;
          } catch (err) {
            lastErr = err;
            console.warn(`[WARP] Bootstrap candidate endpoint ${ep} failed:`, err.message);
            await new Promise(r => setTimeout(r, 400));
          }
        }

        if (!started) throw lastErr;

        this.activePort = this.basePort;
        this.startAutoRotateCron();

        // Boot any additional pre-warmed slots (40001..40003) for instant multi-tunnel load balancing
        const ports = [this.basePort + 1, this.basePort + 2, this.basePort + 3];
        for (let i = 0; i < ports.length; i++) {
          const slotPort = ports[i];
          const slotAcc = pool[i + 1];
          if (slotAcc && !this.portProcesses.has(slotPort)) {
            this.startWireproxy(slotAcc, slotPort)
              .then(() => console.log(`[WARP Pool] Pre-warmed tunnel is LIVE on port ${slotPort} (IPv6: ${slotAcc.addressV6 ? 'enabled' : 'none'})`))
              .catch(err => console.warn(`[WARP Pool] Port ${slotPort} startup notice:`, err.message));
          }
        }

        this.setProgress(100, 'connected', `Cloudflare WARP Connected on ${host}:${this.basePort} (warp=on)`);
        return true;
      }

      // 3. Fallback to official warp-cli daemon if present
      if (this.cliPath) {
        console.log('[WARP] Configuring official Cloudflare WARP CLI proxy mode...');
        this.setProgress(50, 'configuring_cli', 'Configuring warp-cli daemon proxy mode...');
        const ok = await this.ensureProxyMode(port);
        if (ok) {
          this.setProgress(100, 'connected', `Cloudflare WARP CLI Connected on ${host}:${port}`);
        }
        return ok;
      }

      this.setProgress(0, 'idle', 'No local WARP engine found. Egress direct or via custom proxy.');
      console.log('[WARP] No local WARP engine found. Egress direct or via custom proxy.');
      return false;
    } catch (err) {
      console.warn('[WARP] Auto-bootstrap error:', err.message);
      this.setProgress(0, 'error', 'Bootstrap notice: ' + err.message);
      return false;
    } finally {
      this.isBootstrapping = false;
    }
  }

  execWarp(args) {
    return new Promise((resolve, reject) => {
      if (!this.cliPath) {
        return reject(new Error('Cloudflare WARP CLI is not installed or detected.'));
      }
      const finalArgs = args.includes('--accept-tos') ? args : ['--accept-tos', ...args];
      execFile(this.cliPath, finalArgs, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`warp-cli ${finalArgs.join(' ')} failed: ${err.message}. ${stderr || ''}`));
        }
        resolve(stdout.trim());
      });
    });
  }

  async ensureProxyMode(targetPort) {
    if (!this.cliPath) return false;
    const port = targetPort || config.get('warp_port') || 40000;

    try {
      try { await this.execWarp(['registration', 'new']); } catch (e) {}
      try { await this.execWarp(['tunnel', 'protocol', 'set', 'MASQUE']); } catch (e) {}
      try {
        await this.execWarp(['mode', 'proxy']);
      } catch (e) {
        try { await this.execWarp(['set-mode', 'proxy']); } catch (e2) {}
      }
      try {
        await this.execWarp(['proxy', 'port', String(port)]);
      } catch (e) {
        try { await this.execWarp(['set-proxy-port', String(port)]); } catch (e2) {}
      }
      await this.execWarp(['connect']);
      const host = config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
      console.log(`[WARP] Cloudflare WARP CLI proxy mode active on ${host}:${port}`);
      this.statusCache = null;
      return true;
    } catch (err) {
      console.error('[WARP] Failed to set CLI proxy mode:', err.message);
      return false;
    }
  }

  async probeEgressTrace(port, timeoutMs = 5000) {
    const targetPort = port || this.getActivePort();
    const targetHost = this._resolveWarpHost(targetPort);

    return new Promise((resolve) => {
      let resolved = false;
      const done = (val) => {
        if (resolved) return;
        resolved = true;
        resolve(val);
      };

      this.createSocks5Connection('cloudflare.com', 443, targetHost, targetPort, timeoutMs)
        .then((rawSocket) => {
          const tlsSocket = tls.connect({
            socket: rawSocket,
            servername: 'cloudflare.com'
          }, () => {
            const reqStr = 'GET /cdn-cgi/trace HTTP/1.1\r\nHost: cloudflare.com\r\nUser-Agent: curl/8.0\r\nConnection: close\r\n\r\n';
            tlsSocket.write(reqStr);
          });

          let body = '';
          tlsSocket.on('data', chunk => body += chunk.toString());
          tlsSocket.on('end', () => {
            const matchIp = body.match(/ip=([^\r\n]+)/);
            const matchColo = body.match(/colo=([^\r\n]+)/);
            const matchWarp = body.match(/warp=([^\r\n]+)/);
            done({
              ip: matchIp ? matchIp[1] : null,
              colo: matchColo ? matchColo[1] : null,
              warp: matchWarp ? matchWarp[1] : null
            });
          });
          tlsSocket.on('error', () => done(null));
          tlsSocket.setTimeout(timeoutMs, () => {
            tlsSocket.destroy();
            done(null);
          });
        })
        .catch(() => done(null));
    });
  }

  async getStatus() {
    const now = Date.now();
    if (this.statusCache && (now - this.lastStatusCheck < 3000)) {
      return this.statusCache;
    }

    const port = this.getActivePort();
    const host = this._resolveWarpHost(port);

    // Fast socket check
    const socketAlive = await this.probeSocks5(host, port);

    if (socketAlive) {
      const engineMode = this.getEngineMode();
      const engine = engineMode === 'sidecar'
        ? 'Sidecar SOCKS5'
        : (this.wireproxyPath ? 'Userspace WireGuard' : (this.cliPath ? 'CLI Daemon' : 'SOCKS5 Proxy'));
      const trace = await this.probeEgressTrace(port);
      const egressDetail = trace?.ip ? ` • IP: ${trace.ip}${trace.colo ? ` (${trace.colo})` : ''}` : '';
      this.setProgress(100, 'connected', `Cloudflare WARP Egress Active (${engine} • ${host}:${port}${egressDetail})`);
      const result = {
        available: true,
        installed: true,
        status: 'Connected',
        connected: true,
        running: true,
        mode: 'proxy',
        engine_mode: engineMode,
        host: host,
        port: port,
        engine: engine,
        socketAlive: true,
        egressIp: trace?.ip || null,
        colo: trace?.colo || null,
        reason: 'Active & Answering (warp=on)',
        bootstrapping: this.isBootstrapping,
        progress: this.progress
      };
      this.statusCache = result;
      this.lastStatusCheck = now;
      if (engineMode === 'sidecar') this.sidecarReady = true;
      return result;
    }

    // If socket is not alive but an engine is installed or configured, return Disconnected
    if (this.wireproxyPath || this.cliPath || this.getEngineMode() === 'sidecar') {
      const engineMode = this.getEngineMode();
      const result = {
        available: true,
        installed: true,
        status: this.isBootstrapping ? 'Connecting' : 'Disconnected',
        connected: false,
        running: false,
        mode: 'proxy',
        engine_mode: engineMode,
        host: host,
        port: port,
        engine: engineMode === 'sidecar' ? 'Sidecar SOCKS5' : (this.wireproxyPath ? 'Userspace WireGuard' : 'CLI Daemon'),
        socketAlive: false,
        reason: this.isBootstrapping ? 'Establishing tunnel...' : 'SOCKS5 socket inactive',
        bootstrapping: this.isBootstrapping,
        progress: this.progress
      };
      this.statusCache = result;
      this.lastStatusCheck = now;
      if (engineMode === 'sidecar') this.sidecarReady = false;
      return result;
    }

    const uninstalledResult = {
      available: false,
      installed: false,
      status: 'Not Installed',
      mode: 'none',
      host: host,
      port: port,
      connected: false,
      running: false,
      bootstrapping: this.isBootstrapping,
      progress: this.progress,
      installCmd: 'curl -fsSL https://raw.githubusercontent.com/Nystic-Shadow/Opencode2api/main/scripts/install-warp.sh | sudo bash'
    };
    this.statusCache = uninstalledResult;
    this.lastStatusCheck = now;
    return uninstalledResult;
  }

  /**
   * Rotates Cloudflare WARP session keys to acquire a brand new edge egress IP via zero-downtime hot-swap
   */
  markAccountBurned(port, retryAfterSec = 0) {
    this.clearAgent(port);
    const procInfo = this.portProcesses.get(port);
    const account = procInfo?.account;
    const cooldownMs = (retryAfterSec > 0 ? retryAfterSec * 1000 : 3600 * 1000);
    const cooldownUntil = Date.now() + cooldownMs;

    if (account) {
      account._cooldownUntil = cooldownUntil;
      account._burnCount = (account._burnCount || 0) + 1;
      console.log(`[WARP Pool] Account (${account.accountId?.slice(0, 8)}...) on port ${port} set to ${Math.round(cooldownMs / 60000)}m cooldown (burnCount: ${account._burnCount}).`);

      // Immediately hot-swap port with an unburned backup account from pool slots 4..7 if available!
      const pool = this.accountPool || [];
      const cleanBackup = pool.slice(4).find(a => !a._cooldownUntil || Date.now() > a._cooldownUntil);
      if (cleanBackup) {
        console.log(`[WARP Pool] Instantly hot-swapping burned port ${port} to pre-warmed backup slot (${cleanBackup.accountId?.slice(0, 8)})...`);
        this.startWireproxy(cleanBackup, port)
          .then(() => console.log(`[WARP Pool] Port ${port} hot-swapped to fresh backup account!`))
          .catch(err => console.warn(`[WARP Pool] Port ${port} backup hot-swap notice:`, err.message));
      }

      const idx = pool.findIndex(a => a.accountId === account.accountId);
      if (idx !== -1) {
        this.queueSlotReplacement(idx, port);
      }
    } else {
      const pool = this.accountPool || [];
      const offset = (port - this.basePort) % (pool.length || 1);
      if (pool[offset]) {
        pool[offset]._cooldownUntil = cooldownUntil;
        console.log(`[WARP Pool] Slot ${offset + 1} (port ${port}) set to ${Math.round(cooldownMs / 60000)}m rate-limit cooldown.`);
        this.queueSlotReplacement(offset, port);
      }
    }
  }

  async refreshPool() {
    console.log('[WARP Pool] Flushing old account pool and registering fresh credentials...');
    this.accountPool = [];
    try {
      if (fs.existsSync(POOL_FILE)) fs.unlinkSync(POOL_FILE);
      if (fs.existsSync(ACCOUNT_FILE)) fs.unlinkSync(ACCOUNT_FILE);
    } catch (e) {}
    this.regCooldownUntil = 0;
    return await this.autoBootstrap(true);
  }

  async rotateKeys(reason = 'manual') {
    const engine = this.getEngineMode();
    if (engine === 'sidecar') {
      console.warn('[WARP] Key rotation is owned by the sidecar in WARP_ENGINE=sidecar mode; restart the sidecar to rotate.');
      return false;
    }
    if (engine === 'disabled') return false;

    const now = Date.now();

    // 1. Concurrent deduplication: If a rotation is already in flight, await it!
    if (this.isRotating && this.activeRotationPromise) {
      console.log(`[WARP] Awaiting in-flight tunnel key rotation (triggered by: ${reason})...`);
      return await this.activeRotationPromise;
    }

    // 2. Debounce window:
    // Rate-limit rotations jump immediately (minDebounce: 200ms) to unblock traffic instantly!
    const minDebounce = (reason === 'auto_rate_limit' || reason === 'connection_failure') ? 200 : (reason === 'manual' || reason === 'scheduled_cron' ? 1000 : this.rotationCooldownMs);
    if (now - this.lastRotationTime < minDebounce) {
      const waitRemaining = Math.max(1, Math.round((minDebounce - (now - this.lastRotationTime)) / 1000));
      console.log(`[WARP] Key rotation in debounce window (${waitRemaining}s remaining). Active tunnel on port ${this.getActivePort()} is ready.`);
      return true;
    }

    this.isRotating = true;
    this.activeRotationPromise = (async () => {
      this.setProgress(20, 'rotating', `Rotating Cloudflare WARP tunnel session keys (${reason})...`);
      try {
        // Option 1: Running Userspace WireProxy (Pre-Warmed Multi-Port Zero-Downtime Hot-Swap)
        if (this.wireproxyPath) {
          const currentPort = this.getActivePort();
          const allPorts = [this.basePort, this.basePort + 1, this.basePort + 2, this.basePort + 3];
          const primaryNext = this.getNextPort(currentPort);
          const candidatePorts = [
            primaryNext,
            ...allPorts.filter(p => p !== currentPort && p !== primaryNext)
          ];
          const pool = await this.ensureAccountPool();

          // If rate limit triggered rotation: immediately mark current account on cooldown
          if (reason === 'auto_rate_limit' || reason === 'exhausted_failover') {
            this.markAccountBurned(currentPort);
          }

          // Pick the best available slot: search for an account not on cooldown
          let chosenOffset = (this.poolAccountIndex || 0) % pool.length;
          let healthyFound = false;
          for (let i = 0; i < pool.length; i++) {
            const checkOffset = ((this.poolAccountIndex || 0) + i) % pool.length;
            const checkAcc = pool[checkOffset];
            if (!checkAcc._cooldownUntil || Date.now() > checkAcc._cooldownUntil) {
              chosenOffset = checkOffset;
              healthyFound = true;
              break;
            }
          }
          this.poolAccountIndex = (chosenOffset + 1) % pool.length;

          let account = pool[chosenOffset] || pool[0];

          // If all accounts in pool are on cooldown, immediately register a brand new account!
          if (!healthyFound) {
            console.log('[WARP Pool] All accounts in pool are on cooldown. Registering brand new Cloudflare WARP account...');
            try {
              account = await this.registerCloudflareAccount();
              account.endpoint = WARP_ENDPOINTS[Math.floor(Math.random() * WARP_ENDPOINTS.length)];
              account._burnCount = 0;
              account._cooldownUntil = 0;
              this.accountPool.unshift(account);
              if (this.accountPool.length > 10) this.accountPool.pop();
              this.saveAccountPool();
            } catch (regErr) {
              console.warn('[WARP Pool] Emergency registration notice:', regErr.message);
              account = pool[0];
            }
          }

          const candidateEndpoints = [
            this.sanitizeEndpoint(account.endpoint),
            '162.159.192.1:2408',
            'engage.cloudflareclient.com:2408',
            '162.159.193.1:2408',
            '162.159.195.1:2408',
            '188.114.97.1:2408'
          ].filter((v, i, a) => v && a.indexOf(v) === i);

          let targetPort = candidatePorts[0];
          let started = false;
          let lastErr = null;

          for (const portToTry of candidatePorts) {
            targetPort = portToTry;
            for (const ep of candidateEndpoints) {
              account.endpoint = ep;
              console.log(`[WARP] Initiating zero-downtime hot-swap rotation (${reason}) to port ${targetPort} (${ep})...`);
              this.setProgress(50, 'hot_swapping', `Launching pre-warmed WireProxy tunnel on port ${targetPort} (${ep})...`);
              try {
                await this.startWireproxy(account, targetPort);
                started = true;
                break;
              } catch (err) {
                lastErr = err;
                console.warn(`[WARP] Rotation candidate endpoint ${ep} on port ${targetPort} failed:`, err.message);
                await new Promise(r => setTimeout(r, 400));
              }
            }
            if (started) break;
          }

          if (!started) {
            console.warn(`[WARP] All candidate endpoints failed for account offset ${chosenOffset}. Purging bad account and refreshing...`);
            const replacement = await this.replaceBadAccount(chosenOffset);
            if (replacement) {
              for (const portToTry of candidatePorts) {
                targetPort = portToTry;
                try {
                  await this.startWireproxy(replacement, targetPort);
                  started = true;
                  break;
                } catch (reErr) {
                  lastErr = reErr;
                }
              }
            }
          }

          if (!started) {
            throw lastErr || new Error(`Failed to establish working WireProxy tunnel on port ${targetPort}`);
          }

          // Hot-swap active port instantaneously without dropping in-flight traffic
          const oldPort = currentPort;
          this.activePort = targetPort;

          // Swap cached agent to null so new requests use targetPort without destroying in-flight requests on oldPort
          this.cachedAgent = null;
          this.cachedKey = '';
          this.statusCache = null;

          // Maintain persistent multi-tunnel pool: preserve all ports running in parallel
          // so getBestPort() can round-robin across clean tunnels without dropping live slots

          this.lastRotationTime = Date.now();
          this.setProgress(100, 'connected', `Cloudflare WARP hot-swapped to port ${targetPort} with fresh edge session (warp=on)`);
          console.log(`[WARP] Zero-downtime hot-swap complete! Traffic routed to port ${targetPort} (${account.endpoint}, warp=on)`);
          return true;
        }

        // Option 2: Running official warp-cli daemon
        if (this.cliPath) {
          console.log(`[WARP] Rotating CLI tunnel keys (${reason})...`);
          await this.execWarp(['tunnel', 'rotate-keys']);
          await new Promise(r => setTimeout(r, 1200));
          this.statusCache = null;
          this.cachedAgent = null;
          this.lastRotationTime = Date.now();
          this.setProgress(100, 'connected', 'Cloudflare WARP CLI keys rotated');
          return true;
        }

        // Option 3: Fallback socket probe
        const host = config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
        const port = this.getActivePort();
        return await this.probeSocks5(host, port);
      } catch (err) {
        console.warn('[WARP] Key rotation notice:', err.message);
        this.setProgress(0, 'error', 'Key rotation notice: ' + err.message);
        return false;
      } finally {
        this.isRotating = false;
        this.activeRotationPromise = null;
      }
    })();

    return await this.activeRotationPromise;
  }

  async triggerAutoInstall() {
    try {
      console.log('[WARP] Manual Auto-Setup triggered. Initiating auto-bootstrap...');
      const ok = await this.autoBootstrap(true);
      if (ok) {
        return { success: true, message: 'Cloudflare WARP configured & connected successfully!' };
      }
    } catch (e) {
      console.warn('[WARP] Auto-bootstrap error:', e.message);
    }

    // Fallback: If on Linux and no binary, launch install script in background
    if (process.platform !== 'win32') {
      const scriptPath = path.join(__dirname, '..', 'scripts', 'install-warp.sh');
      if (fs.existsSync(scriptPath)) {
        try {
          const child = spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' });
          child.unref();
          return { success: true, message: 'Host installation launched in background. Refresh status in 15 seconds.' };
        } catch (e) {}
      }
    }

    return {
      success: false,
      error: 'Auto-setup requires wireproxy binary or host execution. Run the curl command below.'
    };
  }

  /**
   * Pure native SOCKS5 socket creator (RFC 1928, Zero dependencies).
   * Robust handshake with strict timeout cleanup to prevent socket destruction during inference.
   */
  createSocks5Connection(targetHost, targetPort, proxyHost, proxyPort, timeoutMs = 12000) {
    const self = this;
    const pPort = proxyPort || this.getActivePort();
    const pHost = proxyHost || this._resolveWarpHost(pPort);

    return new Promise((resolve, reject) => {
      let resolved = false;
      const socket = net.connect({ host: pHost, port: pPort }, () => {
        // Handshake: [VER=5, NMETHODS=1, METHOD=0 (NO_AUTH)]
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      let state = 'handshake';

      const cleanupHandshake = () => {
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('timeout');
        socket.setTimeout(0);
      };

      socket.on('data', (data) => {
        if (state === 'handshake') {
          if (data[0] !== 0x05 || data[1] !== 0x00) {
            cleanupHandshake();
            socket.destroy();
            resolved = true;
            if (pPort === self.getActivePort()) {
              self.socketAlive = false;
              self.statusCache = null;
            }
            return reject(new Error('SOCKS5 auth negotiation failed with WARP daemon'));
          }
          // CONNECT request: Always forward domain name [ATYP=0x03] directly to WireProxy
          // so WireProxy resolves it internally via Cloudflare edge DNS without routing leaks
          const hostBuf = Buffer.from(targetHost);
          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])
          ]);
          state = 'connect';
          socket.write(req);
        } else if (state === 'connect') {
          if (data[0] !== 0x05 || data[1] !== 0x00) {
            cleanupHandshake();
            socket.destroy();
            resolved = true;
            if (pPort === self.getActivePort()) {
              self.socketAlive = false;
              self.statusCache = null;
            }
            return reject(new Error(`SOCKS5 WARP tunnel rejected target: ${targetHost}, code: ${data[1]}`));
          }
          // Handshake complete: clean up temporary listeners & clear handshake timeout
          cleanupHandshake();
          resolved = true;
          resolve(socket);
        }
      });

      socket.on('error', (err) => {
        if (!resolved) {
          cleanupHandshake();
          socket.destroy();
          resolved = true;
          reject(err);
        }
      });

      socket.setTimeout(timeoutMs, () => {
        if (!resolved) {
          cleanupHandshake();
          socket.destroy();
          resolved = true;
          if (pPort === self.getActivePort()) {
            self.socketAlive = false;
            self.statusCache = null;
          }
          reject(new Error(`SOCKS5 connection to Cloudflare WARP timed out during handshake (${timeoutMs}ms)`));
        }
      });
    });
  }

  /**
   * Returns an https.Agent routed through Cloudflare WARP SOCKS5.
   */
  getWarpAgent(port, host) {
    const targetPort = port || this.getBestPort();
    const targetHost = this._resolveWarpHost(targetPort, host);
    const cacheKey = `${targetHost}:${targetPort}`;

    if (!this.cachedAgents) this.cachedAgents = new Map();

    if (this.cachedAgents.has(cacheKey)) {
      return this.cachedAgents.get(cacheKey);
    }

    const manager = this;
    const agent = new https.Agent({
      keepAlive: true,
      maxSockets: 64,
      maxFreeSockets: 16,
      timeout: 60000,
      keepAliveMsecs: 15000
    });

    agent.createConnection = function(options, callback) {
      const destHost = options.host || options.hostname || 'opencode.ai';
      const destPort = options.port || 443;
      let connected = false;

      manager.createSocks5Connection(destHost, destPort, targetHost, targetPort)
        .then((rawSocket) => {
          const tlsSocket = tls.connect({
            socket: rawSocket,
            servername: options.servername || destHost
          }, () => {
            connected = true;
            callback(null, tlsSocket);
          });
          tlsSocket.on('error', err => {
            if (!connected) {
              callback(err);
            }
          });
        })
        .catch(err => {
          if (!connected) {
            callback(err);
          }
        });
    };

    this.cachedAgents.set(cacheKey, agent);
    return agent;
  }
}

module.exports = new CloudflareWarpManager();
