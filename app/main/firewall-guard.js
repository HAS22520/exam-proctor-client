const fs = require('node:fs');
const { NativeNetwork, endpoints, failure } = require('./native-network');
const LegacyFirewallGuard = require('./legacy-firewall-guard');

class FirewallGuard {
  constructor(config, logger, directory, runtime = {}) {
    Object.assign(this, { config, logger, directory, isLocked: false });
    this.platform = runtime.platform || process.platform;
    this.trace = runtime.trace || (() => {});
    this.activity = runtime.activity || ((_kind, _stage, action) => action());
    this.lookup = runtime.lookup;
    this.pending = Promise.resolve();
    this.native = runtime.native || new NativeNetwork({ platform: this.platform, trace: this.trace,
      onFailure: (error) => { this.isLocked = false; runtime.onFailure?.(error); } });
    this.legacy = runtime.legacy || new LegacyFirewallGuard(config, logger, directory, runtime);
    this.statePath = this.legacy.statePath;
  }
  get mode() { return this.platform === 'win32' ? 'windows-wfp' : this.platform === 'darwin' ? 'macos-network-extension' : 'unavailable'; }
  checkPrivileges() { return this.platform === 'win32' ? this.native.check() : Promise.resolve(); }
  enqueue(stage, action) {
    const result = this.pending.then(() => this.activity('network', stage, action));
    this.pending = result.catch(() => {});
    return result;
  }
  lock() {
    if (this.lockPending) return this.lockPending;
    if (this.isLocked && (this.native.healthy?.() ?? this.native.active) && !this.restorePending) return Promise.resolve(true);
    this.cancelled = false;
    const pending = this.enqueue('lock', async () => {
      if (this.platform === 'win32' && fs.existsSync(this.statePath)) await this.legacy.recover();
      this.trace('info', 'firewall.stage', { phase: 'resolve-destinations' });
      const policy = await endpoints(this.config.exam.allowedOrigins, this.lookup);
      if (this.cancelled) throw failure('NETWORK_CANCELLED', '用户已退出监考');
      const started = Date.now();
      try { await this.native.lock(policy); }
      catch (error) { this.isLocked = false; this.native.close(); throw error; }
      if (this.cancelled) { this.native.close(); throw failure('NETWORK_CANCELLED', '用户已退出监考'); }
      this.isLocked = true;
      this.trace('info', 'firewall.complete', { operation: 'native-lock', backend: this.mode, durationMs: Date.now() - started });
      this.logger?.logViolation({ source: 'FIREWALL', type: 'NETWORK_POLICY_APPLIED', target: this.mode, detail: '' });
      return true;
    });
    this.lockPending = pending;
    pending.finally(() => { if (this.lockPending === pending) this.lockPending = null; }).catch(() => {});
    return pending;
  }
  recover() {
    if (this.restorePending) return this.restorePending;
    const legacy = this.platform === 'win32' && fs.existsSync(this.statePath);
    if (!this.lockPending && !this.isLocked && !this.native.active && !legacy) return Promise.resolve();
    const pending = this.enqueue('restore', async () => {
      const started = Date.now();
      try { await this.native.unlock(); }
      catch (error) { this.isLocked = false; throw error; }
      this.isLocked = false;
      if (this.platform === 'win32' && fs.existsSync(this.statePath)) await this.legacy.recover();
      this.trace('info', 'firewall.complete', { operation: 'native-unlock', backend: this.mode, durationMs: Date.now() - started });
    });
    this.restorePending = pending;
    pending.finally(() => { if (this.restorePending === pending) this.restorePending = null; }).catch(() => {});
    return pending;
  }
  unlock() { return this.recover(); }
  cancelPendingLock() {
    if (this.lockPending) { this.cancelled = true; this.native.close(); }
  }
  close() { this.native.close(); }
}
module.exports = FirewallGuard;
