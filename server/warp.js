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
const WIREPROXY_CONF = path.join(DATA_DIR, 'wireproxy.conf');

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
    this.rotationCooldownMs = 5000; // 5-second debounce between rapid rotations
    this.isRotating = false;
    this.activeRotationPromise = null;
    this.cachedAgent = null;
    this.cachedKey = '';
    this.statusCache = null;
    this.socketAlive = false;
    this.lastStatusCheck = 0;
    this.isBootstrapping = false;
    this.progress = {
      percent: 0,
      stage: 'idle',
      message: 'WARP Engine Idle'
    };

    // Fast initial background probe so socketAlive state is immediately populated
    this.probeSocks5().catch(() => {});
  }

  getActivePort() {
    return this.activePort || this.basePort || 40000;
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

  loadCachedAccount() {
    try {
      if (fs.existsSync(ACCOUNT_FILE)) {
        const raw = fs.readFileSync(ACCOUNT_FILE, 'utf-8');
        const acc = JSON.parse(raw);
        if (!acc.privateKey || !acc.peerPublicKey) return null;
        return acc;
      }
    } catch (e) {}
    return null;
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

    this.setProgress(65, 'configuring_tunnel', `Configuring WireGuard profile for ${host}:${port}...`);

    // WireProxy Egress: Enforce IPv4 Anycast strictly to prevent shared Cloudflare IPv6 /64 prefix rate limits on opencode.ai
    const addresses = [];
    if (account.addressV4) addresses.push(`${account.addressV4}/32`);
    if (addresses.length === 0) addresses.push('172.16.0.2/32');

    const endpointHost = account.endpoint || 'engage.cloudflareclient.com:2408';

    const confContent = `[Interface]
PrivateKey = ${account.privateKey}
Address = ${addresses.join(', ')}
DNS = 1.1.1.1

[Peer]
PublicKey = ${account.peerPublicKey}
Endpoint = ${endpointHost}
KeepAlive = 25

[Socks5]
BindAddress = ${host}:${port}
`;

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(confPath, confContent);

    this.setProgress(75, 'launching_tunnel', `Starting userspace WireProxy SOCKS5 daemon on ${host}:${port}...`);
    console.log(`[WARP] Starting userspace WireProxy SOCKS5 daemon on ${host}:${port}...`);

    let procExited = false;
    let procExitCode = null;
    let procExitSignal = null;

    const proc = spawn(this.wireproxyPath, ['-c', confPath], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.portProcesses.set(port, { proc, startedAt: Date.now() });

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

    // Poll until SOCKS5 socket answers handshake (up to 8 seconds)
    const startTime = Date.now();
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
        console.log(`[WARP] WireProxy SOCKS5 engine is LIVE on ${host}:${port} (warp=on)`);
        this.setProgress(100, 'connected', `Cloudflare WARP Egress Active on ${host}:${port} (warp=on)`);
        this.socketAlive = true;
        this.statusCache = null;
        return proc;
      }
    }

    try { proc.kill('SIGTERM'); } catch (e) {}
    this.portProcesses.delete(port);
    throw new Error(`WireProxy launched on ${host}:${port} but SOCKS5 port failed to answer within 8s`);
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
        this.setProgress(30, 'preparing_keys', 'Verifying Curve25519 tunnel credentials...');
        let account = this.loadCachedAccount();
        if (!account || forceRestart) {
          account = await this.registerCloudflareAccount();
        }
        await this.startWireproxy(account, this.basePort);
        this.activePort = this.basePort;
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

  async getStatus() {
    const now = Date.now();
    if (this.statusCache && (now - this.lastStatusCheck < 2000)) {
      return this.statusCache;
    }

    const host = config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
    const port = this.getActivePort();

    // Fast socket check
    const socketAlive = await this.probeSocks5(host, port);

    if (socketAlive) {
      const engine = this.wireproxyPath ? 'Userspace WireGuard' : (this.cliPath ? 'CLI Daemon' : 'SOCKS5 Proxy');
      this.setProgress(100, 'connected', `Cloudflare WARP Egress Active (${engine} • ${host}:${port})`);
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
  async rotateKeys(reason = 'manual') {
    const now = Date.now();

    // 1. Concurrent deduplication: If a rotation is already in flight, await it!
    if (this.isRotating && this.activeRotationPromise) {
      console.log(`[WARP] Awaiting in-flight tunnel key rotation (triggered by: ${reason})...`);
      return await this.activeRotationPromise;
    }

    // 2. Debounce window:
    // If rate-limited, allow rotation after at least 3 seconds so we don't spam Cloudflare API,
    // but don't trap the user in an 8-second dead state.
    const minDebounce = (reason === 'auto_rate_limit' || reason === 'manual') ? 3000 : this.rotationCooldownMs;
    if (now - this.lastRotationTime < minDebounce) {
      const waitRemaining = Math.round((minDebounce - (now - this.lastRotationTime)) / 1000);
      console.log(`[WARP] Key rotation in debounce window (${waitRemaining}s remaining). Active tunnel on port ${this.getActivePort()} is ready.`);
      return true;
    }

    this.isRotating = true;
    this.activeRotationPromise = (async () => {
      this.setProgress(20, 'rotating', `Rotating Cloudflare WARP tunnel session keys (${reason})...`);
      try {
        // Option 1: Running Userspace WireProxy (Multi-Port Zero-Downtime Hot-Swap)
        if (this.wireproxyPath) {
          console.log(`[WARP] Initiating zero-downtime hot-swap rotation (${reason})...`);
          const currentPort = this.getActivePort();
          const nextPort = this.getNextPort(currentPort);

          this.setProgress(40, 'registering', 'Negotiating fresh Curve25519 session with Cloudflare API...');
          const newAccount = await this.registerCloudflareAccount();

          this.setProgress(70, 'hot_swapping', `Launching secondary WireProxy tunnel on port ${nextPort}...`);
          await this.startWireproxy(newAccount, nextPort);

          // Hot-swap active port instantaneously without dropping in-flight traffic
          const oldPort = currentPort;
          this.activePort = nextPort;
          this.cachedAgent = null;
          this.cachedKey = '';
          this.statusCache = null;

          // Gracefully drain old wireproxy process after 12 seconds
          this.scheduleDraining(oldPort);

          this.lastRotationTime = Date.now();
          this.setProgress(100, 'connected', `Cloudflare WARP hot-swapped to port ${nextPort} with fresh edge session (warp=on)`);
          console.log(`[WARP] Zero-downtime hot-swap complete! Traffic routed to port ${nextPort}. Egress IP refreshed.`);
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
  createSocks5Connection(targetHost, targetPort, proxyHost, proxyPort) {
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
          resolved = true;
          reject(err);
        }
      });

      socket.setTimeout(12000, () => {
        if (!resolved) {
          cleanupHandshake();
          socket.destroy();
          resolved = true;
          reject(new Error('SOCKS5 connection to Cloudflare WARP timed out during handshake'));
        }
      });
    });
  }

  /**
   * Returns an https.Agent routed through Cloudflare WARP SOCKS5.
   */
  getWarpAgent(port, host) {
    const targetHost = host || config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
    const targetPort = port || this.getActivePort();
    const cacheKey = `${targetHost}:${targetPort}`;

    if (this.cachedAgent && this.cachedKey === cacheKey) {
      return this.cachedAgent;
    }

    const manager = this;
    this.cachedKey = cacheKey;
    const agent = new https.Agent({
      keepAlive: true,
      maxSockets: 64,
      maxFreeSockets: 16,
      timeout: 60000,
      keepAliveMsecs: 10000
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
            manager.cachedAgent = null;
            if (!connected) {
              callback(err);
            }
          });
        })
        .catch(err => {
          manager.cachedAgent = null;
          if (!connected) {
            callback(err);
          }
        });
    };

    this.cachedAgent = agent;
    return this.cachedAgent;
  }
}

module.exports = new CloudflareWarpManager();
