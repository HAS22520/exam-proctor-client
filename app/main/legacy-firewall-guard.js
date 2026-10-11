const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { atomicWrite } = require('./device-store');

function powerShellArgs(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
}

function execute(command, args, options, callback) {
  // Detached watchdogs must not inherit pipes whose EOF would delay completion.
  const child = spawn(command, args, { ...options, stdio: 'ignore' });
  child.once('error', callback);
  child.once('exit', (code, signal) => callback(code === 0 ? null : Object.assign(new Error('Firewall process failed'),
    { code: signal ? 'ETIMEDOUT' : 'FIREWALL_COMMAND_FAILED' })));
}

class FirewallGuard {
  constructor(config, logger, directory, runtime = {}) {
    this.platform = runtime.platform || process.platform;
    this.exec = runtime.exec || execute;
    this.trace = runtime.trace || (() => {});
    this.activity = runtime.activity || ((_kind, _stage, action) => action());
    this.pending = Promise.resolve();
    this.restorePending = null;
    this.restoreFailure = null;
    this.statePath = path.join(directory, 'network-state.json');
  }

  script(name) {
    const packaged = path.join(process.resourcesPath || '', 'scripts', name);
    return fs.existsSync(packaged) ? packaged : path.resolve(__dirname, '../../scripts', name);
  }

  async run(name) {
    const quote = (value) => `'${value.replace(/'/g, "''")}'`;
    const script = `& ${quote(this.script(name))} -StatePath ${quote(this.statePath)}`;
    const started = Date.now();
    this.trace('info', 'firewall.start', { operation: name });
    const report = () => {
      try {
        const stage = JSON.parse(fs.readFileSync(`${this.statePath}.progress.json`, 'utf8')).stage;
        if (/^[a-z-]{1,64}$/.test(stage) && stage !== lastStage) {
          lastStage = stage; this.trace('info', 'firewall.stage', { operation: name, phase: stage, durationMs: Date.now() - started });
        }
      } catch { /* A stage file may be between atomic writes. */ }
    };
    let lastStage;
    const progressTimer = setInterval(report, 500);
    try {
      await new Promise((resolve, reject) => {
        this.exec('powershell.exe', powerShellArgs(script), { windowsHide: true, timeout: 30000 },
          (error) => error ? reject(error) : resolve());
      });
      report();
      this.trace('info', 'firewall.complete', { operation: name, durationMs: Date.now() - started });
    } catch (error) {
      const detail = (error.code === 'ETIMEDOUT' || error.killed) ? '操作超时，请检查 Windows 防火墙服务。'
        : '请以管理员身份启动客户端，并确认 Windows 防火墙服务正常运行。';
      const failure = new Error(`无法恢复旧版本监考网络设置。${detail}恢复失败时请以管理员身份运行随包 scripts/restore-network.bat；保留客户端数据。`);
      failure.code = error.killed ? 'ETIMEDOUT' : error.code || 'FIREWALL_COMMAND_FAILED';
      this.trace('error', 'firewall.failed', { operation: name, code: failure.code, message: failure.message, durationMs: Date.now() - started });
      throw failure;
    } finally { clearInterval(progressTimer); }
  }

  enqueue(action, stage) {
    const result = this.pending.then(() => this.activity('network', stage, action));
    this.pending = result.catch(() => {});
    return result;
  }

  async restore() {
    if (this.platform !== 'win32' || !fs.existsSync(this.statePath)) { this.restoreFailure = null; return; }
    if (this.restoreFailure && Date.now() < this.retryRestoreAt) throw this.restoreFailure;
    try {
      const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      let watch = this.liveWatch();
      const deadline = Date.now() + 2000;
      while (state.watchdogProtocol === 1 && watch?.group !== state.group && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100)); watch = this.liveWatch();
      }
      if (watch && watch.group === state.group) await this.requestRecovery(state.group);
      else await this.run('unlock-firewall.ps1');
      this.restoreFailure = null;
    } catch (error) {
      this.restoreFailure = error; this.retryRestoreAt = Date.now() + 30000;
      throw error;
    }
  }

  liveWatch() {
    try {
      const filename = `${this.statePath}.watch.json`;
      if (Date.now() - fs.statSync(filename).mtimeMs < 10000) return JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch { /* Older clients do not have a command-capable watchdog. */ }
    return null;
  }

  async requestRecovery(group) {
    const id = crypto.randomBytes(16).toString('hex'), started = Date.now();
    atomicWrite(`${this.statePath}.restore-request.json`, JSON.stringify({ id, group }));
    this.trace('info', 'firewall.watchdog-recovery-requested');
    let lastStage;
    while (Date.now() - started < 30000) {
      try {
        const stage = JSON.parse(fs.readFileSync(`${this.statePath}.progress.json`, 'utf8')).stage;
        if (/^[a-z-]{1,64}$/.test(stage) && stage !== lastStage) {
          lastStage = stage; this.trace('info', 'firewall.stage', { operation: 'watchdog-recovery', phase: stage, durationMs: Date.now() - started });
        }
      } catch { }
      // The watchdog removes state only after all restoration steps succeeded.
      if (!fs.existsSync(this.statePath)) { this.trace('info', 'firewall.watchdog-restored', { durationMs: Date.now() - started }); return; }
      let result;
      try { result = JSON.parse(fs.readFileSync(`${this.statePath}.restore-result.json`, 'utf8')); } catch { }
      if (result?.id === id && result.ok === false) {
        const failure = new Error(`网络守护进程恢复失败：${String(result.message || '请检查 Windows 防火墙服务').slice(0, 200)}`);
        failure.code = 'FIREWALL_RECOVERY_FAILED'; throw failure;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const failure = new Error('网络守护进程正在恢复或恢复超时。请保留数据；必要时以管理员身份运行 scripts/restore-network.bat。');
    failure.code = 'ETIMEDOUT'; throw failure;
  }

  recover() {
    if (this.restorePending) return this.restorePending;
    if (this.platform !== 'win32' || !fs.existsSync(this.statePath)) {
      this.restoreFailure = null; return Promise.resolve();
    }
    const pending = this.enqueue(() => this.restore(), 'restore');
    this.restorePending = pending;
    pending.finally(() => { if (this.restorePending === pending) this.restorePending = null; }).catch(() => {});
    return pending;
  }
}

module.exports = FirewallGuard;
