const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

class FirewallGuard {
  constructor(config, auditLogger = null) {
    this.config = config;
    this.auditLogger = auditLogger;
    this.isLocked = false;
    this.lockScript = this.resolveScript('scripts/lock-firewall.ps1');
    this.unlockScript = this.resolveScript('scripts/unlock-firewall.ps1');
  }

  resolveScript(relPath) {
    if (process.resourcesPath) {
      const p = path.join(process.resourcesPath, relPath);
      if (fs.existsSync(p)) return p;
    }
    return path.resolve(__dirname, '../../', relPath);
  }

  // 检查当前进程是否具有管理员特权
  checkIsAdmin() {
    if (process.platform !== 'win32') return false;
    try {
      execSync('net session', { stdio: 'ignore' });
      return true;
    } catch (e) {
      return false;
    }
  }

  // 执行全局断网锁定
  lock() {
    if (process.platform !== 'win32') return;
    if (this.isLocked) return;

    console.log('[FirewallGuard] [INFO] 正在启动全局网络物理切断 (仅保留考试网站)...');

    const isAdmin = this.checkIsAdmin();
    try {
      if (isAdmin) {
        // 已经是管理员身份，直接执行 PowerShell 脚本
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${this.lockScript}"`, { stdio: 'ignore' });
      } else {
        // 请求 UAC 提权执行
        console.log('[FirewallGuard] [INFO] 请求 Windows 管理员权限执行防火墙策略...');
        const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"\\"${this.lockScript}\\"\\"'"` ;
        execSync(cmd, { stdio: 'ignore' });
      }
      this.isLocked = true;
      console.log('[FirewallGuard] [INFO] 全局防火墙切断已生效，整机外部网络已阻断！');

      if (this.auditLogger) {
        this.auditLogger.logViolation({
          source: 'FIREWALL_GUARD',
          type: 'GLOBAL_NETWORK_LOCKED',
          target: 'ALL_EXTERNAL_TRAFFIC',
          detail: '全局网络硬阻断已激活，除考试站点外整机断网'
        });
      }
    } catch (err) {
      console.error('[FirewallGuard] [ERROR] 启动全局防火墙断网失败:', err.message);
    }
  }

  // 恢复全局网络
  unlock() {
    if (process.platform !== 'win32') return;
    if (!this.isLocked) return;

    console.log('[FirewallGuard] [INFO] 正在恢复整机全局网络与防火墙...');

    const isAdmin = this.checkIsAdmin();
    try {
      if (isAdmin) {
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${this.unlockScript}"`, { stdio: 'ignore' });
      } else {
        const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"\\"${this.unlockScript}\\"\\"'"` ;
        execSync(cmd, { stdio: 'ignore' });
      }
      this.isLocked = false;
      console.log('[FirewallGuard] [INFO] 全局网络与防火墙已全部恢复正常！');
    } catch (err) {
      console.error('[FirewallGuard] [ERROR] 恢复全局网络失败:', err.message);
    }
  }
}

module.exports = FirewallGuard;
