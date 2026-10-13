import { contextBridge, ipcRenderer } from 'electron';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Panel } from '../renderer/pages/Panel';
import panelStyles from '../renderer/styles/panel.css';
import { createPanelBridge } from './panel-bridge';

// 远程 OJ 只能获取提交证明和普通状态，调试/更新操作桥仅供隔离浮窗使用。
contextBridge.exposeInMainWorld('examAPI', {
  proctorHeaders: (request: unknown) => ipcRenderer.invoke('exam:proctor-headers', request),
  requestQuit: () => ipcRenderer.invoke('exam:request-quit'),
  status: () => ipcRenderer.invoke('exam:status'),
});
window.addEventListener('DOMContentLoaded', () => {
  const host = document.createElement('div');
  host.id = 'hydro-proctor-status';
  host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:calc(100vw - 32px)';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style'); style.textContent = panelStyles;
  const container = document.createElement('div'); shadow.append(style, container);
  document.documentElement.append(host);
  const bridge = createPanelBridge(ipcRenderer);
  createRoot(container).render(createElement(Panel, { bridge, host }));
});
