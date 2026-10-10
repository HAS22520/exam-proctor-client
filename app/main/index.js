const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { ProtectedStore } = require('./device-store');
const { validateConfig } = require('./config-policy');
const { ProctorController } = require('./proctor-controller');
const NetworkGuard = require('./network-guard');
const AntiCheatGuard = require('./anti-cheat');
const FirewallGuard = require('./firewall-guard');
const Updater = require('./updater');

app.setName('HydroProctorClient');
let window, controller, network, antiCheat, firewall, config, trust;
let quitting = false, exiting = false, root = false, debug = false, timer, trustedUrl;
let latestStatus = { phase: 'idle', message: '正在连接 OJ' };
const directory = app.getPath('userData');
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (window) { window.restore(); window.focus(); } });

function loadConfig() {
  trust = JSON.parse(fs.readFileSync(path.join(__dirname, '../generated/trust.json'), 'utf8'));
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '../generated/config.json'), 'utf8'));
  const cache = path.join(directory, 'config', 'exam-config.json');
  if (!fs.existsSync(cache)) return validateConfig(base, trust);
  try {
    const remote = JSON.parse(fs.readFileSync(cache, 'utf8'));
    // Remote config cannot enable debugging or change the compiled trust boundary.
    return validateConfig({ ...base, ...remote, debug: base.debug }, trust);
  } catch { return validateConfig(base, trust); }
}

async function applyIdentity(login) {
  root = !!login?.root && login.uid > 0;
  const next = root && config.debug.allowRoot;
  if (next !== debug) {
    debug = next;
    network.debug = debug;
    if (!debug && !config.exam.allowedOrigins.includes(new URL(window.webContents.getURL()).origin)) {
      window.loadURL(config.exam.targetUrl).catch(() => {});
    }
    if (debug || !login?.uid) { antiCheat.stop(); firewall.unlock(); }
  }
  const uid = login?.uid ?? controller?.current?.login.uid;
  const ongoing = [...(controller?.records.values() || [])].some((record) => record.login.uid === uid && record.journal?.state.phase === 'open');
  const protectedExam = !!uid && (!!login?.proctorEnabled || ongoing) && !debug && !exiting;
  if (protectedExam) {
    if (config.globalFirewallLock?.enabled) firewall.lock();
    antiCheat.start();
  } else { antiCheat.stop(); firewall.unlock(); }
  window.setKiosk(protectedExam && config.window?.kiosk !== false);
  window.setAlwaysOnTop(protectedExam && config.window?.alwaysOnTop !== false);
  if (!debug && window.webContents.isDevToolsOpened()) window.webContents.closeDevTools();
}

function ipcContext(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('IPC requires the exam main frame');
  const url = new URL(event.senderFrame.url);
  if (!config.exam.allowedOrigins.includes(url.origin)) throw new Error('IPC requires a trusted OJ origin');
  return url.href;
}

async function syncLogin() {
  if (exiting || window.isDestroyed()) return;
  const url = window.webContents.getURL();
  if (config.exam.allowedOrigins.includes(new URL(url).origin)) trustedUrl = url;
  if (!trustedUrl) return;
  try {
    await controller.sync(trustedUrl);
    for (const record of controller.records.values()) {
      if (record.login.uid === controller.current?.login.uid && record.journal?.state.phase === 'open') await record.auth.ensure();
    }
    controller.logViolation({ source: 'CLIENT', type: 'MONITOR_HEARTBEAT', target: '', detail: debug ? 'root-debug' : 'exam' });
    await controller.retryUploads();
  } catch { latestStatus.message = '认证失败，请检查登录账号、客户端版本及认证密钥'; }
}

async function requestExit() {
  if (exiting) return;
  exiting = true;
  const { response } = await dialog.showMessageBox(window, { type: 'question', title: '结束监考',
    message: '结束监考并上传日志？', detail: '此操作不会代你提交代码。上传成功后成绩才能有效；断网时日志会保存并在下次登录原账号后补传。',
    buttons: ['继续考试', '结束监考并退出'], defaultId: 0, cancelId: 0 });
  if (response !== 1) { exiting = false; return; }
  clearInterval(timer);
  antiCheat.stop();
  let restored = false;
  try {
    firewall.unlock(); restored = true;
    const uploaded = await controller.finish();
    if (!uploaded) await dialog.showMessageBox(window, { type: 'warning', message: '日志已加密保存，尚未上传',
      detail: '成绩待确认。请保留本机客户端数据，联网后重新打开客户端并登录原考试账号完成补传。' });
    controller.shutdown();
    quitting = true;
    app.quit();
  } catch {
    await dialog.showMessageBox(window, { type: 'error', message: '结束监考失败，请保留客户端数据',
      detail: restored ? '本地日志仍保留，请重试结束监考。' : '系统网络尚未恢复，请重试，或使用随包提供的恢复脚本。' });
    exiting = false;
    timer = setInterval(syncLogin, 15000);
    await syncLogin();
  }
}

app.whenReady().then(async () => {
  config = loadConfig();
  const logger = { logViolation: (item) => controller?.logViolation(item) };
  firewall = new FirewallGuard(config, logger, directory);
  firewall.recover();
  const store = new ProtectedStore(path.join(directory, 'secrets'), safeStorage);
  store.check();
  const updates = new Updater(config, { directory, trust, version: app.getVersion() });
  const journals = path.join(directory, 'journals');
  const hasExam = fs.existsSync(journals) && fs.readdirSync(journals).some((entry) => {
    try { return ['open', 'closing', 'pending-upload'].includes(JSON.parse(fs.readFileSync(path.join(journals, entry, 'state.json'))).phase); }
    catch { return true; }
  });
  if (!hasExam && config.updater.enabled) {
    try { await updates.check(); } catch { latestStatus.message = '更新检查失败，将由 OJ 握手检查客户端版本'; }
    config = loadConfig();
    if (updates.manifest && (updates.installerUrl || updates.minimumBlocked)) {
      const choice = await dialog.showMessageBox({ message: updates.minimumBlocked ? '客户端版本过低，需要更新' : '发现新版监考客户端',
        detail: '请安装与当前系统和架构匹配的完整安装包。当前服务器清单不支持签名 ASAR 自动替换。',
        buttons: updates.installerUrl ? ['稍后', '打开安装包下载地址'] : ['知道了'] });
      if (choice.response === 1) await shell.openExternal(updates.installerUrl);
    }
  }
  window = new BrowserWindow({ width: 1280, height: 800, title: config.exam.title, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), partition: 'persist:hydro-exam',
      nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: true, webSecurity: true } });
  network = new NetworkGuard(config, logger);
  network.install(window);
  antiCheat = new AntiCheatGuard(window, config, logger);
  controller = new ProctorController({ config, directory: journals, protectedStore: store,
    session: window.webContents.session, version: app.getVersion(), onIdentity: applyIdentity,
    onStatus: (status) => { latestStatus = { ...status, debug, root, networkMode: process.platform === 'win32' ? 'windows-firewall' : 'application-allowlist' }; } });
  ipcMain.handle('exam:status', (event) => { ipcContext(event); return { ...latestStatus, debug, root, allowRootDebug: config.debug.allowRoot }; });
  ipcMain.handle('exam:proctor-headers', async (event, request) => {
    const url = ipcContext(event);
    if (updates.minimumBlocked) throw new Error('客户端低于更新清单指定的最低版本，请安装新版');
    return controller.headers(url, request);
  });
  ipcMain.handle('exam:request-quit', async (event) => { ipcContext(event); await requestExit(); });
  ipcMain.handle('exam:retry', async (event) => { await controller.retryManually(ipcContext(event)); });
  ipcMain.handle('exam:debug', async (event) => {
    await controller.sync(ipcContext(event));
    if (!root || !config.debug.allowRoot) throw new Error('只有已验证的 root 账号可以使用调试模式');
    window.webContents.openDevTools({ mode: 'detach' });
    return true;
  });
  const requests = window.webContents.session.webRequest;
  requests.onBeforeSendHeaders((details, callback) => {
    if (details.webContentsId === window.webContents.id && details.method === 'POST'
      && Object.keys(details.requestHeaders).some((key) => key.toLowerCase() === 'x-proctor-token')) controller.inFlight.add(details.id);
    callback({ requestHeaders: details.requestHeaders });
  });
  const settled = (details) => {
    if (controller.inFlight.delete(details.id)) controller.logViolation({ source: 'SUBMISSION', type: 'SUBMISSION_RESPONSE',
      target: details.url, detail: String(details.statusCode || details.error || '') });
  };
  requests.onCompleted(settled);
  requests.onErrorOccurred(settled);
  window.webContents.on('devtools-opened', () => { if (!debug) window.webContents.closeDevTools(); });
  window.webContents.on('did-navigate', () => syncLogin());
  window.webContents.on('did-navigate-in-page', () => syncLogin());
  window.webContents.on('render-process-gone', () => controller.logViolation({ source: 'CLIENT', type: 'RENDERER_CRASH', target: '', detail: '' }));
  window.on('close', (event) => { if (!quitting) { event.preventDefault(); requestExit(); } });
  await window.loadURL(config.exam.targetUrl);
  timer = setInterval(syncLogin, 15000);
}).catch((error) => {
  dialog.showErrorBox('客户端启动失败', error.message);
  try { firewall?.unlock(); } catch { /* Recovery state is retained. */ }
  app.exit(1);
});
app.on('before-quit', (event) => { if (!quitting && window) { event.preventDefault(); requestExit(); } });
process.on('exit', () => { try { firewall?.unlock(); } catch { /* Watchdog retries after process exit. */ } });
