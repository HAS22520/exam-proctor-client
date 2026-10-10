const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
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

class FirewallGuard {
  constructor(config, logger, directory, runtime = {}) {
    Object.assign(this, { config, logger, directory, isLocked: false });
    this.platform = runtime.platform || process.platform;
    this.exec = runtime.exec || execFileSync;
    this.clientPid = runtime.pid || process.pid;
    this.statePath = path.join(directory, 'network-state.json');
  }

  script(name) {
    const packaged = path.join(process.resourcesPath || '', 'scripts', name);
    return fs.existsSync(packaged) ? packaged : path.resolve(__dirname, '../../scripts', name);
  }

  run(name, policyPath = '') {
    const quote = (value) => `'${value.replace(/'/g, "''")}'`;
    const script = `& ${quote(this.script(name))} -StatePath ${quote(this.statePath)}${policyPath ? ` -PolicyPath ${quote(policyPath)} -ClientProcessId ${this.clientPid}` : ''}`;
    try {
      this.exec('powershell.exe', powerShellArgs(script), { stdio: 'ignore', windowsHide: true, timeout: 90000 });
    } catch (error) {
      const action = name === 'unlock-firewall.ps1' ? '恢复' : '应用';
      const detail = error.code === 'ETIMEDOUT' ? '操作超时，请检查 Windows 防火墙服务。'
        : '请允许 Windows 管理员授权，并确认 Windows 防火墙服务正常运行。';
      const failure = new Error(`无法${action}监考网络设置。${detail}恢复失败时请以管理员身份运行随包 scripts/restore-network.bat；保留客户端数据。`);
      failure.code = error.code || 'FIREWALL_COMMAND_FAILED';
      throw failure;
    }
  }

  recover() {
    if (this.platform === 'win32' && fs.existsSync(this.statePath)) this.run('unlock-firewall.ps1');
  }

  lock() {
    if (this.platform !== 'win32') {
      this.logger?.logViolation({ source: 'FIREWALL', type: 'SYSTEM_NETWORK_FILTER_UNAVAILABLE', target: this.platform, detail: '应用内白名单仍生效' });
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
    if (this.platform !== 'win32') return;
    this.recover();
    this.isLocked = false;
  }
}

module.exports = FirewallGuard;
module.exports.powerShellArgs = powerShellArgs;
