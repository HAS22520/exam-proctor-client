const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { pathToFileURL } = require('node:url');
const { workspace } = require('./helpers');

async function fixture(t, options = {}) {
  const directory = workspace(t), handlers = new Map(), windows = [], choices = [];
  let quitCount = 0, shutdownCount = 0, finishCalled, releaseFinish;
  let recoverCount = 0, exitCount = 0, controller, antiCheatStarts = 0, lockCalled, releaseLock;
  const errors = [], exitHooks = [], startupSteps = [], requestEvents = new Map();
  let ready;
  const initialized = new Promise((resolve) => { ready = resolve; });
  const locking = new Promise((resolve) => { lockCalled = resolve; });
  const locked = new Promise((resolve) => { releaseLock = resolve; });
  const started = new Promise((resolve) => { finishCalled = resolve; });
  const finished = new Promise((resolve) => { releaseFinish = resolve; });
  const app = new EventEmitter();
  Object.assign(app, { setName: () => {}, getPath: () => directory, getVersion: () => '1.0.0', requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), quit: () => { quitCount++; }, exit: (code) => {
      if (!options.recoveryError) assert.fail('app must not exit during initialization');
      assert.equal(code, 1); exitCount++; ready();
    } });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new EventEmitter(); this.sent = [];
      Object.assign(this.webContents, { id: windows.length + 1, mainFrame: { url: '' },
        session: { clearStorageData: async () => { startupSteps.push('clear-storage'); }, clearAuthCache: async () => { startupSteps.push('clear-auth'); },
          cookies: Object.assign(new EventEmitter(), { flushStore: async () => { startupSteps.push('flush-cookies'); } }),
          webRequest: { onBeforeSendHeaders: () => {}, onCompleted: (callback) => requestEvents.set('completed', callback),
            onErrorOccurred: (callback) => requestEvents.set('error', callback), onBeforeRequest: () => {} } },
        setWindowOpenHandler: () => {}, send: (channel, value) => this.sent.push({ channel, value }),
        isDevToolsOpened: () => false, closeDevTools: () => {}, openDevTools: () => {}, getURL: () => this.webContents.mainFrame.url });
      windows.push(this);
    }
    async loadURL(url) { startupSteps.push('load-page'); this.webContents.mainFrame.url = url; ready(); }
    async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    show() {} focus() {}
    setKiosk(value) { this.kiosk = value; }
    setAlwaysOnTop() {}
  }
  const config = { exam: { targetUrl: 'https://oj.example.com/d/exam/', allowedOrigins: ['https://oj.example.com'] },
    updater: { enabled: false }, debug: { allowRoot: !!options.debug }, globalFirewallLock: { enabled: !!options.delayLock } };
  class Controller {
    constructor(options) { controller = this; this.options = options; this.records = new Map(); this.inFlight = new Set(); this.finishing = false; }
    logViolation() {}
    async finish(beforeFinish = async () => {}) {
      this.finishing = true;
      await beforeFinish();
      this.options.onStatus({ finishing: true, upload: { phase: 'uploading', percent: 50, sent: 100, total: 200 } });
      finishCalled(); return finished;
    }
    shutdown() { shutdownCount++; }
  }
  class Guard {
    recover() { recoverCount++; if (options.recoveryError) throw options.recoveryError; }
    check() {} install() {} start() { antiCheatStarts++; } stop() {}
    lock() { lockCalled(); return locked; }
    unlock() { if (options.exitRecoveryError) throw options.exitRecoveryError; this.recover(); }
  }
  const mocks = {
    electron: { app, BrowserWindow, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
      dialog: { showMessageBox: async (owner, options) => { choices.push(options); return { response: 1 }; }, showErrorBox: (title, message) => {
        if (!options.recoveryError) assert.fail('startup error');
        errors.push({ title, message });
      } } },
    'node:fs': { ...fs, readFileSync: (file, ...args) => String(file).endsWith('/generated/config.json') || String(file).endsWith('\\generated\\config.json')
      ? JSON.stringify(config) : String(file).endsWith('trust.json') ? '{}' : fs.readFileSync(file, ...args) },
    './config-policy': { validateConfig: (value) => value }, './device-store': { ProtectedStore: Guard, prepareBootIdentity: async () => 'boot-id' },
    './proctor-controller': { ProctorController: Controller }, './network-guard': Guard, './anti-cheat': Guard,
    './firewall-guard': Guard, './updater': Guard, './proctor-request-guard': Guard,
    './login-session': require('../app/main/login-session'),
    './diagnostics': require('../app/main/diagnostics'), './debug-console': require('../app/main/debug-console'),
  };
  const source = path.resolve(__dirname, '../app/main/index.js');
  runInNewContext(fs.readFileSync(source, 'utf8'), { URL, __dirname: path.dirname(source), require: (name) => mocks[name] || require(name),
    process: { platform: 'darwin', on: (name, callback) => { if (name === 'exit') exitHooks.push(callback); } }, setInterval: () => 1, clearInterval: () => {}, setTimeout, clearTimeout });
  await initialized;
  await new Promise((resolve) => setImmediate(resolve));
  const event = (owner) => ({ sender: owner.webContents, senderFrame: owner.webContents.mainFrame });
  return { handlers, windows, choices, controller, errors, exitHooks, startupSteps, requestEvents, started, releaseFinish, locking, releaseLock, event,
    get antiCheatStarts() { return antiCheatStarts; }, get quitCount() { return quitCount; },
    get shutdownCount() { return shutdownCount; }, get recoverCount() { return recoverCount; }, get exitCount() { return exitCount; } };
}

test('ending requires explicit log reminder and only the native main frame can exit after receipt', async (t) => {
  const f = await fixture(t), main = f.windows[0];
  const ending = f.handlers.get('exam:request-quit')(f.event(main));
  await f.started;
  const upload = f.windows[1];
  assert.match(f.choices[0].detail, /上传成功后成绩才能有效/);
  assert.equal(upload.options.webPreferences.sandbox, true); assert.equal(upload.options.webPreferences.nodeIntegration, false);
  const read = f.handlers.get('exam:upload-status'), exit = f.handlers.get('exam:upload-exit');
  assert.equal(read(f.event(upload)).upload.percent, 50);
  assert.throws(() => exit(f.event(upload)), /处理中/);
  assert.throws(() => exit(f.event(main)), /native progress window/);
  assert.throws(() => read({ sender: upload.webContents, senderFrame: { url: upload.webContents.mainFrame.url } }), /native progress window/);
  f.releaseFinish(true); await ending;
  assert.equal(read(f.event(upload)).exitReady, true); assert.equal(read(f.event(upload)).upload.phase, 'complete');
  assert.equal(f.quitCount, 0); // Keep the completion visible until the user's confirmation.
  exit(f.event(upload)); assert.equal(f.quitCount, 1); assert.equal(f.shutdownCount, 1);
});

test('every startup clears login and flushes cookies before navigating to the OJ', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.startupSteps, ['clear-storage', 'clear-auth', 'flush-cookies', 'load-page']);
});

test('failed exit recovery still processes logs and displays a network warning after upload', async (t) => {
  const f = await fixture(t, { exitRecoveryError: new Error('Firewall service stopped') });
  const ending = f.handlers.get('exam:request-quit')(f.event(f.windows[0]));
  await f.started;
  assert.equal(f.controller.finishing, true);
  f.releaseFinish(true); await ending;
  const status = f.handlers.get('exam:upload-status')(f.event(f.windows[1]));
  assert.equal(status.exitReady, true); assert.equal(status.upload.phase, 'complete');
  assert.match(status.networkWarning, /网络尚未确认恢复/);
  assert.equal(f.choices.length, 1);
  f.handlers.get('exam:upload-exit')(f.event(f.windows[1])); assert.equal(f.quitCount, 1);
});

test('successful net::OK responses do not become errors, while HTTP rejection remains visible', async (t) => {
  const f = await fixture(t, { debug: true });
  const settled = f.requestEvents.get('completed');
  settled({ id: 1, url: 'https://oj.example.com/assets/page.js', statusCode: 200, error: 'net::OK' });
  settled({ id: 2, url: 'https://oj.example.com/contest/blocked', statusCode: 403, error: 'net::OK' });
  await f.controller.options.onIdentity({ uid: 1, root: true, expiresAt: new Date(Date.now() + 60000).toISOString() });
  const console = f.windows[1];
  const entries = f.handlers.get('exam:debug-logs')(f.event(console), 0).entries.filter((entry) => entry.event === 'request.response');
  assert.equal(entries.length, 1); assert.equal(entries[0].level, 'warn'); assert.equal(entries[0].data.status, 403);
});

test('offline finish displays retained logs and allows native exit without claiming upload success', async (t) => {
  const f = await fixture(t), ending = f.handlers.get('exam:request-quit')(f.event(f.windows[0]));
  await f.started; f.releaseFinish(false); await ending;
  const status = f.handlers.get('exam:upload-status')(f.event(f.windows[1]));
  assert.equal(status.upload.phase, 'deferred'); assert.equal(status.upload.percent, null);
  assert.match(status.message, /成绩待确认/); assert.match(status.message, /原考试账号补传/);
  f.handlers.get('exam:upload-exit')(f.event(f.windows[1])); assert.equal(f.quitCount, 1);
});

test('cancelled startup recovery reports failure once and does not repeatedly elevate during exit', async (t) => {
  const error = new Error('无法恢复监考网络设置，请允许 Windows 管理员授权。');
  const f = await fixture(t, { recoveryError: error });
  assert.equal(f.recoverCount, 1); assert.equal(f.exitCount, 1); assert.equal(f.windows.length, 0);
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].message, error.message);
  for (const hook of f.exitHooks) hook();
  assert.equal(f.recoverCount, 1);
});

test('only signed root debug opens the native console and logout revokes its IPC', async (t) => {
  const f = await fixture(t, { debug: true });
  const login = { uid: 1, root: false, expiresAt: new Date(Date.now() + 60000).toISOString() };
  await f.controller.options.onIdentity(login);
  assert.equal(f.windows.length, 1);
  await f.controller.options.onIdentity({ ...login, root: true });
  const console = f.windows[1], read = f.handlers.get('exam:debug-logs');
  assert.equal(console.options.webPreferences.sandbox, true);
  assert.equal(console.options.webPreferences.nodeIntegration, false);
  const history = read(f.event(console), 0);
  assert.ok(history.entries.some((entry) => entry.event === 'startup.ready'));
  assert.ok(history.file.endsWith('.log'));
  assert.throws(() => read(f.event(f.windows[0]), 0), /native console/);
  assert.throws(() => read({ sender: console.webContents, senderFrame: { url: console.webContents.mainFrame.url } }, 0), /native console/);
  assert.throws(() => read(f.event(console), -1), /cursor/);
  await f.controller.options.onIdentity(null);
  assert.equal(console.isDestroyed(), true);
  assert.throws(() => read(f.event(console), 0), /native console/);
});

test('console requires build opt-in and a root identity that has not expired', async (t) => {
  const disabled = await fixture(t);
  await disabled.controller.options.onIdentity({ uid: 1, root: true, expiresAt: new Date(Date.now() + 60000).toISOString() });
  assert.equal(disabled.windows.length, 1);
  const f = await fixture(t, { debug: true });
  await f.controller.options.onIdentity({ uid: 1, root: true, expiresAt: new Date(Date.now() - 1).toISOString() });
  assert.equal(f.windows.length, 1);
  await f.controller.options.onIdentity({ uid: 1, root: true, expiresAt: new Date(Date.now() + 50).toISOString() });
  const console = f.windows[1];
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.throws(() => f.handlers.get('exam:debug-logs')(f.event(console), 0), /有效/);
  assert.equal(console.isDestroyed(), true);
});

test('an older identity waiting for firewall cannot reenable kiosk after switching to root debug', async (t) => {
  const f = await fixture(t, { debug: true, delayLock: true });
  const applying = f.controller.options.onIdentity({ uid: 2, root: false, proctorEnabled: true });
  await f.locking;
  await f.controller.options.onIdentity({ uid: 1, root: true, expiresAt: new Date(Date.now() + 60000).toISOString() });
  f.releaseLock(); await applying;
  assert.equal(f.antiCheatStarts, 0); assert.equal(f.windows[0].kiosk, false);
  assert.equal(f.windows.length, 2);
});
