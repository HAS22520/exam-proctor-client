import { DEFAULT_PRODUCT_NAME } from '../../shared/branding';
import { localPreferences, pageFile, requireLocalFrame, secureLocalPage, windowIcon } from './local-page';

class DebugConsole {
    declare BrowserWindow: typeof import('electron').BrowserWindow;
    declare window: Electron.BrowserWindow | null;

    constructor(
        BrowserWindow: DebugConsole['BrowserWindow'],
        private productName = DEFAULT_PRODUCT_NAME,
    ) {
        this.BrowserWindow = BrowserWindow;
    }

    async show() {
        if (this.window && !this.window.isDestroyed()) {
            this.window.show();
            this.window.focus();
            return;
        }
        const window = new this.BrowserWindow({
            width: 960,
            height: 640,
            minWidth: 620,
            minHeight: 400,
            title: `调试控制台 · ${this.productName}`,
            show: false,
            autoHideMenuBar: true,
            icon: windowIcon,
            webPreferences: { ...localPreferences('debug'), partition: 'proctor-console' },
        });
        this.window = window;
        secureLocalPage(window);
        window.on('closed', () => {
            if (this.window === window) this.window = null;
        });
        try {
            await window.loadFile(pageFile('console'));
            if (this.window === window && !window.isDestroyed()) {
                window.show();
                window.focus();
            }
        } catch (error) {
            if (!window.isDestroyed()) throw error;
        }
    }

    context(event: Electron.IpcMainInvokeEvent) {
        requireLocalFrame(this.window, 'console', event);
    }

    close() {
        if (this.window && !this.window.isDestroyed()) this.window.destroy();
        this.window = null;
    }
}

export = DebugConsole;
