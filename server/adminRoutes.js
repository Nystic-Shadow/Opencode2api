const crypto = require('crypto');
const config = require('./config');
const keys = require('./keys');
const metrics = require('./metrics');
const discovery = require('./discovery');
const updater = require('./updater');
const notifications = require('./notifications');
const proxy = require('./proxy');

// In-memory admin sessions
const sessions = new Set();

function authenticateAdmin(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  return sessions.has(token);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleAdminRoute(req, res, pathname) {
  // Login
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const { username, password } = await parseBody(req);
    const expectedUser = config.get('admin_username');
    const expectedPass = config.get('admin_password');

    if (username === expectedUser && password === expectedPass) {
      const token = 'adm_' + crypto.randomUUID();
      sessions.add(token);
      return sendJson(res, 200, { success: true, token, username });
    }
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
    // Don't expose password directly, return masked
    return sendJson(res, 200, {
      ...conf,
      admin_password: '••••••••'
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
    if (body.global_rpm_limit !== undefined) updates.global_rpm_limit = parseInt(body.global_rpm_limit, 10) || 0;
    if (body.global_tpm_limit !== undefined) updates.global_tpm_limit = parseInt(body.global_tpm_limit, 10) || 0;

    config.update(updates);
    notifications.add('Settings Updated', 'System gateway settings were saved successfully.', 'info');
    return sendJson(res, 200, { success: true });
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
