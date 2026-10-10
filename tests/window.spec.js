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
  let recoverCount = 0, exitCount = 0;
  const errors = [], exitHooks = [];
  const started = new Promise((resolve) => { finishCalled = resolve; });
  const finished = new Promise((resolve) => { releaseFinish = resolve; });
  const app = new EventEmitter();
  Object.assign(app, { setName: () => {}, getPath: () => directory, getVersion: () => '1.0.0', requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), quit: () => { quitCount++; }, exit: (code) => {
      if (!options.recoveryError) assert.fail('app must not exit during initialization');
      assert.equal(code, 1); exitCount++;
    } });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new EventEmitter(); this.sent = [];
      Object.assign(this.webContents, { id: windows.length + 1, mainFrame: { url: '' },
        session: { webRequest: { onBeforeSendHeaders: () => {}, onCompleted: () => {}, onErrorOccurred: () => {} } },
        setWindowOpenHandler: () => {}, send: (channel, value) => this.sent.push({ channel, value }),
        isDevToolsOpened: () => false, getURL: () => this.webContents.mainFrame.url });
      windows.push(this);
    }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
    async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    isDestroyed() { return false; }
    setKiosk() {}
    setAlwaysOnTop() {}
  }
  const config = { exam: { targetUrl: 'https://oj.example.com/d/exam/', allowedOrigins: ['https://oj.example.com'] },
    updater: { enabled: false }, debug: { allowRoot: false } };
  class Controller {
    constructor(options) { this.options = options; this.records = new Map(); this.finishing = false; }
    async finish() {
      this.finishing = true;
      this.options.onStatus({ finishing: true, upload: { phase: 'uploading', percent: 50, sent: 100, total: 200 } });
      finishCalled(); return finished;
    }
    shutdown() { shutdownCount++; }
  }
  class Guard {
    recover() { recoverCount++; if (options.recoveryError) throw options.recoveryError; }
    check() {} install() {} start() {} stop() {}
    unlock() { this.recover(); }
  }
  const mocks = {
    electron: { app, BrowserWindow, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
      dialog: { showMessageBox: async (owner, options) => { choices.push(options); return { response: 1 }; }, showErrorBox: (title, message) => {
        if (!options.recoveryError) assert.fail('startup error');
        errors.push({ title, message });
      } } },
    'node:fs': { ...fs, readFileSync: (file, ...args) => String(file).endsWith('/generated/config.json') || String(file).endsWith('\\generated\\config.json')
      ? JSON.stringify(config) : String(file).endsWith('trust.json') ? '{}' : fs.readFileSync(file, ...args) },
    './config-policy': { validateConfig: (value) => value }, './device-store': { ProtectedStore: Guard },
    './proctor-controller': { ProctorController: Controller }, './network-guard': Guard, './anti-cheat': Guard,
    './firewall-guard': Guard, './updater': Guard, './proctor-request-guard': Guard,
  };
  const source = path.resolve(__dirname, '../app/main/index.js');
  runInNewContext(fs.readFileSync(source, 'utf8'), { URL, __dirname: path.dirname(source), require: (name) => mocks[name] || require(name),
    process: { platform: 'darwin', on: (name, callback) => { if (name === 'exit') exitHooks.push(callback); } }, setInterval: () => 1, clearInterval: () => {} });
  await new Promise((resolve) => setImmediate(resolve));
  const event = (owner) => ({ sender: owner.webContents, senderFrame: owner.webContents.mainFrame });
  return { handlers, windows, choices, errors, exitHooks, started, releaseFinish, event, get quitCount() { return quitCount; },
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
