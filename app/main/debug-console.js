const path = require('node:path');
const { pathToFileURL } = require('node:url');

class DebugConsole {
  constructor(BrowserWindow) { this.BrowserWindow = BrowserWindow; }

  async show() {
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return; }
    const window = new this.BrowserWindow({ width: 960, height: 640, minWidth: 620, minHeight: 400,
      title: '管理员调试控制台', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, '../debug/preload.js'), partition: 'proctor-debug-console',
        nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false } });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith(pathToFileURL(path.join(__dirname, '../debug/')).href) });
    });
    window.on('closed', () => { if (this.window === window) this.window = null; });
    await window.loadFile(path.join(__dirname, '../debug/console.html'));
  }

  context(event) {
    const window = this.window;
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame.url !== pathToFileURL(path.join(__dirname, '../debug/console.html')).href) {
      throw new Error('Debug IPC requires the native console main frame');
    }
  }

  close() { if (this.window && !this.window.isDestroyed()) this.window.destroy(); this.window = null; }
}

module.exports = DebugConsole;
