import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export type LocalPage = 'console' | 'waiting' | 'upload' | 'dialog';
export const rendererRoot = path.resolve(__dirname, '../../renderer');
export const pageFile = (page: LocalPage) => path.join(rendererRoot, `${page}.html`);
export const windowIcon = path.join(rendererRoot, 'assets/icon.png');
export const localPreferences = (bridge: string): Electron.WebPreferences => ({
  preload: path.resolve(__dirname, '../../preload', `${bridge}.js`),
  nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false,
});

/** 本地窗口不能导航到远程内容；IPC 同时限定窗口、主 frame 与完整文件 URL。 */
export function secureLocalPage(window: Electron.BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(pathToFileURL(`${rendererRoot}${path.sep}`).href) });
  });
}
export function requireLocalFrame(window: Electron.BrowserWindow, page: LocalPage, event: Electron.IpcMainInvokeEvent) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    || event.senderFrame.url !== pathToFileURL(pageFile(page)).href) throw new Error(`${page} IPC requires its trusted local main frame`);
}
