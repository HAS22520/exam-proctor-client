import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session as electronSession, shell } from 'electron';
import ActivityProgress = require('./diagnostics/activity-progress');
import AntiCheatGuard = require('./security/anti-cheat');
import type { ActivityStatus, ClientConfig, ClientStatus, LoginIdentity, TraceLevel, Trust } from './contracts';
import { validateConfig } from './security/config-policy';
import { protectExamInput } from './security/exam-input';
import DebugConsole = require('./windows/debug-console');
import { prepareBootIdentity, ProtectedStore } from './audit/device-store';
import { Diagnostics } from './diagnostics/diagnostics';
import ExamNetwork = require('./network/exam-network');
import FirewallGuard = require('./network/firewall-guard');
import { observeLogin, resetLogin } from './security/login-session';
import NetworkGuard = require('./network/network-guard');
import { identity, isNetworkError, proctorErrorMessage, Transport } from './proctor/proctor-auth';
import { ProctorController } from './proctor/proctor-controller';
import ProctorRequestGuard = require('./proctor/proctor-request-guard');
import { DEFAULT_PRODUCT_NAME, INTERNAL_APP_NAME } from '../shared/branding';
import { runtime } from './runtime';
import { hasUnfinishedJournals } from './updates/update-cache';
import { type ClientDialogOptions, DialogService } from './windows/dialog-service';
import { localPreferences, pageFile, requireLocalFrame, secureLocalPage, windowIcon } from './windows/local-page';
import Updater = require('./updates/updater');
import WaitingWindow = require('./windows/waiting-window');

const running = runtime(app);
const productName = running.identity.productName || DEFAULT_PRODUCT_NAME;
const prompts = new DialogService({ BrowserWindow, ipcMain, dialog, productName });
const diagnostics = new Diagnostics();
let activity: ActivityProgress;
const waitingWindow = new WaitingWindow(BrowserWindow, productName);
const trace = (
    level: TraceLevel,
    event: string,
    details: Record<string, unknown> & { phase?: string, url?: string, operation?: string } = {},
) => {
    diagnostics.log(level, event, details);
    if (event === 'firewall.stage') activity.stage('network', details.phase);
    if (event === 'protocol.request') {
        const stage = details.url?.endsWith('/proctor/identity') ? 'identity' : details.operation;
        if (['identity', 'challenge', 'handshake', 'refresh'].includes(stage)) activity.stage('auth', stage);
    }
};
const debugConsole = new DebugConsole(BrowserWindow, productName);

app.setName(INTERNAL_APP_NAME);
for (const name of ['remote-debugging-port', 'remote-debugging-pipe']) app.commandLine?.removeSwitch(name);
let window: BrowserWindow,
    controller: ProctorController,
    network: NetworkGuard,
    antiCheat: AntiCheatGuard,
    firewall: FirewallGuard,
    config: ClientConfig,
    trust: Trust,
    uploadWindow: BrowserWindow,
    updates: Updater,
    examNetwork: ExamNetwork;
let quitting = false;
let exiting = false;
let root = false;
let debug = false;
let timer: ReturnType<typeof setInterval>;
let trustedUrl: string;
let latestStatus: ClientStatus = { phase: 'idle', message: '正在连接 OJ' };
let exitReady = false;
let dialogDepth = 0;
let protectedFocus = false;
let enforcedWindowFocus: boolean | null = null;
let recoveryReady = false;
let debugExpiry = 0;
let debugTimer: ReturnType<typeof setTimeout>;
let syncing = false;
let syncRequested = false;
let lastUploadStage: string;
let identityRevision = 0;
let lastTick = Date.now();
let preparationTimer: ReturnType<typeof setInterval>;
let startupReady = false;
let pageFailurePrompt = false;
diagnostics.log('info', 'startup.process', { platform: process.platform, arch: process.arch });
process.on('uncaughtExceptionMonitor', (error) => diagnostics.error('process.uncaught-exception', error));
const directory = app.getPath('userData');
if (!running.singleInstanceLocked && !app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
    // 弹窗拥有焦点时，只激活弹窗，避免主窗口抢回焦点。
    if (dialogDepth) {
        prompts.focus();
        return;
    }
    const target = uploadWindow && !uploadWindow.isDestroyed() ? uploadWindow : window || waitingWindow.window;
    if (target && !target.isDestroyed()) {
        target.restore();
        target.show();
        target.focus();
    }
});

function applyWindowFocus() {
    if (!window || window.isDestroyed()) return;
    const enabled = protectedFocus && !dialogDepth && !exiting;
    if (enabled) antiCheat.start();
    else antiCheat.stop();
    const enforce = enabled && process.platform !== 'darwin';
    // 认证刷新不反复切换 kiosk/置顶，否则 Windows 可能重新排列窗口并短暂丢失前台。
    if (enforcedWindowFocus === enforce) return;
    enforcedWindowFocus = enforce;
    window.setKiosk(enforce && config.window?.kiosk !== false);
    window.setAlwaysOnTop(enforce && config.window?.alwaysOnTop !== false, 'screen-saver');
}

async function showExamDialog(options: ClientDialogOptions, owner = window) {
    dialogDepth++;
    try {
        // 在弹窗使父窗口失焦前解除强制抢焦点；取消后再按监考状态恢复。
        applyWindowFocus();
        owner.restore();
        owner.show();
        owner.focus();
        return await prompts.show(options, owner);
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
        // 远端配置不能开启调试模式或改变编译时确定的信任边界。
        return validateConfig({ ...base, ...remote, debug: base.debug }, trust);
    } catch {
        return validateConfig(base, trust);
    }
}

function statusSnapshot(freshUpdates = false): ClientStatus {
    return {
        ...latestStatus,
        activity: activity.snapshot(),
        productName: running.identity.productName || DEFAULT_PRODUCT_NAME,
        update: freshUpdates ? updates?.snapshot() : latestStatus.update,
        debug,
        root,
        exitReady,
        allowRootDebug: !!config?.debug?.allowRoot,
    };
}

function publishClientStatus() {
    if (window && !window.isDestroyed()) window.webContents.send('exam:client-status', statusSnapshot());
}

function publishStatus(status: ClientStatus) {
    latestStatus = {
        ...status,
        activity: activity.snapshot(),
        update: updates?.snapshot(),
        debug,
        root,
        exitReady,
        networkMode: firewall?.mode || 'unavailable',
    };
    publishClientStatus();
    if (uploadWindow && !uploadWindow.isDestroyed()) uploadWindow.webContents.send('exam:upload-status', latestStatus);
    if (status.upload) {
        const { phase, percent, sent, total } = status.upload;
        const stage = `${phase}:${Math.floor((percent || 0) / 10)}`;
        if (stage !== lastUploadStage) {
            trace('info', 'logs.upload-progress', { phase, percent, sent, total });
            lastUploadStage = stage;
        }
    }
}

function publishActivity(status: ActivityStatus | null) {
    latestStatus.activity = status;
    waitingWindow.publish(status);
    if (window && !window.isDestroyed()) window.webContents.send('exam:activity-status', status);
    publishClientStatus();
    if (uploadWindow && !uploadWindow.isDestroyed()) {
        uploadWindow.webContents.send('exam:upload-status', { ...latestStatus, activity: status });
    }
}

activity = new ActivityProgress({ onChange: publishActivity });

async function applyIdentity(login: LoginIdentity | null) {
    const revision = ++identityRevision;
    root = !!login?.root && login.uid > 0;
    const next = root && config.debug.allowRoot && Date.parse(login.expiresAt) > Date.now();
    debugExpiry = next ? Date.parse(login.expiresAt) : 0;
    clearTimeout(debugTimer);
    if (next) {
        debugTimer = setTimeout(() => {
            if (debug && Date.now() >= debugExpiry) {
                applyIdentity(null).catch((error) => diagnostics.error('identity.revoke-failed', error));
            }
        }, Math.max(1, debugExpiry - Date.now()));
        debugTimer.unref?.();
    }
    if (next !== debug) {
        debug = next;
        network.debug = debug;
        // 权限失效必须同步销毁调试窗口，不能等网络连接恢复后才撤销。
        if (!debug) debugConsole.close();
        if (process.platform === 'win32') await examNetwork.setDebug(debug);
        if (!debug && !config.exam.allowedOrigins.includes(new URL(window.webContents.getURL()).origin)) {
            window.loadURL(config.exam.targetUrl).catch(() => {});
        }
        trace('info', 'identity.debug-mode', { debug, root });
        if (debug) {
            antiCheat.stop();
            window.setKiosk(false);
            window.setAlwaysOnTop(false);
            if (!dialogDepth && !exiting) await debugConsole.show();
            if (revision !== identityRevision) return;
        } else {
            debugConsole.close();
            if (window.webContents.isDevToolsOpened()) window.webContents.closeDevTools();
        }
    }
    publishClientStatus();
    const uid = login?.uid ?? controller?.current?.login.uid;
    const ongoing = [...(controller?.records.values() || [])].some(
        (record) => record.login.uid === uid && record.journal?.state.phase === 'open',
    );
    const activeRecord = controller?.current;
    const closed =
        !!activeRecord
        && activeRecord.login.uid === uid
        && (activeRecord.completed || (!!activeRecord.journal && activeRecord.journal.state.phase !== 'open'));
    protectedFocus = !!uid && ((!!login?.proctorEnabled && !closed) || ongoing) && !debug;
    const protectedExam = protectedFocus && !exiting;
    if (protectedExam) {
        if (config.globalFirewallLock?.enabled) {
            try {
                await firewall.lock();
            } catch (error) {
                publishStatus({ ...latestStatus, authenticated: false, phase: 'network-error', message: error.message });
                throw error;
            }
        }
        if (revision !== identityRevision || exiting) return;
    } else {
        antiCheat.stop();
        await firewall.unlock();
    }
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

function ipcContext(event: Electron.IpcMainInvokeEvent) {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('IPC 请求必须来自考试主页面');
    }
    const url = new URL(event.senderFrame.url);
    if (!config.exam.allowedOrigins.includes(url.origin)) throw new Error('IPC 请求必须来自受信任的 OJ 来源');
    return url.href;
}

function uploadContext(event: Electron.IpcMainInvokeEvent) {
    requireLocalFrame(uploadWindow, 'upload', event);
}

async function showUploadWindow() {
    exitReady = false;
    uploadWindow = new BrowserWindow({
        width: 560,
        height: 600,
        useContentSize: true,
        minWidth: 430,
        minHeight: 560,
        title: `结束监考 · 上传日志 · ${productName}`,
        icon: windowIcon,
        parent: window,
        modal: true,
        show: false,
        minimizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        resizable: false,
        webPreferences: {
            ...localPreferences('upload'),
            partition: 'proctor-upload',
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            devTools: false,
        },
    });
    secureLocalPage(uploadWindow);
    uploadWindow.on('close', (event) => {
        if (!quitting) event.preventDefault();
    });
    await uploadWindow.loadFile(pageFile('upload'));
    uploadWindow.show();
    uploadWindow.focus();
}

function completeExit() {
    controller.shutdown();
    quitting = true;
    app.quit();
}

async function syncLogin(force = false) {
    if (exiting || window.isDestroyed()) return;
    if (syncing) {
        if (force) syncRequested = true;
        return;
    }
    const url = window.webContents.getURL();
    if (config.exam.allowedOrigins.includes(new URL(url).origin)) trustedUrl = url;
    if (!trustedUrl) return;
    syncing = true;
    try {
        await diagnostics.span('identity.sync', () => controller.sync(trustedUrl, { force }));
        for await (const record of controller.records.values()) {
            if (record.login.uid === controller.current?.login.uid && record.journal?.state.phase === 'open') {
                await activity.run('auth', 'refresh', () => record.auth.ensure());
            }
        }
        controller.logViolation({
            source: 'CLIENT',
            type: 'MONITOR_HEARTBEAT',
            target: '',
            detail: debug ? 'root-debug' : process.platform === 'darwin' ? 'macos-audit-only' : 'exam',
        });
        await controller.retryUploads();
    } catch (error) {
        diagnostics.error('monitor.failed', error, { version: running.identity.version });
        if (latestStatus.phase !== 'network-error') {
            publishStatus({
                ...latestStatus,
                authenticated: false,
                phase: isNetworkError(error) ? 'network-error' : 'authentication-error',
                message: proctorErrorMessage(error, running.identity.version),
            });
        }
    } finally {
        syncing = false;
        if (syncRequested) {
            syncRequested = false;
            setTimeout(() => syncLogin(true), 0);
        }
    }
}

async function requestExit() {
    if (exiting) return;
    exiting = true;
    let response;
    try {
        const choice = await showExamDialog({
            type: 'question',
            title: '结束监考',
            message: '退出客户端还是结束监考？',
            detail: '此操作不会代你提交代码。保留日志退出可在下次登录原账号后续写、继续做题，不会结束监考。上传成功后成绩才能有效；选择结束监考后无法继续本场比赛，断网时可补传。',
            buttons: ['继续监考', '保留日志退出', '上传日志并结束监考'],
            primaryIds: [0, 2],
            secondaryDetail: '保留日志退出不会结束监考，也不会确认成绩；下次登录原账号后可继续监考。',
            defaultId: 0,
            cancelId: 0,
        });
        response = choice.response;
    } catch (error) {
        diagnostics.error('exit.prompt-failed', error);
        exiting = false;
        applyWindowFocus();
        return;
    }
    if (![1, 2].includes(response)) {
        exiting = false;
        applyWindowFocus();
        return;
    }
    firewall.cancelPendingLock?.();
    clearInterval(timer);
    antiCheat.stop();
    window.setKiosk(false);
    window.setAlwaysOnTop(false);
    if (response === 1) {
        try {
            await diagnostics.span('exit.pause', () => activity.run('exit', 'pause', () => controller.pause()));
            try {
                await diagnostics.span('exit.restore-network', () => firewall.unlock());
            } catch (error) {
                diagnostics.error('exit.network-recovery-deferred', error);
                await showExamDialog({
                    type: 'warning',
                    message: '日志已保留，系统网络尚未确认恢复',
                    detail: 'WFP 临时规则会在网络辅助进程退出后由系统清理。请保留客户端数据；若仍无法联网，请退出客户端后检查系统网络设置。',
                });
            }
            completeExit();
        } catch (error) {
            diagnostics.error('exit.pause-failed', error);
            exiting = false;
            controller.finishing = false;
            timer = setInterval(() => syncLogin(true), 15000);
            await syncLogin();
            applyWindowFocus();
        }
        return;
    }
    let restored = false;
    let networkWarning = '';
    try {
        const uploaded = await diagnostics.span('exit.finish-and-upload', () =>
            controller.finish(async () => {
                await showUploadWindow();
                const auditOnly = process.platform === 'darwin';
                publishStatus({
                    ...latestStatus,
                    upload: { phase: auditOnly ? 'preparing' : 'restoring-network', percent: null },
                    message: auditOnly ? '正在准备加密日志，随后自动上传。' : '正在恢复系统网络，请稍候；日志随后会自动上传。',
                });
                try {
                    await diagnostics.span('exit.restore-network', () => firewall.unlock());
                    restored = true;
                } catch (error) {
                    networkWarning =
                        '系统网络尚未确认恢复。WFP 临时规则会在网络辅助进程退出后由系统清理；若仍无法联网，请退出客户端后检查系统网络设置。';
                    diagnostics.error('exit.network-recovery-deferred', error);
                    // 即使 Windows 网络恢复失败，也封存证据并尝试向允许的 OJ 上传。
                    // 此时不能恢复考试或反复触发 UAC 提权。
                    publishStatus({ ...latestStatus, message: networkWarning });
                }
            }),
        );
        exitReady = true;
        publishStatus({
            ...latestStatus,
            upload: uploaded
                ? { ...latestStatus.upload, phase: 'complete', percent: 100 }
                : { phase: 'deferred', sent: 0, total: 0, percent: null },
            message: uploaded
                ? latestStatus.upload?.empty
                    ? '本次没有需要上传的监考日志，可以退出客户端。'
                    : '日志上传完成，服务端已确认接收。'
                : '日志已加密保存，成绩待确认。联网后请使用原考试账号补传。',
            networkWarning,
        });
    } catch (error) {
        diagnostics.error('exit.failed', error);
        await showExamDialog(
            {
                type: 'error',
                message: '结束监考失败，请保留客户端数据',
                detail: restored ? '本地日志仍保留，请重试结束监考。' : '系统网络尚未恢复，请重试，或使用随包提供的恢复脚本。',
            },
            uploadWindow && !uploadWindow.isDestroyed() ? uploadWindow : window,
        );
        exiting = false;
        // 已进入结束流程的会话只重试封存和上传，不恢复考试访问。
        controller.finishing = false;
        if (uploadWindow && !uploadWindow.isDestroyed()) {
            uploadWindow.destroy();
            uploadWindow = null;
        }
        timer = setInterval(() => syncLogin(true), 15000);
        await syncLogin();
        applyWindowFocus();
    }
}

async function pageLoadFailed(code: number, message: string, url: string, isMainFrame: boolean) {
    if (code === -3) return; // 重定向或重新加载时取消导航属于正常行为。
    trace('error', 'page.load-failed', { code, message, url });
    if (
        !startupReady
        || !isMainFrame
        || pageFailurePrompt
        || exiting
        || quitting
        || !config.exam.allowedOrigins.includes(new URL(url).origin)
    ) {
        return;
    }
    pageFailurePrompt = true;
    const error = new Error(`net::${message}`);
    controller.authenticationFailed(error);
    try {
        async function recoverPage(): Promise<void> {
            const choice = await showExamDialog({
                type: 'warning',
                title: '考试页面无法加载',
                message: '与 OJ 的连接已中断，页面未能加载',
                detail: `${proctorErrorMessage(error, running.identity.version)}\n可以关闭代理后重试，或退出并保留当前日志。`,
                buttons: ['重试加载', '返回 OJ 首页', '退出／结束监考'],
                defaultId: 0,
                cancelId: 2,
            });
            if (exiting || quitting || window.isDestroyed()) return;
            if (choice.response === 2) {
                await requestExit();
                return;
            }
            try {
                await window.loadURL(choice.response === 0 ? url : config.exam.targetUrl);
                return;
            } catch (retryError) {
                diagnostics.error('page.retry-failed', retryError);
            }
            await recoverPage();
        }
        await recoverPage();
    } finally {
        pageFailurePrompt = false;
    }
}

app.whenReady()
    .then(async () => {
        app.setAboutPanelOptions?.({ applicationName: productName });
        if (process.platform === 'darwin') {
            const menu = Menu?.getApplicationMenu();
            if (menu?.items[0]) menu.items[0].label = productName;
        }
        // 加载 OJ 或打开受保护窗口前，先检查进程权限。
        // 原生辅助进程不会自动请求提权。
        const privilegeGuard = new FirewallGuard({}, null);
        try {
            await privilegeGuard.checkPrivileges();
        } catch (error) {
            privilegeGuard.close();
            if (error.code !== 'ADMIN_REQUIRED') throw error;
            await prompts.show({
                type: 'warning',
                title: '需要管理员权限',
                message: '请使用管理员模式打开监考客户端',
                detail: error.message,
                buttons: ['关闭软件'],
                defaultId: 0,
                cancelId: 0,
            });
            quitting = true;
            app.exit(1);
            return;
        }
        privilegeGuard.close();
        config = loadConfig();
        const updateSession = electronSession?.fromPartition('proctor-updates');
        ipcMain.handle('exam:waiting-status', (event) => {
            waitingWindow.context(event);
            return activity.snapshot();
        });
        // 准备耗时明显时才打开本地 React 进度窗口；
        // 网络恢复始终先于 OJ 页面加载完成。
        preparationTimer = setTimeout(
            () => waitingWindow.show().catch((error) => diagnostics.error('startup.progress-failed', error)),
            350,
        );
        if (config.debug.allowRoot) await diagnostics.enable(directory);
        trace('info', 'startup.config-loaded', {
            ...running.identity,
            source: running.source,
            debug: config.debug.allowRoot,
        });
        const logger = {
            logViolation: (item: import('./contracts').Violation) => {
                trace('warn', 'guard.event', { source: item.source, type: item.type, url: item.target });
                controller?.logViolation(item);
            },
        };
        firewall = new FirewallGuard(config, logger, {
            trace,
            activity: activity.run.bind(activity),
            lookup: (host: string) => examNetwork.lookup(host),
            auxiliaryEndpoints: () => examNetwork.auxiliaryEndpoints,
            verifyConnectivity: async () => {
                const record = controller.current;
                const login = await identity(
                    new Transport(window.webContents.session, record.context.origin, 5000, trace),
                    record.context,
                    trust,
                );
                if (login.uid !== record.login.uid || login.domainId !== record.login.domainId || login.tid !== record.login.tid) {
                    throw new Error('网络设置期间登录身份已变化，请重新认证');
                }
            },
            onFailure: (error: import('./contracts').ClientError) => {
                diagnostics.error('firewall.protection-lost', error);
                controller?.invalidateIdentity();
                publishStatus({ ...latestStatus, authenticated: false, phase: 'network-error', message: error.message });
            },
        });
        await diagnostics.span('startup.restore-network', () => firewall.recover());
        const bootId = await diagnostics.span('startup.boot-identity', () =>
            activity.run('startup', 'boot-identity', () => prepareBootIdentity()),
        );
        if (!bootId) trace('warn', 'startup.boot-identity-unavailable');
        recoveryReady = true;
        const store = new ProtectedStore(path.join(directory, 'secrets'), safeStorage);
        store.check();
        updates = new Updater(config, {
            directory,
            trust,
            ...running.identity,
            source: running.source,
            failure: running.failure,
            cache: running.cache,
            fetch: (input, init) => (updateSession || window.webContents.session).fetch(input instanceof URL ? input.href : input, init),
            onStatus: (update) => {
                latestStatus.update = update;
                publishClientStatus();
                trace('info', 'update.status', { phase: update.phase, message: update.message });
            },
        });
        const journals = path.join(directory, 'journals');
        window = new BrowserWindow({
            width: 1280,
            height: 800,
            title: productName,
            icon: windowIcon,
            autoHideMenuBar: true,
            webPreferences: {
                preload: path.join(__dirname, '../preload/preload.js'),
                partition: 'persist:hydro-exam',
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                devTools: false,
                webSecurity: true,
            },
        });
        // 页面可更新题目标题，软件名称始终保留在原生窗口标题里。
        window.on('page-title-updated', (event, title) => {
            event.preventDefault();
            const pageTitle = title.trim().slice(0, 160);
            window.setTitle(pageTitle && pageTitle !== productName ? `${pageTitle} · ${productName}` : productName);
        });
        protectExamInput(window.webContents, logger);
        examNetwork = new ExamNetwork(window.webContents.session,
            [...new Set([...config.exam.allowedOrigins, ...(config.updater.allowedOrigins || [])])], trace, () => firewall.refresh(), updateSession);
        if (process.platform === 'win32') await diagnostics.span('startup.direct-connection', () => examNetwork.prepare());
        await diagnostics.span('startup.clear-login', () => resetLogin(window.webContents.session));
        network = new NetworkGuard(config, logger);
        network.install(window);
        antiCheat = new AntiCheatGuard(window, config, logger);
        controller = new ProctorController({
            config,
            directory: journals,
            protectedStore: store,
            session: window.webContents.session,
            version: running.identity.version,
            onIdentity: applyIdentity,
            onStatus: publishStatus,
            trace,
            activity: activity.run.bind(activity),
        });
        let loginTimer: ReturnType<typeof setTimeout>;
        observeLogin(window.webContents.session, config.exam.allowedOrigins, () => {
            trace('info', 'identity.login-cookie-changed');
            controller.invalidateIdentity();
            applyIdentity(null).catch((error) => diagnostics.error('identity.revoke-failed', error));
            clearTimeout(loginTimer);
            loginTimer = setTimeout(() => syncLogin(true), 200);
        });
        ipcMain.handle('exam:status', (event) => {
            ipcContext(event);
            return statusSnapshot(true);
        });
        ipcMain.handle('exam:update-check', async (event) => {
            ipcContext(event);
            if (!config.updater.enabled) throw new Error('更新功能未启用');
            await updates.check({ force: true });
            return updates.snapshot();
        });
        ipcMain.handle('exam:update-install', async (event) => {
            ipcContext(event);
            if (!config.updater.enabled) throw new Error('更新功能未启用');
            if (exiting || hasUnfinishedJournals(directory)) throw new Error('请先上传日志并结束所有监考，再更新客户端');
            await updates.stage();
            const choice = await showExamDialog({
                type: 'question',
                message: 'ASAR 更新已通过验证',
                detail: '现在重启以应用更新？重启后需要重新登录。',
                buttons: ['稍后重启', '立即重启'],
                defaultId: 0,
                cancelId: 0,
            });
            if (choice.response === 1) {
                if (exiting || hasUnfinishedJournals(directory)) throw new Error('监考已开始，更新将在结束监考后重启生效');
                await firewall.unlock();
                controller.shutdown();
                quitting = true;
                app.relaunch();
                app.quit();
            }
            return updates.snapshot();
        });
        ipcMain.handle('exam:update-download', async (event) => {
            ipcContext(event);
            if (!config.updater.enabled || !updates.installerUrl) throw new Error('清单没有当前平台的安装包地址');
            await shell.openExternal(updates.installerUrl);
        });
        ipcMain.handle('exam:proctor-headers', async (event, request) => {
            const url = ipcContext(event);
            if (updates.minimumBlocked) throw new Error('客户端低于更新清单指定的最低版本，请安装新版');
            try {
                return await controller.headers(url, request);
            } catch (error) {
                // Electron IPC 只保留 Error.message，不保留 publicMessage 和 code。
                if (error.publicMessage || isNetworkError(error)) {
                    throw new Error(proctorErrorMessage(error, running.identity.version));
                }
                throw error;
            }
        });
        ipcMain.handle('exam:request-quit', async (event) => {
            ipcContext(event);
            await requestExit();
        });
        ipcMain.handle('exam:retry', async (event) => {
            await controller.retryManually(ipcContext(event));
        });
        ipcMain.handle('exam:upload-status', (event) => {
            uploadContext(event);
            return { ...latestStatus, activity: activity.snapshot() };
        });
        ipcMain.handle('exam:upload-exit', (event) => {
            uploadContext(event);
            if (!exitReady) throw new Error('日志仍在处理中');
            completeExit();
        });
        ipcMain.handle('exam:debug', async (event) => {
            await controller.sync(ipcContext(event), { force: true });
            if (!root || !config.debug.allowRoot) throw new Error('只有已验证的 root 账号可以使用调试模式');
            requireDebug();
            await debugConsole.show();
            return true;
        });
        ipcMain.handle('exam:debug-logs', (event, after) => {
            debugConsole.context(event);
            requireDebug();
            if (!Number.isSafeInteger(after) || after < 0) throw new Error('诊断日志读取位置无效');
            return diagnostics.snapshot(after);
        });
        ipcMain.handle('exam:debug-devtools', (event) => {
            debugConsole.context(event);
            requireDebug();
            return debugConsole.showPage(window.webContents.getURL(), window.webContents.session,
                () => debug && root && Date.now() < debugExpiry);
        });
        const requests = window.webContents.session.webRequest;
        requests.onResponseStarted((details) => examNetwork.observe(details));
        const requestMethods = new Map();
        const requestGuard = new ProctorRequestGuard(controller, config, window.webContents, () => updates.minimumBlocked);
        requests.onBeforeSendHeaders((details, callback) => {
            requestGuard
                .headers(details)
                .then((headers) => {
                    if (
                        details.webContentsId === window.webContents.id
                        && Object.keys(headers).some((key) => key.toLowerCase() === 'x-proctor-token')
                    ) {
                        controller.inFlight.add(details.id);
                        requestMethods.set(details.id, details.method);
                    }
                    callback({ requestHeaders: headers });
                })
                .catch((error) => {
                    diagnostics.error('request.blocked', error, { method: details.method, url: details.url });
                    callback({ cancel: true });
                });
        });
        const settled = (details: Electron.OnCompletedListenerDetails & { error?: string }) => {
            const read = requestMethods.get(details.id) === 'GET';
            requestMethods.delete(details.id);
            // WebSocket 升级成功后，Chromium 会以 ERR_WS_UPGRADE 结束 URLRequest。
            const upgraded = details.error === 'net::ERR_WS_UPGRADE' && details.statusCode === 101 && /^wss?:/.test(details.url);
            const failure = details.error && details.error !== 'net::OK' && !upgraded ? details.error : undefined;
            if (upgraded) trace('info', 'request.websocket-upgraded', { url: details.url, status: details.statusCode });
            if (failure || details.statusCode >= 400) {
                trace(failure && failure !== 'net::ERR_BLOCKED_BY_CLIENT' ? 'error' : 'warn', 'request.response', {
                    url: details.url,
                    status: details.statusCode,
                    message: failure,
                });
            }
            if (controller.inFlight.delete(details.id)) {
                controller.logViolation({
                    source: read ? 'ACCESS' : 'SUBMISSION',
                    type: read ? 'ACCESS_RESPONSE' : 'SUBMISSION_RESPONSE',
                    target: details.url,
                    detail: String(details.statusCode || details.error || ''),
                });
            }
        };
        requests.onCompleted(settled);
        requests.onErrorOccurred(settled);

        window.webContents.on('did-navigate', () => syncLogin());
        window.webContents.on('did-navigate-in-page', () => syncLogin());
        window.on('unresponsive', () => trace('error', 'window.unresponsive'));
        window.on('responsive', () => trace('info', 'window.responsive'));
        window.webContents.on('did-fail-load', (_event, code, message, url, isMainFrame) => {
            pageLoadFailed(code, message, url, isMainFrame).catch((error) => diagnostics.error('page.error-prompt-failed', error));
        });
        window.webContents.on('render-process-gone', (_event, details) => {
            trace('error', 'renderer.crashed', { reason: details?.reason, exitCode: details?.exitCode });
            controller.logViolation({ source: 'CLIENT', type: 'RENDERER_CRASH', target: '', detail: '' });
        });
        window.on('close', (event) => {
            if (!quitting) {
                event.preventDefault();
                requestExit();
            }
        });
        await diagnostics.span('startup.load-exam', () =>
            activity.run('startup', 'load-exam', () => window.loadURL(config.exam.targetUrl)),
        );
        trace('info', 'startup.ready');
        startupReady = true;
        clearTimeout(preparationTimer);
        waitingWindow.close();
        running.markReady();
        if (running.failure) trace('warn', 'update.rollback', running.failure);
        // 获取更新清单不能延迟登录和比赛认证。
        if (config.updater.enabled) {
            setTimeout(
                () =>
                    diagnostics
                        .span('startup.update-check', () => updates.check())
                        .catch((error) => diagnostics.error('update.check-failed', error)),
                0,
            );
        }
        lastTick = Date.now();
        setInterval(() => {
            const now = Date.now();
            const delay = now - lastTick - 1000;
            lastTick = now;
            if (delay > 2000) trace('warn', 'main.event-loop-delayed', { durationMs: delay });
            if (debug && now >= debugExpiry) {
                applyIdentity(null).catch((error) => diagnostics.error('identity.revoke-failed', error));
            }
        }, 1000);
        timer = setInterval(() => syncLogin(true), 15000);
    })
    .catch(async (error) => {
        clearTimeout(preparationTimer);
        waitingWindow.close();
        diagnostics.error('startup.failed', error);
        try {
            await prompts.show({
                type: 'error',
                title: '客户端启动失败',
                message: '客户端启动失败',
                detail: error.message,
                buttons: ['关闭软件'],
            });
        } catch (promptError) {
            diagnostics.error('startup.prompt-failed', promptError);
        }
        try {
            if (recoveryReady) await firewall?.unlock();
        } catch (restoreError) {
            diagnostics.error('startup.restore-failed', restoreError);
        }
        await diagnostics.pending;
        app.exit(1);
    });
app.on('before-quit', (event) => {
    if (!quitting && window) {
        event.preventDefault();
        requestExit();
    }
});
app.on('will-quit', () => {
    clearTimeout(debugTimer);
    firewall?.close();
    examNetwork?.close();
    antiCheat?.close();
});
// 正常退出在 requestExit 中等待网络恢复；强制退出由管理员权限的守护进程处理。
// Node 的 exit 事件无法等待异步子进程结束。
