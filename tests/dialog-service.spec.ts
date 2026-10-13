import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { DialogService } from '../app/main/windows/dialog-service';
import { forEachSerial } from './helpers';

function fixture(platform = 'win32', failLoad = false) {
    const handlers = new Map();
    const windows: any[] = [];
    const native: any[] = [];
    class Window extends EventEmitter {
        contents: any;
        destroyed = false;
        shown = false;
        focused = false;
        constructor(public options) {
            super();
            const contents: any = new EventEmitter();
            Object.assign(contents, {
                mainFrame: { url: '' },
                setWindowOpenHandler: () => {},
                session: { webRequest: { onBeforeRequest: () => {} } },
            });
            this.contents = contents;
            windows.push(this);
        }

        get webContents() {
            if (this.destroyed) throw new TypeError('Object has been destroyed');
            return this.contents;
        }

        async loadFile(filename) {
            if (failLoad) throw new Error('页面加载失败');
            this.webContents.mainFrame.url = pathToFileURL(filename).href;
        }

        show() {
            this.shown = true;
        }

        focus() {
            this.focused = true;
        }

        restore() {}
        isDestroyed() {
            return this.destroyed;
        }

        destroy() {
            this.destroyed = true;
            this.emit('closed');
        }
    }
    const service = new DialogService({
        BrowserWindow: Window as any,
        platform: platform as NodeJS.Platform,
        ipcMain: {
            handle: (name, callback) => {
                handlers.set(name, callback);
            },
        },
        dialog: {
            showMessageBox: (async (...args) => {
                native.push(args);
                return { response: 1, checkboxChecked: false };
            }) as any,
        },
    });
    const event = (window) => ({ sender: window.contents, senderFrame: window.contents.mainFrame });
    return { service, handlers, windows, native, event };
}

test('Windows React 弹窗持有焦点，拒绝外部页面和伪造响应，并只完成一次', async () => {
    const f = fixture();
    const result = f.service.show({ type: 'question', message: '退出？', buttons: ['继续', '退出'], defaultId: 0, cancelId: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.native.length, 0);
    const window = f.windows[0];
    const event = f.event(window);
    assert.equal(window.shown, true);
    assert.equal(window.focused, true);
    assert.equal(window.options.frame, false);
    assert.equal(window.options.maximizable, false);
    assert.equal(window.options.resizable, false);
    assert.equal(window.options.webPreferences.sandbox, true);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.deepEqual(f.handlers.get('exam:dialog-model')(event).buttons, ['继续', '退出']);
    for (const forged of [
        { ...event, senderFrame: { url: event.senderFrame.url } },
        { ...event, sender: {} },
    ]) {
        assert.throws(() => f.handlers.get('exam:dialog-model')(forged), /受信任的本地主页面/);
    }
    for (const response of [-1, 2, 0.5, '1']) {
        assert.throws(() => f.handlers.get('exam:dialog-response')(event, response, false), /弹窗操作响应无效/);
    }
    f.handlers.get('exam:dialog-response')(event, 1, true);
    assert.deepEqual(await result, { response: 1, checkboxChecked: true });
    assert.equal(window.destroyed, true);
    assert.throws(() => f.handlers.get('exam:dialog-response')(event, 0, false), /受信任的本地主页面/);
});

test('关闭 React 弹窗执行取消动作，页面加载失败后允许恢复焦点', async () => {
    const f = fixture();
    const result = f.service.show({ message: '提示', buttons: ['继续', '退出'], cancelId: 0 });
    f.windows[0].destroy();
    assert.equal((await result).response, 0);
    const failed = fixture('win32', true);
    await assert.rejects(failed.service.show({ message: '提示' }), /页面加载失败/);
    assert.equal(failed.windows[0].destroyed, true);
});

test('已销毁的结束弹窗按继续监考处理，清理过期 IPC 时不访问原生窗口', async () => {
    const f = fixture();
    const result = f.service.show({
        message: '退出客户端还是结束监考？',
        buttons: ['继续监考', '保留日志退出', '上传日志并结束监考'],
        primaryIds: [0, 2],
        cancelId: 0,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const window = f.windows[0];
    const event = f.event(window);
    assert.doesNotThrow(() => window.destroy());
    assert.throws(() => window.webContents, /Object has been destroyed/);
    assert.deepEqual(await result, { response: 0, checkboxChecked: false });
    assert.throws(() => f.handlers.get('exam:dialog-model')(event), /受信任的本地主页面/);
    assert.doesNotThrow(() => f.service.focus());
    assert.doesNotThrow(() => window.emit('closed'));
});

test('macOS 普通提示可保留原生弹窗，无需创建 React 窗口', async () => {
    const f = fixture('darwin');
    assert.equal((await f.service.show({ message: '提示' })).response, 1);
    assert.equal(f.native.length, 1);
    assert.equal(f.windows.length, 0);
});

test('macOS 分级结束弹窗使用 React，保留上传及取消的操作编号', async () => {
    const f = fixture('darwin');
    const result = f.service.show({
        message: '结束监考',
        buttons: ['继续监考', '保留日志退出', '上传日志并结束监考'],
        primaryIds: [0, 2],
        defaultId: 0,
        cancelId: 0,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.native.length, 0);
    const event = f.event(f.windows[0]);
    assert.equal(f.windows[0].options.frame, true);
    assert.deepEqual(f.handlers.get('exam:dialog-model')(event).primaryIds, [0, 2]);
    f.handlers.get('exam:dialog-response')(event, 2, false);
    assert.equal((await result).response, 2);
});

test('页面崩溃或 preload 失败时结束提示流程，不让退出一直等待', async () => {
    await forEachSerial(['render-process-gone', 'preload-error'], async (name) => {
        const f = fixture();
        const result = f.service.show({ message: '退出？', buttons: ['继续', '退出'] });
        f.windows[0].webContents.emit(name);
        await assert.rejects(result, /提示页面/);
        assert.equal(f.windows[0].destroyed, true);
        assert.throws(() => f.handlers.get('exam:dialog-model')(f.event(f.windows[0])), /受信任的本地主页面/);
    });
});
