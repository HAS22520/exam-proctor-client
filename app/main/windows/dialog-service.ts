import type { DialogModel } from '../../types/dialog';
import { localPreferences, pageFile, requireLocalFrame, secureLocalPage, windowIcon } from './local-page';

interface Dependencies {
    productName?: string;
    BrowserWindow: typeof import('electron').BrowserWindow;
    ipcMain: Pick<Electron.IpcMain, 'handle'>;
    dialog: Pick<Electron.Dialog, 'showMessageBox'>;
    platform?: NodeJS.Platform;
}
interface PendingDialog {
    window: Electron.BrowserWindow;
    model: DialogModel;
    settle(value: Electron.MessageBoxReturnValue): void;
}
export interface ClientDialogOptions extends Electron.MessageBoxOptions {
    primaryIds?: number[];
    secondaryDetail?: string;
}

/** Windows 全部采用 React；macOS 普通提示可原生展示，操作分级弹窗统一使用 React。 */
export class DialogService {
    private pending = new Map<Electron.WebContents, PendingDialog>();
    constructor(private dependencies: Dependencies) {
        dependencies.ipcMain.handle('exam:dialog-model', (event) => this.context(event).model);
        dependencies.ipcMain.handle('exam:dialog-response', (event, response: unknown, checked: unknown) => {
            const item = this.context(event);
            if (
                !Number.isSafeInteger(response)
                || typeof response !== 'number'
                || response < 0
                || response >= item.model.buttons.length
                || typeof checked !== 'boolean'
            ) {
                throw new Error('弹窗操作响应无效');
            }
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
        if (item) {
            item.window.restore();
            item.window.show();
            item.window.focus();
        }
    }

    async show(options: ClientDialogOptions, owner?: Electron.BrowserWindow): Promise<Electron.MessageBoxReturnValue> {
        const { BrowserWindow, dialog, platform = process.platform } = this.dependencies;
        // 自定义操作层级的结束弹窗在两个平台均使用 React；其他 macOS 提示仍可原生展示。
        if (platform === 'darwin' && !options.primaryIds) {
            return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
        }
        const buttons = options.buttons?.length ? [...options.buttons] : ['确定'];
        const validIndex = (index: number, fallback: number) =>
            Number.isInteger(index) && index >= 0 && index < buttons.length ? index : fallback;
        const title = this.dependencies.productName
            ? `${options.title || '提示'} · ${this.dependencies.productName}`
            : options.title || '监考客户端';
        const model: DialogModel = {
            title,
            message: options.message,
            detail: options.detail,
            type: options.type,
            buttons,
            defaultId: validIndex(options.defaultId, 0),
            cancelId: validIndex(options.cancelId, buttons.length - 1),
            checkboxLabel: options.checkboxLabel,
            checkboxChecked: options.checkboxChecked,
            primaryIds: options.primaryIds?.filter((index) => Number.isInteger(index) && index >= 0 && index < buttons.length),
            secondaryDetail: options.secondaryDetail,
        };
        const window = new BrowserWindow({
            width: 620,
            height: 430,
            minWidth: 520,
            minHeight: 360,
            useContentSize: true,
            title: model.title,
            icon: windowIcon,
            parent: owner,
            modal: !!owner,
            show: false,
            minimizable: false,
            fullscreenable: false,
            // Windows 操作全部放在 React 页面中；禁用标题栏与最大化，避免系统按钮绕过操作提示。
            frame: platform !== 'win32',
            maximizable: false,
            resizable: false,
            autoHideMenuBar: true,
            webPreferences: { ...localPreferences('dialog'), partition: 'proctor-dialog' },
        });
        // closed 触发时原生窗口已经销毁，不能再通过 window.webContents 访问它。
        const contents = window.webContents;
        secureLocalPage(window);
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (value: Electron.MessageBoxReturnValue) => {
                if (settled) return;
                settled = true;
                this.pending.delete(contents);
                if (!window.isDestroyed()) window.destroy();
                resolve(value);
            };
            const fail = (error: Error) => {
                if (settled) return;
                settled = true;
                this.pending.delete(contents);
                if (!window.isDestroyed()) window.destroy();
                reject(error);
            };
            this.pending.set(contents, { window, model, settle });
            window.on('closed', () => settle({ response: model.cancelId, checkboxChecked: !!model.checkboxChecked }));
            contents.once('render-process-gone', () => fail(new Error('提示页面进程已退出，请重试。')));
            contents.once('preload-error', () => fail(new Error('提示页面通信桥加载失败，请重试。')));
            // 内容加载完成后再显示弹窗，并主动将焦点交给它。
            window
                .loadFile(pageFile('dialog'))
                .then(() => {
                    if (!settled && !window.isDestroyed()) {
                        window.show();
                        window.focus();
                    }
                })
                .catch(fail);
        });
    }
}
