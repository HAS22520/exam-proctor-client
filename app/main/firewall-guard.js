const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { atomicWrite } = require('./device-store');

class FirewallGuard {
  constructor(config, logger, directory) {
    Object.assign(this, { config, logger, directory, isLocked: false });
    this.statePath = path.join(directory, 'network-state.json');
  }

  script(name) {
    const packaged = path.join(process.resourcesPath || '', 'scripts', name);
    return fs.existsSync(packaged) ? packaged : path.resolve(__dirname, '../../scripts', name);
  }

  run(name, policyPath = '') {
    const quote = (value) => `'${value.replace(/'/g, "''")}'`;
    const script = `& ${quote(this.script(name))} -StatePath ${quote(this.statePath)}${policyPath ? ` -PolicyPath ${quote(policyPath)} -ClientProcessId ${process.pid}` : ''}`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let admin = false;
    try { execFileSync('net.exe', ['session'], { stdio: 'ignore', windowsHide: true }); admin = true; } catch { /* UAC below. */ }
    const args = admin ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
      : ['-NoProfile', '-Command', `$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'); exit $p.ExitCode`];
    execFileSync('powershell.exe', args, { stdio: 'ignore', windowsHide: true, timeout: 90000 });
  }

  recover() {
    if (process.platform === 'win32' && fs.existsSync(this.statePath)) this.run('unlock-firewall.ps1');
  }

  lock() {
    if (process.platform !== 'win32') {
      this.logger?.logViolation({ source: 'FIREWALL', type: 'SYSTEM_NETWORK_FILTER_UNAVAILABLE', target: process.platform, detail: '应用内白名单仍生效' });
      return false;
    }
    if (this.isLocked) return true;
    const policyPath = path.join(this.directory, 'network-policy.json');
    atomicWrite(policyPath, JSON.stringify({ origins: this.config.exam.allowedOrigins, group: `HydroProctor-${crypto.randomUUID()}` }));
    try { this.run('lock-firewall.ps1', policyPath); this.isLocked = true; }
    catch (error) { this.recover(); throw error; }
    this.logger?.logViolation({ source: 'FIREWALL', type: 'NETWORK_POLICY_APPLIED', target: 'win32', detail: '' });
    return true;
  }

  unlock() {
    if (process.platform !== 'win32') return;
    this.recover();
    this.isLocked = false;
  }
}

module.exports = FirewallGuard;
