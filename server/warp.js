const { execFile } = require('child_process');
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
    this.cachedPort = 0;
    this.statusCache = null;
    this.lastStatusCheck = 0;

    // Check and initialize on startup
    if (this.cliPath) {
      console.log(`[WARP] Cloudflare WARP CLI detected at: ${this.cliPath}`);
      this.ensureProxyMode().catch(err => {
        console.warn('[WARP] Initial proxy mode check warning:', err.message);
      });
    } else {
      console.log('[WARP] Cloudflare WARP CLI not detected on system.');
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
      execFile(this.cliPath, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`warp-cli ${args.join(' ')} failed: ${err.message}. ${stderr || ''}`));
        }
        resolve(stdout.trim());
      });
    });
  }

  async getStatus() {
    const now = Date.now();
    if (this.statusCache && (now - this.lastStatusCheck < 3000)) {
      return this.statusCache;
    }

    if (!this.isAvailable()) {
      return {
        available: false,
        status: 'Not Installed',
        mode: 'none',
        port: 40000,
        connected: false
      };
    }

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
      const port = settingsJson?.settings?.proxy_port || config.get('warp_port') || 40000;

      const result = {
        available: true,
        cliPath: this.cliPath,
        status: isConnected ? 'Connected' : 'Disconnected',
        connected: isConnected,
        mode: opMode,
        port: port,
        reason: statusJson?.reason || 'OK'
      };

      this.statusCache = result;
      this.lastStatusCheck = now;
      return result;
    } catch (err) {
      return {
        available: true,
        status: 'Error',
        connected: false,
        error: err.message,
        port: config.get('warp_port') || 40000
      };
    }
  }

  async ensureProxyMode(targetPort) {
    if (!this.isAvailable()) return false;
    const port = targetPort || config.get('warp_port') || 40000;

    try {
      await this.execWarp(['mode', 'proxy']);
      try {
        await this.execWarp(['proxy', 'port', String(port)]);
      } catch (e) {}
      await this.execWarp(['connect']);
      console.log(`[WARP] Cloudflare WARP proxy mode active on 127.0.0.1:${port}`);
      this.statusCache = null; // Invalidate cache
      return true;
    } catch (err) {
      console.error('[WARP] Failed to set proxy mode:', err.message);
      return false;
    }
  }

  async rotateKeys() {
    if (!this.isAvailable()) return false;

    const now = Date.now();
    if (now - this.lastRotationTime < this.rotationCooldownMs) {
      return true; // Throttle excessive rotations
    }
    this.lastRotationTime = now;

    try {
      console.log('[WARP] Rotating tunnel keys / switching Cloudflare edge session on unauth...');
      await this.execWarp(['tunnel', 'rotate-keys']);
      // Allow brief moment for WARP to establish new tunnel handshake
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

  /**
   * Pure native SOCKS5 socket creator (RFC 1928, Zero dependencies).
   */
  createSocks5Connection(targetHost, targetPort, proxyHost = '127.0.0.1', proxyPort = 40000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: proxyHost, port: proxyPort }, () => {
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
  getWarpAgent(port) {
    const targetPort = port || config.get('warp_port') || 40000;
    if (this.cachedAgent && this.cachedPort === targetPort) {
      return this.cachedAgent;
    }

    const manager = this;
    this.cachedPort = targetPort;
    const agent = new https.Agent({
      keepAlive: true,
      maxSockets: 128,
      maxFreeSockets: 32,
      timeout: 60000,
      keepAliveMsecs: 30000
    });

    agent.createConnection = function(options, callback) {
      const targetHost = options.host || options.hostname || 'opencode.ai';
      const destPort = options.port || 443;
      manager.createSocks5Connection(targetHost, destPort, '127.0.0.1', targetPort)
        .then((rawSocket) => {
          const tlsSocket = tls.connect({
            socket: rawSocket,
            servername: options.servername || targetHost
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
