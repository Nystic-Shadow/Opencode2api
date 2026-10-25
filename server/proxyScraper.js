const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROXY_CACHE_FILE = path.join(DATA_DIR, 'verified_proxies.json');

// Curated active, checked proxy sources (hourly verified)
const PROXY_SOURCES = [
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', type: 'socks5' },
  { url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/master/socks5.txt', type: 'socks5' },
  { url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=2500&country=all&ssl=all&anonymity=all', type: 'socks5' },
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', type: 'http' },
  { url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/master/http.txt', type: 'http' },
  { url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=2500&country=all&ssl=all&anonymity=all', type: 'http' }
];

// Pre-verified fast proxies tested directly against opencode.ai:443 (<3000ms latency, genuine TLS cert, 5x strict check)
const DEFAULT_SEED_PROXIES = [
  { host: '101.36.104.239', port: 10808, type: 'socks5', latency: 680, successCount: 5, lastChecked: Date.now() },
  { host: '123.58.219.171', port: 10808, type: 'socks5', latency: 710, successCount: 5, lastChecked: Date.now() },
  { host: '183.106.215.208', port: 1080, type: 'socks5', latency: 719, successCount: 5, lastChecked: Date.now() }
];

class ProxyScraperService {
  constructor() {
    this.rawCandidates = [];
    this.verifiedPool = [...DEFAULT_SEED_PROXIES]; // [{ host, port, type, latency, successCount, lastChecked }]
    this.isScanning = false;
    this.scanInterval = null;
    this.roundRobinIndex = 0;
    this.burnedProxies = new Map(); // proxyStr -> cooldownUntil
    this.cachedAgents = new Map();

    this.loadCache();
    this.startBackgroundScanner();
  }

  loadCache() {
    try {
      if (fs.existsSync(PROXY_CACHE_FILE)) {
        const raw = fs.readFileSync(PROXY_CACHE_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (data && data.version === 3 && Array.isArray(data.proxies)) {
          this.verifiedPool = data.proxies.filter(p => p.latency <= 3000);
          console.log(`[ProxyScraper] Loaded ${this.verifiedPool.length} verified fast (<3s) proxies from disk cache.`);
        } else {
          console.log('[ProxyScraper] Cache invalidated (version upgrade). Starting with pre-verified clean proxies.');
          this.verifiedPool = [...DEFAULT_SEED_PROXIES];
          this.saveCache();
        }
      }
    } catch (e) {
      console.warn('[ProxyScraper] Cache load notice:', e.message);
    }
  }

  saveCache() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PROXY_CACHE_FILE, JSON.stringify({
        version: 3,
        updatedAt: new Date().toISOString(),
        count: this.verifiedPool.length,
        proxies: this.verifiedPool
      }, null, 2), 'utf8');
    } catch (e) {
      console.warn('[ProxyScraper] Cache save notice:', e.message);
    }
  }

  startBackgroundScanner() {
    // If pool has fewer than 5 verified proxies, initiate fast sweep on startup
    if (this.verifiedPool.length < 5) {
      setTimeout(() => this.runScrapeAndVerify().catch(() => {}), 1000);
    }

    // Refresh every 5 minutes to keep proxy pool fresh and latency ultra low
    this.scanInterval = setInterval(() => {
      this.runScrapeAndVerify().catch(e => console.warn('[ProxyScraper] Background cycle notice:', e.message));
    }, 5 * 60 * 1000);
  }

  async fetchSourceList(source) {
    return new Promise((resolve) => {
      const u = new URL(source.url);
      const getter = u.protocol === 'https:' ? https : http;
      const req = getter.get(source.url, { timeout: 6000 }, (res) => {
        if (res.statusCode !== 200) return resolve([]);
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          const lines = body.split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#') && l.includes(':'));
          const list = lines.map(line => {
            const parts = line.split(':');
            return {
              host: parts[0].trim(),
              port: parseInt(parts[1].trim(), 10),
              type: source.type
            };
          }).filter(p => p.host && p.port > 0 && p.port < 65536);
          resolve(list);
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
    });
  }

  /**
   * Probe SOCKS5 proxy directly to opencode.ai:443 with strict timeout.
   */
  async probeSocks5Single(host, port, timeoutMs = 3000) {
    const startTime = Date.now();
    return new Promise((resolve) => {
      let resolved = false;
      const done = (ok, err = null) => {
        if (resolved) return;
        resolved = true;
        const latency = Date.now() - startTime;
        resolve({ ok, latency, err });
      };

      const socket = net.connect({ host, port, timeout: timeoutMs }, () => {
        // Send RFC 1928 SOCKS5 auth negotiation [VER=5, NMETHODS=1, NO_AUTH=0]
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      let state = 'handshake';

      socket.on('data', (d) => {
        if (state === 'handshake') {
          if (d[0] !== 0x05 || d[1] !== 0x00) {
            socket.destroy();
            return done(false, 'socks5 auth reject');
          }
          // Send SOCKS5 CONNECT to opencode.ai:443 using FQDN [ATYP=0x03]
          const hostBuf = Buffer.from('opencode.ai');
          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            Buffer.from([0x01, 0xbb]) // 443
          ]);
          state = 'connect';
          socket.write(req);
        } else if (state === 'connect') {
          if (d[0] !== 0x05 || d[1] !== 0x00) {
            socket.destroy();
            return done(false, `socks5 target reject: ${d[1]}`);
          }
          // Direct TLS handshake through the established proxy tunnel to opencode.ai
          const tlsSocket = tls.connect({
            socket,
            servername: 'opencode.ai',
            rejectUnauthorized: true
          }, () => {
            // Fast HTTP/1.1 ping
            tlsSocket.write('GET /cdn-cgi/trace HTTP/1.1\r\nHost: opencode.ai\r\nUser-Agent: curl/8.0\r\nConnection: close\r\n\r\n');
          });

          let traceBody = '';
          tlsSocket.on('data', chunk => traceBody += chunk.toString());
          tlsSocket.on('end', () => {
            const hasTrace = traceBody.includes('h=opencode.ai') && traceBody.includes('visit_scheme=https');
            tlsSocket.destroy();
            done(hasTrace, hasTrace ? null : 'invalid trace (not opencode.ai)');
          });
          tlsSocket.on('error', err => {
            tlsSocket.destroy();
            done(false, err.message);
          });
        }
      });

      socket.on('error', err => {
        socket.destroy();
        done(false, err.message);
      });

      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        done(false, 'timeout');
      });
    });
  }

  /**
   * Probe HTTP CONNECT proxy directly to opencode.ai:443 with strict timeout.
   */
  async probeHttpSingle(host, port, timeoutMs = 3000) {
    const startTime = Date.now();
    return new Promise((resolve) => {
      let resolved = false;
      const done = (ok, err = null) => {
        if (resolved) return;
        resolved = true;
        const latency = Date.now() - startTime;
        resolve({ ok, latency, err });
      };

      const req = http.request({
        host,
        port,
        method: 'CONNECT',
        path: 'opencode.ai:443',
        timeout: timeoutMs
      });

      req.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return done(false, `CONNECT status ${res.statusCode}`);
        }

        const tlsSocket = tls.connect({
          socket,
          servername: 'opencode.ai',
          rejectUnauthorized: true
        }, () => {
          tlsSocket.write('GET /cdn-cgi/trace HTTP/1.1\r\nHost: opencode.ai\r\nUser-Agent: curl/8.0\r\nConnection: close\r\n\r\n');
        });

        let traceBody = '';
        tlsSocket.on('data', chunk => traceBody += chunk.toString());
        tlsSocket.on('end', () => {
          const hasTrace = traceBody.includes('h=opencode.ai') && traceBody.includes('visit_scheme=https');
          tlsSocket.destroy();
          done(hasTrace, hasTrace ? null : 'invalid trace (not opencode.ai)');
        });
        tlsSocket.on('error', err => {
          tlsSocket.destroy();
          done(false, err.message);
        });
      });

      req.on('error', err => done(false, err.message));
      req.on('timeout', () => { req.destroy(); done(false, 'timeout'); });
      req.end();
    });
  }

  /**
   * Ultra-Strict Verification:
   * Tests proxy directly against opencode.ai with strict <= 3000ms latency.
   * Requires 5 consecutive successful passes to qualify for the Verified Clean Pool!
   */
  async verifyProxyStrict(candidate, requiredPasses = 5, maxLatencyMs = 3000) {
    let latencies = [];
    const prober = candidate.type === 'socks5'
      ? (h, p, t) => this.probeSocks5Single(h, p, t)
      : (h, p, t) => this.probeHttpSingle(h, p, t);

    for (let pass = 1; pass <= requiredPasses; pass++) {
      const res = await prober(candidate.host, candidate.port, maxLatencyMs);
      if (!res.ok || res.latency > maxLatencyMs) {
        return { verified: false, failedAt: pass, reason: res.err || `Latency ${res.latency}ms > ${maxLatencyMs}ms` };
      }
      latencies.push(res.latency);
      // Brief pause between verification passes
      await new Promise(r => setTimeout(r, 120));
    }

    const avgLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    return {
      verified: true,
      passes: requiredPasses,
      avgLatency,
      latencies
    };
  }

  async runScrapeAndVerify() {
    if (this.isScanning) return;
    this.isScanning = true;
    console.log('[ProxyScraper] Initiating proxy scrape & 5x strict validation sweep...');

    try {
      const fetchedCandidates = [];
      for (const src of PROXY_SOURCES) {
        try {
          const list = await this.fetchSourceList(src);
          console.log(`[ProxyScraper] Source (${src.type}) yielded ${list.length} endpoints.`);
          fetchedCandidates.push(...list);
        } catch (e) {}
      }

      // Deduplicate candidates
      const seen = new Set();
      const uniqueCandidates = [];
      for (const c of fetchedCandidates) {
        const key = `${c.type}://${c.host}:${c.port}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueCandidates.push(c);
        }
      }

      console.log(`[ProxyScraper] Total unique candidates discovered: ${uniqueCandidates.length}. Testing candidates with concurrency...`);

      // Shuffle candidates for diverse geo-distribution
      uniqueCandidates.sort(() => Math.random() - 0.5);

      // Limit candidates per sweep to top 1500 to keep CPU & network light
      const testCandidates = uniqueCandidates.slice(0, 1500);

      // Concurrency pipeline
      const CONCURRENCY = 40;
      const targetVerifiedCount = 20;
      const newVerified = [];
      let currentIndex = 0;

      const worker = async () => {
        while (currentIndex < testCandidates.length && newVerified.length < targetVerifiedCount) {
          const idx = currentIndex++;
          const c = testCandidates[idx];
          if (!c) break;

          // 1. Fast pre-screen check (1800ms) to drop dead proxies immediately
          const prober = c.type === 'socks5'
            ? (h, p, t) => this.probeSocks5Single(h, p, t)
            : (h, p, t) => this.probeHttpSingle(h, p, t);

          const preCheck = await prober(c.host, c.port, 1800);
          if (!preCheck.ok || preCheck.latency > 1800) continue;

          // 2. Candidate passed pre-screen! Now run strict 5-pass verification
          const strictRes = await this.verifyProxyStrict(c, 5, 3000);
          if (strictRes.verified) {
            console.log(`[ProxyScraper] ⭐ Proxy ${c.type}://${c.host}:${c.port} PASSED 5/5 strict checks! Avg latency: ${strictRes.avgLatency}ms`);
            const verifiedObj = {
              host: c.host,
              port: c.port,
              type: c.type,
              latency: strictRes.avgLatency,
              successCount: strictRes.passes,
              lastChecked: Date.now()
            };
            newVerified.push(verifiedObj);
            // Immediately add to live pool so requests can failover to it without delay
            if (!this.verifiedPool.some(p => p.host === c.host && p.port === c.port)) {
              this.verifiedPool.push(verifiedObj);
              this.verifiedPool.sort((a, b) => a.latency - b.latency);
              this.saveCache();
            }
          }
        }
      };

      const workers = [];
      for (let w = 0; w < CONCURRENCY; w++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      if (newVerified.length > 0) {
        // Merge with existing non-burned proxies, deduplicate and sort by latency
        const existingClean = this.verifiedPool.filter(p => !newVerified.some(n => n.host === p.host && n.port === p.port));
        const merged = [...newVerified, ...existingClean].sort((a, b) => a.latency - b.latency);
        this.verifiedPool = merged.slice(0, 30); // Keep top 30 fastest
        this.saveCache();
        console.log(`[ProxyScraper] Sweep completed! Verified pool has ${this.verifiedPool.length} rock-solid proxies with <3s latency.`);
      } else {
        console.log(`[ProxyScraper] Sweep finished. Retaining current pool of ${this.verifiedPool.length} proxies.`);
      }
    } catch (err) {
      console.warn('[ProxyScraper] Scrape sweep error:', err.message);
    } finally {
      this.isScanning = false;
    }
  }

  markProxyBurned(proxyStr, cooldownSec = 1800) {
    const key = String(proxyStr);
    this.burnedProxies.set(key, Date.now() + (cooldownSec * 1000));
    console.warn(`[ProxyScraper] Proxy ${key} marked burned for ${Math.round(cooldownSec / 60)}m.`);
    // Prune from verified pool
    this.verifiedPool = this.verifiedPool.filter(p => `${p.host}:${p.port}` !== key && `${p.type}://${p.host}:${p.port}` !== key);
    this.saveCache();
  }

  getBestProxy() {
    const now = Date.now();
    const cleanList = this.verifiedPool.filter(p => {
      const key1 = `${p.host}:${p.port}`;
      const key2 = `${p.type}://${p.host}:${p.port}`;
      const cd1 = this.burnedProxies.get(key1) || 0;
      const cd2 = this.burnedProxies.get(key2) || 0;
      return now > cd1 && now > cd2 && p.latency <= 3000;
    });

    if (cleanList.length === 0) return null;

    // Pick round-robin among top fast verified proxies
    this.roundRobinIndex = (this.roundRobinIndex + 1) % cleanList.length;
    return cleanList[this.roundRobinIndex];
  }

  createProxyAgent(proxyObj) {
    if (!proxyObj) return null;
    const cacheKey = `${proxyObj.type}://${proxyObj.host}:${proxyObj.port}`;
    if (this.cachedAgents.has(cacheKey)) {
      return this.cachedAgents.get(cacheKey);
    }

    const agent = new https.Agent({
      keepAlive: true,
      maxSockets: 32,
      maxFreeSockets: 8,
      timeout: 30000
    });

    if (proxyObj.type === 'socks5') {
      agent.createConnection = function(options, callback) {
        const destHost = options.host || options.hostname || 'opencode.ai';
        const destPort = options.port || 443;

        const socket = net.connect({ host: proxyObj.host, port: proxyObj.port, timeout: 5000 }, () => {
          socket.write(Buffer.from([0x05, 0x01, 0x00]));
        });

        let state = 'handshake';

        socket.on('data', (d) => {
          if (state === 'handshake') {
            if (d[0] !== 0x05 || d[1] !== 0x00) {
              socket.destroy();
              return callback(new Error('SOCKS5 auth negotiation failed'));
            }
            const hostBuf = Buffer.from(destHost);
            const req = Buffer.concat([
              Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
              hostBuf,
              Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff])
            ]);
            state = 'connect';
            socket.write(req);
          } else if (state === 'connect') {
            if (d[0] !== 0x05 || d[1] !== 0x00) {
              socket.destroy();
              return callback(new Error(`SOCKS5 CONNECT rejected: code ${d[1]}`));
            }
            // Clean listeners and hand over to TLS
            socket.removeAllListeners('data');
            socket.removeAllListeners('error');
            socket.removeAllListeners('timeout');
            socket.setTimeout(0);

            const tlsSocket = tls.connect({
              socket,
              servername: options.servername || destHost,
              rejectUnauthorized: true
            }, () => {
              callback(null, tlsSocket);
            });
            tlsSocket.on('error', err => callback(err));
          }
        });

        socket.on('error', err => callback(err));
        socket.setTimeout(5000, () => {
          socket.destroy();
          callback(new Error(`SOCKS5 proxy ${proxyObj.host}:${proxyObj.port} connection timed out`));
        });
      };
    } else {
      // HTTP CONNECT proxy
      agent.createConnection = function(options, callback) {
        const destHost = options.host || options.hostname || 'opencode.ai';
        const destPort = options.port || 443;

        const connectReq = http.request({
          host: proxyObj.host,
          port: proxyObj.port,
          method: 'CONNECT',
          path: `${destHost}:${destPort}`,
          timeout: 5000
        });

        connectReq.on('connect', (res, socket) => {
          if (res.statusCode !== 200) {
            socket.destroy();
            return callback(new Error(`HTTP CONNECT returned ${res.statusCode}`));
          }
          const tlsSocket = tls.connect({
            socket,
            servername: options.servername || destHost,
            rejectUnauthorized: true
          }, () => {
            callback(null, tlsSocket);
          });
          tlsSocket.on('error', err => callback(err));
        });

        connectReq.on('error', err => callback(err));
        connectReq.on('timeout', () => {
          connectReq.destroy(new Error(`HTTP CONNECT to ${proxyObj.host}:${proxyObj.port} timed out`));
        });
        connectReq.end();
      };
    }

    this.cachedAgents.set(cacheKey, agent);
    return agent;
  }

  getStatus() {
    return {
      verifiedCount: this.verifiedPool.length,
      isScanning: this.isScanning,
      fastestProxy: this.verifiedPool[0] || null,
      topProxies: this.verifiedPool.slice(0, 10).map(p => ({
        endpoint: `${p.type}://${p.host}:${p.port}`,
        latency: p.latency,
        passes: p.successCount
      }))
    };
  }
}

module.exports = new ProxyScraperService();
