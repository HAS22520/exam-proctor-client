const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const crypto = require('node:crypto');
const { secureUrl, validateConfig } = require('./config-policy');
const { atomicWrite } = require('./device-store');
const { verify } = require('./proctor-crypto');

function compare(a, b) {
  if (![a, b].every((value) => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value))) throw new Error('Invalid update version');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

class Updater {
  constructor(config, { directory, trust, version, fetch = globalThis.fetch }) {
    Object.assign(this, { config, directory, trust, version, fetch, minimumBlocked: false });
    this.policyPath = path.join(directory, 'updates', 'policy.json');
    if (fs.existsSync(this.policyPath)) {
      const policy = JSON.parse(fs.readFileSync(this.policyPath, 'utf8'));
      this.minimumBlocked = !!policy.minClientVersion && compare(version, policy.minClientVersion) < 0;
    }
  }

  url(value, base) {
    const url = secureUrl(new URL(value, base || this.config.updater.versionUrl).href);
    if (!this.config.updater.allowedOrigins.includes(url.origin)) throw new Error('Update address outside compiled allowlist');
    return url;
  }

  async response(value, maxBytes) {
    let url = this.url(value);
    const signal = AbortSignal.timeout(Math.max(4000, Math.min(120000, this.config.updater.timeoutMs || 30000)));
    for (let count = 0; count < 6; count++) {
      const response = await this.fetch(url, { redirect: 'manual', signal, credentials: 'omit', cache: 'no-store' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Missing update redirect');
        url = this.url(location, url);
        continue;
      }
      if (!response.ok || !response.body) throw new Error('Update download failed');
      if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new Error('Update exceeds size limit');
      return response;
    }
    throw new Error('Too many update redirects');
  }

  async json(primary, fallback) {
    let last;
    for (const url of [...new Set([primary, fallback].filter(Boolean))]) {
      try {
        const response = await this.response(url, 256 * 1024);
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length; if (size > 256 * 1024) throw new Error('Update JSON too large'); chunks.push(Buffer.from(chunk));
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) { last = error; }
    }
    throw last || new Error('No update URL');
  }

  async downloadPackage(info, destination) {
    if (!Number.isSafeInteger(info.size) || info.size < 1 || info.size > 240 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(info.sha256 || '')) throw new Error('Invalid update integrity metadata');
    let last;
    for (const url of [...new Set([info.asarUrl, info.fallbackUrl].filter(Boolean))]) {
      const temp = `${destination}.tmp`;
      try {
        const response = await this.response(url, info.size);
        let size = 0; const hash = crypto.createHash('sha256');
        const source = Readable.from((async function* () {
          for await (const chunk of response.body) { size += chunk.length; if (size > info.size) throw new Error('Update size mismatch'); hash.update(chunk); yield chunk; }
        })());
        await pipeline(source, fs.createWriteStream(temp, { mode: 0o600 }));
        if (size !== info.size || hash.digest('hex') !== info.sha256) throw new Error('Update integrity mismatch');
        fs.renameSync(temp, destination); return destination;
      } catch (error) { fs.rmSync(temp, { force: true }); last = error; }
    }
    throw last || new Error('No update package URL');
  }

  async check() {
    if (this.config.updater.checkOnStartup === false) return;
    const manifest = await this.json(this.config.updater.versionUrl, this.config.updater.fallbackVersionUrl);
    compare(manifest.version, this.version);
    this.minimumBlocked = !!manifest.minClientVersion && compare(this.version, manifest.minClientVersion) < 0;
    atomicWrite(this.policyPath, JSON.stringify({ version: manifest.version, minClientVersion: manifest.minClientVersion || '' }));
    if (manifest.config?.url) {
      const remote = await this.json(manifest.config.url, manifest.config.fallbackUrl);
      const validated = validateConfig({ ...this.config, ...remote, debug: this.config.debug }, this.trust);
      delete validated.trust;
      atomicWrite(path.join(this.directory, 'config', 'exam-config.json'), JSON.stringify(validated));
    }
    this.manifest = manifest;
    const newer = compare(manifest.version, this.version) > 0;
    if (!newer && !this.minimumBlocked) return manifest;
    // The current OJ manifest is unsigned. Never execute downloaded ASAR based on
    // a hash supplied by that same manifest. Native signed installers preserve
    // macOS code signatures and support upgrading Electron itself on Windows.
    const platform = manifest.fullUpdate?.platforms?.[process.platform]?.[process.arch];
    const info = platform || (process.platform === 'win32' && process.arch === 'x64' ? manifest.fullUpdate : null);
    const candidate = info?.installerUrl || info?.portableUrl;
    if (candidate) this.installerUrl = this.url(candidate).href;
    return manifest;
  }

  // Optional independent signature extension, for release tooling and future
  // server support. No automatic ASAR replacement is enabled by this client.
  verifyHotUpdate(info) {
    const payload = { action: 'hydro-proctor-update/1', version: info.version, platform: info.platform,
      arch: info.arch, size: info.size, sha256: info.sha256 };
    return !!this.trust.updatePublicKey && verify(payload, info.signature, this.trust.updatePublicKey);
  }
}

module.exports = Updater;
module.exports.compare = compare;
