const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// 抑制 Windows 控制台乱码与 Chromium 底层网络提示噪声
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch (e) {}
}
app.commandLine.appendSwitch('log-level', '3');

const AuditLogger = require('./audit-logger');
const NetworkGuard = require('./network-guard');
const ScreenRecorder = require('./screen-recorder');
const AntiCheatGuard = require('./anti-cheat');
const SystemProxyGuard = require('./system-proxy-guard');

// 资源路径解析（兼容开发环境与打包后的 extraResources）
function resolveAppResource(relPath) {
  if (app.isPackaged && process.resourcesPath) {
    const p = path.join(process.resourcesPath, relPath);
    if (fs.existsSync(p)) return p;
  }
  return path.resolve(__dirname, '../../', relPath);
}

// 读取配置
const configPath = resolveAppResource('config/exam-config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (e) {
  console.error('[Main] [ERROR] 加载配置文件失败，使用默认配置', e);
  config = {
    exam: {
      targetUrl: 'https://oj.hntou.fmcf.cc/',
      allowedDomains: ['oj.hntou.fmcf.cc']
    },
    systemNetworkLock: { enabled: true, proxyPort: 18899 },
    window: { kiosk: false, alwaysOnTop: false },
    recording: { enabled: true }
  };
}

// 打包模式下，如果输出路径是相对路径，让 records 位于 exe 所在的同级目录下
if (app.isPackaged) {
  const exeDir = path.dirname(process.execPath);
  config.recording = config.recording || {};
  config.recording.outputDir = path.resolve(exeDir, config.recording.outputDir || './records');
}

let mainWindow = null;
let auditLogger = null;
let networkGuard = null;
let screenRecorder = null;
let antiCheatGuard = null;
let systemProxyGuard = null;
let isQuitting = false;
let isCleanedUp = false;

function createWindow() {
  const isKiosk = config.window?.kiosk ?? true;
  const isAlwaysOnTop = config.window?.alwaysOnTop ?? true;

  mainWindow = new BrowserWindow({
    title: config.exam.title || '安全监考客户端',
    width: 1280,
    height: 800,
    kiosk: isKiosk, // 全屏锁定模式
    alwaysOnTop: isAlwaysOnTop, // 置顶显示
    autoHideMenuBar: true,
    fullscreen: isKiosk,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: !(config.window?.disableDevTools ?? true)
    }
  });

  // 1. 初始化客户端网络防火墙 / 域名白名单拦截
  networkGuard = new NetworkGuard(config, auditLogger);
  networkGuard.install(mainWindow);

  // 2. 加载目标考试网址
  console.log(`[Main] [INFO] 正在导航至考试系统: ${config.exam.targetUrl}`);
  mainWindow.loadURL(config.exam.targetUrl);

  // 3. 启动防作弊看门狗
  antiCheatGuard = new AntiCheatGuard(mainWindow, config, auditLogger);
  antiCheatGuard.start();

  // 4. 退出防误触确认
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['继续考试', '确认交卷并退出'],
        defaultId: 0,
        cancelId: 0,
        title: '退出提示',
        message: '确定要退出监考系统吗？',
        detail: '退出后系统将解除网络白名单限制，停止录屏并生成违规访问审计报告。'
      });

      if (choice === 1) {
        isQuitting = true;
        mainWindow.close();
      }
    }
  });

  // 监听前端悬浮栏发起的交卷退出请求
  ipcMain.handle('exam:request-quit', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });
}

// 清理所有监考与网络限制资源并生成报告
async function cleanupAllResources() {
  console.log('[Main] [INFO] 正在清理资源并恢复系统正常网络...');
  if (systemProxyGuard) {
    try {
      systemProxyGuard.stop();
    } catch (e) {}
    systemProxyGuard = null;
  }
  if (antiCheatGuard) {
    try {
      antiCheatGuard.stop();
    } catch (e) {}
    antiCheatGuard = null;
  }
  if (screenRecorder && screenRecorder.isRecording) {
    try {
      await screenRecorder.stop();
    } catch (e) {}
    screenRecorder = null;
  }
  if (auditLogger) {
    try {
      auditLogger.finalize();
    } catch (e) {}
    auditLogger = null;
  }
}

// 进程意外中断保底恢复
function registerSafetyHandlers() {
  const safeExit = () => {
    if (systemProxyGuard) {
      try { systemProxyGuard.disableSystemProxy(); } catch (e) {}
    }
    if (auditLogger) {
      try { auditLogger.finalize(); } catch (e) {}
      auditLogger = null;
    }
  };
  process.on('exit', safeExit);
  process.on('SIGINT', () => { safeExit(); process.exit(0); });
  process.on('SIGTERM', () => { safeExit(); process.exit(0); });
  process.on('uncaughtException', (err) => {
    console.error('[Main] [CRASH]', err);
    safeExit();
    process.exit(1);
  });
}
registerSafetyHandlers();

// 应用启动生命周期
app.whenReady().then(async () => {
  // 1. 初始化集中式审计日志模块
  auditLogger = new AuditLogger(config);

  // 2. 启动整机系统级白名单网络锁定
  if (config.systemNetworkLock?.enabled) {
    systemProxyGuard = new SystemProxyGuard(config, auditLogger);
    try {
      await systemProxyGuard.start();
    } catch (err) {
      console.warn('[Main] [WARN] 系统级网络锁定启动遇到异常，继续运行客户端拦截:', err.message);
    }
  }

  // 3. 启动屏幕录制
  if (config.recording?.enabled) {
    screenRecorder = new ScreenRecorder(config);
    screenRecorder.start();
  }

  // 4. 创建主考试窗口
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 应用退出前保存录屏数据、审计报告并恢复网络
app.on('before-quit', async (e) => {
  if (!isCleanedUp) {
    e.preventDefault();
    isCleanedUp = true;
    try {
      await cleanupAllResources();
    } catch (err) {
      console.error('[Main] [ERROR] 清理资源遇到异常:', err);
    }
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
