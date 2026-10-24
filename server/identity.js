const crypto = require('crypto');
const config = require('./config');

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Mint canonical descending session identifier.
 * Conforms to OpenCode's Identifier.descending() specification:
 * ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$
 * Real millisecond timestamp inverted with ~((now << 12) | 1) for valid temporal ordering.
 */
let lastMs = 0;
let seqCounter = 0;

/**
 * Mint canonical descending session identifier.
 * Conforms to OpenCode 2.x Identifier.descending() specification:
 * Exact decompiled EZ(true) algorithm from official opencode CLI v2.0.32:
 * ~(ts_ms * 4096 + counter) inverted into 48-bit hex + 14 Base62 characters.
 */
function generateCanonicalSessionId(seed = null) {
  const n = Date.now();
  if (n !== lastMs) {
    lastMs = n;
    seqCounter = 0;
  }
  seqCounter++;
  const r = BigInt(n) * 0x1000n + BigInt(seqCounter);
  const a = ~r; // Descending inversion
  const timePart = Array.from({ length: 6 }, (_, D) =>
    Number((a >> BigInt(40 - 8 * D)) & 0xffn).toString(16).padStart(2, '0')
  ).join('');

  let randPart;
  if (seed) {
    const sum = crypto.createHash('sha256').update('ses\x00' + seed + n).digest();
    let num = BigInt('0x' + sum.subarray(0, 10).toString('hex'));
    const chars = [];
    for (let i = 0; i < 14; i++) {
      chars.unshift(BASE62[Number(num % 62n)]);
      num = num / 62n;
    }
    randPart = chars.join('');
  } else {
    const randomBytes = crypto.randomBytes(14);
    randPart = Array.from(randomBytes, b => BASE62[b % 62]).join('');
  }

  return 'ses_' + timePart + randPart;
}

/**
 * Generate 40-character hex project ID.
 */
function generateProjectId(project = null) {
  const name = project || ('proj_' + crypto.randomBytes(8).toString('hex'));
  return crypto.createHash('sha256').update('opencode-project\x00' + name).digest().subarray(0, 20).toString('hex');
}

/**
 * Build authentic upstream request headers.
 * Matches packages/core/src/session/model-request.ts in anomalyco/opencode
 */
function buildUpstreamHeaders(sessionId, projectId, payloadLength) {
  const clientVersion = config.get('client_version') || '2.0.32';
  const upstreamKey = config.get('upstream_zen_key') || process.env.OPENCODE_ZEN_KEY || process.env.OPENCODE_API_KEY;

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'User-Agent': `opencode/${clientVersion}`,
    'x-opencode-client': 'opencode',
    'x-opencode-session': sessionId,
    'x-opencode-session-id': sessionId,
    'x-session-affinity': sessionId,
    'X-Session-Id': sessionId,
    'x-opencode-project': projectId || 'global',
    'Content-Length': payloadLength
  };

  // Upstream requires Bearer public for anonymous free tier access, or genuine key when provided
  if (upstreamKey && upstreamKey.trim()) {
    headers['Authorization'] = `Bearer ${upstreamKey.trim()}`;
  } else {
    headers['Authorization'] = 'Bearer public';
  }

  return headers;
}

module.exports = {
  generateCanonicalSessionId,
  generateProjectId,
  buildUpstreamHeaders
};
