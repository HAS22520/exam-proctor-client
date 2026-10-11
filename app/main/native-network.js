const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns').promises;
const { spawn } = require('node:child_process');

const messages = {
  ADMIN_REQUIRED: '请关闭软件，右键点击监考客户端，选择“以管理员身份运行”后重新打开。',
  NATIVE_MISSING: '安装包缺少系统网络组件，请安装新版完整安装包；ASAR 更新不能安装原生组件。',
  FILTER_FAILED: '系统网络过滤未能启用，请检查系统授权及网络服务后重试。',
  HELPER_EXITED: '系统网络组件已停止，监考认证已撤销。请重新进入考试。',
  ETIMEDOUT: 'Windows 网络组件响应超时。请查看诊断日志。',
};
function failure(code, detail = '') {
  return Object.assign(new Error(messages[code] || `系统网络操作失败（${code}）${detail ? `：${String(detail).slice(0, 200)}` : ''}`), { code });
}

function executable(platform = process.platform, resources = process.resourcesPath) {
  const name = 'hydro-network.exe';
  const packaged = resources && path.join(resources, 'native', name);
  return packaged && fs.existsSync(packaged) ? packaged : path.resolve(__dirname, '../../build/native', name);
}

async function endpoints(origins, lookup = dns.lookup) {
  const groups = await Promise.all(origins.map(async (origin) => {
    const url = new URL(origin), host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    let timer;
    try {
      const addresses = net.isIP(host) ? [{ address: host }] : await Promise.race([
        lookup(host, { all: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure('DNS_TIMEOUT', host)), 8000); }),
      ]);
      if (!addresses.length || addresses.some(({ address }) => !net.isIP(address) || address.includes('%'))) throw failure('INVALID_ADDRESS', host);
      return addresses.map(({ address }) => `${address}|${port}`);
    } finally { clearTimeout(timer); }
  }));
  const result = [...new Set(groups.flat())];
  if (!result.length || result.length > 1024) throw failure('INVALID_POLICY');
  return result.join(';');
}

class NativeNetwork {
  constructor({ platform = process.platform, spawnProcess = spawn, filename = executable(platform), trace = () => {}, onFailure = () => {}, now = () => performance.now() } = {}) {
    Object.assign(this, { platform, spawnProcess, filename, trace, onFailure, now });
    this.sequence = 0; this.requests = new Map(); this.child = null; this.active = false; this.closing = false;
  }
  start() {
    if (this.child) return;
    if (this.platform !== 'win32') throw failure('UNSUPPORTED_PLATFORM');
    if (this.spawnProcess === spawn && !fs.existsSync(this.filename)) throw failure('NATIVE_MISSING');
    this.closing = false;
    this.lastPulseAt = this.now();
    const child = this.spawnProcess(this.filename, ['--parent', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let buffer = '';
    const stopped = () => {
      if (this.child !== child) return;
      this.child = null; clearInterval(this.heartbeat);
      const active = this.active; this.active = false;
      for (const { reject, timer } of this.requests.values()) { clearTimeout(timer); reject(failure('HELPER_EXITED')); }
      this.requests.clear();
      if (active && !this.closing) this.onFailure(failure('HELPER_EXITED'));
    };
    child.once('error', stopped); child.once('exit', stopped);
    child.stdin.on('error', stopped);
    child.stderr.on('data', (chunk) => this.trace('warn', 'firewall.native-error', { message: String(chunk).slice(0, 500) }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 65536) { child.kill(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let reply;
        try { reply = JSON.parse(line); } catch { continue; }
        if (reply.event === 'stage') { this.trace('info', 'firewall.stage', { phase: reply.phase }); continue; }
        if (reply.event === 'lease-expired') {
          this.active = false; this.onFailure(failure('HELPER_EXITED')); continue;
        }
        const pending = this.requests.get(reply.id);
        if (!pending) continue;
        this.requests.delete(reply.id); clearTimeout(pending.timer);
        if (reply.ok && reply.protocol === 1) pending.resolve(reply);
        else pending.reject(failure(reply.code || 'NATIVE_PROTOCOL_MISMATCH', reply.message));
      }
    });
    this.heartbeat = setInterval(() => {
      if (this.active && !this.healthy()) {
        this.close(); this.onFailure(failure('HELPER_EXITED')); return;
      }
      if (this.child === child && !child.stdin.destroyed) { child.stdin.write('0\tping\n'); this.lastPulseAt = this.now(); }
    }, 2000);
    this.heartbeat.unref?.();
  }
  command(operation, policy = '', timeout = 15000) {
    try { this.start(); } catch (error) { return Promise.reject(error); }
    if (!['check', 'lock', 'unlock'].includes(operation) || /[\r\n\t]/.test(policy)) return Promise.reject(failure('INVALID_POLICY'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        const active = this.active;
        this.close();
        if (active) this.onFailure(failure('ETIMEDOUT'));
        reject(failure('ETIMEDOUT'));
      }, timeout);
      this.requests.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${id}\t${operation}\t${policy}\n`);
    });
  }
  check() { return this.command('check'); }
  healthy() { return this.active && !this.closing && this.now() - this.lastPulseAt < 8000; }
  async lock(policy) {
    await this.command('lock', policy);
    if (!this.child) throw failure('HELPER_EXITED');
    this.active = true;
  }
  async unlock() { if (this.child) await this.command('unlock'); this.active = false; }
  close() {
    this.closing = true; this.active = false; clearInterval(this.heartbeat);
    this.child?.stdin.end();
  }
}
module.exports = { NativeNetwork, endpoints, executable, failure };
