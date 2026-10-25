const crypto = require('crypto');
const config = require('./config');
const keys = require('./keys');
const metrics = require('./metrics');
const discovery = require('./discovery');
const updater = require('./updater');
const notifications = require('./notifications');
const proxy = require('./proxy');
const warp = require('./warp');
const proxyScraper = require('./proxyScraper');

// In-memory admin sessions with 24-hour TTL (H4)
const sessions = new Map(); // token -> { createdAt, lastActive, username }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function authenticateAdmin(req) {
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
  if (record && record.resetAt > now) {
    if (record.count >= 5) {
      const waitSec = Math.ceil((record.resetAt - now) / 1000);
      return { throttled: true, waitSec };
    }
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
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleAdminRoute(req, res, pathname) {
  const clientIp = req.socket?.remoteAddress || req.headers['x-forwarded-for'] || '127.0.0.1';

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
    // Don't expose password or raw upstream keys directly (H5)
    return sendJson(res, 200, {
      ...conf,
      admin_password: '••••••••',
      upstream_zen_key: maskedZenKey,
      has_zen_key: !!conf.upstream_zen_key
    });
  }

  // Settings: Update
  if (pathname === '/api/settings' && req.method === 'POST') {
    const body = await parseBody(req);
    const updates = {};
    if (body.admin_username && body.admin_username.trim()) updates.admin_username = body.admin_username.trim();
    if (body.admin_password && body.admin_password.trim() && body.admin_password !== '••••••••') {
      updates.admin_password = body.admin_password.trim();
    }
    if (body.discovery_interval_seconds !== undefined) updates.discovery_interval_seconds = parseInt(body.discovery_interval_seconds, 10) || 600;
    if (body.auto_update_cli !== undefined) updates.auto_update_cli = !!body.auto_update_cli;
    if (body.free_only !== undefined) updates.free_only = !!body.free_only;
    if (body.smart_fallback !== undefined) updates.smart_fallback = !!body.smart_fallback;
    if (body.max_retries !== undefined) updates.max_retries = parseInt(body.max_retries, 10) || 3;
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
    if (body.warp_mode !== undefined) updates.warp_mode = body.warp_mode;
    if (body.warp_host !== undefined) updates.warp_host = (body.warp_host || '127.0.0.1').trim();
    if (body.warp_auto_switch !== undefined) updates.warp_auto_switch = !!body.warp_auto_switch;
    if (body.warp_rotate_on_unauth !== undefined) updates.warp_rotate_on_unauth = !!body.warp_rotate_on_unauth;
    if (body.warp_rotate_on_rate_limit !== undefined) updates.warp_rotate_on_rate_limit = !!body.warp_rotate_on_rate_limit;
    if (body.warp_auto_rotate_minutes !== undefined) updates.warp_auto_rotate_minutes = parseInt(body.warp_auto_rotate_minutes, 10) || 0;
    if (body.warp_port !== undefined) updates.warp_port = parseInt(body.warp_port, 10) || 40000;
    if (body.proxies !== undefined) {
      if (Array.isArray(body.proxies)) {
        updates.proxies = body.proxies.map(p => typeof p === 'string' ? p.trim() : '').filter(Boolean);
      } else if (typeof body.proxies === 'string') {
        updates.proxies = body.proxies.split(/[\n,]/).map(p => p.trim()).filter(Boolean);
      }
    }

    config.update(updates);
    if (body.warp_auto_rotate_minutes !== undefined) {
      warp.startAutoRotateCron();
    }
    if (body.free_only !== undefined) {
      discovery.sync().catch(e => console.warn('[Discovery] Resync on free_only toggle:', e.message));
    }
    notifications.add('Settings Updated', 'System gateway settings were saved successfully.', 'info');
    return sendJson(res, 200, { success: true });
  }

  // Cloudflare WARP: Status
  if (pathname === '/api/warp/status' && req.method === 'GET') {
    const status = await warp.getStatus();
    return sendJson(res, 200, status);
  }

  // Cloudflare WARP: Manual Key Rotation
  if (pathname === '/api/warp/rotate' && req.method === 'POST') {
    const ok = await warp.rotateKeys();
    const status = await warp.getStatus();
    notifications.add('WARP Keys Rotated', 'Cloudflare WARP tunnel keys were rotated to establish a fresh edge session.', 'info');
    return sendJson(res, 200, { success: ok, ...status });
  }

  // Cloudflare WARP: Flush & Re-arm Account Pool
  if (pathname === '/api/warp/refresh-pool' && req.method === 'POST') {
    const ok = await warp.refreshPool();
    const status = await warp.getStatus();
    notifications.add('WARP Pool Refreshed', 'Flushed old accounts and generated fresh Cloudflare WARP credentials.', 'info');
    return sendJson(res, 200, { success: ok, ...status });
  }

  // Cloudflare WARP: Connect & Configure Proxy Mode
  if (pathname === '/api/warp/connect' && req.method === 'POST') {
    const body = await parseBody(req);
    const ok = await warp.autoBootstrap(true);
    const status = await warp.getStatus();
    return sendJson(res, 200, { success: ok, ...status });
  }

  // Cloudflare WARP: Auto-Install / Auto-Bootstrap
  if (pathname === '/api/warp/install' && req.method === 'POST') {
    const resInstall = await warp.triggerAutoInstall();
    const status = await warp.getStatus();
    return sendJson(res, 200, { ...resInstall, ...status });
  }

  // Inbuilt Scraped Proxies: Pool Status
  if (pathname === '/api/proxies/status' && req.method === 'GET') {
    return sendJson(res, 200, proxyScraper.getStatus());
  }

  // Inbuilt Scraped Proxies: Trigger Fast Re-scan
  if (pathname === '/api/proxies/rescan' && req.method === 'POST') {
    proxyScraper.runScrapeAndVerify().catch(() => {});
    notifications.add('Proxy Sweep Started', 'Strict 5x verification sweep initiated for scraped proxy pool.', 'info');
    return sendJson(res, 200, { success: true, message: 'Strict proxy sweep started in background', ...proxyScraper.getStatus() });
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
  handleAdminRoute
};
