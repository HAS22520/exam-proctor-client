import { DEFAULT_PRODUCT_NAME } from '../../shared/branding';
import { localPreferences, pageFile, requireLocalFrame, secureLocalPage, windowIcon } from './local-page';

class WaitingWindow {
    declare BrowserWindow: typeof import('electron').BrowserWindow;
    declare window: Electron.BrowserWindow | null;

    constructor(
        BrowserWindow: WaitingWindow['BrowserWindow'],
        private productName = DEFAULT_PRODUCT_NAME,
    ) {
        this.BrowserWindow = BrowserWindow;
        this.window = null;
    }

    async show() {
        if (this.window) return;
        const window = (this.window = new this.BrowserWindow({
            width: 540,
            height: 430,
            useContentSize: true,
            resizable: false,
            show: false,
            title: `正在准备 · ${this.productName}`,
            autoHideMenuBar: true,
            icon: windowIcon,
            webPreferences: { ...localPreferences('waiting'), partition: 'proctor-waiting' },
        }));
        secureLocalPage(window);
        window.on('close', (event) => event.preventDefault());
        try {
            await window.loadFile(pageFile('waiting'));
            if (this.window === window && !window.isDestroyed()) window.show();
        } catch (error) {
            if (!window.isDestroyed()) throw error;
        }
    }

    context(event: Electron.IpcMainInvokeEvent) {
        requireLocalFrame(this.window, 'waiting', event);
    }

    publish(status: import('../contracts').ActivityStatus | null) {
        if (this.window && !this.window.isDestroyed()) this.window.webContents.send('exam:waiting-status', status);
    }

    close() {
        if (this.window && !this.window.isDestroyed()) this.window.destroy();
        this.window = null;
    }
}
export = WaitingWindow;
