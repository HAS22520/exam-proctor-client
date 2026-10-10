const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { atomicWrite } = require('./device-store');

function powerShellArgs(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const launcher = `$ErrorActionPreference = 'Stop'
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        & ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))))
        exit 0
    }
    $p = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}')
    # Start-Process -Wait also waits for the watchdog, which waits for Electron.
    # Wait only for the firewall command's process, leaving the watchdog running.
    $p.WaitForExit()
    exit $p.ExitCode
} catch {
    Write-Error -ErrorRecord $_ -ErrorAction Continue
    exit 1
}`;
  // Encoding both layers avoids Windows command-line quoting changing the script.
  return ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(launcher, 'utf16le').toString('base64')];
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
    Object.assign(this, { config, logger, directory, isLocked: false });
    this.platform = runtime.platform || process.platform;
    this.exec = runtime.exec || execute;
    this.trace = runtime.trace || (() => {});
    this.activity = runtime.activity || ((_kind, _stage, action) => action());
    this.pending = Promise.resolve();
    this.restorePending = null;
    this.restoreFailure = null;
    this.clientPid = runtime.pid || process.pid;
    this.statePath = path.join(directory, 'network-state.json');
  }

  script(name) {
    const packaged = path.join(process.resourcesPath || '', 'scripts', name);
    return fs.existsSync(packaged) ? packaged : path.resolve(__dirname, '../../scripts', name);
  }

  async run(name, policyPath = '') {
    const quote = (value) => `'${value.replace(/'/g, "''")}'`;
    const script = `& ${quote(this.script(name))} -StatePath ${quote(this.statePath)}${policyPath ? ` -PolicyPath ${quote(policyPath)} -ClientProcessId ${this.clientPid}` : ''}`;
    const started = Date.now();
    this.trace('info', 'firewall.start', { operation: name });
    const report = () => {
      if (name === 'lock-firewall.ps1' && this.cancelLock && !cancelSent) {
        try {
          const watch = this.liveWatch();
          if (watch) {
            atomicWrite(`${this.statePath}.restore-request.json`, JSON.stringify({ id: crypto.randomBytes(16).toString('hex'), group: watch.group }));
            cancelSent = true;
          }
        } catch { /* Snapshot/watchdog may not exist yet. Retry on the next tick. */ }
      }
      try {
        const stage = JSON.parse(fs.readFileSync(`${this.statePath}.progress.json`, 'utf8')).stage;
        if (/^[a-z-]{1,64}$/.test(stage) && stage !== lastStage) {
          lastStage = stage; this.trace('info', 'firewall.stage', { operation: name, phase: stage, durationMs: Date.now() - started });
        }
      } catch { /* A stage file may be between atomic writes. */ }
    };
    let lastStage, cancelSent = false;
    const progressTimer = setInterval(report, 500);
    try {
      await new Promise((resolve, reject) => {
        this.exec('powershell.exe', powerShellArgs(script), { windowsHide: true, timeout: name === 'lock-firewall.ps1' ? 45000 : 30000 },
          (error) => error ? reject(error) : resolve());
      });
      report();
      this.trace('info', 'firewall.complete', { operation: name, durationMs: Date.now() - started });
    } catch (error) {
      if (name === 'lock-firewall.ps1') this.cancelPolicy(policyPath);
      const action = name === 'unlock-firewall.ps1' ? '恢复' : '应用';
      const detail = (error.code === 'ETIMEDOUT' || error.killed) ? '操作超时，请检查 Windows 防火墙服务。'
        : '请允许 Windows 管理员授权，并确认 Windows 防火墙服务正常运行。';
      const failure = new Error(`无法${action}监考网络设置。${detail}恢复失败时请以管理员身份运行随包 scripts/restore-network.bat；保留客户端数据。`);
      failure.code = error.killed ? 'ETIMEDOUT' : error.code || 'FIREWALL_COMMAND_FAILED';
      this.trace('error', 'firewall.failed', { operation: name, code: failure.code, message: failure.message, durationMs: Date.now() - started });
      throw failure;
    } finally { clearInterval(progressTimer); }
  }

  cancelPolicy(policyPath) {
    try {
      const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
      atomicWrite(`${policyPath}.cancel`, 'cancelled');
      atomicWrite(`${this.statePath}.restore-request.json`, JSON.stringify({ id: crypto.randomBytes(16).toString('hex'), group: policy.group }));
    } catch { /* No policy/snapshot has been written yet. */ }
  }

  enqueue(action, stage) {
    const result = this.pending.then(() => this.activity('network', stage, action));
    this.pending = result.catch(() => {});
    return result;
  }

  async restore() {
    if (this.platform !== 'win32' || !fs.existsSync(this.statePath)) { this.isLocked = false; this.restoreFailure = null; return; }
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
    this.isLocked = false;
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
    // A queued lock may not have written its snapshot yet. Only skip recovery
    // when there is no lock in flight and no saved network state to restore.
    if (!this.lockPending && (this.platform !== 'win32' || !fs.existsSync(this.statePath))) {
      this.isLocked = false; this.restoreFailure = null; return Promise.resolve();
    }
    const pending = this.enqueue(() => this.restore(), 'restore');
    this.restorePending = pending;
    pending.finally(() => { if (this.restorePending === pending) this.restorePending = null; }).catch(() => {});
    return pending;
  }

  lock() {
    if (this.lockPending) return this.lockPending;
    if (this.isLocked && !this.restorePending) return Promise.resolve(true);
    this.cancelLock = false;
    const pending = this.enqueue(() => this.applyLock(), 'lock');
    this.lockPending = pending;
    pending.finally(() => { if (this.lockPending === pending) this.lockPending = null; }).catch(() => {});
    return pending;
  }

  async applyLock() {
    if (this.platform !== 'win32') {
      this.logger?.logViolation({ source: 'FIREWALL', type: 'SYSTEM_NETWORK_FILTER_UNAVAILABLE', target: this.platform, detail: '应用内白名单仍生效' });
      return false;
    }
    if (this.isLocked) return true;
    // Never launch another policy command over an unresolved snapshot. In
    // particular, a failed recovery must not cause an elevation per page click.
    if (fs.existsSync(this.statePath)) await this.restore();
    const policyId = crypto.randomUUID();
    const policyPath = path.join(this.directory, `network-policy-${policyId}.json`);
    atomicWrite(policyPath, JSON.stringify({ origins: this.config.exam.allowedOrigins, group: `HydroProctor-${policyId}` }));
    try { await this.run('lock-firewall.ps1', policyPath); this.isLocked = true; }
    catch (error) { await this.restore(); throw error; }
    this.logger?.logViolation({ source: 'FIREWALL', type: 'NETWORK_POLICY_APPLIED', target: 'win32', detail: '' });
    return true;
  }

  unlock() { this.cancelLock = true; return this.recover(); }
}

module.exports = FirewallGuard;
module.exports.powerShellArgs = powerShellArgs;
