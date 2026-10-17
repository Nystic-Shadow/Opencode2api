const crypto = require('crypto');
const config = require('./config');

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Mint canonical descending session identifier.
 * Conforms to OpenCode's Identifier.descending() specification:
 * ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$
 * Real millisecond timestamp inverted with ~((now << 12) | 1) for valid temporal ordering.
 */
function generateCanonicalSessionId(seed = null) {
  const now = BigInt(Date.now());
  // 36-bit millisecond timestamp into 48-bit word, OR counter 1, bitwise NOT
  let current = ((now & 0xFFFFFFFFFn) << 12n) | 1n;
  const inverted = (~current) & 0xFFFFFFFFFFFFn;
  
  const timePartBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timePartBytes[i] = Number((inverted >> BigInt((5 - i) * 8)) & 0xFFn);
  }
  const timePart = timePartBytes.toString('hex'); // 12 hex chars ending in ...ffe

  // 14 Base62 characters from remainder of hash or cryptographic random bytes
  let n;
  if (seed) {
    const sum = crypto.createHash('sha256').update('ses\x00' + seed + Date.now()).digest();
    n = BigInt('0x' + sum.subarray(0, 10).toString('hex'));
  } else {
    n = BigInt('0x' + crypto.randomBytes(10).toString('hex'));
  }

  let chars = [];
  for (let i = 0; i < 14; i++) {
    chars.unshift(BASE62[Number(n % 62n)]);
    n = n / 62n;
  }
  return 'ses_' + timePart + chars.join('');
}

/**
 * Generate 40-character hex project ID.
 */
function generateProjectId(project = 'default-project') {
  return crypto.createHash('sha256').update('opencode-project\x00' + project).digest().subarray(0, 20).toString('hex');
}

/**
 * Build authentic upstream request headers.
 */
function buildUpstreamHeaders(sessionId, projectId, payloadLength) {
  const clientVersion = config.get('client_version') || '2.0.29';
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': 'Bearer public',
    'User-Agent': `opencode/latest/${clientVersion}/cli`,
    'x-opencode-client': 'cli',
    'x-opencode-session': sessionId,
    'x-opencode-session-id': sessionId,
    'x-session-affinity': sessionId,
    'X-Session-Id': sessionId,
    'x-opencode-project': projectId,
    'Content-Length': payloadLength
  };
}

module.exports = {
  generateCanonicalSessionId,
  generateProjectId,
  buildUpstreamHeaders
};
