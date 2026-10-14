import { DEFAULT_PRODUCT_NAME } from '../../shared/branding';
import { localPreferences, pageFile, requireLocalFrame, secureLocalPage, windowIcon } from './local-page';

class DebugConsole {
    declare BrowserWindow: typeof import('electron').BrowserWindow;
    declare window: Electron.BrowserWindow | null;
    private page: Electron.BrowserWindow | null = null;

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

    async showPage(url: string, session: Electron.Session, allowed: () => boolean) {
        if (this.page && !this.page.isDestroyed()) this.page.destroy();
        const page = new this.BrowserWindow({
            width: 1100, height: 760, title: `管理员页面调试 · ${this.productName}`,
            webPreferences: { session, nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: true },
        });
        this.page = page;
        page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        page.on('closed', () => { if (this.page === page) this.page = null; });
        try {
            await page.loadURL(url);
            if (this.page === page && !page.isDestroyed()) {
                if (allowed()) page.webContents.openDevTools({ mode: 'detach' });
                else page.destroy();
            }
        } catch (error) {
            if (this.page === page && !page.isDestroyed()) {
                page.destroy();
                throw error;
            }
        }
    }

    context(event: Electron.IpcMainInvokeEvent) {
        requireLocalFrame(this.window, 'console', event);
    }

    close() {
        if (this.page && !this.page.isDestroyed()) this.page.destroy();
        this.page = null;
        if (this.window && !this.window.isDestroyed()) this.window.destroy();
        this.window = null;
    }
}

export = DebugConsole;
