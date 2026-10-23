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
  'engage.cloudflareclient.com:2408',
  '162.159.192.1:2408',
  '162.159.195.1:500',
  'engage.cloudflareclient.com:500',
  '162.159.195.1:2408',
  '162.159.192.1:500'
];

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

  getBestPort(excludePorts = []) {
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

    // 2. Any healthy live port not on cooldown
    const healthy = livePorts.filter(p => {
      const acc = this.portProcesses.get(p)?.account;
      return !acc?._cooldownUntil || now > acc._cooldownUntil;
    });

    if (healthy.length > 0) {
      this.roundRobinIndex = ((this.roundRobinIndex || 0) + 1) % healthy.length;
      return healthy[this.roundRobinIndex];
    }

    // 3. Fallback: least recently cooled down port not in exclude list
    const candidates = Array.isArray(excludePorts) ? livePorts.filter(p => !excludePorts.includes(p)) : [];
    const pool = candidates.length > 0 ? candidates : livePorts;
    let lowestPort = pool[0];
    let lowestCd = Infinity;
    for (const p of pool) {
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

  async forceKillPort(port) {
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
    if (!ep || typeof ep !== 'string') return 'engage.cloudflareclient.com:2408';
    const trimmed = ep.trim();
    if (trimmed.startsWith('162.159.193.1') || trimmed.includes(':4500')) {
      return '162.159.192.1:2408';
    }
    return trimmed;
  }

  async replaceBadAccount(idx) {
    if (this.regCooldownUntil && Date.now() < this.regCooldownUntil) {
      console.log(`[WARP Pool] Skipping replacement for account ${idx + 1}: Cloudflare registration in cooldown.`);
      return null;
    }
    console.warn(`[WARP Pool] Account ${idx + 1} marked exhausted/burned. Purging and registering a fresh replacement...`);
    try {
      const freshAcc = await this.registerCloudflareAccount();
      freshAcc.endpoint = WARP_ENDPOINTS[idx % WARP_ENDPOINTS.length];
      freshAcc.ipv4Only = (idx % 2 === 1);
      freshAcc._burnCount = 0;
      freshAcc._cooldownUntil = 0;
      if (this.accountPool && this.accountPool.length > idx) {
        this.accountPool[idx] = freshAcc;
      } else {
        this.accountPool.push(freshAcc);
      }
      this.saveAccountPool();
      const modeLabel = freshAcc.ipv4Only ? 'IPv4-Only' : `Dual-Stack IPv6: ${freshAcc.addressV6}`;
      console.log(`[WARP Pool] Fresh replacement account ${idx + 1} ready on ${freshAcc.endpoint} (${modeLabel})`);
      return freshAcc;
    } catch (err) {
      console.warn(`[WARP Pool] Could not register replacement account ${idx + 1}:`, err.message);
      return null;
    }
  }

  loadCachedAccount() {
    try {
      if (fs.existsSync(ACCOUNT_FILE)) {
        const raw = fs.readFileSync(ACCOUNT_FILE, 'utf-8');
        const acc = JSON.parse(raw);
        if (!acc.privateKey || !acc.peerPublicKey) return null;
        acc.endpoint = this.sanitizeEndpoint(acc.endpoint);
        return acc;
      }
    } catch (e) {}
    return null;
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
          const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours max age
          const freshAccounts = parsed.accounts
            .filter(a => {
              if (!a || !a.privateKey || !a.peerPublicKey) return false;
              const regTime = new Date(a.registeredAt || 0).getTime();
              if (now - regTime > MAX_AGE_MS) return false; // Auto-prune accounts older than 2h
              if ((a._burnCount || 0) >= 2) return false; // Auto-prune accounts burned 2+ times
              return true;
            })
            .map((a, idx) => {
              a.endpoint = this.sanitizeEndpoint(WARP_ENDPOINTS[idx % WARP_ENDPOINTS.length]);
              a.ipv4Only = (idx % 2 === 1);
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
      cached.ipv4Only = false;
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
    firstAcc.ipv4Only = false;
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
          acc.ipv4Only = (idx % 2 === 1);
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
   * Starts WireProxy userspace SOCKS5 engine
   */
  async startWireproxy(account, targetPort = null) {
    if (!this.wireproxyPath) {
      throw new Error('wireproxy binary not found on system');
    }

    const host = config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
    const port = targetPort || this.getActivePort();
    const confPath = path.join(DATA_DIR, `wireproxy_${port}.conf`);

    // Ensure port is completely free and clean before spawning!
    await this.forceKillPort(port);

    const isIpv4Only = Boolean(account.ipv4Only);
    this.setProgress(65, 'configuring_tunnel', `Configuring WireGuard profile for ${host}:${port} (${isIpv4Only ? 'IPv4-Only' : 'Dual-Stack IPv6'})...`);

    // WireProxy Egress: Enable dual-stack IPv4/IPv6 OR pure IPv4-only egress to bypass IPv6 subnet exhaustion.
    const addresses = [];
    if (account.addressV4) addresses.push(`${account.addressV4}/32`);
    if (account.addressV6 && !isIpv4Only) addresses.push(`${account.addressV6}/128`);
    if (addresses.length === 0) addresses.push('172.16.0.2/32');

    const endpointHost = this.sanitizeEndpoint(account.endpoint) || 'engage.cloudflareclient.com:2408';
    const dnsServers = isIpv4Only ? '1.1.1.1, 8.8.8.8' : '1.1.1.1, 2606:4700:4700::1111, 8.8.8.8';
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
BindAddress = ${host}:${port}
`;

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(confPath, confContent);

    this.setProgress(75, 'launching_tunnel', `Starting userspace WireProxy SOCKS5 daemon on ${host}:${port}...`);
    console.log(`[WARP] Starting userspace WireProxy SOCKS5 daemon on ${host}:${port} (${endpointHost})...`);

    let procExited = false;
    let procExitCode = null;
    let procExitSignal = null;

    const proc = spawn(this.wireproxyPath, ['-c', confPath], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.portProcesses.set(port, { proc, startedAt: Date.now(), account });

    proc.stdout.on('data', d => {
      const msg = d.toString().trim();
      if (msg.includes('bind:') || msg.includes('error')) console.warn(`[WireProxy:${port}]`, msg);
    });

    proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg.includes('Interface state was Down, requested Up, now Up')) {
        console.log(`[WireProxy:${port}] Tunnel connected to Cloudflare Edge (warp=on)`);
      }
    });

    proc.on('exit', (code, sig) => {
      procExited = true;
      procExitCode = code;
      procExitSignal = sig;
      console.warn(`[WireProxy:${port}] Process exited (code: ${code}, signal: ${sig})`);
      const current = this.portProcesses.get(port);
      if (current && current.proc === proc) {
        this.portProcesses.delete(port);
      }
      if (port === this.getActivePort()) {
        this.socketAlive = false;
        this.statusCache = null;
      }
    });

    this.setProgress(85, 'verifying_socket', `Probing SOCKS5 handshake on ${host}:${port}...`);

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
      const alive = await this.probeSocks5(host, port);
      if (alive) {
        socketLive = true;
        break;
      }
    }

    if (!socketLive) {
      try { proc.kill('SIGTERM'); } catch (e) {}
      this.portProcesses.delete(port);
      throw new Error(`WireProxy launched on ${host}:${port} but SOCKS5 port failed to answer within 8s`);
    }

    // 2. Poll for genuine Cloudflare Edge egress verification (trace)
    this.setProgress(90, 'verifying_tunnel', `Verifying edge egress connectivity on ${host}:${port} (${endpointHost})...`);
    let trace = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (procExited) break;
      trace = await this.probeEgressTrace(port, 2500);
      if (trace && trace.ip) break;
      await new Promise(r => setTimeout(r, 400));
    }

    if (trace && trace.ip) {
      const ipFamily = trace.ip.includes(':') ? 'IPv6' : 'IPv4';
      console.log(`[WARP] WireProxy SOCKS5 engine is LIVE on ${host}:${port} (warp=on • Egress: ${trace.ip} [${ipFamily} • ${trace.colo || 'Edge'}])`);
      this.setProgress(100, 'connected', `Cloudflare WARP Egress Active on ${host}:${port} (warp=on • ${trace.ip})`);
      this.socketAlive = true;
      this.statusCache = null;
      return proc;
    }

    // If edge verification failed on this endpoint, terminate process and throw so rotate/bootstrap can try alternative endpoint
    console.warn(`[WARP] WireProxy on ${host}:${port} answered SOCKS5, but edge egress trace failed on ${endpointHost}`);
    try { proc.kill('SIGTERM'); } catch (e) {}
    this.portProcesses.delete(port);
    throw new Error(`WireProxy tunnel on ${host}:${port} (${endpointHost}) failed edge egress check (code: 4 / unreachable)`);
  }

  /**
   * Fast SOCKS5 socket probe (RFC 1928) to test if proxy is answering on host:port
   */
  probeSocks5(host, port) {
    const targetHost = host || config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
    const targetPort = port || this.getActivePort();

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
   * Auto-bootstraps Cloudflare WARP:
   * 1. Checks if SOCKS5 proxy is already live.
   * 2. If not, boots wireproxy (userspace WireGuard) or warp-cli.
   */
  async autoBootstrap(forceRestart = false) {
    if (this.isBootstrapping && !forceRestart) return false;
    this.isBootstrapping = true;
    this.setProgress(10, 'initializing', 'Initializing Cloudflare WARP engine...');

    const host = config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
    const port = this.getActivePort();

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
          'engage.cloudflareclient.com:2408',
          '162.159.192.1:2408',
          'engage.cloudflareclient.com:500'
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

  async probeEgressTrace(port, timeoutMs = 2500) {
    const targetHost = config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
    const targetPort = port || this.getActivePort();

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

    const host = config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
    const port = this.getActivePort();

    // Fast socket check
    const socketAlive = await this.probeSocks5(host, port);

    if (socketAlive) {
      const engine = this.wireproxyPath ? 'Userspace WireGuard' : (this.cliPath ? 'CLI Daemon' : 'SOCKS5 Proxy');
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
      return result;
    }

    // If socket is not alive but an engine is installed, return Disconnected
    if (this.wireproxyPath || this.cliPath) {
      const result = {
        available: true,
        installed: true,
        status: this.isBootstrapping ? 'Connecting' : 'Disconnected',
        connected: false,
        running: false,
        mode: 'proxy',
        host: host,
        port: port,
        engine: this.wireproxyPath ? 'Userspace WireGuard' : 'CLI Daemon',
        socketAlive: false,
        reason: this.isBootstrapping ? 'Establishing tunnel...' : 'SOCKS5 socket inactive',
        bootstrapping: this.isBootstrapping,
        progress: this.progress
      };
      this.statusCache = result;
      this.lastStatusCheck = now;
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
  markAccountBurned(port) {
    const procInfo = this.portProcesses.get(port);
    const account = procInfo?.account;
    if (account) {
      // 45-second fast cooldown window for rate-limited account
      account._cooldownUntil = Date.now() + (45 * 1000);
      account._burnCount = (account._burnCount || 0) + 1;
      console.log(`[WARP Pool] Account (${account.accountId?.slice(0, 8)}...) on port ${port} set to 45s cooldown (burnCount: ${account._burnCount}).`);

      // If an account gets burned 2 times, replace it with a fresh account in the background
      if ((account._burnCount || 0) >= 2) {
        const pool = this.accountPool || [];
        const idx = pool.findIndex(a => a.accountId === account.accountId);
        if (idx !== -1) {
          console.log(`[WARP Pool] Slot ${idx + 1} reached burn threshold (2). Auto-retiring and generating fresh account...`);
          this.replaceBadAccount(idx).then((freshAcc) => {
            if (freshAcc && this.portProcesses.has(port)) {
              this.startWireproxy(freshAcc, port)
                .then(() => console.log(`[WARP Pool] Port ${port} re-armed with fresh account ${freshAcc.accountId.slice(0, 8)} (${freshAcc.ipv4Only ? 'IPv4-Only' : 'Dual-Stack IPv6'})!`))
                .catch(err => console.warn(`[WARP Pool] Port ${port} re-arm notice:`, err.message));
            }
          }).catch(() => {});
        }
      }
    } else {
      const pool = this.accountPool || [];
      const offset = (port - this.basePort) % (pool.length || 1);
      if (pool[offset]) {
        pool[offset]._cooldownUntil = Date.now() + (45 * 1000);
        console.log(`[WARP Pool] Slot ${offset + 1} (port ${port}) set to 45s rate-limit cooldown.`);
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
          const targetPort = this.getNextPort(currentPort);
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

          // If all accounts are on cooldown, pick the slot closest to cooldown expiration
          if (!healthyFound) {
            let lowestIdx = 0;
            let lowestCd = Infinity;
            for (let i = 0; i < pool.length; i++) {
              const cd = pool[i]._cooldownUntil || 0;
              if (cd < lowestCd) {
                lowestCd = cd;
                lowestIdx = i;
              }
            }
            chosenOffset = lowestIdx;
            account = pool[chosenOffset];
            const waitSec = Math.max(0, Math.ceil((lowestCd - Date.now()) / 1000));
            console.log(`[WARP Pool] Cycling pool: selecting slot ${chosenOffset + 1} (${waitSec}s cooldown remaining).`);
          }

          const candidateEndpoints = [
            this.sanitizeEndpoint(account.endpoint),
            'engage.cloudflareclient.com:2408',
            '162.159.192.1:2408',
            'engage.cloudflareclient.com:500'
          ].filter((v, i, a) => v && a.indexOf(v) === i);

          let started = false;
          let lastErr = null;
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

          if (!started) {
            console.warn(`[WARP] All candidate endpoints failed for account offset ${chosenOffset}. Purging bad account and refreshing...`);
            const replacement = await this.replaceBadAccount(chosenOffset);
            if (replacement) {
              try {
                await this.startWireproxy(replacement, targetPort);
                started = true;
              } catch (reErr) {
                lastErr = reErr;
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

          // Gracefully drain old wireproxy process after 12 seconds only if truly distinct from active targetPort
          if (oldPort !== targetPort) {
            this.scheduleDraining(oldPort);
          }

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
    const pHost = proxyHost || config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
    const pPort = proxyPort || this.getActivePort();

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
          // CONNECT request: [VER=5, CMD=1, RSV=0, ATYP=3 (DOMAIN), LEN, ...domain, PORT_HI, PORT_LO]
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
    const targetHost = host || config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
    const targetPort = port || this.getBestPort();
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
