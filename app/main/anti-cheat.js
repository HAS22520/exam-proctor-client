const { globalShortcut, screen } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');

class AntiCheatGuard {
  constructor(mainWindow, config, auditLogger = null, runtime = {}) {
    this.window = mainWindow;
    this.config = { ...config.antiCheat, preventMinimize: config.window?.preventMinimize };
    this.logger = auditLogger;
    this.shortcuts = [];
    this.listeners = [];
    this.running = false;
    this.scanning = false;
    this.detected = new Map();
    this.platform = runtime.platform || process.platform;
    this.auditOnly = this.platform === 'darwin';
  }

  record(type, target = '') { this.logger?.logViolation({ source: 'ANTI_CHEAT', type, target, detail: '' }); }

  listen(emitter, event, callback) {
    emitter.on(event, callback);
    this.listeners.push(() => emitter.removeListener(event, callback));
  }

  start() {
    if (this.running) return;
    this.running = true;
    for (const shortcut of this.auditOnly ? [] : this.config.blockShortcuts || []) {
      try {
        if (globalShortcut.register(shortcut, () => this.record('BLOCKED_SHORTCUT', shortcut))) this.shortcuts.push(shortcut);
        else this.record('SHORTCUT_UNAVAILABLE', shortcut);
      } catch { this.record('SHORTCUT_UNAVAILABLE', shortcut); }
    }
    this.listen(this.window, 'blur', () => {
      this.record('WINDOW_BLUR');
      if (!this.auditOnly && this.config.preventMinimize && !this.window.isDestroyed()) this.window.focus();
    });
    this.listen(this.window, 'minimize', () => {
      this.record('WINDOW_MINIMIZED');
      if (!this.auditOnly && this.config.preventMinimize && !this.window.isDestroyed()) this.window.restore();
    });
    const displays = () => {
      const count = screen.getAllDisplays().length;
      if (this.config.singleScreenOnly && count > 1) this.record('MULTI_SCREEN_DETECTED', String(count));
    };
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) this.listen(screen, event, displays);
    displays();
    this.scan();
    this.timer = setInterval(() => this.scan(), Math.max(1000, this.config.checkProcessIntervalMs || 3000));
    this.timer.unref();
  }

  scan() {
    if (!this.running || this.scanning) return;
    this.scanning = true;
    const windows = this.platform === 'win32';
    if (!windows && this.platform !== 'darwin') { this.scanning = false; return; }
    const blacklist = this.config.processBlacklistByPlatform?.[this.platform]
      || (windows ? this.config.processBlacklist || [] : []);
    execFile(windows ? 'tasklist.exe' : '/bin/ps', windows ? ['/fo', 'csv', '/nh'] : ['-axo', 'pid=,comm='],
      { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, output) => {
        this.scanning = false;
        if (!this.running) return;
        if (error) { this.record('PROCESS_SCAN_UNAVAILABLE'); return; }
        const detected = new Map();
        for (const line of output.split(/\r?\n/)) {
          const match = windows ? line.match(/^"([^"]+)","(\d+)"/) : line.trim().match(/^(\d+)\s+(.+)$/);
          if (!match) continue;
          const name = windows ? match[1] : path.basename(match[2]);
          const pid = Number(windows ? match[2] : match[1]);
          if (pid === process.pid || pid < 2 || !blacklist.some((item) => item.toLowerCase() === name.toLowerCase())) continue;
          const processKey = `${pid}:${name}`;
          detected.set(processKey, name);
          if (this.detected.has(processKey)) continue;
          this.record('FORBIDDEN_PROCESS', name);
          if (!this.auditOnly && this.config.terminateBlacklisted === true) {
            execFile(windows ? 'taskkill.exe' : '/bin/kill', windows ? ['/F', '/T', '/PID', String(pid)] : ['-TERM', String(pid)],
              { windowsHide: true, timeout: 5000 }, (killError) => this.record(killError ? 'PROCESS_TERMINATION_FAILED' : 'PROCESS_TERMINATED', name));
          }
        }
        for (const [key, name] of this.detected) if (!detected.has(key)) this.record('FORBIDDEN_PROCESS_EXITED', name);
        this.detected = detected;
      });
  }

  stop() {
    this.running = false;
    this.detected.clear();
    clearInterval(this.timer);
    for (const dispose of this.listeners.splice(0)) dispose();
    for (const shortcut of this.shortcuts.splice(0)) globalShortcut.unregister(shortcut);
  }
}

module.exports = AntiCheatGuard;
