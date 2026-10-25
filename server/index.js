const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const keys = require('./keys');
const discovery = require('./discovery');
const proxy = require('./proxy');
const egress = require('./egress');
const requestQueue = require('./requestQueue');
const adminRoutes = require('./adminRoutes');
const metrics = require('./metrics');

// Global exception protection to guarantee gateway 100% zero-crash uptime
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err?.message || err);
  if (err?.stack) console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled Rejection:', reason?.message || reason);
});

const PORT = config.get('port') || 8080;
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

// Whitelisted MIME types for static assets
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
};

// Safe static file server protecting against path traversal (C1) and arbitrary file disclosure
function serveStatic(req, res, pathname) {
  // Reject null bytes and non-printable control characters
  if (!pathname || pathname.includes('\0') || /[\x00-\x1f]/.test(pathname)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Invalid path' } }));
  }

  // Safe path decoding and normalization
  let decoded = '/';
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Malformed URL encoding' } }));
  }

  // Strip leading traversal artifacts and normalize
  const cleanRelative = path.normalize(decoded).replace(/^([.][.][/\\])+/, '');
  let targetPath = path.resolve(DIST_DIR, '.' + path.sep + cleanRelative);

  // Strict containment verification: targetPath MUST reside inside DIST_DIR.
  // The distribution root itself is valid here; it is resolved to index.html
  // by the directory fallback below.
  const relativeToDist = path.relative(DIST_DIR, targetPath);
  const insideDist = relativeToDist === '' || (
    relativeToDist !== '..' &&
    !relativeToDist.startsWith('..' + path.sep) &&
    !path.isAbsolute(relativeToDist)
  );
  if (!insideDist) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Access denied: Path outside distribution root' } }));
  }

  // Ban dotfiles / hidden files
  const baseName = path.basename(targetPath);
  if (baseName.startsWith('.')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Access denied: Hidden files are protected' } }));
  }

  let stat = null;
  try {
    stat = fs.statSync(targetPath);
  } catch (e) {
    stat = null;
  }

  // If path doesn't exist or is a directory, fall back to index.html for SPA routing
  if (!stat || stat.isDirectory()) {
    targetPath = path.join(DIST_DIR, 'index.html');
    try {
      stat = fs.statSync(targetPath);
    } catch (e) {
      stat = null;
    }
  }

  if (stat && stat.isFile()) {
    const ext = path.extname(targetPath).toLowerCase();
    const contentType = MIME_TYPES[ext];

    // Enforce whitelist: only serve recognised web asset types
    if (!contentType && ext !== '') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Asset type not permitted' } }));
    }

    res.writeHead(200, {
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(targetPath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unable to read asset' } }));
      } else {
        try { res.end(); } catch (e) {}
      }
    });
    return stream.pipe(res);
  }

  // Fallback placeholder if dist hasn't been built yet
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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

// Bounded JSON body parser with strict size limits preventing Denial of Service (H1)
const MAX_BODY_SIZE_INFERENCE = 10 * 1024 * 1024; // 10MB for vision payloads

function parseJsonBody(req, maxSize = MAX_BODY_SIZE_INFERENCE) {
  return new Promise((resolve, reject) => {
    const headerLen = parseInt(req.headers['content-length'], 10);
    if (!isNaN(headerLen) && headerLen > maxSize) {
      const err = new Error(`Payload too large. Exceeds ${Math.round(maxSize / (1024 * 1024))}MB limit.`);
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

// Parse the request target with the WHATWG URL parser. Requests normally use
// origin-form ("/v1/models?x=1"), so a fixed base is required; malformed
// targets fall back to "/" instead of throwing inside the request handler.
function requestPathname(rawUrl) {
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch (e) {
    return '/';
  }
}

const server = http.createServer(async (req, res) => {
  const pathname = requestPathname(req.url);

  // Global CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // Baseline hardening headers for both API and dashboard responses.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (pathname.startsWith('/api/') || pathname.startsWith('/v1/')) {
    res.setHeader('Cache-Control', 'no-store');
  }

  try {
    // 1. Health endpoint (liveness: always 200 while the process is alive)
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        service: 'OpenCode2API',
        uptime_seconds: Math.round(process.uptime()),
        cli_version: config.get('client_version'),
        models_count: discovery.models.length,
        egress_ready: egress.getCandidates().length > 0
      }));
    }

    // 1b. Readiness endpoint (traffic should only be sent when this is 200)
    if (pathname === '/readyz') {
      const routes = egress.getCandidates();
      const modelsCount = discovery.models.length;
      const ready = routes.length > 0 && modelsCount > 0;
      const body = {
        status: ready ? 'ready' : 'not_ready',
        service: 'OpenCode2API',
        uptime_seconds: Math.round(process.uptime()),
        models_count: modelsCount,
        egress: {
          mode: config.get('egress_mode'),
          ready_routes: routes.map(r => ({ id: r.id, type: r.type })),
          proxies_configured: (config.get('proxies') || []).length,
          allow_direct: egress.getStatus().allowDirect
        },
        queue: requestQueue.getStats()
      };
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(body));
    }

    // 2. Admin dashboard APIs (/api/...)
    if (pathname.startsWith('/api/')) {
      return await adminRoutes.handleAdminRoute(req, res, pathname);
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

      // Reject invalid/disabled/expired keys before reading a potentially 10 MB body.
      const earlyAuth = keys.validateToken(token);
      if (!earlyAuth.valid) {
        res.writeHead(earlyAuth.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: earlyAuth.error, type: 'authentication_error' } }));
      }

      let payload;
      try {
        payload = await parseJsonBody(req, MAX_BODY_SIZE_INFERENCE);
      } catch (err) {
        const status = err.statusCode || 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: err.message } }));
      }

      const authResult = keys.validateAndCheckLimit(token, payload?.model);
      if (!authResult.valid) {
        res.writeHead(authResult.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: authResult.error } }));
      }
      return await proxy.handleChatCompletions(payload, req, res, authResult.key);
    }

    // 5. Anthropic Messages (/v1/messages)
    if (pathname === '/v1/messages' && req.method === 'POST') {
      const authHeader = req.headers['authorization'] || '';
      const apiKeyHeader = req.headers['x-api-key'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '') || apiKeyHeader;

      const earlyAuth = keys.validateToken(token);
      if (!earlyAuth.valid) {
        res.writeHead(earlyAuth.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: earlyAuth.error }
        }));
      }

      let payload;
      try {
        payload = await parseJsonBody(req, MAX_BODY_SIZE_INFERENCE);
      } catch (err) {
        const status = err.statusCode || 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: err.message } }));
      }

      const authResult = keys.validateAndCheckLimit(token, payload?.model);
      if (!authResult.valid) {
        res.writeHead(authResult.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: authResult.error } }));
      }
      return await proxy.handleAnthropicMessages(payload, req, res, authResult.key);
    }

    // 6. Static Web UI / Dashboard
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Route not found' } }));
  } catch (err) {
    console.error(`[Server] Unhandled error handling ${req.method} ${pathname}:`, err);
    if (!res.headersSent) {
      const status = err.statusCode || 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: err.message || 'Internal server error',
          type: 'internal_server_error'
        }
      }));
    } else if (!res.writableEnded && !res.destroyed) {
      // Never leave a client hanging if an unexpected error happens after the
      // stream headers have already been sent.
      try { res.end(); } catch (e) {}
    }
  }
});

// Bound slow clients without breaking legitimate long-running SSE streams.
server.requestTimeout = 120000;
server.headersTimeout = 30000;

// Boot order: bind the HTTP port immediately, then sync models in the
// background. Slow model discovery or proxy checks must never make the
// container fail its liveness probe or refuse to start.
function startHttpServer() {
  if (server.listening) return;

  server.on('error', (err) => {
    console.error('[HTTP] Server error:', err.message);
    if (err.code === 'EADDRINUSE') process.exit(1);
  });

  server.listen(PORT, () => {
    console.log(`\n=============================================================`);
    console.log(`🚀 OpenCode2API Gateway Live on http://127.0.0.1:${PORT}`);
    console.log(`📊 Admin Dashboard: http://127.0.0.1:${PORT}/`);
    console.log(`🔑 Admin Username: ${config.get('admin_username')} (password via DASHBOARD_PASS or data/admin-password.txt)`);
    console.log(`🌐 OpenAI Base URL: http://127.0.0.1:${PORT}/v1`);
    console.log(`🌐 Anthropic Messages URL: http://127.0.0.1:${PORT}/v1/messages`);
    console.log(`✨ Discovered Models: ${discovery.models.length} (cached at boot; syncing in background)`);
    console.log(`⚡ OpenCode CLI Fingerprint: v${config.get('client_version')}`);
    console.log(`🛡️  Egress Mode: ${config.get('egress_mode')} (${egress.getCandidates().length} ready route(s))`);
    console.log(`✅ Readiness probe: http://127.0.0.1:${PORT}/readyz`);
    console.log(`=============================================================\n`);
  });
}

async function boot() {
  console.log(`\n=============================================================`);
  console.log(`⚡ OpenCode2API Gateway Boot Sequence Initiated`);
  console.log(`=============================================================`);

  // Bind first. The dashboard and /healthz are available immediately.
  startHttpServer();

  // Explicit proxy pool health checks (5 probes per configured proxy, 5s cap).
  try { egress.startHealthChecks(); } catch (e) {
    console.warn('[Boot] Proxy health checks could not start:', e.message);
  }

  // Model discovery runs in the background; cached models are served now.
  discovery.sync()
    .then(() => console.log(`[Boot] Model discovery complete: ${discovery.models.length} models.`))
    .catch((err) => console.warn('[Boot] Initial model discovery notice:', err.message));
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Process] ${signal} received; draining HTTP connections...`);
  const forceTimer = setTimeout(() => {
    console.error('[Process] Graceful shutdown timed out; exiting.');
    process.exit(1);
  }, 15000);
  if (typeof forceTimer.unref === 'function') forceTimer.unref();
  server.close(() => {
    try { keys.flush(); } catch (e) {}
    try { metrics.flush(); } catch (e) {}
    try { egress.stopHealthChecks(); } catch (e) {}
    clearTimeout(forceTimer);
    process.exit(0);
  });
  if (server.closeIdleConnections) server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

boot().catch(err => {
  console.error('[Boot] Critical error during startup:', err);
  startHttpServer();
});
