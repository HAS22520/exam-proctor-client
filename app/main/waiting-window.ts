import path = require('node:path');
import { pathToFileURL } from 'node:url';

class WaitingWindow {
  declare BrowserWindow: typeof import('electron').BrowserWindow;
  declare window: Electron.BrowserWindow | null;

  constructor(BrowserWindow: WaitingWindow['BrowserWindow']) {
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
      title: '正在准备监考客户端',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '../status/waiting-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: false,
      },
    }));
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.on('close', (event) => event.preventDefault());
    try {
      await window.loadFile(path.join(__dirname, '../status/waiting.html'));
      if (this.window === window && !window.isDestroyed()) window.show();
    } catch (error) {
      if (!window.isDestroyed()) throw error;
    }
  }
  context(event: Electron.IpcMainInvokeEvent) {
    const window = this.window;
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== pathToFileURL(path.join(__dirname, '../status/waiting.html')).href
    )
      throw new Error('Waiting IPC requires the native progress window');
  }
  publish(status: import('./contracts').ActivityStatus | null) {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('exam:waiting-status', status);
  }
  close() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
export = WaitingWindow;
