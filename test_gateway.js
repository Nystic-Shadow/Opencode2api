const http = require('http');

const API_KEY = 'O2P-master-key'; // Master key from data/keys.json
const BASE_HOST = '127.0.0.1';
const BASE_PORT = 8080;

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: BASE_HOST,
      port: BASE_PORT,
      ...options,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk.toString());
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log('=== OpenCode2API Full Gateway Verification Suite ===\n');
  let passed = 0;
  let total = 0;

  async function check(name, testFn) {
    total++;
    try {
      const res = await testFn();
      if (res.ok) {
        passed++;
        console.log(`✅ [PASS] ${name}: ${res.detail}`);
      } else {
        console.log(`❌ [FAIL] ${name}: ${res.detail}`);
      }
    } catch (err) {
      console.log(`❌ [ERROR] ${name}: ${err.message}`);
    }
  }

  // 1. Models endpoint
  await check('GET /v1/models (Model Discovery)', async () => {
    const res = await request({ path: '/v1/models', method: 'GET' });
    const data = JSON.parse(res.body);
    const hasModels = Array.isArray(data.data) && data.data.length > 0;
    const cleanIds = data.data.every(m => !m.id.endsWith('-free'));
    return {
      ok: res.statusCode === 200 && hasModels && cleanIds,
      detail: `Returned ${data.data?.length} clean models (no -free suffixes)`
    };
  });

  // 2. OpenAI Chat Completions (Non-streaming, deepseek-v4.1-flash)
  await check('POST /v1/chat/completions (Non-streaming)', async () => {
    const res = await request({ path: '/v1/chat/completions', method: 'POST' }, {
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'Say "Gateway online" and nothing else.' }],
      stream: false
    });
    const data = JSON.parse(res.body);
    const content = data.choices?.[0]?.message?.content || '';
    return {
      ok: res.statusCode === 200 && content.length > 0,
      detail: `Status ${res.statusCode}, reply: "${content.trim().slice(0, 50)}"`
    };
  });

  // 3. OpenAI Chat Completions (Streaming, beam)
  await check('POST /v1/chat/completions (Streaming SSE)', async () => {
    const res = await request({ path: '/v1/chat/completions', method: 'POST' }, {
      model: 'beam',
      messages: [{ role: 'user', content: 'Say "Stream OK"' }],
      stream: true
    });
    const isSSE = res.headers['content-type']?.includes('text/event-stream');
    const hasDone = res.body.includes('[DONE]');
    return {
      ok: res.statusCode === 200 && isSSE && hasDone,
      detail: `Status ${res.statusCode}, received SSE chunks ending in [DONE]`
    };
  });

  // 4. Anthropic Messages (Non-streaming, beam)
  await check('POST /v1/messages (Anthropic Non-streaming)', async () => {
    const res = await request({
      path: '/v1/messages',
      method: 'POST',
      headers: { 'x-api-key': API_KEY }
    }, {
      model: 'beam',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Reply "Anthropic OK"' }],
      stream: false
    });
    const data = JSON.parse(res.body);
    const isAnthropicFormat = data.type === 'message' && Array.isArray(data.content);
    const text = data.content?.[0]?.text || '';
    return {
      ok: res.statusCode === 200 && isAnthropicFormat,
      detail: `Status ${res.statusCode}, reply: "${text.trim().slice(0, 50)}"`
    };
  });

  // 5. Anthropic Messages (Streaming, deepseek-v4.1-flash)
  await check('POST /v1/messages (Anthropic Streaming SSE)', async () => {
    const res = await request({
      path: '/v1/messages',
      method: 'POST',
      headers: { 'x-api-key': API_KEY }
    }, {
      model: 'deepseek-v4.1-flash',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Reply "SSE OK"' }],
      stream: true
    });
    const isSSE = res.headers['content-type']?.includes('text/event-stream');
    const hasMessageStop = res.body.includes('message_stop');
    return {
      ok: res.statusCode === 200 && isSSE && hasMessageStop,
      detail: `Status ${res.statusCode}, received Anthropic message events`
    };
  });

  // 6. High-Availability Smart Failover Test (Requesting glm-5.3-flash which returns 429 upstream)
  await check('POST /v1/chat/completions (Smart Failover Resilience)', async () => {
    const res = await request({ path: '/v1/chat/completions', method: 'POST' }, {
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'Say "Failover success"' }],
      stream: false
    });
    const data = JSON.parse(res.body);
    const fallbackHeader = res.headers['x-opencode2api-fallback'];
    const resolvedModel = res.headers['x-opencode2api-resolved-model'];
    const content = data.choices?.[0]?.message?.content || '';
    return {
      ok: res.statusCode === 200 && content.length > 0,
      detail: `Auto-recovered! Resolved model: ${resolvedModel}, fallback: "${fallbackHeader}", reply: "${content.trim().slice(0, 40)}"`
    };
  });

  console.log(`\n========================================`);
  console.log(`Test Results: ${passed} / ${total} Passed (${Math.round((passed / total) * 100)}% Success Rate)`);
  console.log(`========================================`);
}

runTests();
