const fs = require('node:fs');
const path = require('node:path');
const { NativeNetwork, endpoints, failure } = require('./native-network');
const LegacyFirewallGuard = require('./legacy-firewall-guard');

class FirewallGuard {
  constructor(config, logger, directory, runtime = {}) {
    Object.assign(this, { config, logger, directory, isLocked: false });
    this.platform = runtime.platform || process.platform;
    this.trace = runtime.trace || (() => {});
    this.activity = runtime.activity || ((_kind, _stage, action) => action());
    this.lookup = runtime.lookup;
    this.verifyConnectivity = runtime.verifyConnectivity || (async () => {});
    this.pending = Promise.resolve();
    this.native = this.platform === 'darwin' ? null : runtime.native || new NativeNetwork({ platform: this.platform, trace: this.trace,
      onFailure: (error) => { this.isLocked = false; runtime.onFailure?.(error); } });
    this.legacy = this.platform === 'win32' ? runtime.legacy || new LegacyFirewallGuard(config, logger, directory, runtime) : null;
    this.statePath = this.legacy?.statePath || path.join(directory, 'network-state.json');
  }
  get mode() { return this.platform === 'win32' ? 'windows-wfp' : this.platform === 'darwin' ? 'macos-audit-only' : 'unavailable'; }
  checkPrivileges() { return this.platform === 'win32' ? this.native.check() : Promise.resolve(); }
  enqueue(stage, action) {
    const result = this.pending.then(() => this.activity('network', stage, action));
    this.pending = result.catch(() => {});
    return result;
  }
  lock() {
    if (this.platform === 'darwin') {
      if (!this.auditRecorded) {
        this.logger?.logViolation({ source: 'CLIENT', type: 'NETWORK_AUDIT_ONLY', target: this.mode, detail: 'macOS 不限制系统网络' });
        this.auditRecorded = true;
      }
      return Promise.resolve(false);
    }
    if (this.lockPending) return this.lockPending;
    if (this.isLocked && (this.native.healthy?.() ?? this.native.active) && !this.restorePending) return Promise.resolve(true);
    this.cancelled = false;
    const pending = this.enqueue('lock', async () => {
      if (this.platform === 'win32' && fs.existsSync(this.statePath)) await this.legacy.recover();
      this.trace('info', 'firewall.stage', { phase: 'resolve-destinations' });
      const policy = await endpoints(this.config.exam.allowedOrigins, this.lookup);
      this.trace('info', 'firewall.policy', { message: policy });
      if (this.cancelled) throw failure('NETWORK_CANCELLED', '用户已退出监考');
      const started = Date.now();
      try {
        await this.native.lock(policy);
        this.trace('info', 'firewall.stage', { phase: 'verify-oj-connectivity' });
        try { await this.verifyConnectivity(); }
        catch (cause) {
          this.trace('error', 'firewall.connectivity-failed', { name: cause.name, code: cause.code, message: cause.message });
          throw Object.assign(failure('NETWORK_OJ_UNREACHABLE'), { cause });
        }
      }
      catch (error) {
        this.isLocked = false;
        try { await this.native.unlock(); } catch (restoreError) {
          this.trace('error', 'firewall.rollback-failed', { code: restoreError.code, message: restoreError.message });
        } finally { this.native.close(); }
        throw error;
      }
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
    if (this.platform === 'darwin') { this.auditRecorded = false; return Promise.resolve(); }
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
  close() { this.native?.close(); }
}
module.exports = FirewallGuard;
