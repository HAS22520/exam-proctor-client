import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { INTERNAL_APP_NAME } from '../shared/branding';
import ActivityProgress = require('./diagnostics/activity-progress');
import { configureStorage, migrateStorage, restoreBrowserProfile } from './storage';
import { ENTRY } from './updates/signed-archive';
import { UpdateCache } from './updates/update-cache';
import { DialogService } from './windows/dialog-service';
import WaitingWindow = require('./windows/waiting-window');

// 加载器始终从原安装目录运行，不执行缓存 ASAR 中的加载器。

app.setName(INTERNAL_APP_NAME);
for (const name of ['remote-debugging-port', 'remote-debugging-pipe']) app.commandLine?.removeSwitch(name);
let waitingWindow: WaitingWindow;
const focusStartup = () => waitingWindow?.focus();
// 在实例锁和 Chromium session 初始化前设置目录，避免写回默认 AppData。
(async () => {
    const { root: dataRoot, directory, previous } = configureStorage(app);
    if (!app.requestSingleInstanceLock()) {
        app.exit(0);
        return;
    }
    // 实例锁固定在安装位置根目录；所有 setPath 必须在第一次 await 前完成。
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    app.setPath('userData', directory);
    const root = path.resolve(__dirname, '../..');
    const json = (name: string) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    const identity = json('app/generated/build.json');
    waitingWindow = new WaitingWindow(BrowserWindow, identity.productName);
    const progress = new ActivityProgress({ onChange: (status) => waitingWindow.publish(status) });
    waitingWindow.bindStatus(ipcMain, () => progress.snapshot());
    app.on('second-instance', focusStartup);
    await app.whenReady();
    await progress.run('startup', 'prepare-data', async () => {
        try {
            await waitingWindow.show();
        } catch (error) {
            console.error('无法显示启动窗口：', error.message);
        }
        await migrateStorage(previous, directory);
        await restoreBrowserProfile(directory, path.join(dataRoot, 'browser'));
    });
    const anchor = {
        trust: json('app/generated/trust.json'),
        config: json('app/generated/config.json'),
        identity,
        electronVersion: process.versions.electron,
    };
    const cache = new UpdateCache(directory, anchor);
    const selected = await progress.run('startup', 'verify-app', () => cache.select());
    let adopted = false;
    globalThis.__hydroProctorRuntime = {
        identity: selected ? { ...anchor.identity, version: selected.version, buildVersion: selected.buildVersion } : anchor.identity,
        markReady: () => {
            cache.ready();
            if (!adopted) waitingWindow.close();
        },
        takeWaitingWindow: () => {
            adopted = true;
            return waitingWindow;
        },
        singleInstanceLocked: true,
        source: selected ? 'asar' : 'installed',
        failure: cache.read('failure'),
        cache,
    };
    try {
        // 主入口接管状态 IPC；旧 ASAR 有自己的等待窗和同名处理器。
        ipcMain.removeHandler('exam:waiting-status');
        app.removeListener('second-instance', focusStartup);
        require(selected ? path.join(cache.filename(selected), ENTRY) : './index');
        if (!adopted && waitingWindow.window && !waitingWindow.window.isDestroyed()) waitingWindow.window.hide();
    } catch (error) {
        // 在同一进程重新执行主入口会重复注册 IPC 和事件监听器。
        if (selected && cache.read('launch')) {
            cache.rollback(error.message);
            waitingWindow.close();
            app.relaunch();
            app.exit(1);
        } else throw error;
    }
})().catch(async (error) => {
    await app.whenReady();
    app.removeListener('second-instance', focusStartup);
    ipcMain.removeHandler('exam:dialog-model');
    ipcMain.removeHandler('exam:dialog-response');
    const prompts = new DialogService({ BrowserWindow, dialog, ipcMain });
    try {
        await prompts.show({
            type: 'error',
            title: '客户端启动失败',
            message: '客户端启动失败',
            detail: error.message,
            buttons: ['关闭软件'],
        }, waitingWindow?.visibleWindow);
    } catch (promptError) {
        // 页面损坏时也必须结束进程，Windows 不回退到系统提示框。
        console.error('客户端启动失败：', error.message, '提示页面不可用：', promptError.message);
    } finally {
        waitingWindow?.close();
        app.exit(1);
    }
});
