import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { workspace } from './helpers';

async function fixture(t, scenario: any = {}) {
    const exitChoice = scenario.exitChoice ?? 2;
    const onDialog = scenario.onDialog;
    const directory = workspace(t);
    const handlers = new Map();
    const windows = [];
    const choices = [];
    let quitCount = 0;
    let shutdownCount = 0;
    let finishCalled;
    let releaseFinish;
    let pauseCount = 0;
    let recoverCount = 0;
    let exitCount = 0;
    let controller;
    let antiCheatStarts = 0;
    let lockCalled;
    let releaseLock;
    const errors = [];
    const exitHooks = [];
    const startupSteps = [];
    const requestEvents = new Map();
    let ready;
    const initialized = new Promise((resolve) => {
        ready = resolve;
    });
    const locking = new Promise((resolve) => {
        lockCalled = resolve;
    });
    const locked = new Promise((resolve) => {
        releaseLock = resolve;
    });
    const started = new Promise((resolve) => {
        finishCalled = resolve;
    });
    const finished = new Promise((resolve) => {
        releaseFinish = resolve;
    });
    const app: any = new EventEmitter();
    Object.assign(app, {
        setName: () => {},
        getPath: () => directory,
        getVersion: () => '1.0.0',
        requestSingleInstanceLock: () => true,
        whenReady: () => Promise.resolve(),
        quit: () => {
            quitCount++;
        },
        exit: (code) => {
            if (!scenario.recoveryError && !scenario.adminError) assert.fail('初始化期间不应退出客户端');
            assert.equal(code, 1);
            exitCount++;
            ready();
        },
    });
    class BrowserWindow extends EventEmitter {
        declare options: any;
        declare webContents: any;
        declare sent: any[];
        declare destroyed: boolean;
        declare showCount: any;
        declare focusCount: any;
        declare restoreCount: any;
        declare kiosk: any;
        declare alwaysOnTop: any;

        constructor(options) {
            super();
            this.options = options;
            this.webContents = new EventEmitter();
            this.sent = [];
            Object.assign(this.webContents, {
                id: windows.length + 1,
                mainFrame: { url: '' },
                session: {
                    clearStorageData: async () => {
                        startupSteps.push('clear-storage');
                    },
                    clearAuthCache: async () => {
                        startupSteps.push('clear-auth');
                    },
                    setProxy: async (value) => {
                        assert.ok(['direct', 'fixed_servers'].includes(value.mode));
                        startupSteps.push('direct-proxy');
                    },
                    closeAllConnections: async () => {
                        startupSteps.push('close-connections');
                    },
                    cookies: Object.assign(new EventEmitter(), {
                        flushStore: async () => {
                            startupSteps.push('flush-cookies');
                        },
                    }),
                    webRequest: {
                        onBeforeSendHeaders: () => {},
                        onCompleted: (callback) => requestEvents.set('completed', callback),
                        onErrorOccurred: (callback) => requestEvents.set('error', callback),
                        onResponseStarted: (callback) => requestEvents.set('started', callback),
                        onBeforeRequest: () => {},
                    },
                },
                setWindowOpenHandler: () => {},
                send: (channel, value) => this.sent.push({ channel, value }),
                isDevToolsOpened: () => false,
                closeDevTools: () => {},
                openDevTools: () => {},
                getURL: () => this.webContents.mainFrame.url,
            });
            this.on('request-second-instance', () => app.emit('second-instance'));
            windows.push(this);
        }

        async loadURL(url) {
            startupSteps.push('load-page');
            this.webContents.mainFrame.url = url;
            ready();
        }

        async loadFile(file) {
            this.webContents.mainFrame.url = pathToFileURL(file).href;
        }

        isDestroyed() {
            return !!this.destroyed;
        }

        destroy() {
            this.destroyed = true;
            this.emit('closed');
        }

        show() {
            this.showCount = (this.showCount || 0) + 1;
            if (this.webContents.mainFrame.url.endsWith('/waiting.html')) {
                scenario.onWaitingShow?.(this, handlers, startupSteps);
            }
        }

        focus() {
            this.focusCount = (this.focusCount || 0) + 1;
        }

        restore() {
            this.restoreCount = (this.restoreCount || 0) + 1;
        }

        setKiosk(value) {
            if (this.kiosk && !value) this.emit('blur');
            this.kiosk = value;
        }

        setAlwaysOnTop(value) {
            this.alwaysOnTop = value;
        }

        setTitle(value) {
            this.options.title = value;
        }
    }
    const examConfig: any = {
        exam: { targetUrl: 'https://oj.example.com/d/exam/', allowedOrigins: ['https://oj.example.com'] },
        updater: { enabled: !!scenario.updateGate },
        debug: { allowRoot: !!scenario.debug },
        globalFirewallLock: { enabled: !!scenario.delayLock },
    };
    class Controller {
        declare options: any;
        declare records: Map<any, any>;
        declare inFlight: Set<any>;
        declare finishing: boolean;

        constructor(options) {
            controller = this;
            this.options = options;
            this.records = new Map();
            this.inFlight = new Set();
            this.finishing = false;
        }

        logViolation() {}
        async finish(beforeFinish: (...args: any[]) => any = async () => {}) {
            this.finishing = true;
            await beforeFinish();
            this.options.onStatus({ finishing: true, upload: { phase: 'uploading', percent: 50, sent: 100, total: 200 } });
            finishCalled();
            return finished;
        }

        async pause() {
            pauseCount++;
            this.finishing = true;
        }

        shutdown() {
            shutdownCount++;
        }
    }
    class Guard {
        declare running: boolean;
        declare refocus: any;
        declare activity: any;

        constructor(_config, _logger, _directory, runtime: any = {}) {
            this.running = false;
            this.refocus = () => windows[0].focus();
            this.activity = runtime.activity || ((_kind, _stage, action) => action());
        }

        checkPrivileges() {
            if (scenario.adminError) return Promise.reject(scenario.adminError);
            return Promise.resolve();
        }

        refresh() { return Promise.resolve(); }
        close() {}
        recover() {
            return this.activity('network', 'restore', async () => {
                recoverCount++;
                if (scenario.recoveryGate) await scenario.recoveryGate;
                if (scenario.recoveryError) throw scenario.recoveryError;
            });
        }

        snapshot() {
            return { version: '1.0.0', buildVersion: '2026101001' };
        }

        check() {
            return scenario.updateGate;
        }

        install() {}
        start() {
            if (!this.running) {
                antiCheatStarts++;
                this.running = true;
                windows[0].on('blur', this.refocus);
            }
        }

        stop() {
            this.running = false;
            windows[0]?.removeListener('blur', this.refocus);
        }

        lock() {
            return this.activity('network', 'lock', () => {
                lockCalled();
                return locked;
            });
        }

        unlock() {
            if (scenario.exitRecoveryError) throw scenario.exitRecoveryError;
            return this.recover();
        }
    }
    const mocks: any = {
        electron: {
            app,
            BrowserWindow,
            ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
            dialog: {
                showMessageBox: async (owner, options) => {
                    if (!options) {
                        options = owner;
                        owner = null;
                    }
                    choices.push(options);
                    if (onDialog) await onDialog(owner, options);
                    return { response: options.buttons?.length === 3 ? exitChoice : 1 };
                },
                showErrorBox: (title, message) => {
                    if (!scenario.recoveryError) assert.fail('启动过程发生错误');
                    errors.push({ title, message });
                },
            },
        },
        'node:fs': {
            ...fs,
            readFileSync: (file, ...args) =>
                String(file).endsWith('/generated/config.json') || String(file).endsWith('\\generated\\config.json')
                    ? JSON.stringify(examConfig)
                    : String(file).endsWith('trust.json')
                        ? '{}'
                        : fs.readFileSync(file, ...args),
        },
        './security/config-policy': { validateConfig: (value) => value },
        './audit/device-store': { ProtectedStore: Guard, prepareBootIdentity: async () => 'boot-id' },
        './proctor/proctor-controller': { ProctorController: Controller },
        './network/network-guard': Guard,
        './security/anti-cheat': Guard,
        './security/exam-input': require('../app/main/security/exam-input'),
        './proctor/proctor-auth': require('../app/main/proctor/proctor-auth'),
        './network/firewall-guard': class extends Guard {
            constructor(config, logger, runtime = {}) {
                super(config, logger, undefined, runtime);
            }
        },
        './updates/updater': Guard,
        './proctor/proctor-request-guard': Guard,
        './windows/local-page': require('../app/main/windows/local-page'),
        './windows/dialog-service': {
            DialogService: class {
                constructor(private dependencies) {}
                focus() {}
                show(value, owner?) {
                    if (value.title === '客户端启动失败') {
                        errors.push({ title: value.title, message: value.detail });
                        return Promise.resolve({ response: 0 });
                    }
                    return this.dependencies.dialog.showMessageBox(owner, value);
                }
            },
        },
        '../shared/branding': require('../app/shared/branding'),
        './runtime': {
            runtime: () => ({
                identity: { version: '1.0.0', buildVersion: '2026101001', productName: scenario.productName },
                markReady: () => {},
                source: 'installed',
            }),
        },
        './updates/update-cache': require('../app/main/updates/update-cache'),
        './security/login-session': require('../app/main/security/login-session'),
        './diagnostics/diagnostics': require('../app/main/diagnostics/diagnostics'),
        './windows/debug-console': require('../app/main/windows/debug-console'),
        './diagnostics/activity-progress': require('../app/main/diagnostics/activity-progress'),
        './windows/waiting-window': require('../app/main/windows/waiting-window'),
        './network/exam-network': class {
            auxiliaryEndpoints = [];
            observe() {}
            lookup() { return Promise.resolve([]); }
            async prepare() {
                await windows[0].webContents.session.setProxy({ mode: 'fixed_servers' });
                await windows[0].webContents.session.closeAllConnections();
            }

            setDebug() { return Promise.resolve(); }
            close() {}
        },
    };
    const source = path.resolve(__dirname, '../app/main/index.js');
    if (scenario.platform === 'darwin') {
        const FirewallGuard = require('../app/main/network/firewall-guard');
        mocks['./network/firewall-guard'] = class extends FirewallGuard {
            constructor(config, logger, runtime) {
                super(config, logger, { ...runtime, platform: 'darwin' });
            }
        };
    }
    runInNewContext(fs.readFileSync(source, 'utf8'), {
        exports: {},
        URL,
        __dirname: path.dirname(source),
        require: (name) => mocks[name] || require(name),
        process: {
            platform: scenario.platform || 'win32',
            on: (name, callback) => {
                if (name === 'exit') exitHooks.push(callback);
            },
        },
        setInterval: () => 1,
        clearInterval: () => {},
        setTimeout,
        clearTimeout,
    });
    await initialized;
    await new Promise((resolve) => setImmediate(resolve));
    const event = (owner) => ({ sender: owner.webContents, senderFrame: owner.webContents.mainFrame });
    return {
        app,
        handlers,
        windows,
        choices,
        controller,
        errors,
        exitHooks,
        startupSteps,
        requestEvents,
        started,
        releaseFinish,
        locking,
        releaseLock,
        event,
        get antiCheatStarts() {
            return antiCheatStarts;
        },
        get quitCount() {
            return quitCount;
        },
        get pauseCount() {
            return pauseCount;
        },
        get shutdownCount() {
            return shutdownCount;
        },
        get recoverCount() {
            return recoverCount;
        },
        get exitCount() {
            return exitCount;
        },
    };
}

test('非管理员启动在考试或恢复前提示关闭，并以管理员权限重开', async (t) => {
    const error = Object.assign(new Error('请关闭软件，右键选择“以管理员身份运行”'), { code: 'ADMIN_REQUIRED' });
    const f = await fixture(t, { adminError: error });
    assert.equal(f.windows.length, 0);
    assert.equal(f.recoverCount, 0);
    assert.equal(f.exitCount, 1);
    assert.match(f.choices[0].message, /管理员模式/);
    assert.match(f.choices[0].detail, /以管理员身份运行/);
    assert.equal(f.choices[0].buttons.length, 1);
    assert.equal(f.choices[0].buttons[0], '关闭软件');
});
test('配置的软件名称显示在状态中，且保留在远端页面窗口标题内', async (t) => {
    const productName = '计算机学院监考客户端';
    const f = await fixture(t, { productName });
    const main = f.windows[0];
    assert.equal(main.options.title, productName);
    let prevented = false;
    main.emit(
        'page-title-updated',
        {
            preventDefault: () => {
                prevented = true;
            },
        },
        '考试题目',
    );
    assert.equal(prevented, true);
    assert.equal(main.options.title, `考试题目 · ${productName}`);
    const status = await f.handlers.get('exam:status')(f.event(main));
    assert.equal(status.productName, productName);
});
test('macOS 认证不设置网络或强制焦点，退出时直接准备日志', async (t) => {
    const f = await fixture(t, { platform: 'darwin', delayLock: true });
    const main = f.windows[0];
    await f.controller.options.onIdentity({
        uid: 7,
        proctorEnabled: true,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    assert.equal(main.kiosk, false);
    assert.equal(main.alwaysOnTop, false);
    assert.equal(f.antiCheatStarts, 1);
    assert.equal(f.recoverCount, 0);
    const ending = f.handlers.get('exam:request-quit')(f.event(main));
    await f.started;
    const upload = f.windows[1];
    const statuses = upload.sent.filter((item) => item.channel === 'exam:upload-status').map((item) => item.value);
    assert.ok(statuses.some((item) => item.upload?.phase === 'preparing' && /加密日志/.test(item.message)));
    assert.ok(statuses.every((item) => item.upload?.phase !== 'restoring-network'));
    assert.equal(f.handlers.get('exam:upload-status')(f.event(upload)).networkMode, 'macos-audit-only');
    f.releaseFinish(true);
    await ending;
});

test('结束前明确提醒上传日志，收到回执后仅原生主页面可以退出', async (t) => {
    const f = await fixture(t);
    const main = f.windows[0];
    const ending = f.handlers.get('exam:request-quit')(f.event(main));
    await f.started;
    const upload = f.windows[1];
    assert.match(f.choices[0].detail, /上传成功后成绩才能有效/);
    assert.equal(upload.options.webPreferences.sandbox, true);
    assert.equal(upload.options.webPreferences.nodeIntegration, false);
    const read = f.handlers.get('exam:upload-status');
    const exit = f.handlers.get('exam:upload-exit');
    assert.equal(read(f.event(upload)).upload.percent, 50);
    assert.throws(() => exit(f.event(upload)), /处理中/);
    assert.throws(() => exit(f.event(main)), /受信任的本地主页面/);
    assert.throws(() => read({ sender: upload.webContents, senderFrame: { url: upload.webContents.mainFrame.url } }), /受信任的本地主页面/);
    f.releaseFinish(true);
    await ending;
    assert.equal(read(f.event(upload)).exitReady, true);
    assert.equal(read(f.event(upload)).upload.phase, 'complete');
    assert.equal(f.quitCount, 0); // 用户确认前保持上传完成提示可见。
    exit(f.event(upload));
    assert.equal(f.quitCount, 1);
    assert.equal(f.shutdownCount, 1);
});

test('每次启动在导航到 OJ 前清除登录状态并刷新 Cookie', async (t) => {
    const f = await fixture(t);
    assert.deepEqual(f.startupSteps, ['direct-proxy', 'close-connections', 'clear-storage', 'clear-auth', 'flush-cookies', 'load-page']);
});
test('普通用户主页面加载失败时提供恢复提示，子页面或取消导航不触发', async (t) => {
    const f = await fixture(t, { exitChoice: 1 });
    const main = f.windows[0];
    const failures = [];
    f.controller.authenticationFailed = (error: any) => failures.push(error.message);
    main.webContents.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', 'https://oj.example.com/contest/problems', false);
    main.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://oj.example.com/contest/problems', true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.choices.length, 0);
    main.webContents.emit('did-fail-load', {}, -100, 'ERR_CONNECTION_CLOSED', 'https://oj.example.com/contest/problems', true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.choices.length, 1);
    assert.equal(f.choices[0].title, '考试页面无法加载');
    assert.match(f.choices[0].detail, /日志已保留/);
    assert.deepEqual(failures, ['net::ERR_CONNECTION_CLOSED']);
    assert.equal(main.webContents.getURL(), 'https://oj.example.com/d/exam/');
    assert.equal(f.startupSteps.filter((step) => step === 'load-page').length, 2);
});
test('后台认证和页面桥保留带版本说明的中文错误', async (t) => {
    const { ProctorError } = require('../app/main/proctor/proctor-auth');
    const f = await fixture(t);
    const main = f.windows[0];
    const error = new ProctorError('Proctor client version mismatch.', 403);
    f.controller.sync = async () => {
        throw error;
    };
    main.webContents.emit('did-navigate');
    await new Promise((resolve) => setImmediate(resolve));
    const status = f.handlers.get('exam:status')(f.event(main));
    assert.match(status.message, /版本不符合系统要求（当前：1\.0\.0）/);
    assert.match(status.message, /请安装/);
    f.controller.headers = async () => {
        throw error;
    };
    await assert.rejects(f.handlers.get('exam:proctor-headers')(f.event(main), {}), /版本不符合系统要求（当前：1\.0\.0）/);
    f.controller.options.onStatus({ phase: 'network-error', message: '网络设置失败' });
    main.webContents.emit('did-navigate');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.handlers.get('exam:status')(f.event(main)).message, '网络设置失败');
});
test('启动恢复较慢时先展示本地进度，完成恢复后关闭进度窗口', async (t) => {
    let release, show;
    const recoveryGate = new Promise((resolve) => {
        release = resolve;
    });
    const shown = new Promise((resolve) => {
        show = resolve;
    });
    const preparing = fixture(t, {
        recoveryGate,
        onWaitingShow: (window, handlers, startupSteps) => show({ window, handlers, startupSteps }),
    });
    let native;
    try {
        native = await shown;
        assert.equal(native.window.options.webPreferences.sandbox, true);
        assert.equal(native.startupSteps.includes('load-page'), false);
        const read = native.handlers.get('exam:waiting-status');
        const event: any = { sender: native.window.webContents, senderFrame: native.window.webContents.mainFrame };
        assert.equal(read(event).kind, 'network');
        assert.equal(read(event).stage, 'restore');
        assert.equal(read(event).busy, true);
        assert.throws(() => read({ ...event, senderFrame: { url: event.senderFrame.url } }), /受信任的本地主页面/);
    } finally {
        release();
    }
    const f = await preparing;
    assert.equal(native.window.destroyed, true);
    const main = f.windows.find((window) => window.webContents.mainFrame.url.startsWith('https://'));
    assert.equal(f.handlers.get('exam:status')(f.event(main)).activity, null);
});

test('退出恢复失败时仍处理日志，上传后显示网络警告', async (t) => {
    const f = await fixture(t, { exitRecoveryError: new Error('防火墙服务已停止') });
    const ending = f.handlers.get('exam:request-quit')(f.event(f.windows[0]));
    await f.started;
    assert.equal(f.controller.finishing, true);
    f.releaseFinish(true);
    await ending;
    const status = f.handlers.get('exam:upload-status')(f.event(f.windows[1]));
    assert.equal(status.exitReady, true);
    assert.equal(status.upload.phase, 'complete');
    assert.match(status.networkWarning, /网络尚未确认恢复/);
    assert.equal(f.choices.length, 1);
    f.handlers.get('exam:upload-exit')(f.event(f.windows[1]));
    assert.equal(f.quitCount, 1);
});

test('成功的 net::OK 响应不误记为错误，HTTP 拒绝仍可见', async (t) => {
    const f = await fixture(t, { debug: true });
    const settled = f.requestEvents.get('completed');
    settled({ id: 1, url: 'https://oj.example.com/assets/page.js', statusCode: 200, error: 'net::OK' });
    settled({ id: 2, url: 'https://oj.example.com/contest/blocked', statusCode: 403, error: 'net::OK' });
    f.requestEvents.get('error')({
        id: 3,
        url: 'wss://oj.example.com/contest-announcements-conn',
        statusCode: 101,
        error: 'net::ERR_WS_UPGRADE',
    });
    await f.controller.options.onIdentity({ uid: 1, root: true, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const console = f.windows[1];
    const entries = f.handlers
        .get('exam:debug-logs')(f.event(console), 0)
        .entries.filter((entry) => entry.event === 'request.response');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].level, 'warn');
    assert.equal(entries[0].data.status, 403);
    const upgraded = f.handlers
        .get('exam:debug-logs')(f.event(console), 0)
        .entries.filter((entry) => entry.event === 'request.websocket-upgraded');
    assert.equal(upgraded.length, 1);
    assert.equal(upgraded[0].level, 'info');
});

test('离线结束显示日志已保留，允许退出但不宣称上传成功', async (t) => {
    const f = await fixture(t);
    const ending = f.handlers.get('exam:request-quit')(f.event(f.windows[0]));
    await f.started;
    f.releaseFinish(false);
    await ending;
    const status = f.handlers.get('exam:upload-status')(f.event(f.windows[1]));
    assert.equal(status.upload.phase, 'deferred');
    assert.equal(status.upload.percent, null);
    assert.match(status.message, /成绩待确认/);
    assert.match(status.message, /原考试账号补传/);
    f.handlers.get('exam:upload-exit')(f.event(f.windows[1]));
    assert.equal(f.quitCount, 1);
});

test('启动恢复取消只报告一次，不在退出时反复提权', async (t) => {
    const error = new Error('无法恢复监考网络设置，请允许 Windows 管理员授权。');
    const f = await fixture(t, { recoveryError: error });
    assert.equal(f.recoverCount, 1);
    assert.equal(f.exitCount, 1);
    assert.equal(f.windows.length, 0);
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0].message, error.message);
    for (const hook of f.exitHooks) hook();
    assert.equal(f.recoverCount, 1);
});

test('仅签名 root 调试打开本地控制台，退出登录撤销 IPC 权限', async (t) => {
    const f = await fixture(t, { debug: true });
    const login: any = { uid: 1, root: false, expiresAt: new Date(Date.now() + 60000).toISOString() };
    await f.controller.options.onIdentity(login);
    assert.equal(f.windows.length, 1);
    await f.controller.options.onIdentity({ ...login, root: true });
    const console = f.windows[1];
    const read = f.handlers.get('exam:debug-logs');
    assert.equal(console.options.webPreferences.sandbox, true);
    assert.equal(console.options.webPreferences.nodeIntegration, false);
    const history = read(f.event(console), 0);
    assert.ok(history.entries.some((entry) => entry.event === 'startup.ready'));
    assert.ok(history.file.endsWith('.log'));
    assert.throws(() => read(f.event(f.windows[0]), 0), /受信任的本地主页面/);
    assert.throws(
        () => read({ sender: console.webContents, senderFrame: { url: console.webContents.mainFrame.url } }, 0),
        /受信任的本地主页面/,
    );
    assert.throws(() => read(f.event(console), -1), /诊断日志读取位置无效/);
    await f.controller.options.onIdentity(null);
    assert.equal(console.isDestroyed(), true);
    assert.throws(() => read(f.event(console), 0), /受信任的本地主页面/);
});

test('控制台要求构建允许调试且 root 身份未过期', async (t) => {
    const disabled = await fixture(t);
    await disabled.controller.options.onIdentity({
        uid: 1,
        root: true,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    assert.equal(disabled.windows.length, 1);
    const f = await fixture(t, { debug: true });
    await f.controller.options.onIdentity({ uid: 1, root: true, expiresAt: new Date(Date.now() - 1).toISOString() });
    assert.equal(f.windows.length, 1);
    await f.controller.options.onIdentity({ uid: 1, root: true, expiresAt: new Date(Date.now() + 50).toISOString() });
    const console = f.windows[1];
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(console.isDestroyed(), true);
    assert.throws(() => f.handlers.get('exam:debug-logs')(f.event(console), 0), /受信任/);
});

test('旧身份等待网络期间切换到 root 调试，不会重新启用全屏保护', async (t) => {
    const f = await fixture(t, { debug: true, delayLock: true });
    const applying = f.controller.options.onIdentity({ uid: 2, root: false, proctorEnabled: true });
    await f.locking;
    await f.controller.options.onIdentity({ uid: 1, root: true, expiresAt: new Date(Date.now() + 60000).toISOString() });
    f.releaseLock();
    await applying;
    assert.equal(f.antiCheatStarts, 0);
    assert.equal(f.windows[0].kiosk, false);
    assert.equal(f.windows.length, 2);
});

test('已结束比赛认证时不重新启用网络限制', async (t) => {
    const f = await fixture(t, { delayLock: true });
    const login: any = { uid: 7, root: false, proctorEnabled: true };
    f.controller.current = { login, completed: true };
    await f.controller.options.onIdentity(login);
    assert.equal(f.antiCheatStarts, 0);
    assert.equal(f.windows[0].kiosk, false);
});

test('不上传退出会暂停考试并恢复网络，不创建上传窗口', async (t) => {
    const f = await fixture(t, { exitChoice: 1 });
    await f.handlers.get('exam:request-quit')(f.event(f.windows[0]));
    assert.equal(f.pauseCount, 1);
    assert.equal(f.quitCount, 1);
    assert.equal(f.shutdownCount, 1);
    assert.equal(f.recoverCount, 2);
    assert.equal(f.windows.length, 1);
    assert.deepEqual(Array.from(f.choices[0].buttons), ['继续监考', '保留日志退出', '上传日志并结束监考']);
    assert.match(f.choices[0].detail, /续写、继续做题/);
});

test('更新服务器缓慢不会延迟考试窗口或认证 IPC 初始化', async (t) => {
    let release;
    const updateGate = new Promise((resolve) => {
        release = resolve;
    });
    const f = await fixture(t, { updateGate });
    assert.equal(f.windows.length, 1);
    assert.ok(f.handlers.has('exam:proctor-headers'));
    assert.ok(f.startupSteps.includes('load-page'));
    const status = f.handlers.get('exam:status')(f.event(f.windows[0]));
    assert.equal(status.update.version, '1.0.0');
    assert.equal(status.update.buildVersion, '2026101001');
    release();
});

test('退出弹窗显示前解除抢焦点、全屏和置顶，取消后恢复保护', async (t) => {
    const f = await fixture(t, {
        exitChoice: 0,
        onDialog: (owner) => {
            assert.equal(owner.kiosk, false);
            assert.equal(owner.alwaysOnTop, false);
            const focused = owner.focusCount;
            owner.emit('blur');
            assert.equal(owner.focusCount, focused);
            owner.emit('request-second-instance');
            assert.equal(owner.focusCount, focused);
        },
    });
    const main = f.windows[0];
    await f.controller.options.onIdentity({ uid: 7, proctorEnabled: true });
    assert.equal(main.kiosk, true);
    assert.equal(main.alwaysOnTop, true);
    assert.equal(f.antiCheatStarts, 1);
    await f.handlers.get('exam:request-quit')(f.event(main));
    assert.equal(main.kiosk, true);
    assert.equal(main.alwaysOnTop, true);
    assert.equal(f.antiCheatStarts, 2);
    assert.equal(f.quitCount, 0);
    assert.equal(f.recoverCount, 1); // 仅打开提示框不会恢复或重新限制网络。
});

test('上传窗口加载后才显示，再次启动客户端时将焦点交给它', async (t) => {
    const f = await fixture(t);
    const main = f.windows[0];
    await f.controller.options.onIdentity({ uid: 7, proctorEnabled: true });
    const ending = f.handlers.get('exam:request-quit')(f.event(main));
    await f.started;
    const upload = f.windows[1];
    assert.equal(upload.options.show, false);
    assert.equal(upload.options.modal, true);
    assert.equal(upload.options.minimizable, false);
    assert.equal(upload.showCount, 1);
    assert.equal(upload.focusCount, 1);
    const focused = main.focusCount;
    main.emit('blur');
    f.app.emit('second-instance');
    assert.equal(main.focusCount, focused);
    assert.equal(upload.focusCount, 2);
    f.releaseFinish(true);
    await ending;
    f.handlers.get('exam:upload-exit')(f.event(upload));
    assert.equal(f.quitCount, 1);
});

test('退出弹窗期间网络限制完成，不重新启动抢焦点', async (t) => {
    let entered, dismiss;
    const shown = new Promise((resolve) => {
        entered = resolve;
    });
    const answered = new Promise((resolve) => {
        dismiss = resolve;
    });
    const f = await fixture(t, {
        delayLock: true,
        exitChoice: 0,
        onDialog: () => {
            entered();
            return answered;
        },
    });
    const main = f.windows[0];
    const applying = f.controller.options.onIdentity({ uid: 7, proctorEnabled: true });
    await f.locking;
    const ending = f.handlers.get('exam:request-quit')(f.event(main));
    await shown;
    f.releaseLock();
    await applying;
    assert.equal(main.kiosk, false);
    assert.equal(f.antiCheatStarts, 0);
    const focused = main.focusCount;
    main.emit('blur');
    assert.equal(main.focusCount, focused);
    dismiss();
    await ending;
    assert.equal(main.kiosk, true);
    assert.equal(f.antiCheatStarts, 1);
});

test('弹窗打开失败后恢复控制，并允许再次尝试退出', async (t) => {
    let prompts = 0;
    const f = await fixture(t, {
        exitChoice: 1,
        onDialog: () => {
            if (++prompts === 1) throw new Error('原生弹窗打开失败');
        },
    });
    const main = f.windows[0];
    await f.controller.options.onIdentity({ uid: 7, proctorEnabled: true });
    await f.handlers.get('exam:request-quit')(f.event(main));
    assert.equal(main.kiosk, true);
    assert.equal(f.quitCount, 0);
    await f.handlers.get('exam:request-quit')(f.event(main));
    assert.equal(f.pauseCount, 1);
    assert.equal(f.quitCount, 1);
});

test('构建允许 root 调试不会豁免普通考试账号的网络和焦点保护', async (t) => {
    const f = await fixture(t, { debug: true, delayLock: true });
    const applying = f.controller.options.onIdentity({
        uid: 7,
        root: false,
        proctorEnabled: true,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await f.locking;
    f.releaseLock();
    await applying;
    assert.equal(f.windows[0].kiosk, true);
    assert.equal(f.antiCheatStarts, 1);
    const status = f.handlers.get('exam:status')(f.event(f.windows[0]));
    assert.equal(status.debug, false);
    assert.equal(status.root, false);
    assert.equal(status.allowRootDebug, true);
});

test('控制器认证失败立即推送浮窗，推送与 IPC 查询状态一致', async (t) => {
    const f = await fixture(t);
    const main = f.windows[0];
    f.controller.options.onStatus({ authenticated: false, phase: 'authentication-error', message: '客户端版本不匹配' });
    const pushed = main.sent.filter((item) => item.channel === 'exam:client-status').at(-1).value;
    assert.equal(pushed.authenticated, false);
    assert.equal(pushed.message, '客户端版本不匹配');
    assert.equal(pushed.allowRootDebug, false);
    assert.equal(f.handlers.get('exam:status')(f.event(main)).message, pushed.message);
});

export {};

test('重复认证不反复切换全屏或置顶，正式考试窗口始终禁用开发工具', async (t) => {
    const f = await fixture(t, { delayLock: true });
    const main = f.windows[0];
    assert.equal(main.options.webPreferences.devTools, false);
    const calls = [];
    main.setKiosk = (value) => calls.push(['kiosk', value]);
    main.setAlwaysOnTop = (value, level) => calls.push(['top', value, level]);
    const login = { uid: 3, root: false, proctorEnabled: true, expiresAt: new Date(Date.now() + 60000).toISOString() };
    const verified = f.controller.options.onIdentity(login);
    await f.locking;
    f.releaseLock();
    await verified;
    await f.controller.options.onIdentity(login);
    assert.deepEqual(calls, [['kiosk', true], ['top', true, 'screen-saver']]);
});
