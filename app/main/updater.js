const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const crypto = require('node:crypto');
const { secureUrl, validateConfig } = require('./config-policy');
const { atomicWrite } = require('./device-store');
const { buildVersion: validateBuildVersion } = require('./build-version');
const { hasUnfinishedJournals } = require('./update-cache');

function compare(a, b) {
  if (![a, b].every((value) => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value))) throw new Error('Invalid update version');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

class Updater {
  constructor(config, { directory, trust, version, buildVersion = '', source = 'installed', failure, cache, onStatus = () => {}, fetch = globalThis.fetch }) {
    Object.assign(this, { config, directory, trust, version, buildVersion, source, failure, cache, onStatus, fetch, minimumBlocked: false });
    this.state = { phase: 'idle', available: false, message: '尚未检查更新' };
    this.policyPath = path.join(directory, 'updates', 'policy.json');
    try {
      const policy = JSON.parse(fs.readFileSync(this.policyPath, 'utf8'));
      this.minimumBlocked = !!policy.minClientVersion && compare(version, policy.minClientVersion) < 0;
    } catch { /* A corrupt optional cache does not prevent startup. */ }
  }

  snapshot() {
    return { ...this.state, enabled: this.config.updater.enabled, source: this.source, rollback: this.failure?.message || '', blocked: hasUnfinishedJournals(this.directory), version: this.version, buildVersion: this.buildVersion, minimumBlocked: this.minimumBlocked,
      installerUrl: this.installerUrl || '', canHotUpdate: !!this.cache && !!this.manifest?.hotUpdate?.asarUrl && this.state.available };
  }
  publish(state) { Object.assign(this.state, state); this.onStatus(this.snapshot()); }

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

  async downloadPackage(info, destination, progress = () => {}) {
    if (!Number.isSafeInteger(info.size) || info.size < 1 || info.size > 240 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(info.sha256 || '')) throw new Error('Invalid update integrity metadata');
    let last;
    for (const url of [...new Set([info.asarUrl, info.fallbackUrl].filter(Boolean))]) {
      const temp = `${destination}.tmp`;
      try {
        const response = await this.response(url, info.size);
        let size = 0; const hash = crypto.createHash('sha256');
        const source = Readable.from((async function* () {
          for await (const chunk of response.body) { size += chunk.length; if (size > info.size) throw new Error('Update size mismatch'); hash.update(chunk); progress(Math.floor(size * 100 / info.size)); yield chunk; }
        })());
        await pipeline(source, fs.createWriteStream(temp, { mode: 0o600 }));
        if (size !== info.size || hash.digest('hex') !== info.sha256) throw new Error('Update integrity mismatch');
        fs.renameSync(temp, destination); return destination;
      } catch (error) { fs.rmSync(temp, { force: true }); last = error; }
    }
    throw last || new Error('No update package URL');
  }

  async check({ force = false } = {}) {
    if (!force && this.config.updater.checkOnStartup === false) return;
    if (this.checkPending) return this.checkPending;
    if (this.busy) return this.manifest;
    this.checkPending = this.readManifest().finally(() => { this.checkPending = null; });
    return this.checkPending;
  }

  async readManifest() {
    this.publish({ phase: 'checking', message: '正在检查更新' });
    try {
      const manifest = await this.json(this.config.updater.versionUrl, this.config.updater.fallbackVersionUrl);
      compare(manifest.version, this.version);
      this.minimumBlocked = !!manifest.minClientVersion && compare(this.version, manifest.minClientVersion) < 0;
      atomicWrite(this.policyPath, JSON.stringify({ version: manifest.version, buildVersion: manifest.buildVersion || '', minClientVersion: manifest.minClientVersion || '' }));
      if (manifest.config?.url) {
        const remote = await this.json(manifest.config.url, manifest.config.fallbackUrl);
        const validated = validateConfig({ ...this.config, ...remote, debug: this.config.debug }, this.trust);
        delete validated.trust;
        atomicWrite(path.join(this.directory, 'config', 'exam-config.json'), JSON.stringify(validated));
      }
      this.manifest = manifest;
      const platform = manifest.fullUpdate?.platforms?.[process.platform]?.[process.arch];
      const info = platform || (process.platform === 'win32' && process.arch === 'x64' ? manifest.fullUpdate : null);
      const candidate = info?.installerUrl || info?.portableUrl;
      this.installerUrl = candidate ? this.url(candidate).href : '';
      let newer;
      try { newer = validateBuildVersion(manifest.buildVersion) > validateBuildVersion(this.buildVersion); }
      catch {
        this.publish({ phase: 'incompatible', available: false, message: '本机或更新清单缺少有效 buildVersion，请安装支持构建编号的完整客户端' });
        return manifest;
      }
      this.publish({ phase: newer ? 'available' : 'current', available: newer,
        latestVersion: manifest.version, latestBuildVersion: manifest.buildVersion,
        message: this.minimumBlocked ? '当前版本低于最低版本要求，请更新' : newer ? `发现新版本 ${manifest.version} · 构建 ${manifest.buildVersion}` : '已是最新构建' });
      return manifest;
    } catch (error) { this.publish({ phase: 'failed', message: `更新检查失败：${error.message}` }); throw error; }
  }

  async stage() {
    if (this.busy) throw new Error('更新正在处理中');
    if (this.checkPending) await this.checkPending;
    const manifest = this.manifest;
    if (!this.cache || !this.state.available || !manifest?.hotUpdate?.asarUrl) throw new Error('此更新需要完整安装包');
    if (hasUnfinishedJournals(this.directory)) throw new Error('仍有未结束或待上传的监考日志，请上传完成后再更新');
    const hot = manifest.hotUpdate;
    if (hot.version !== manifest.version || validateBuildVersion(manifest.buildVersion) <= validateBuildVersion(this.buildVersion)) throw new Error('更新包版本不匹配');
    const info = { version: manifest.version, buildVersion: manifest.buildVersion, size: hot.size, sha256: hot.sha256 };
    const destination = path.join(this.directory, 'updates', `download-${crypto.randomBytes(12).toString('hex')}.asar`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    this.busy = true;
    try {
      this.publish({ phase: 'downloading', percent: 0, message: '正在下载 ASAR 更新' });
      await this.downloadPackage(hot, destination, (percent) => {
        if (this.state.percent !== percent) this.publish({ percent });
      });
      this.publish({ phase: 'verifying', message: '正在验证发布签名与应用文件' });
      await this.cache.stage(info, destination);
      this.publish({ phase: 'ready', percent: 100, message: '更新已验证，重启后生效' });
      return info;
    } catch (error) { this.publish({ phase: 'failed', message: `更新未应用：${error.message}` }); throw error; }
    finally { this.busy = false; fs.rmSync(destination, { force: true }); }
  }
}

module.exports = Updater;
module.exports.compare = compare;
