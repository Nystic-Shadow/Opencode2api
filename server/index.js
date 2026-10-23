const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const keys = require('./keys');
const discovery = require('./discovery');
const proxy = require('./proxy');
const warp = require('./warp');
const adminRoutes = require('./adminRoutes');

const PORT = config.get('port') || 8080;
const DIST_DIR = path.join(__dirname, '..', 'dist');

// MIME types for static assets
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);

  // If path doesn't exist or doesn't have extension, fall back to index.html for SPA routing
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html');
  }

  if (fs.existsSync(filePath)) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath).pipe(res);
  }

  // Fallback placeholder if dist hasn't been built yet
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <!DOCTYPE html>
    <html>
      <head><title>OpenCode2API Gateway</title></head>
      <body style="font-family:sans-serif;background:#02080e;color:#e9f0f5;padding:40px;text-align:center;">
        <h1 style="color:#2fbc5b;">OpenCode2API Gateway is Active</h1>
        <p>API endpoints ready at <code>/v1/chat/completions</code> and <code>/v1/messages</code>.</p>
        <p>Building React 19 dashboard...</p>
      </body>
    </html>
  `);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Global CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // 1. Health endpoint
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'OpenCode2API',
      cli_version: config.get('client_version'),
      models_count: discovery.models.length
    }));
  }

  // 2. Admin dashboard APIs (/api/...)
  if (pathname.startsWith('/api/')) {
    return adminRoutes.handleAdminRoute(req, res, pathname);
  }

  // 3. OpenAI Models List (/v1/models)
  if (pathname === '/v1/models' && req.method === 'GET') {
    const list = discovery.getAllModels().map(m => ({
      id: m.id,
      object: "model",
      created: 1792240000,
      owned_by: "opencode-zen",
      context_window: m.context_window,
      max_output: m.max_output,
      modalities: m.modalities,
      supports_vision: m.supports_vision,
      supports_reasoning: m.supports_reasoning,
      supports_tools: m.supports_tools,
      is_free: m.is_free
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: "list", data: list }));
  }

  // Model details (/v1/models/:model)
  if (pathname.startsWith('/v1/models/') && req.method === 'GET') {
    const modelId = pathname.replace('/v1/models/', '');
    let model = discovery.getModel(modelId);
    if (!model) {
      await discovery.ensureModel(modelId);
      model = discovery.getModel(modelId);
    }
    if (!model) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `Model '${modelId}' not found.` } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ id: model.id, object: "model", ...model }));
  }

  // 4. OpenAI Chat Completions (/v1/chat/completions)
  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    const authHeader = req.headers['authorization'] || '';
    const apiKeyHeader = req.headers['x-api-key'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '') || apiKeyHeader;

    try {
      const payload = await parseJsonBody(req);
      const authResult = keys.validateAndCheckLimit(token, payload.model);
      if (!authResult.valid) {
        res.writeHead(authResult.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: authResult.error } }));
      }
      return proxy.handleChatCompletions(payload, req, res, authResult.key);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid JSON request: ' + err.message } }));
    }
  }

  // 5. Anthropic Messages (/v1/messages)
  if (pathname === '/v1/messages' && req.method === 'POST') {
    const authHeader = req.headers['authorization'] || '';
    const apiKeyHeader = req.headers['x-api-key'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '') || apiKeyHeader;

    try {
      const payload = await parseJsonBody(req);
      const authResult = keys.validateAndCheckLimit(token, payload.model);
      if (!authResult.valid) {
        res.writeHead(authResult.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: authResult.error } }));
      }
      return proxy.handleAnthropicMessages(payload, req, res, authResult.key);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid JSON request: ' + err.message } }));
    }
  }

  // 6. Static Web UI / Dashboard
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, pathname);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Route not found' } }));
});

// Sequenced Boot: Ensure WARP is connected before dashboard/server starts
async function boot() {
  console.log(`\n=============================================================`);
  console.log(`⚡ OpenCode2API Gateway Boot Sequence Initiated`);
  console.log(`=============================================================`);

  // Step 1: Establish Cloudflare WARP connection first so gateway egress is ready
  console.log(`[Boot] Step 1/3: Establishing Cloudflare WARP connection...`);
  try {
    const warpReady = await Promise.race([
      warp.autoBootstrap(),
      new Promise(resolve => setTimeout(() => resolve(false), 12000))
    ]);
    if (warpReady) {
      console.log(`[Boot] Cloudflare WARP successfully connected on port ${config.get('warp_port') || 40000} (warp=on)`);
    } else {
      console.warn(`[Boot] WARP bootstrap in progress or timed out. Proceeding in background...`);
    }
  } catch (err) {
    console.warn(`[Boot] WARP bootstrap notice:`, err.message);
  }

  // Step 2: Discover models from OpenCode Zen (routes through WARP)
  console.log(`[Boot] Step 2/3: Discovering upstream models from OpenCode Zen...`);
  try {
    await discovery.sync();
  } catch (err) {
    console.warn(`[Boot] Initial model discovery notice:`, err.message);
  }

  // Step 3: Launch Gateway HTTP Server & Dashboard
  console.log(`[Boot] Step 3/3: Launching HTTP API & Control Plane on port ${PORT}...`);
  server.listen(PORT, () => {
    console.log(`\n=============================================================`);
    console.log(`🚀 OpenCode2API Gateway Live on http://127.0.0.1:${PORT}`);
    console.log(`📊 Admin Dashboard: http://127.0.0.1:${PORT}/`);
    console.log(`🔑 Admin Credentials: ${config.get('admin_username')} / ${config.get('admin_password')}`);
    console.log(`🌐 OpenAI Base URL: http://127.0.0.1:${PORT}/v1`);
    console.log(`🌐 Anthropic Messages URL: http://127.0.0.1:${PORT}/v1/messages`);
    console.log(`✨ Discovered Models: ${discovery.models.length} (clean IDs, free suffixes auto-removed)`);
    console.log(`⚡ OpenCode CLI Fingerprint: v${config.get('client_version')}`);
    console.log(`🛡️  WARP Status: ${warp.isReady() ? 'Connected (warp=on)' : 'Connecting / Idle'}`);
    console.log(`=============================================================\n`);
  });
}

boot().catch(err => {
  console.error('[Boot] Critical error during startup:', err);
  server.listen(PORT, () => {
    console.log(`🚀 OpenCode2API Gateway started in emergency fallback mode on http://127.0.0.1:${PORT}`);
  });
});
