import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { DialogService } from '../app/main/windows/dialog-service';

function fixture(platform = 'win32', failLoad = false) {
  const handlers = new Map(), windows: any[] = [], native: any[] = [];
  class Window extends EventEmitter {
    webContents: any;
    destroyed = false;
    shown = false;
    focused = false;
    constructor(public options) {
      super();
      const contents: any = new EventEmitter();
      Object.assign(contents, { mainFrame: { url: '' }, setWindowOpenHandler: () => {}, session: { webRequest: { onBeforeRequest: () => {} } } });
      this.webContents = contents;
      windows.push(this);
    }
    async loadFile(filename) { if (failLoad) throw new Error('load failed'); this.webContents.mainFrame.url = pathToFileURL(filename).href; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    restore() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const service = new DialogService({ BrowserWindow: Window as any, platform: platform as NodeJS.Platform,
    ipcMain: { handle: (name, callback) => { handlers.set(name, callback); } },
    dialog: { showMessageBox: (async (...args) => { native.push(args); return { response: 1, checkboxChecked: false }; }) as any } });
  const event = (window) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return { service, handlers, windows, native, event };
}

test('Windows React prompt owns focus, rejects foreign frames and forged responses, and settles once', async () => {
  const f = fixture();
  const result = f.service.show({ type: 'question', message: '退出？', buttons: ['继续', '退出'], defaultId: 0, cancelId: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.native.length, 0);
  const window = f.windows[0], event = f.event(window);
  assert.equal(window.shown, true); assert.equal(window.focused, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.deepEqual(f.handlers.get('exam:dialog-model')(event).buttons, ['继续', '退出']);
  for (const forged of [{ ...event, senderFrame: { url: event.senderFrame.url } }, { ...event, sender: {} }])
    assert.throws(() => f.handlers.get('exam:dialog-model')(forged), /trusted local main frame/);
  for (const response of [-1, 2, 0.5, '1']) assert.throws(() => f.handlers.get('exam:dialog-response')(event, response, false), /Invalid dialog/);
  f.handlers.get('exam:dialog-response')(event, 1, true);
  assert.deepEqual(await result, { response: 1, checkboxChecked: true });
  assert.equal(window.destroyed, true);
  assert.throws(() => f.handlers.get('exam:dialog-response')(event, 0, false), /trusted local main frame/);
});

test('closing a React prompt resolves the explicit cancel action; failed page load rejects for focus restoration', async () => {
  const f = fixture();
  const result = f.service.show({ message: '提示', buttons: ['继续', '退出'], cancelId: 0 });
  f.windows[0].destroy();
  assert.equal((await result).response, 0);
  const failed = fixture('win32', true);
  await assert.rejects(failed.service.show({ message: '提示' }), /load failed/);
  assert.equal(failed.windows[0].destroyed, true);
});

test('macOS can keep its native message box without creating a React window', async () => {
  const f = fixture('darwin');
  assert.equal((await f.service.show({ message: '提示' })).response, 1);
  assert.equal(f.native.length, 1); assert.equal(f.windows.length, 0);
});
