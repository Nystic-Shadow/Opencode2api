const crypto = require('crypto');
const config = require('./config');
const keys = require('./keys');
const metrics = require('./metrics');
const discovery = require('./discovery');
const updater = require('./updater');
const notifications = require('./notifications');
const proxy = require('./proxy');
const egress = require('./egress');
const proxyDiscovery = require('./proxyDiscovery');
const upstreamQuota = require('./upstreamQuota');

// In-memory admin sessions with 24-hour TTL (H4)
const sessions = new Map(); // token -> { createdAt, lastActive, username }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function pruneSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.lastActive > SESSION_TTL_MS) sessions.delete(token);
  }
}

function authenticateAdmin(req) {
  pruneSessions();
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.lastActive > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  session.lastActive = Date.now();
  return true;
}

// Rate limiting for admin login attempts: max 5 failed attempts per IP per 5 minutes
const loginAttempts = new Map(); // ip -> { count, resetAt }

function checkLoginThrottle(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (record && record.resetAt <= now) {
    loginAttempts.delete(ip);
    return { throttled: false };
  }
  if (record && record.count >= 5) {
    const waitSec = Math.ceil((record.resetAt - now) / 1000);
    return { throttled: true, waitSec };
  }
  return { throttled: false };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, resetAt: now + 5 * 60 * 1000 };
  if (record.resetAt <= now) {
    record.count = 1;
    record.resetAt = now + 5 * 60 * 1000;
  } else {
    record.count++;
  }
  loginAttempts.set(ip, record);
}

function recordLoginSuccess(ip) {
  loginAttempts.delete(ip);
}

// Constant-time string comparison preventing timing attacks (C2)
function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function proxyIdentity(raw) {
  try {
    const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    const url = new URL(value);
    let protocol = url.protocol.replace(':', '').toLowerCase();
    if (protocol === 'socks5h' || protocol === 'socks') protocol = 'socks5';
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const displayHost = hostname.includes(':') ? `[${hostname}]` : hostname;
    const port = url.port || (protocol === 'https' ? '443' : protocol === 'socks5' ? '1080' : '80');
    return `${protocol}://${displayHost}:${port}`;
  } catch (e) {
    return '';
  }
}

function maskProxy(raw) {
  try {
    const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    const url = new URL(value);
    if (!url.username && !url.password) return raw;
    url.username = '***';
    url.password = '***';
    return url.toString().replace(/\/$/, '');
  } catch (e) {
    // Never return a malformed value that might contain credentials. The
    // settings update handler rejects this marker until the entry is fixed.
    if (typeof raw === 'string' && raw.includes('@')) return '[invalid proxy]';
    return typeof raw === 'string' ? raw : '';
  }
}

// Restore masked entries by endpoint in order, consuming each existing raw
// entry once. This preserves credential-only variants that share host:port.
function restoreMaskedProxies(maskedList, existing) {
  const remaining = Array.isArray(existing) ? [...existing] : [];
  return (Array.isArray(maskedList) ? maskedList : []).map(masked => {
    if (typeof masked !== 'string' || !masked.includes('***')) return masked;
    const identity = proxyIdentity(masked);
    if (!identity) return masked;
    const index = remaining.findIndex(entry => proxyIdentity(entry) === identity);
    if (index === -1) return masked;
    return remaining.splice(index, 1)[0];
  });
}

// Bounded JSON body parser with 1MB ceiling preventing Denial of Service (H1)
const MAX_ADMIN_BODY = 1 * 1024 * 1024;

function parseBody(req, maxSize = MAX_ADMIN_BODY) {
  return new Promise((resolve, reject) => {
    const headerLen = parseInt(req.headers['content-length'], 10);
    if (!isNaN(headerLen) && headerLen > maxSize) {
      const err = new Error(`Payload too large. Maximum size is ${Math.round(maxSize / (1024 * 1024))}MB.`);
      err.statusCode = 413;
      return reject(err);
    }

    let body = '';
    let bytesReceived = 0;

    const onData = (chunk) => {
      bytesReceived += chunk.length;
      if (bytesReceived > maxSize) {
        req.pause();
        req.removeListener('data', onData);
        const err = new Error(`Payload too large. Exceeded ${Math.round(maxSize / (1024 * 1024))}MB limit.`);
        err.statusCode = 413;
        reject(err);
        try { req.destroy(); } catch (e) {}
      } else {
        body += chunk;
      }
    };

    req.on('data', onData);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

async function handleAdminRoute(req, res, pathname) {
  const forwarded = req.headers['x-forwarded-for'];
  const clientIp = (process.env.TRUST_PROXY === 'true' && typeof forwarded === 'string' && forwarded.trim())
    ? forwarded.split(',')[0].trim()
    : (req.socket?.remoteAddress || '127.0.0.1');

  // Login
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const throttle = checkLoginThrottle(clientIp);
    if (throttle.throttled) {
      return sendJson(res, 429, { error: `Too many failed login attempts. Please wait ${throttle.waitSec} seconds.` });
    }

    config.refreshFromEnv();
    let body;
    try {
      body = await parseBody(req);
    } catch (err) {
      return sendJson(res, err.statusCode || 400, { error: err.message });
    }

    const { username, password } = body;
    const expectedUser = config.get('admin_username');
    const expectedPass = config.get('admin_password');

    if (constantTimeCompare(username, expectedUser) && constantTimeCompare(password, expectedPass)) {
      recordLoginSuccess(clientIp);
      const token = 'adm_' + crypto.randomUUID();
      sessions.set(token, {
        token,
        username,
        createdAt: Date.now(),
        lastActive: Date.now()
      });
      return sendJson(res, 200, { success: true, token, username });
    }

    recordLoginFailure(clientIp);
    return sendJson(res, 401, { error: 'Invalid admin credentials' });
  }

  // Verify auth for other /api routes
  if (!authenticateAdmin(req)) {
    return sendJson(res, 401, { error: 'Admin session expired or unauthorized' });
  }

  // Logout
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    sessions.delete(token);
    return sendJson(res, 200, { success: true });
  }

  // Dashboard Stats
  if (pathname === '/api/stats' && req.method === 'GET') {
    return sendJson(res, 200, metrics.getStats());
  }

  // Reset Stats / Telemetry
  if (pathname === '/api/stats/reset' && req.method === 'POST') {
    metrics.reset();
    notifications.add('Telemetry Reset', 'Gateway statistics and counters reset to zero.', 'info');
    return sendJson(res, 200, { success: true, message: 'Telemetry successfully reset.' });
  }

  // Playground Chat
  if (pathname === '/api/playground/chat' && req.method === 'POST') {
    const body = await parseBody(req);
    const masterKey = keys.keys[0] || { id: 'admin_playground', name: 'Playground Admin', key: 'O2P-playground' };
    return proxy.handleChatCompletions(body, req, res, masterKey);
  }

  // API Keys: List
  if (pathname === '/api/keys' && req.method === 'GET') {
    return sendJson(res, 200, keys.getAll());
  }

  // API Keys: Create
  if (pathname === '/api/keys' && req.method === 'POST') {
    const body = await parseBody(req);
    const newKey = keys.createKey(body);
    notifications.add('API Key Created', `Created key "${newKey.name}" (${newKey.key.slice(0, 10)}...)`, 'info');
    return sendJson(res, 201, newKey);
  }

  // API Keys: Update / Delete
  if (pathname.startsWith('/api/keys/')) {
    const keyId = pathname.replace('/api/keys/', '');
    if (req.method === 'PATCH') {
      const body = await parseBody(req);
      const updated = keys.updateKey(keyId, body);
      if (!updated) return sendJson(res, 404, { error: 'Key not found' });
      return sendJson(res, 200, updated);
    }
    if (req.method === 'DELETE') {
      const ok = keys.deleteKey(keyId);
      if (!ok) return sendJson(res, 404, { error: 'Key not found' });
      return sendJson(res, 200, { success: true });
    }
  }

  // Models: List
  if (pathname === '/api/models' && req.method === 'GET') {
    return sendJson(res, 200, {
      last_synced: discovery.lastSynced,
      count: discovery.models.length,
      models: discovery.getAllModels()
    });
  }

  // Models: Trigger Discovery
  if (pathname === '/api/models/discover' && req.method === 'POST') {
    try {
      const refreshed = await discovery.sync();
      return sendJson(res, 200, {
        success: true,
        count: refreshed.length,
        last_synced: discovery.lastSynced,
        models: refreshed
      });
    } catch (err) {
      return sendJson(res, 500, { error: 'Discovery failed: ' + err.message });
    }
  }

  // Settings: Get
  if (pathname === '/api/settings' && req.method === 'GET') {
    const conf = config.getAll();
    let maskedZenKey = '';
    if (conf.upstream_zen_key) {
      if (conf.upstream_zen_key.length > 8) {
        maskedZenKey = conf.upstream_zen_key.slice(0, 4) + '••••••••' + conf.upstream_zen_key.slice(-4);
      } else {
        maskedZenKey = '••••••••';
      }
    }
    // Don't expose passwords, upstream keys, or proxy credentials directly.
    return sendJson(res, 200, {
      ...conf,
      admin_password: '••••••••',
      upstream_zen_key: maskedZenKey,
      has_zen_key: !!conf.upstream_zen_key,
      proxies: Array.isArray(conf.proxies) ? conf.proxies.map(maskProxy) : []
    });
  }

  // Settings: Update
  if (pathname === '/api/settings' && req.method === 'POST') {
    const body = await parseBody(req);
    const updates = {};
    if (body.admin_username && body.admin_username.trim()) updates.admin_username = body.admin_username.trim();
    if (body.admin_password && body.admin_password.trim() && body.admin_password !== '••••••••') {
      const nextPassword = body.admin_password.trim();
      if (nextPassword === 'admin123' || nextPassword.length < 12) {
        return sendJson(res, 400, { error: 'Dashboard password must be at least 12 characters and must not be a known default.' });
      }
      updates.admin_password = nextPassword;
    }
    if (body.discovery_interval_seconds !== undefined) updates.discovery_interval_seconds = parseInt(body.discovery_interval_seconds, 10) || 600;
    if (body.auto_update_cli !== undefined) updates.auto_update_cli = !!body.auto_update_cli;
    if (body.free_only !== undefined) updates.free_only = !!body.free_only;
    if (body.smart_fallback !== undefined) updates.smart_fallback = !!body.smart_fallback;
    if (body.max_retries !== undefined) {
      const parsed = parseInt(body.max_retries, 10);
      if (Number.isFinite(parsed)) updates.max_retries = Math.min(Math.max(0, parsed), 3);
    }
    if (body.proxy_quota_failovers !== undefined) {
      const parsed = parseInt(body.proxy_quota_failovers, 10);
      if (Number.isFinite(parsed)) updates.proxy_quota_failovers = Math.min(Math.max(0, parsed), 20);
    }
    if (body.proxy_check_interval_minutes !== undefined) {
      const parsed = parseInt(body.proxy_check_interval_minutes, 10);
      if (Number.isFinite(parsed)) updates.proxy_check_interval_minutes = Math.min(Math.max(1, parsed), 1440);
    }
    if (body.proxy_auto_prune_dead !== undefined) {
      updates.proxy_auto_prune_dead = body.proxy_auto_prune_dead === true || body.proxy_auto_prune_dead === 'true';
    }
    if (body.auto_proxy_discovery !== undefined) {
      updates.auto_proxy_discovery = body.auto_proxy_discovery === true || body.auto_proxy_discovery === 'true';
    }
    if (body.global_rpm_limit !== undefined) updates.global_rpm_limit = parseInt(body.global_rpm_limit, 10) || 0;
    if (body.global_tpm_limit !== undefined) updates.global_tpm_limit = parseInt(body.global_tpm_limit, 10) || 0;
    if (body.upstream_zen_key !== undefined) {
      const zk = body.upstream_zen_key.trim();
      if (zk && !zk.includes('••••')) {
        updates.upstream_zen_key = zk;
      } else if (zk === '') {
        updates.upstream_zen_key = '';
      }
    }
    if (Object.keys(body).some(key => key.startsWith('warp_'))) {
      // WARP was removed. Accepting these fields silently would leave an
      // operator believing egress is tunneled when it is not.
      return sendJson(res, 400, { error: 'WARP support has been removed. Automatic proxy discovery is built in; set PROXIES only to add your own routes.' });
    }
    if (body.proxies !== undefined) {
      const existingProxies = Array.isArray(config.get('proxies')) ? config.get('proxies') : [];
      let incoming = [];
      if (Array.isArray(body.proxies)) {
        incoming = body.proxies.map(p => typeof p === 'string' ? p.trim() : '').filter(Boolean);
      } else if (typeof body.proxies === 'string') {
        incoming = body.proxies.split(/[\n,]/).map(p => p.trim()).filter(Boolean);
      }
      const restored = restoreMaskedProxies(incoming, existingProxies);
      if (restored.length > 100) {
        return sendJson(res, 400, { error: 'A maximum of 100 proxies is supported.' });
      }
      if (restored.some(entry => typeof entry === 'string' && entry.includes('***'))) {
        return sendJson(res, 400, {
          error: 'Proxy credentials are masked. Re-enter the full proxy URL for new or changed entries, or leave unchanged entries exactly as shown.'
        });
      }
      const invalid = restored.find(entry => !egress.parseProxyUrl(entry));
      if (invalid) {
        return sendJson(res, 400, {
          error: `Invalid proxy URL: ${maskProxy(invalid)}. Use http://, https://, or socks5:// with an optional user:pass.`
        });
      }
      updates.proxies = restored;
    }

    config.update(updates);
    if (updates.admin_password) {
      sessions.clear();
    }
    if (body.free_only !== undefined) {
      discovery.sync().catch(e => console.warn('[Discovery] Resync on free_only toggle:', e.message));
    }
    notifications.add('Settings Updated', 'System gateway settings were saved successfully.', 'info');
    return sendJson(res, 200, { success: true });
  }

  // Automatic discovery + explicit egress pool: Status
  if (pathname === '/api/proxies/status' && req.method === 'GET') {
    return sendJson(res, 200, {
      ...egress.getProxyStatus(),
      autoDiscovery: proxyDiscovery.getStatus(),
      upstreamQuota: upstreamQuota.getStatus()
    });
  }

  // Re-run 5x health checks and refresh the automatic pool.
  if (pathname === '/api/proxies/recheck' && req.method === 'POST') {
    egress.recheckNow().catch(err => console.warn('[Admin] Proxy recheck failed:', err.message));
    if (proxyDiscovery.isEnabled()) {
      proxyDiscovery.refreshNow().catch(err => console.warn('[Admin] Proxy discovery refresh failed:', err.message));
    }
    notifications.add('Proxy Health Sweep Started', '5x health checks and automatic proxy discovery refresh initiated for the egress pool.', 'info');
    return sendJson(res, 200, {
      success: true,
      message: 'Proxy health checks and discovery started',
      ...egress.getProxyStatus(),
      autoDiscovery: proxyDiscovery.getStatus(),
      upstreamQuota: upstreamQuota.getStatus()
    });
  }

  // Remove proxies whose latest 5x check failed, then replenish automatically.
  if (pathname === '/api/proxies/prune' && req.method === 'POST') {
    const result = egress.pruneFailed();
    if (result.removed > 0) {
      notifications.add(
        'Dead Proxies Removed',
        `${result.removed} failed route${result.removed === 1 ? ' was' : 's were'} removed from the egress pool. Automatic discovery will replenish the pool.`,
        'warning'
      );
      if (proxyDiscovery.isEnabled()) {
        proxyDiscovery.refreshNow().catch(err => console.warn('[Admin] Proxy replenish failed:', err.message));
      }
    }
    return sendJson(res, 200, {
      success: true,
      ...result,
      ...egress.getProxyStatus(),
      autoDiscovery: proxyDiscovery.getStatus(),
      upstreamQuota: upstreamQuota.getStatus()
    });
  }

  // Settings: Check CLI Update
  if (pathname === '/api/settings/check-update' && req.method === 'POST') {
    const resUpdate = await updater.checkForUpdate();
    if (resUpdate) {
      return sendJson(res, 200, { updated: true, ...resUpdate });
    }
    return sendJson(res, 200, { updated: false, current: config.get('client_version'), message: 'Already on latest OpenCode CLI' });
  }

  // Notifications: Get
  if (pathname === '/api/notifications' && req.method === 'GET') {
    return sendJson(res, 200, {
      unread: notifications.getUnreadCount(),
      items: notifications.getAll()
    });
  }

  // Notifications: Mark Read
  if (pathname === '/api/notifications/read' && req.method === 'POST') {
    notifications.markAllRead();
    return sendJson(res, 200, { success: true });
  }

  // Notifications: Clear All
  if (pathname === '/api/notifications/clear' && req.method === 'POST') {
    notifications.clear();
    return sendJson(res, 200, { success: true });
  }

  return sendJson(res, 404, { error: 'Admin endpoint not found' });
}

module.exports = {
  handleAdminRoute,
  _test: {
    maskProxy,
    proxyIdentity,
    restoreMaskedProxies
  }
};
