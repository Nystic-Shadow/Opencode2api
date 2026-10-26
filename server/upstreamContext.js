/**
 * Upstream context gate for the OpenCode free tier.
 *
 * The official inference endpoint only serves free-tier traffic when the
 * request looks like it came from the OpenCode CLI: a canonical session id,
 * the official core tools, and a system message containing the `<env>` block
 * with a `Working directory:` line. Session ids and tools are handled
 * elsewhere; this module supplies the missing environment context without
 * replacing the caller's own system prompt.
 */

const fs = require('fs');
const path = require('path');

const ENV_BLOCK_KEYS = ['<env>', 'Working directory:'];

let gitRepoCache = null;

function isGitRepo(dir) {
  if (gitRepoCache && gitRepoCache.dir === dir) return gitRepoCache.value;
  let value = false;
  try {
    let current = path.resolve(dir);
    for (let depth = 0; depth < 24; depth++) {
      if (fs.existsSync(path.join(current, '.git'))) {
        value = true;
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch (e) {
    value = false;
  }
  gitRepoCache = { dir, value };
  return value;
}

function buildEnvBlock(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  // The CLI reports the host platform name, not the Node arch.
  const platform = options.platform || process.platform;
  const gitRepo = options.gitRepo === undefined ? isGitRepo(cwd) : !!options.gitRepo;
  return [
    '<env>',
    `  Working directory: ${cwd}`,
    `  Workspace root folder: ${cwd}`,
    `  Is directory a git repo: ${gitRepo ? 'yes' : 'no'}`,
    `  Platform: ${platform}`,
    '</env>'
  ].join('\n');
}

function contentHasEnvBlock(content) {
  if (typeof content === 'string') {
    return ENV_BLOCK_KEYS.every(key => content.includes(key));
  }
  if (Array.isArray(content)) {
    const text = content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('\n');
    return ENV_BLOCK_KEYS.every(key => text.includes(key));
  }
  return false;
}

/**
 * Return a messages array whose leading system message carries the upstream
 * environment gate. Existing system content is preserved and appended to.
 * The input array is never mutated.
 */
function ensureUpstreamEnv(messages, options = {}) {
  const block = options.block || buildEnvBlock(options);
  const list = Array.isArray(messages) ? messages : [];

  let systemIndex = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].role === 'system') {
      systemIndex = i;
      break;
    }
  }

  if (systemIndex === -1) {
    return [{ role: 'system', content: block }, ...list];
  }

  const message = list[systemIndex];
  if (contentHasEnvBlock(message.content)) return list;

  const next = list.slice();
  if (typeof message.content === 'string') {
    next[systemIndex] = {
      ...message,
      content: message.content ? `${message.content}\n\n${block}` : block
    };
    return next;
  }

  if (Array.isArray(message.content)) {
    next[systemIndex] = {
      ...message,
      content: [...message.content, { type: 'text', text: block }]
    };
    return next;
  }

  // Unknown system content shape: replace it rather than dropping the gate.
  next[systemIndex] = { ...message, content: block };
  return next;
}

module.exports = {
  buildEnvBlock,
  ensureUpstreamEnv,
  contentHasEnvBlock,
  _test: {
    isGitRepo,
    resetGitRepoCache() { gitRepoCache = null; }
  }
};
