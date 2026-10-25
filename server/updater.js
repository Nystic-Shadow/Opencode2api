const https = require('https');
const config = require('./config');
const notifications = require('./notifications');
const egress = require('./egress');

function currentEgressAgent() {
  const routes = egress.getCandidates();
  if (routes.length === 0) return null;
  return egress.getAgent(routes[0], 'https:');
}

function isNewerVersion(remote, current) {
  if (!remote || !current) return false;
  const parse = v => v.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const r = parse(remote);
  const c = parse(current);
  for (let i = 0; i < Math.max(r.length, c.length); i++) {
    const rVal = r[i] || 0;
    const cVal = c[i] || 0;
    if (rVal > cVal) return true;
    if (rVal < cVal) return false;
  }
  return false;
}

class OpenCodeCliUpdater {
  constructor() {
    this.timer = null;
    this.checking = false;
    this.startChecker();
  }

  startChecker() {
    if (this.timer) clearInterval(this.timer);
    // Initial check 5 seconds after boot
    setTimeout(() => {
      if (config.get('auto_update_cli') !== false) {
        this.checkForUpdate().catch(e => console.warn('[Updater] Initial check failed:', e.message));
      }
    }, 5000);

    // Check every 30 minutes for new OpenCode CLI releases
    this.timer = setInterval(() => {
      if (config.get('auto_update_cli') !== false) {
        this.checkForUpdate().catch(e => console.warn('[Updater] Periodic check failed:', e.message));
      }
    }, 1800 * 1000);
  }

  async checkForUpdate() {
    if (this.checking) return null;
    this.checking = true;

    try {
      console.log('[Updater] Checking for latest OpenCode CLI version...');
      const latestTag = await this.queryLatestReleaseTag();
      if (!latestTag) return null;

      const cleanedTag = latestTag.replace(/^v/i, '').trim();
      const currentVersion = config.get('client_version');

      if (cleanedTag && isNewerVersion(cleanedTag, currentVersion)) {
        console.log(`[Updater] New OpenCode CLI version found: ${cleanedTag} (current: ${currentVersion})`);
        
        // 1. Post detection notification
        notifications.add(
          'OpenCode CLI Update Detected',
          `New upstream version ${cleanedTag} is available. Updating client headers...`,
          'info'
        );

        // 2. Hot-update version in config
        config.update({ client_version: cleanedTag });

        // 3. Trigger immediate model discovery for new models in this release
        try {
          const discovery = require('./discovery');
          await discovery.sync();
        } catch (e) {
          console.warn('[Updater] Model discovery sync after update warning:', e.message);
        }

        // 4. Post success notification
        notifications.add(
          'OpenCode CLI Auto-Updated',
          `Successfully upgraded client fingerprint to OpenCode CLI v${cleanedTag} with zero container downtime.`,
          'update'
        );

        return { previous: currentVersion, current: cleanedTag };
      }

      return null;
    } catch (err) {
      console.warn('[Updater] Check update error:', err.message);
      return null;
    } finally {
      this.checking = false;
    }
  }

  async queryLatestReleaseTag() {
    // Primary: Official npm registry for @opencode/cli (where OpenCode 2.x releases are published)
    const npmVersion = await this.queryNpmVersion();
    if (npmVersion) {
      return npmVersion;
    }

    // Fallback: GitHub releases API for anomalyco/opencode
    return this.queryGitHubVersion();
  }

  queryNpmVersion() {
    return new Promise((resolve) => {
      const agent = currentEgressAgent();
      if (!agent) return resolve(null);
      const options = {
        hostname: 'registry.npmjs.org',
        path: '/@opencode%2Fcli/latest',
        method: 'GET',
        agent,
        headers: {
          'User-Agent': 'OpenCode2API-Gateway-Agent',
          'Accept': 'application/json'
        },
        timeout: 8000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.version) {
              return resolve(json.version);
            }
          } catch (e) {}
          resolve(null);
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    });
  }

  queryGitHubVersion() {
    return new Promise((resolve) => {
      const agent = currentEgressAgent();
      if (!agent) return resolve(null);
      const options = {
        hostname: 'api.github.com',
        path: '/repos/anomalyco/opencode/releases/latest',
        method: 'GET',
        agent,
        headers: {
          'User-Agent': 'OpenCode2API-Gateway-Agent',
          'Accept': 'application/vnd.github.v3+json'
        },
        timeout: 8000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              if (json.tag_name) {
                return resolve(json.tag_name);
              }
            } catch (e) {}
          }
          resolve(null);
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    });
  }
}

module.exports = new OpenCodeCliUpdater();
