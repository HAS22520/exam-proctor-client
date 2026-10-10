const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ProtectedStore, prepareBootIdentity } = require('./device-store');
const { validateConfig } = require('./config-policy');
const { ProctorController } = require('./proctor-controller');
const NetworkGuard = require('./network-guard');
const AntiCheatGuard = require('./anti-cheat');
const FirewallGuard = require('./firewall-guard');
const Updater = require('./updater');
const ProctorRequestGuard = require('./proctor-request-guard');
const { Diagnostics } = require('./diagnostics');
const DebugConsole = require('./debug-console');
const { resetLogin, observeLogin } = require('./login-session');
const diagnostics = new Diagnostics();
const trace = diagnostics.log.bind(diagnostics);
const debugConsole = new DebugConsole(BrowserWindow);

app.setName('HydroProctorClient');
let window, controller, network, antiCheat, firewall, config, trust, uploadWindow;
let quitting = false, exiting = false, root = false, debug = false, timer, trustedUrl;
let latestStatus = { phase: 'idle', message: '正在连接 OJ' };
let exitReady = false;
let recoveryReady = false;
let debugExpiry = 0, syncing = false, syncRequested = false, lastUploadStage, identityRevision = 0;
let lastTick = Date.now();
diagnostics.log('info', 'startup.process', { platform: process.platform, arch: process.arch });
process.on('uncaughtExceptionMonitor', (error) => diagnostics.error('process.uncaught-exception', error));
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
  const revision = ++identityRevision;
  root = !!login?.root && login.uid > 0;
  const next = root && config.debug.allowRoot && Date.parse(login.expiresAt) > Date.now();
  debugExpiry = next ? Date.parse(login.expiresAt) : 0;
  if (next !== debug) {
    debug = next;
    network.debug = debug;
    if (!debug && !config.exam.allowedOrigins.includes(new URL(window.webContents.getURL()).origin)) {
      window.loadURL(config.exam.targetUrl).catch(() => {});
    }
    trace('info', 'identity.debug-mode', { debug, root });
    if (debug) {
      antiCheat.stop(); window.setKiosk(false); window.setAlwaysOnTop(false);
      await debugConsole.show();
      if (revision !== identityRevision) return;
    } else {
      debugConsole.close();
      if (window.webContents.isDevToolsOpened()) window.webContents.closeDevTools();
    }
  }
  const uid = login?.uid ?? controller?.current?.login.uid;
  const ongoing = [...(controller?.records.values() || [])].some((record) => record.login.uid === uid && record.journal?.state.phase === 'open');
  const protectedExam = !!uid && (!!login?.proctorEnabled || ongoing) && !debug && !exiting;
  if (protectedExam) {
    if (config.globalFirewallLock?.enabled) await firewall.lock();
    if (revision !== identityRevision || exiting) return;
    antiCheat.start();
  } else { antiCheat.stop(); await firewall.unlock(); }
  if (revision !== identityRevision) return;
  window.setKiosk(protectedExam && config.window?.kiosk !== false);
  window.setAlwaysOnTop(protectedExam && config.window?.alwaysOnTop !== false);
  if (!debug && window.webContents.isDevToolsOpened()) window.webContents.closeDevTools();
}

function requireDebug() {
  if (!debug || !root || !config.debug.allowRoot || Date.now() >= debugExpiry) {
    if (debug) applyIdentity(null).catch((error) => diagnostics.error('identity.revoke-failed', error));
    throw new Error('只有有效的已验证 root 身份可以使用调试控制台');
  }
}

function ipcContext(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('IPC requires the exam main frame');
  const url = new URL(event.senderFrame.url);
  if (!config.exam.allowedOrigins.includes(url.origin)) throw new Error('IPC requires a trusted OJ origin');
  return url.href;
}

function uploadContext(event) {
  if (!uploadWindow || event.sender !== uploadWindow.webContents || event.senderFrame !== uploadWindow.webContents.mainFrame
    || event.senderFrame.url !== pathToFileURL(path.join(__dirname, '../status/upload.html')).href) throw new Error('Upload IPC requires the native progress window');
}

function publishStatus(status) {
  latestStatus = { ...status, debug, root, exitReady, networkMode: process.platform === 'win32' ? 'windows-firewall' : 'application-allowlist' };
  if (uploadWindow && !uploadWindow.isDestroyed()) uploadWindow.webContents.send('exam:upload-status', latestStatus);
  if (status.upload) {
    const { phase, percent, sent, total } = status.upload;
    const stage = `${phase}:${Math.floor((percent || 0) / 10)}`;
    if (stage !== lastUploadStage) { trace('info', 'logs.upload-progress', { phase, percent, sent, total }); lastUploadStage = stage; }
  }
}

async function showUploadWindow() {
  exitReady = false;
  uploadWindow = new BrowserWindow({ width: 560, height: 490, minWidth: 430, minHeight: 440, title: '结束监考 · 上传日志',
    parent: window, modal: true, autoHideMenuBar: true, resizable: false,
    webPreferences: { preload: path.join(__dirname, '../status/upload-preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false } });
  uploadWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  uploadWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  uploadWindow.on('close', (event) => { if (!quitting) event.preventDefault(); });
  await uploadWindow.loadFile(path.join(__dirname, '../status/upload.html'));
}

function completeExit() {
  controller.shutdown(); quitting = true; app.quit();
}

async function syncLogin(force = false) {
  if (exiting || window.isDestroyed()) return;
  if (syncing) { if (force) syncRequested = true; return; }
  const url = window.webContents.getURL();
  if (config.exam.allowedOrigins.includes(new URL(url).origin)) trustedUrl = url;
  if (!trustedUrl) return;
  syncing = true;
  try {
    await diagnostics.span('identity.sync', () => controller.sync(trustedUrl, { force }));
    for (const record of controller.records.values()) {
      if (record.login.uid === controller.current?.login.uid && record.journal?.state.phase === 'open') await record.auth.ensure();
    }
    controller.logViolation({ source: 'CLIENT', type: 'MONITOR_HEARTBEAT', target: '', detail: debug ? 'root-debug' : 'exam' });
    await controller.retryUploads();
  } catch (error) {
    diagnostics.error('monitor.failed', error);
    latestStatus.message = '认证失败，请检查登录账号、客户端版本及认证密钥';
  } finally {
    syncing = false;
    if (syncRequested) { syncRequested = false; setTimeout(() => syncLogin(true), 0); }
  }
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
  window.setKiosk(false); window.setAlwaysOnTop(false);
  let restored = false;
  let networkWarning = '';
  try {
    const uploaded = await diagnostics.span('exit.finish-and-upload', () => controller.finish(async () => {
      await showUploadWindow();
      publishStatus({ ...latestStatus, upload: { phase: 'restoring-network', percent: null }, message: '正在恢复系统网络，请稍候；日志随后会自动上传。' });
      try { await diagnostics.span('exit.restore-network', () => firewall.unlock()); restored = true; }
      catch (error) {
        networkWarning = '系统网络尚未确认恢复。守护进程会继续恢复；必要时请以管理员身份运行随包 restore-network.bat。';
        diagnostics.error('exit.network-recovery-deferred', error);
        // Seal evidence and attempt the allowlisted OJ upload even if Windows
        // recovery fails. Do not resume the exam or trigger another UAC loop.
        publishStatus({ ...latestStatus, message: networkWarning });
      }
    }));
    exitReady = true;
    publishStatus({ ...latestStatus, upload: uploaded ? { ...latestStatus.upload, phase: 'complete', percent: 100 }
      : { phase: 'deferred', sent: 0, total: 0, percent: null },
      message: uploaded ? (latestStatus.upload?.empty ? '本次没有需要上传的监考日志，可以退出客户端。' : '日志上传完成，服务端已确认接收。')
        : '日志已加密保存，成绩待确认。联网后请使用原考试账号补传。', networkWarning });
  } catch (error) {
    diagnostics.error('exit.failed', error);
    await dialog.showMessageBox(window, { type: 'error', message: '结束监考失败，请保留客户端数据',
      detail: restored ? '本地日志仍保留，请重试结束监考。' : '系统网络尚未恢复，请重试，或使用随包提供的恢复脚本。' });
    exiting = false;
    // Closing attempts stay closed; retry sealing/upload instead of resuming access.
    controller.finishing = false;
    if (uploadWindow && !uploadWindow.isDestroyed()) { uploadWindow.destroy(); uploadWindow = null; }
    timer = setInterval(() => syncLogin(true), 15000);
    await syncLogin();
  }
}

app.whenReady().then(async () => {
  config = loadConfig();
  if (config.debug.allowRoot) await diagnostics.enable(directory);
  trace('info', 'startup.config-loaded', { version: app.getVersion(), debug: config.debug.allowRoot });
  const logger = { logViolation: (item) => {
    trace('warn', 'guard.event', { source: item.source, type: item.type, url: item.target });
    controller?.logViolation(item);
  } };
  firewall = new FirewallGuard(config, logger, directory, { trace });
  await diagnostics.span('startup.restore-network', () => firewall.recover());
  const bootId = await diagnostics.span('startup.boot-identity', () => prepareBootIdentity());
  if (!bootId) trace('warn', 'startup.boot-identity-unavailable');
  recoveryReady = true;
  const store = new ProtectedStore(path.join(directory, 'secrets'), safeStorage);
  store.check();
  const updates = new Updater(config, { directory, trust, version: app.getVersion() });
  const journals = path.join(directory, 'journals');
  const hasExam = fs.existsSync(journals) && fs.readdirSync(journals).some((entry) => {
    try { return ['open', 'closing', 'pending-upload'].includes(JSON.parse(fs.readFileSync(path.join(journals, entry, 'state.json'))).phase); }
    catch { return true; }
  });
  if (!hasExam && config.updater.enabled) {
    try { await diagnostics.span('startup.update-check', () => updates.check()); } catch { latestStatus.message = '更新检查失败，将由 OJ 握手检查客户端版本'; }
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
  await diagnostics.span('startup.clear-login', () => resetLogin(window.webContents.session));
  network = new NetworkGuard(config, logger);
  network.install(window);
  antiCheat = new AntiCheatGuard(window, config, logger);
  controller = new ProctorController({ config, directory: journals, protectedStore: store,
    session: window.webContents.session, version: app.getVersion(), onIdentity: applyIdentity,
    onStatus: publishStatus, trace });
  let loginTimer;
  observeLogin(window.webContents.session, config.exam.allowedOrigins, () => {
    trace('info', 'identity.login-cookie-changed');
    controller.invalidateIdentity();
    applyIdentity(null).catch((error) => diagnostics.error('identity.revoke-failed', error));
    clearTimeout(loginTimer);
    loginTimer = setTimeout(() => syncLogin(true), 200);
  });
  ipcMain.handle('exam:status', (event) => { ipcContext(event); return { ...latestStatus, debug, root, allowRootDebug: config.debug.allowRoot }; });
  ipcMain.handle('exam:proctor-headers', async (event, request) => {
    const url = ipcContext(event);
    if (updates.minimumBlocked) throw new Error('客户端低于更新清单指定的最低版本，请安装新版');
    return controller.headers(url, request);
  });
  ipcMain.handle('exam:request-quit', async (event) => { ipcContext(event); await requestExit(); });
  ipcMain.handle('exam:retry', async (event) => { await controller.retryManually(ipcContext(event)); });
  ipcMain.handle('exam:upload-status', (event) => { uploadContext(event); return latestStatus; });
  ipcMain.handle('exam:upload-exit', (event) => { uploadContext(event); if (!exitReady) throw new Error('日志仍在处理中'); completeExit(); });
  ipcMain.handle('exam:debug', async (event) => {
    await controller.sync(ipcContext(event), { force: true });
    if (!root || !config.debug.allowRoot) throw new Error('只有已验证的 root 账号可以使用调试模式');
    requireDebug();
    await debugConsole.show();
    return true;
  });
  ipcMain.handle('exam:debug-logs', (event, after) => {
    debugConsole.context(event); requireDebug();
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid debug cursor');
    return diagnostics.snapshot(after);
  });
  ipcMain.handle('exam:debug-devtools', (event) => {
    debugConsole.context(event); requireDebug();
    window.webContents.openDevTools({ mode: 'detach' });
  });
  const requests = window.webContents.session.webRequest;
  const requestMethods = new Map();
  const requestGuard = new ProctorRequestGuard(controller, config, window.webContents, () => updates.minimumBlocked);
  requests.onBeforeSendHeaders((details, callback) => {
    requestGuard.headers(details).then((headers) => {
      if (details.webContentsId === window.webContents.id && Object.keys(headers).some((key) => key.toLowerCase() === 'x-proctor-token')) {
        controller.inFlight.add(details.id); requestMethods.set(details.id, details.method);
      }
      callback({ requestHeaders: headers });
    }).catch((error) => {
      diagnostics.error('request.blocked', error, { method: details.method, url: details.url });
      callback({ cancel: true });
    });
  });
  const settled = (details) => {
    const read = requestMethods.get(details.id) === 'GET'; requestMethods.delete(details.id);
    const failure = details.error && details.error !== 'net::OK' ? details.error : undefined;
    if (failure || details.statusCode >= 400) trace(failure ? 'error' : 'warn', 'request.response',
      { url: details.url, status: details.statusCode, message: failure });
    if (controller.inFlight.delete(details.id)) controller.logViolation({ source: read ? 'ACCESS' : 'SUBMISSION', type: read ? 'ACCESS_RESPONSE' : 'SUBMISSION_RESPONSE',
      target: details.url, detail: String(details.statusCode || details.error || '') });
  };
  requests.onCompleted(settled);
  requests.onErrorOccurred(settled);
  window.webContents.on('devtools-opened', () => { if (!debug) window.webContents.closeDevTools(); });
  window.webContents.on('did-navigate', () => syncLogin());
  window.webContents.on('did-navigate-in-page', () => syncLogin());
  window.on('unresponsive', () => trace('error', 'window.unresponsive'));
  window.on('responsive', () => trace('info', 'window.responsive'));
  window.webContents.on('did-fail-load', (_event, code, message, url) => trace('error', 'page.load-failed', { code, message, url }));
  window.webContents.on('render-process-gone', (_event, details) => {
    trace('error', 'renderer.crashed', { reason: details?.reason, exitCode: details?.exitCode });
    controller.logViolation({ source: 'CLIENT', type: 'RENDERER_CRASH', target: '', detail: '' });
  });
  window.on('close', (event) => { if (!quitting) { event.preventDefault(); requestExit(); } });
  await diagnostics.span('startup.load-exam', () => window.loadURL(config.exam.targetUrl));
  trace('info', 'startup.ready');
  lastTick = Date.now();
  setInterval(() => {
    const now = Date.now(), delay = now - lastTick - 1000; lastTick = now;
    if (delay > 2000) trace('warn', 'main.event-loop-delayed', { durationMs: delay });
    if (debug && now >= debugExpiry) applyIdentity(null).catch((error) => diagnostics.error('identity.revoke-failed', error));
  }, 1000);
  timer = setInterval(() => syncLogin(true), 15000);
}).catch(async (error) => {
  diagnostics.error('startup.failed', error);
  dialog.showErrorBox('客户端启动失败', error.message);
  try { if (recoveryReady) await firewall?.unlock(); } catch (restoreError) { diagnostics.error('startup.restore-failed', restoreError); }
  await diagnostics.pending;
  app.exit(1);
});
app.on('before-quit', (event) => { if (!quitting && window) { event.preventDefault(); requestExit(); } });
// Normal exit awaits restoration in requestExit. Forced exit is covered by the elevated watchdog;
// asynchronous subprocesses cannot be awaited from Node's exit event.
