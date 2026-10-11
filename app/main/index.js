const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ProtectedStore, prepareBootIdentity } = require('./device-store');
const { validateConfig } = require('./config-policy');
const { ProctorController } = require('./proctor-controller');
const { proctorErrorMessage } = require('./proctor-auth');
const NetworkGuard = require('./network-guard');
const AntiCheatGuard = require('./anti-cheat');
const FirewallGuard = require('./firewall-guard');
const Updater = require('./updater');
const ProctorRequestGuard = require('./proctor-request-guard');
const { Diagnostics } = require('./diagnostics');
const DebugConsole = require('./debug-console');
const ActivityProgress = require('./activity-progress');
const WaitingWindow = require('./waiting-window');
const { resetLogin, observeLogin } = require('./login-session');
const { runtime } = require('./runtime');
const { hasUnfinishedJournals } = require('./update-cache');
const running = runtime(app);
const diagnostics = new Diagnostics();
const activity = new ActivityProgress({ onChange: publishActivity });
const waitingWindow = new WaitingWindow(BrowserWindow);
const trace = (level, event, details = {}) => {
  diagnostics.log(level, event, details);
  if (event === 'firewall.stage') activity.stage('network', details.phase);
  if (event === 'protocol.request') {
    const stage = details.url?.endsWith('/proctor/identity') ? 'identity' : details.operation;
    if (['identity', 'challenge', 'handshake', 'refresh'].includes(stage)) activity.stage('auth', stage);
  }
};
const debugConsole = new DebugConsole(BrowserWindow);

app.setName('HydroProctorClient');
let window, controller, network, antiCheat, firewall, config, trust, uploadWindow, updates;
let quitting = false, exiting = false, root = false, debug = false, timer, trustedUrl;
let latestStatus = { phase: 'idle', message: '正在连接 OJ' };
let exitReady = false;
let dialogDepth = 0, protectedFocus = false;
let recoveryReady = false;
let debugExpiry = 0, syncing = false, syncRequested = false, lastUploadStage, identityRevision = 0;
let lastTick = Date.now();
let preparationTimer;
diagnostics.log('info', 'startup.process', { platform: process.platform, arch: process.arch });
process.on('uncaughtExceptionMonitor', (error) => diagnostics.error('process.uncaught-exception', error));
const directory = app.getPath('userData');
if (!running.singleInstanceLocked && !app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  // A native message box owns focus until it resolves. Never refocus its parent.
  if (dialogDepth) return;
  const target = uploadWindow && !uploadWindow.isDestroyed() ? uploadWindow : window || waitingWindow.window;
  if (target && !target.isDestroyed()) { target.restore(); target.show(); target.focus(); }
});

function applyWindowFocus() {
  if (!window || window.isDestroyed()) return;
  const enabled = protectedFocus && !dialogDepth && !exiting;
  if (enabled) antiCheat.start(); else antiCheat.stop();
  const enforce = enabled && process.platform !== 'darwin';
  window.setKiosk(enforce && config.window?.kiosk !== false);
  window.setAlwaysOnTop(enforce && config.window?.alwaysOnTop !== false);
}

async function showExamDialog(options, owner = window) {
  dialogDepth++;
  try {
    // Remove blur/refocus listeners before the native dialog can blur its parent.
    applyWindowFocus();
    owner.restore(); owner.show(); owner.focus();
    return await dialog.showMessageBox(owner, options);
  } finally {
    dialogDepth--;
    applyWindowFocus();
  }
}

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
      if (!dialogDepth && !exiting) await debugConsole.show();
      if (revision !== identityRevision) return;
    } else {
      debugConsole.close();
      if (window.webContents.isDevToolsOpened()) window.webContents.closeDevTools();
    }
  }
  const uid = login?.uid ?? controller?.current?.login.uid;
  const ongoing = [...(controller?.records.values() || [])].some((record) => record.login.uid === uid && record.journal?.state.phase === 'open');
  const activeRecord = controller?.current;
  const closed = !!activeRecord && activeRecord.login.uid === uid && (activeRecord.completed
    || !!activeRecord.journal && activeRecord.journal.state.phase !== 'open');
  protectedFocus = !!uid && ((!!login?.proctorEnabled && !closed) || ongoing) && !debug;
  const protectedExam = protectedFocus && !exiting;
  if (protectedExam) {
    if (config.globalFirewallLock?.enabled) {
      try { await firewall.lock(); }
      catch (error) {
        publishStatus({ ...latestStatus, authenticated: false, phase: 'network-error', message: error.message });
        throw error;
      }
    }
    if (revision !== identityRevision || exiting) return;
  } else { antiCheat.stop(); await firewall.unlock(); }
  if (revision !== identityRevision) return;
  applyWindowFocus();
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
  latestStatus = { ...status, activity: activity.snapshot(), update: updates?.snapshot(), debug, root, exitReady, networkMode: firewall?.mode || 'unavailable' };
  if (uploadWindow && !uploadWindow.isDestroyed()) uploadWindow.webContents.send('exam:upload-status', latestStatus);
  if (status.upload) {
    const { phase, percent, sent, total } = status.upload;
    const stage = `${phase}:${Math.floor((percent || 0) / 10)}`;
    if (stage !== lastUploadStage) { trace('info', 'logs.upload-progress', { phase, percent, sent, total }); lastUploadStage = stage; }
  }
}

function publishActivity(status) {
  latestStatus.activity = status;
  waitingWindow.publish(status);
  if (window && !window.isDestroyed()) window.webContents.send('exam:activity-status', status);
  if (uploadWindow && !uploadWindow.isDestroyed()) uploadWindow.webContents.send('exam:upload-status', { ...latestStatus, activity: status });
}

async function showUploadWindow() {
  exitReady = false;
  uploadWindow = new BrowserWindow({ width: 560, height: 600, useContentSize: true, minWidth: 430, minHeight: 560, title: '结束监考 · 上传日志',
    parent: window, modal: true, show: false, minimizable: false, fullscreenable: false, autoHideMenuBar: true, resizable: false,
    webPreferences: { preload: path.join(__dirname, '../status/upload-preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false } });
  uploadWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  uploadWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  uploadWindow.on('close', (event) => { if (!quitting) event.preventDefault(); });
  await uploadWindow.loadFile(path.join(__dirname, '../status/upload.html'));
  uploadWindow.show(); uploadWindow.focus();
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
      if (record.login.uid === controller.current?.login.uid && record.journal?.state.phase === 'open') await activity.run('auth', 'refresh', () => record.auth.ensure());
    }
    controller.logViolation({ source: 'CLIENT', type: 'MONITOR_HEARTBEAT', target: '', detail: debug ? 'root-debug' : process.platform === 'darwin' ? 'macos-audit-only' : 'exam' });
    await controller.retryUploads();
  } catch (error) {
    diagnostics.error('monitor.failed', error, { version: running.identity.version });
    if (latestStatus.phase !== 'network-error') latestStatus.message = proctorErrorMessage(error, running.identity.version);
  } finally {
    syncing = false;
    if (syncRequested) { syncRequested = false; setTimeout(() => syncLogin(true), 0); }
  }
}

async function requestExit() {
  if (exiting) return;
  exiting = true;
  let response;
  try {
    const choice = await showExamDialog({ type: 'question', title: '结束监考',
      message: '退出客户端还是结束监考？', detail: '此操作不会代你提交代码。保留日志退出可在下次登录原账号后续写、继续做题，不会结束监考。上传成功后成绩才能有效；选择结束监考后无法继续本场比赛，断网时可补传。',
      buttons: ['继续考试', '保留日志退出', '上传日志并结束监考'], defaultId: 0, cancelId: 0 });
    response = choice.response;
  } catch (error) {
    diagnostics.error('exit.prompt-failed', error);
    exiting = false; applyWindowFocus(); return;
  }
  if (![1, 2].includes(response)) { exiting = false; applyWindowFocus(); return; }
  firewall.cancelPendingLock?.();
  clearInterval(timer);
  antiCheat.stop();
  window.setKiosk(false); window.setAlwaysOnTop(false);
  if (response === 1) {
    try {
      await diagnostics.span('exit.pause', () => activity.run('exit', 'pause', () => controller.pause()));
      try { await diagnostics.span('exit.restore-network', () => firewall.unlock()); }
      catch (error) { diagnostics.error('exit.network-recovery-deferred', error);
        await showExamDialog({ type: 'warning', message: '日志已保留，系统网络尚未确认恢复',
          detail: '守护进程会继续恢复。必要时请以管理员身份运行随包 restore-network.bat；保留客户端数据。' }); }
      completeExit();
    } catch (error) {
      diagnostics.error('exit.pause-failed', error); exiting = false; controller.finishing = false;
      timer = setInterval(() => syncLogin(true), 15000);
      await syncLogin(); applyWindowFocus();
    }
    return;
  }
  let restored = false;
  let networkWarning = '';
  try {
    const uploaded = await diagnostics.span('exit.finish-and-upload', () => controller.finish(async () => {
      await showUploadWindow();
      const auditOnly = process.platform === 'darwin';
      publishStatus({ ...latestStatus, upload: { phase: auditOnly ? 'preparing' : 'restoring-network', percent: null },
        message: auditOnly ? '正在准备加密日志，随后自动上传。' : '正在恢复系统网络，请稍候；日志随后会自动上传。' });
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
    await showExamDialog({ type: 'error', message: '结束监考失败，请保留客户端数据',
      detail: restored ? '本地日志仍保留，请重试结束监考。' : '系统网络尚未恢复，请重试，或使用随包提供的恢复脚本。' }, uploadWindow && !uploadWindow.isDestroyed() ? uploadWindow : window);
    exiting = false;
    // Closing attempts stay closed; retry sealing/upload instead of resuming access.
    controller.finishing = false;
    if (uploadWindow && !uploadWindow.isDestroyed()) { uploadWindow.destroy(); uploadWindow = null; }
    timer = setInterval(() => syncLogin(true), 15000);
    await syncLogin();
    applyWindowFocus();
  }
}

app.whenReady().then(async () => {
  // Check the process token before loading the OJ, recovering old rules or
  // opening protected windows. No automatic PowerShell elevation is used.
  const privilegeGuard = new FirewallGuard({}, null, directory);
  try { await privilegeGuard.checkPrivileges(); }
  catch (error) {
    privilegeGuard.close();
    if (error.code !== 'ADMIN_REQUIRED') throw error;
    await dialog.showMessageBox({ type: 'warning', title: '需要管理员权限', message: '请使用管理员模式打开监考客户端',
      detail: error.message, buttons: ['关闭软件'], defaultId: 0, cancelId: 0 });
    quitting = true; app.exit(1); return;
  }
  privilegeGuard.close();
  config = loadConfig();
  ipcMain.handle('exam:waiting-status', (event) => { waitingWindow.context(event); return activity.snapshot(); });
  // Show a native status window only when preparation takes long enough to be
  // noticeable. Network recovery still finishes before any OJ page is loaded.
  preparationTimer = setTimeout(() => waitingWindow.show().catch((error) => diagnostics.error('startup.progress-failed', error)), 350);
  if (config.debug.allowRoot) await diagnostics.enable(directory);
  trace('info', 'startup.config-loaded', { ...running.identity, source: running.source, debug: config.debug.allowRoot });
  const logger = { logViolation: (item) => {
    trace('warn', 'guard.event', { source: item.source, type: item.type, url: item.target });
    controller?.logViolation(item);
  } };
  firewall = new FirewallGuard(config, logger, directory, { trace, activity: activity.run.bind(activity),
    onFailure: (error) => {
      diagnostics.error('firewall.protection-lost', error);
      controller?.invalidateIdentity();
      publishStatus({ ...latestStatus, authenticated: false, message: error.message });
    } });
  await diagnostics.span('startup.restore-network', () => firewall.recover());
  const bootId = await diagnostics.span('startup.boot-identity', () => activity.run('startup', 'boot-identity', () => prepareBootIdentity()));
  if (!bootId) trace('warn', 'startup.boot-identity-unavailable');
  recoveryReady = true;
  const store = new ProtectedStore(path.join(directory, 'secrets'), safeStorage);
  store.check();
  updates = new Updater(config, { directory, trust, ...running.identity, source: running.source, failure: running.failure, cache: running.cache,
    onStatus: (update) => { latestStatus.update = update; trace('info', 'update.status', { phase: update.phase, message: update.message }); } });
  const journals = path.join(directory, 'journals');
  window = new BrowserWindow({ width: 1280, height: 800, title: config.exam.title, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), partition: 'persist:hydro-exam',
      nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: true, webSecurity: true } });
  await diagnostics.span('startup.clear-login', () => resetLogin(window.webContents.session));
  network = new NetworkGuard(config, logger);
  network.install(window);
  antiCheat = new AntiCheatGuard(window, config, logger);
  controller = new ProctorController({ config, directory: journals, protectedStore: store,
    session: window.webContents.session, version: running.identity.version, onIdentity: applyIdentity,
    onStatus: publishStatus, trace, activity: activity.run.bind(activity) });
  let loginTimer;
  observeLogin(window.webContents.session, config.exam.allowedOrigins, () => {
    trace('info', 'identity.login-cookie-changed');
    controller.invalidateIdentity();
    applyIdentity(null).catch((error) => diagnostics.error('identity.revoke-failed', error));
    clearTimeout(loginTimer);
    loginTimer = setTimeout(() => syncLogin(true), 200);
  });
  ipcMain.handle('exam:status', (event) => { ipcContext(event); return { ...latestStatus, activity: activity.snapshot(), update: updates.snapshot(), debug, root, allowRootDebug: config.debug.allowRoot }; });
  ipcMain.handle('exam:update-check', async (event) => {
    ipcContext(event); if (!config.updater.enabled) throw new Error('更新功能未启用');
    await updates.check({ force: true }); return updates.snapshot();
  });
  ipcMain.handle('exam:update-install', async (event) => {
    ipcContext(event); if (!config.updater.enabled) throw new Error('更新功能未启用');
    if (exiting || hasUnfinishedJournals(directory)) throw new Error('请先上传日志并结束所有监考，再更新客户端');
    await updates.stage();
    const choice = await showExamDialog({ type: 'question', message: 'ASAR 更新已通过验证',
      detail: '现在重启以应用更新？重启后需要重新登录。', buttons: ['稍后重启', '立即重启'], defaultId: 0, cancelId: 0 });
    if (choice.response === 1) {
      if (exiting || hasUnfinishedJournals(directory)) throw new Error('监考已开始，更新将在结束监考后重启生效');
      await firewall.unlock(); controller.shutdown(); quitting = true; app.relaunch(); app.quit();
    }
    return updates.snapshot();
  });
  ipcMain.handle('exam:update-download', async (event) => {
    ipcContext(event); if (!config.updater.enabled || !updates.installerUrl) throw new Error('清单没有当前平台的安装包地址');
    await shell.openExternal(updates.installerUrl);
  });
  ipcMain.handle('exam:proctor-headers', async (event, request) => {
    const url = ipcContext(event);
    if (updates.minimumBlocked) throw new Error('客户端低于更新清单指定的最低版本，请安装新版');
    try { return await controller.headers(url, request); }
    catch (error) {
      // Electron IPC serializes Error.message, but drops publicMessage and code.
      if (error.publicMessage) throw new Error(proctorErrorMessage(error, running.identity.version));
      throw error;
    }
  });
  ipcMain.handle('exam:request-quit', async (event) => { ipcContext(event); await requestExit(); });
  ipcMain.handle('exam:retry', async (event) => { await controller.retryManually(ipcContext(event)); });
  ipcMain.handle('exam:upload-status', (event) => { uploadContext(event); return { ...latestStatus, activity: activity.snapshot() }; });
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
  await diagnostics.span('startup.load-exam', () => activity.run('startup', 'load-exam', () => window.loadURL(config.exam.targetUrl)));
  trace('info', 'startup.ready');
  clearTimeout(preparationTimer); waitingWindow.close();
  running.markReady();
  if (running.failure) trace('warn', 'update.rollback', running.failure);
  // Fetching a manifest must never delay login/contest authentication.
  if (config.updater.enabled) setTimeout(() => diagnostics.span('startup.update-check', () => updates.check())
    .catch((error) => diagnostics.error('update.check-failed', error)), 0);
  lastTick = Date.now();
  setInterval(() => {
    const now = Date.now(), delay = now - lastTick - 1000; lastTick = now;
    if (delay > 2000) trace('warn', 'main.event-loop-delayed', { durationMs: delay });
    if (debug && now >= debugExpiry) applyIdentity(null).catch((error) => diagnostics.error('identity.revoke-failed', error));
  }, 1000);
  timer = setInterval(() => syncLogin(true), 15000);
}).catch(async (error) => {
  clearTimeout(preparationTimer); waitingWindow.close();
  diagnostics.error('startup.failed', error);
  dialog.showErrorBox('客户端启动失败', error.message);
  try { if (recoveryReady) await firewall?.unlock(); } catch (restoreError) { diagnostics.error('startup.restore-failed', restoreError); }
  await diagnostics.pending;
  app.exit(1);
});
app.on('before-quit', (event) => { if (!quitting && window) { event.preventDefault(); requestExit(); } });
app.on('will-quit', () => firewall?.close());
// Normal exit awaits restoration in requestExit. Forced exit is covered by the elevated watchdog;
// asynchronous subprocesses cannot be awaited from Node's exit event.
