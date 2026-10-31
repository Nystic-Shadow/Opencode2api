/**
 * Lifecycle manager for the loopback Bun bridge.
 *
 * The official OpenCode inference gate rejects Node's TLS fingerprint. The
 * OpenCode CLI ships Bun as its runtime, so this manager discovers that
 * binary, starts `server/bunProxy.js` under `BUN_BE_BUN=1`, waits for the
 * loopback health probe, and restarts it with backoff if it exits.
 *
 * The bridge is intentionally optional at the module level: importing this
 * file never spawns a process, so unit tests and non-official upstreams are
 * unaffected.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const config = require('./config');
const egress = require('./egress');

const BRIDGE_SCRIPT = path.join(__dirname, 'bunProxy.js');
const OFFICIAL_HOST = 'opencode.ai';
const DEFAULT_START_TIMEOUT_MS = 15000;
const DEFAULT_READY_WAIT_MS = 12000;

const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy',
  'NO_PROXY', 'no_proxy'
];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isOfficialUpstream(target) {
  if (!target) return false;
  let hostname;
  let pathname;
  if (typeof target === 'string') {
    try {
      const parsed = new URL(target);
      hostname = parsed.hostname;
      pathname = parsed.pathname;
    } catch (e) {
      return false;
    }
  } else {
    hostname = target.hostname;
    pathname = target.path || target.pathname || '';
  }
  hostname = String(hostname || '').toLowerCase();
  pathname = String(pathname || '');
  return hostname === OFFICIAL_HOST && pathname.startsWith('/inference/');
}

// A 429 from a direct Node request to the official host is the TLS gate
// rejecting the fingerprint, not evidence that the free bucket is empty.
// Only requests actually carried by the Bun bridge may poison the global
// free-tier quota gate.
function isDirectOfficialAttempt(officialUpstream, attemptResult) {
  return Boolean(officialUpstream && attemptResult && !attemptResult.viaBridge);
}

function encodeProxyHeader(valueOrRoute) {
  const url = typeof valueOrRoute === 'string'
    ? valueOrRoute
    : buildProxyUrl(valueOrRoute);
  if (!url) return '';
  return Buffer.from(url, 'utf8').toString('base64url');
}

function decodeProxyHeader(value) {
  if (!value) return '';
  try {
    return Buffer.from(String(value), 'base64url').toString('utf8');
  } catch (e) {
    return '';
  }
}

function buildProxyUrl(route) {
  if (!route || route.type !== 'proxy') return '';
  const scheme = ['http', 'https', 'socks5', 'socks5h'].includes(route.proxyType)
    ? route.proxyType
    : 'http';
  let username = route.username || '';
  const password = route.password || '';

  if (route.isRotating || config.get('rotating_proxy_enabled')) {
    username = egress.applyRotatingSession(username, config.get('rotating_proxy_session_mode'));
  }

  const auth = username
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : '';
  const rawHost = String(route.host || '');
  const host = rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost;
  if (!host || !route.port) return '';
  return `${scheme}://${auth}${host}:${route.port}`;
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (e) {}
  }
  return '';
}

function findCliBinary(configuredPath = '') {
  const configured = String(configuredPath || '').trim();
  if (configured && firstExisting([configured])) return configured;

  const candidates = [];
  if (process.env.OPENCODE_CLI_PATH) candidates.push(process.env.OPENCODE_CLI_PATH);
  if (process.env.OPENCODE_BIN) candidates.push(process.env.OPENCODE_BIN);

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    for (const root of [appData, localAppData, programFiles, programFilesX86]) {
      if (!root) continue;
      candidates.push(path.join(root, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'));
      candidates.push(path.join(root, 'nodejs', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'));
      candidates.push(path.join(root, 'Programs', 'nodejs', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'));
    }
    candidates.push(path.join(process.cwd(), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'));
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, 'opencode.exe'));
    }
  } else {
    const home = process.env.HOME || '';
    candidates.push(
      path.join(home, '.opencode', 'bin', 'opencode'),
      path.join(home, '.local', 'bin', 'opencode'),
      '/usr/local/bin/opencode',
      '/opt/homebrew/bin/opencode',
      '/usr/bin/opencode'
    );
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, 'opencode'));
    }
  }

  return firstExisting(candidates);
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function probeHealth(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let req;
    try {
      req = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/__health',
        timeout: timeoutMs,
        agent: false
      }, (res) => {
        res.resume();
        res.on('end', () => finish(res.statusCode === 200));
        res.on('error', () => finish(false));
      });
    } catch (e) {
      finish(false);
      return;
    }
    req.on('timeout', () => {
      try { req.destroy(); } catch (e) {}
      finish(false);
    });
    req.on('error', () => finish(false));
  });
}

class BunBridge {
  constructor() {
    this.child = null;
    this.port = 0;
    this.token = '';
    this.ready = false;
    this.state = 'idle';
    this.lastError = '';
    this.cliPath = '';
    this.restartAttempts = 0;
    this.restartCount = 0;
    this.stopping = false;
    this.retryAt = 0;
    this.transportFailures = 0;
    this._startPromise = null;
    this._restartTimer = null;
    this._stderrTail = [];
  }

  isEnabled() {
    return config.get('bun_bridge_enabled') !== false;
  }

  isRequired() {
    if (!this.isEnabled()) return false;
    return isOfficialUpstream(config.get('upstream_inference_url') || '');
  }

  isReady() {
    return this.ready && this.port > 0;
  }

  getConnection() {
    if (!this.isReady()) return null;
    return { host: '127.0.0.1', port: this.port, token: this.token };
  }

  getStatus() {
    return {
      enabled: this.isEnabled(),
      required: this.isRequired(),
      ready: this.isReady(),
      state: this.state,
      port: this.port || null,
      pid: this.child ? this.child.pid : null,
      cli_path: this.cliPath || null,
      restarts: this.restartCount,
      last_error: this.lastError || null
    };
  }

  getUnavailableMessage() {
    const detail = this.lastError || this.state;
    return 'The OpenCode CLI Bun bridge is not ready (' + detail + '). ' +
      'Free-tier inference requires the OpenCode CLI binary; install it with ' +
      '"npm i -g @opencode/cli" or set BUN_BRIDGE_CLI_PATH to its path.';
  }

  resolveCli() {
    const configured = config.get('bun_bridge_cli_path') || '';
    const found = findCliBinary(configured);
    this.cliPath = found;
    return found;
  }

  start() {
    if (!this.isEnabled()) {
      this.state = 'disabled';
      return Promise.resolve(false);
    }
    if (this.stopping) return Promise.resolve(false);
    if (this.isReady()) return Promise.resolve(true);
    if (this._startPromise) return this._startPromise;
    if (Date.now() < this.retryAt) return Promise.resolve(false);

    this._startPromise = this._launch().finally(() => {
      this._startPromise = null;
    });
    return this._startPromise;
  }

  async ensureReady(waitMs = DEFAULT_READY_WAIT_MS) {
    if (!this.isEnabled()) return false;
    if (this.isReady()) return true;
    if (this.stopping) return false;
    if (this.state === 'unavailable' && Date.now() < this.retryAt) return false;

    const startup = this.start();
    if (waitMs <= 0) return false;

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const started = await Promise.race([startup, timeout]);
    clearTimeout(timer);
    return started === true || this.isReady();
  }

  markHealthy() {
    this.transportFailures = 0;
  }

  reportTransportFailure() {
    if (!this.isReady()) return;
    this.transportFailures++;
    if (this.transportFailures < 2) return;
    this.lastError = 'Bridge loopback transport failed';
    this.ready = false;
    this.state = 'error';
    this.transportFailures = 0;
    if (this.child) {
      try { this.child.kill(); } catch (e) {}
    }
    // Do not rely solely on the exit event: a wedged child that ignores the
    // kill must not leave the bridge permanently unavailable.
    this._scheduleRestart();
  }

  stop() {
    this.stopping = true;
    this.ready = false;
    this.state = 'stopped';
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this.child) {
      try { this.child.kill(); } catch (e) {}
      this.child = null;
    }
  }

  _scheduleRestart() {
    if (this.stopping || !this.isEnabled()) return;
    if (this._restartTimer) return;
    const backoff = Math.min(30000, 1000 * Math.pow(2, Math.min(5, this.restartAttempts)));
    this.restartAttempts++;
    this.retryAt = Date.now() + backoff;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this.start().catch(() => {});
    }, backoff);
    if (typeof this._restartTimer.unref === 'function') this._restartTimer.unref();
  }

  _recordStderr(chunk) {
    const text = String(chunk || '');
    if (!text.trim()) return;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      this._stderrTail.push(line.trim());
      if (this._stderrTail.length > 20) this._stderrTail.shift();
    }
  }

  async _waitForHealth(port, child, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.stopping) return false;
      if (child.exitCode !== null || child.signalCode !== null) return false;
      const remaining = Math.max(250, deadline - Date.now());
      if (await probeHealth(port, Math.min(1500, remaining))) return true;
      await delay(200);
    }
    return false;
  }

  async _launch() {
    this.state = 'starting';
    this.lastError = '';
    this._stderrTail = [];

    const cli = this.resolveCli();
    if (!cli) {
      this.state = 'unavailable';
      this.lastError = 'OpenCode CLI binary not found';
      // Re-check periodically so a later install is picked up without a restart.
      this.retryAt = Date.now() + 60000;
      console.warn('[BunBridge] OpenCode CLI binary not found; official free-tier inference is unavailable.');
      return false;
    }

    let port;
    try {
      port = await reserveLoopbackPort();
    } catch (err) {
      this.state = 'error';
      this.lastError = 'Could not reserve a loopback port: ' + err.message;
      this._scheduleRestart();
      return false;
    }
    if (!port) {
      this.state = 'error';
      this.lastError = 'Could not reserve a loopback port';
      this._scheduleRestart();
      return false;
    }

    const token = crypto.randomBytes(24).toString('base64url');
    const startTimeout = Math.max(
      2000,
      parseInt(config.get('bun_bridge_start_timeout_ms'), 10) || DEFAULT_START_TIMEOUT_MS
    );

    let upstreamOrigin = 'https://opencode.ai';
    try {
      upstreamOrigin = new URL(config.get('upstream_inference_url') || upstreamOrigin).origin;
    } catch (e) {}

    const env = {
      ...process.env,
      BUN_BE_BUN: '1',
      BUN_BRIDGE_PORT: String(port),
      BUN_BRIDGE_TOKEN: token,
      BUN_BRIDGE_PARENT_PID: String(process.pid),
      BUN_BRIDGE_UPSTREAM: upstreamOrigin,
      OPENCODE_DISABLE_AUTOUPDATE: '1'
    };
    // The bridge chooses an egress route per request; inherited proxy env vars
    // would silently add a second, unaccounted hop.
    for (const key of PROXY_ENV_KEYS) delete env[key];

    let child;
    try {
      child = spawn(cli, ['run', BRIDGE_SCRIPT], {
        cwd: path.dirname(BRIDGE_SCRIPT),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      this.state = 'error';
      this.lastError = 'Could not start the OpenCode CLI bridge: ' + err.message;
      this._scheduleRestart();
      return false;
    }

    this.child = child;
    this.port = port;
    this.token = token;
    this.restartCount++;

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('BUN_BRIDGE_READY')) {
          // The health probe decides readiness; this is just a useful trace.
          console.log(`[BunBridge] Bridge process reported ready on 127.0.0.1:${port}.`);
        }
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => this._recordStderr(chunk));
    }

    const exited = new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return false;
        settled = true;
        resolve(false);
        return true;
      };

      // Spawn failures (missing binary, bad permissions) surface here rather
      // than in the try/catch above. Without this listener Node treats the
      // ChildProcess error as unhandled and terminates the gateway.
      child.once('error', (err) => {
        if (!settle()) return;
        this.lastError = 'Could not start the OpenCode CLI bridge: ' +
          (err && err.message ? err.message : String(err));
        this._recordStderr(this.lastError);
        this.child = null;
        this.ready = false;
        if (!this.stopping) {
          this.state = 'error';
          this._scheduleRestart();
        }
      });

      child.once('exit', (code, signal) => {
        if (!settle()) {
          this.child = null;
          this.ready = false;
          return;
        }
        const wasReady = this.ready;
        this.child = null;
        this.ready = false;
        if (!this.stopping) {
          this.state = 'error';
          this.lastError = `Bridge exited (${code === null ? signal : code})` +
            (this._stderrTail.length ? `: ${this._stderrTail[this._stderrTail.length - 1]}` : '');
          if (wasReady) {
            console.warn(`[BunBridge] Bridge exited unexpectedly; restarting. ${this.lastError}`);
          }
          this._scheduleRestart();
        }
      });
    });

    const healthy = await Promise.race([
      this._waitForHealth(port, child, startTimeout),
      exited
    ]);

    if (healthy && !this.stopping) {
      this.ready = true;
      this.state = 'ready';
      this.lastError = '';
      this.restartAttempts = 0;
      this.retryAt = 0;
      console.log(`[BunBridge] Bun TLS bridge ready on 127.0.0.1:${port} (pid ${child.pid}).`);
      return true;
    }

    if (!this.stopping) {
      this.ready = false;
      this.state = 'error';
      if (!this.lastError) {
        this.lastError = `Bridge did not become healthy within ${startTimeout}ms`;
      }
      try { child.kill(); } catch (e) {}
      this._scheduleRestart();
    }
    return false;
  }
}

const singleton = new BunBridge();

module.exports = singleton;
module.exports.BunBridge = BunBridge;
module.exports.isOfficialUpstream = isOfficialUpstream;
module.exports.isDirectOfficialAttempt = isDirectOfficialAttempt;
module.exports.buildProxyUrl = buildProxyUrl;
module.exports.encodeProxyHeader = encodeProxyHeader;
module.exports.decodeProxyHeader = decodeProxyHeader;
module.exports.findCliBinary = findCliBinary;
module.exports._test = {
  isOfficialUpstream,
  isDirectOfficialAttempt,
  buildProxyUrl,
  encodeProxyHeader,
  decodeProxyHeader,
  findCliBinary,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_READY_WAIT_MS
};
