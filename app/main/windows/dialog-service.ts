import type { DialogModel } from '../../types/dialog';
import { localPreferences, pageFile, requireLocalFrame, secureLocalPage, windowIcon } from './local-page';

interface Dependencies {
  BrowserWindow: typeof import('electron').BrowserWindow;
  ipcMain: Pick<Electron.IpcMain, 'handle'>;
  dialog: Pick<Electron.Dialog, 'showMessageBox'>;
  platform?: NodeJS.Platform;
}
interface PendingDialog { window: Electron.BrowserWindow; model: DialogModel; settle(value: Electron.MessageBoxReturnValue): void }

/** Windows 全部采用本地 React 弹窗，macOS 保留系统原生对话框。 */
export class DialogService {
  private pending = new Map<Electron.WebContents, PendingDialog>();
  constructor(private dependencies: Dependencies) {
    dependencies.ipcMain.handle('exam:dialog-model', (event) => this.context(event).model);
    dependencies.ipcMain.handle('exam:dialog-response', (event, response: unknown, checked: unknown) => {
      const item = this.context(event);
      if (!Number.isSafeInteger(response) || typeof response !== 'number' || response < 0 || response >= item.model.buttons.length || typeof checked !== 'boolean')
        throw new Error('Invalid dialog response');
      item.settle({ response, checkboxChecked: checked });
    });
  }
  private context(event: Electron.IpcMainInvokeEvent) {
    const item = this.pending.get(event.sender);
    requireLocalFrame(item?.window, 'dialog', event);
    return item;
  }
  focus() {
    const item = [...this.pending.values()].at(-1);
    if (item) { item.window.restore(); item.window.show(); item.window.focus(); }
  }
  async show(options: Electron.MessageBoxOptions, owner?: Electron.BrowserWindow): Promise<Electron.MessageBoxReturnValue> {
    const { BrowserWindow, dialog, platform = process.platform } = this.dependencies;
    if (platform === 'darwin') return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
    const buttons = options.buttons?.length ? [...options.buttons] : ['确定'];
    const validIndex = (index: number, fallback: number) => Number.isInteger(index) && index >= 0 && index < buttons.length ? index : fallback;
    const model: DialogModel = { title: options.title || '监考客户端', message: options.message, detail: options.detail,
      type: options.type, buttons, defaultId: validIndex(options.defaultId, 0), cancelId: validIndex(options.cancelId, buttons.length - 1),
      checkboxLabel: options.checkboxLabel, checkboxChecked: options.checkboxChecked };
    const window = new BrowserWindow({ width: 620, height: 430, minWidth: 520, minHeight: 360, useContentSize: true,
      title: model.title, icon: windowIcon, parent: owner, modal: !!owner, show: false, minimizable: false, fullscreenable: false,
      autoHideMenuBar: true, webPreferences: { ...localPreferences('dialog'), partition: 'proctor-dialog' } });
    secureLocalPage(window);
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (value: Electron.MessageBoxReturnValue) => {
        if (settled) return;
        settled = true;
        this.pending.delete(window.webContents);
        if (!window.isDestroyed()) window.destroy();
        resolve(value);
      };
      this.pending.set(window.webContents, { window, model, settle });
      window.on('closed', () => settle({ response: model.cancelId, checkboxChecked: !!model.checkboxChecked }));
      // Show after content is loaded, then explicitly give the modal focus.
      window.loadFile(pageFile('dialog')).then(() => {
        if (!settled && !window.isDestroyed()) { window.show(); window.focus(); }
      }).catch((error) => {
        if (settled) return;
        settled = true;
        this.pending.delete(window.webContents);
        if (!window.isDestroyed()) window.destroy();
        reject(error);
      });
    });
  }
}
