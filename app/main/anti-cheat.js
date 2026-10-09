const { globalShortcut, screen, dialog } = require('electron');
const { exec } = require('child_process');

class AntiCheatGuard {
  constructor(mainWindow, config, auditLogger = null) {
    this.mainWindow = mainWindow;
    this.config = config.antiCheat || {};
    this.auditLogger = auditLogger;
    this.blurCount = 0;
    this.timer = null;
    this.violationLogs = [];
  }

  start() {
    this.registerShortcuts();
    this.listenWindowEvents();
    this.checkDisplays();
    this.startProcessMonitor();
  }

  registerShortcuts() {
    const shortcuts = this.config.blockShortcuts || [];
    shortcuts.forEach(sc => {
      try {
        globalShortcut.register(sc, () => {
          console.warn(`[AntiCheat] [BLOCKED] 用户触发被禁止的全局快捷键: ${sc}`);
          if (this.auditLogger) {
            this.auditLogger.logViolation({
              source: 'ANTI_CHEAT',
              type: 'BLOCKED_SHORTCUT',
              target: sc,
              detail: `尝试按下受限制的快捷键组合: ${sc}`
            });
          }
        });
      } catch (e) {}
    });
  }

  listenWindowEvents() {
    // 监听窗口失焦 (切屏行为)
    this.mainWindow.on('blur', () => {
      this.blurCount++;
      const msg = `检测到离开考试窗口 (第 ${this.blurCount} 次切屏)`;
      console.warn(`[AntiCheat] [WARN] ${msg}`);
      this.violationLogs.push({
        type: 'WINDOW_BLUR',
        count: this.blurCount,
        time: new Date().toISOString()
      });

      if (this.auditLogger) {
        this.auditLogger.logViolation({
          source: 'ANTI_CHEAT',
          type: 'WINDOW_BLUR',
          target: `FOCUS_LOST_${this.blurCount}`,
          detail: msg
        });
      }

      // 强行重新聚焦
      if (this.config.preventMinimize) {
        this.mainWindow.focus();
      }
    });
  }

  checkDisplays() {
    if (this.config.singleScreenOnly) {
      const displays = screen.getAllDisplays();
      if (displays.length > 1) {
        console.warn(`[AntiCheat] [WARN] 检测到存在多台显示器 (${displays.length} 台)，请拔除副屏！`);
        if (this.auditLogger) {
          this.auditLogger.logViolation({
            source: 'ANTI_CHEAT',
            type: 'MULTI_SCREEN_DETECTED',
            target: `${displays.length}_DISPLAYS`,
            detail: `连接了多台显示设备 (${displays.length} 台)，存在扩展屏违规风险`
          });
        }
        dialog.showErrorBox(
          '防作弊提示',
          `检测到当前连接了 ${displays.length} 台显示器！\n考试环境仅允许使用单显示器，请拔除扩展显示屏后再进行考试。`
        );
      }
    }
  }

  startProcessMonitor() {
    const blacklist = this.config.processBlacklist || [];
    if (blacklist.length === 0) return;

    const interval = this.config.checkProcessIntervalMs || 1500;
    const detectedBadProcs = new Set();

    // 启动时立即执行一次强制查杀高危即时通讯与AI工具
    const initialFastKillList = [
      'Weixin.exe', 'WeChat.exe', 'WeChatAppEx.exe', 'WXWork.exe',
      'QQ.exe', 'QQProtect.exe', 'TIM.exe',
      'DeepSeek.exe', 'DeepSeek Harness.exe', 'chatbox.exe'
    ];
    const killArgs = initialFastKillList.map(p => `/IM "${p}"`).join(' ');
    exec(`taskkill /F /T ${killArgs}`, () => {});

    const scanAndKill = () => {
      exec('tasklist /fo csv /nh', (err, stdout) => {
        if (err || !stdout) return;

        const currentProcesses = stdout.toLowerCase();
        for (const badProc of blacklist) {
          const procLower = badProc.toLowerCase();
          if (currentProcesses.includes(procLower)) {
            console.warn(`[AntiCheat] [TERMINATE] 强制关闭黑名单违规软件: ${badProc}`);
            
            // 立即强制终止违规程序及其子进程
            exec(`taskkill /F /T /IM "${badProc}"`, () => {});

            this.violationLogs.push({
              type: 'FORBIDDEN_PROCESS_KILLED',
              process: badProc,
              time: new Date().toISOString()
            });

            if (!detectedBadProcs.has(badProc)) {
              detectedBadProcs.add(badProc);
              if (this.auditLogger) {
                this.auditLogger.logViolation({
                  source: 'ANTI_CHEAT',
                  type: 'FORBIDDEN_PROCESS_KILLED',
                  target: badProc,
                  detail: `检测到违规软件运行，已自动强制关闭: ${badProc}`
                });
              }
            }
          } else {
            detectedBadProcs.delete(badProc);
          }
        }
      });
    };

    // 随后开启高频实时守护
    scanAndKill();
    this.timer = setInterval(scanAndKill, interval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    globalShortcut.unregisterAll();
  }
}

module.exports = AntiCheatGuard;
