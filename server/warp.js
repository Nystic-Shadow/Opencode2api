const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const https = require('https');
const config = require('./config');

class CloudflareWarpManager {
  constructor() {
    this.cliPath = this.detectCliPath();
    this.lastRotationTime = 0;
    this.rotationCooldownMs = 4000;
    this.cachedAgent = null;
    this.cachedKey = '';
    this.statusCache = null;
    this.lastStatusCheck = 0;

    // Check and initialize on startup
    if (this.cliPath) {
      console.log(`[WARP] Cloudflare WARP CLI detected at: ${this.cliPath}`);
      this.ensureProxyMode().catch(err => {
        console.warn('[WARP] Initial proxy mode check warning:', err.message);
      });
    } else {
      console.log('[WARP] Cloudflare WARP CLI not detected. Checking SOCKS5 socket...');
      this.probeSocks5().then(alive => {
        if (alive) {
          const host = config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
          const port = config.get('warp_port') || parseInt(process.env.WARP_PORT, 10) || 40000;
          console.log(`[WARP] Cloudflare WARP SOCKS5 proxy detected and active on ${host}:${port}`);
        } else {
          console.log('[WARP] SOCKS5 proxy socket not active. WARP proxy idle.');
        }
      }).catch(() => {});
    }
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
    return Boolean(this.cliPath && fs.existsSync(this.cliPath));
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

  /**
   * Fast SOCKS5 socket probe (RFC 1928) to test if proxy is answering on host:port
   */
  probeSocks5(host, port) {
    const targetHost = host || config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
    const targetPort = port || config.get('warp_port') || parseInt(process.env.WARP_PORT, 10) || 40000;

    return new Promise((resolve) => {
      const socket = net.connect({ host: targetHost, port: targetPort, timeout: 2000 }, () => {
        // Send SOCKS5 handshake: VER=5, NMETHODS=1, METHOD=0
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      socket.on('data', (data) => {
        socket.destroy();
        resolve(data.length >= 2 && data[0] === 0x05 && data[1] === 0x00);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  async getStatus() {
    const now = Date.now();
    if (this.statusCache && (now - this.lastStatusCheck < 3000)) {
      return this.statusCache;
    }

    const host = config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
    const port = config.get('warp_port') || parseInt(process.env.WARP_PORT, 10) || 40000;

    // 1. If CLI is present, check official CLI status
    if (this.isAvailable()) {
      try {
        let statusStr = '';
        let settingsStr = '';

        try {
          statusStr = await this.execWarp(['--json', 'status']);
        } catch (e) {
          statusStr = await this.execWarp(['status']);
        }

        try {
          settingsStr = await this.execWarp(['--json', 'settings', 'list']);
        } catch (e) {}

        let statusJson = null;
        let settingsJson = null;

        try { statusJson = JSON.parse(statusStr); } catch (e) {}
        try { settingsJson = JSON.parse(settingsStr); } catch (e) {}

        const isConnected = statusJson?.status === 'Connected' || statusStr.toLowerCase().includes('connected');
        const opMode = settingsJson?.settings?.operation_mode || (statusStr.includes('proxy') ? 'proxy' : 'warp');
        const reportedPort = settingsJson?.settings?.proxy_port || port;

        const result = {
          available: true,
          installed: true,
          cliPath: this.cliPath,
          status: isConnected ? 'Connected' : 'Disconnected',
          connected: isConnected,
          running: isConnected,
          mode: opMode,
          host: host,
          port: reportedPort,
          reason: statusJson?.reason || 'OK'
        };

        this.statusCache = result;
        this.lastStatusCheck = now;
        return result;
      } catch (err) {
        // Fall through to probe check
      }
    }

    // 2. If CLI is absent or failed, check if SOCKS5 proxy port is active (e.g. sidecar or host daemon)
    const isSocketAlive = await this.probeSocks5(host, port);
    if (isSocketAlive) {
      const result = {
        available: true,
        installed: true,
        cliPath: this.cliPath || 'SOCKS5 Daemon / Sidecar',
        status: 'Connected',
        connected: true,
        running: true,
        mode: 'proxy',
        host: host,
        port: port,
        reason: 'SOCKS5 Active'
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
      installCmd: 'curl -fsSL https://raw.githubusercontent.com/Nystic-Shadow/Opencode2api/main/scripts/install-warp.sh | sudo bash'
    };
    this.statusCache = uninstalledResult;
    this.lastStatusCheck = now;
    return uninstalledResult;
  }

  async ensureProxyMode(targetPort) {
    if (!this.isAvailable()) return false;
    const port = targetPort || config.get('warp_port') || 40000;

    try {
      try {
        await this.execWarp(['registration', 'new']);
      } catch (e) {}
      await this.execWarp(['mode', 'proxy']);
      try {
        await this.execWarp(['proxy', 'port', String(port)]);
      } catch (e) {}
      await this.execWarp(['connect']);
      const host = config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
      console.log(`[WARP] Cloudflare WARP proxy mode active on ${host}:${port}`);
      this.statusCache = null; // Invalidate cache
      return true;
    } catch (err) {
      console.error('[WARP] Failed to set proxy mode:', err.message);
      return false;
    }
  }

  async rotateKeys() {
    const now = Date.now();
    if (now - this.lastRotationTime < this.rotationCooldownMs) {
      return true; // Throttle excessive rotations
    }
    this.lastRotationTime = now;

    if (!this.isAvailable()) {
      // Re-probe socket
      const host = config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
      const port = config.get('warp_port') || parseInt(process.env.WARP_PORT, 10) || 40000;
      return await this.probeSocks5(host, port);
    }

    try {
      console.log('[WARP] Rotating tunnel keys / switching Cloudflare edge session on unauth...');
      await this.execWarp(['tunnel', 'rotate-keys']);
      await new Promise(r => setTimeout(r, 1200));
      console.log('[WARP] Cloudflare WARP tunnel keys successfully rotated (fresh edge egress active).');
      this.statusCache = null;
      return true;
    } catch (err) {
      console.warn('[WARP] Tunnel key rotation error, attempting reconnect fallback:', err.message);
      try {
        await this.execWarp(['disconnect']);
        await new Promise(r => setTimeout(r, 800));
        await this.execWarp(['connect']);
        await new Promise(r => setTimeout(r, 1200));
        return true;
      } catch (fallbackErr) {
        console.error('[WARP] Reconnect fallback failed:', fallbackErr.message);
        return false;
      }
    }
  }

  async triggerAutoInstall() {
    if (process.platform === 'win32') {
      return { success: false, error: 'Automatic installation on Windows requires manual installer download from https://1.1.1.1' };
    }
    const scriptPath = path.join(__dirname, '..', 'scripts', 'install-warp.sh');
    if (!fs.existsSync(scriptPath)) {
      return { success: false, error: 'Install script not found on disk at scripts/install-warp.sh' };
    }

    return new Promise((resolve) => {
      try {
        const child = spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' });
        child.unref();
        resolve({
          success: true,
          message: 'Cloudflare WARP installation initiated in background. Refresh status in 15 seconds.'
        });
      } catch (err) {
        resolve({ success: false, error: 'Failed to launch installer: ' + err.message });
      }
    });
  }

  /**
   * Pure native SOCKS5 socket creator (RFC 1928, Zero dependencies).
   */
  createSocks5Connection(targetHost, targetPort, proxyHost, proxyPort) {
    const pHost = proxyHost || config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
    const pPort = proxyPort || config.get('warp_port') || parseInt(process.env.WARP_PORT, 10) || 40000;

    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: pHost, port: pPort }, () => {
        // Handshake: [VER=5, NMETHODS=1, METHOD=0 (NO_AUTH)]
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      let state = 'handshake';

      socket.on('data', (data) => {
        if (state === 'handshake') {
          if (data[0] !== 0x05 || data[1] !== 0x00) {
            socket.destroy();
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
            socket.destroy();
            return reject(new Error(`SOCKS5 WARP tunnel rejected target: ${targetHost}, code: ${data[1]}`));
          }
          socket.removeAllListeners('data');
          resolve(socket);
        }
      });

      socket.on('error', reject);
      socket.setTimeout(8000, () => {
        socket.destroy();
        reject(new Error('SOCKS5 connection to Cloudflare WARP timed out'));
      });
    });
  }

  /**
   * Returns an https.Agent routed through Cloudflare WARP SOCKS5.
   */
  getWarpAgent(port, host) {
    const targetHost = host || config.get('warp_host') || process.env.WARP_HOST || '127.0.0.1';
    const targetPort = port || config.get('warp_port') || parseInt(process.env.WARP_PORT, 10) || 40000;
    const cacheKey = `${targetHost}:${targetPort}`;

    if (this.cachedAgent && this.cachedKey === cacheKey) {
      return this.cachedAgent;
    }

    const manager = this;
    this.cachedKey = cacheKey;
    const agent = new https.Agent({
      keepAlive: true,
      maxSockets: 128,
      maxFreeSockets: 32,
      timeout: 60000,
      keepAliveMsecs: 30000
    });

    agent.createConnection = function(options, callback) {
      const destHost = options.host || options.hostname || 'opencode.ai';
      const destPort = options.port || 443;
      manager.createSocks5Connection(destHost, destPort, targetHost, targetPort)
        .then((rawSocket) => {
          const tlsSocket = tls.connect({
            socket: rawSocket,
            servername: options.servername || destHost
          }, () => {
            callback(null, tlsSocket);
          });
          tlsSocket.on('error', err => callback(err));
        })
        .catch(err => callback(err));
    };

    this.cachedAgent = agent;
    return this.cachedAgent;
  }
}

module.exports = new CloudflareWarpManager();
