import { contextBridge, ipcRenderer } from 'electron';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Panel, type PanelBridge } from '../renderer/pages/Panel';
import panelStyles from '../renderer/styles/panel.css';
import type { ActivityStatus, ClientStatus } from '../types/status';

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
  let latest: ClientStatus = {}, revision = 0;
  const bridge: PanelBridge = {
    async status() {
      const requested = revision;
      const next: ClientStatus = await ipcRenderer.invoke('exam:status');
      // 请求期间收到实时进度时保留该进度，身份字段仍接受主进程快照。
      latest = requested === revision ? next : { ...next, activity: latest.activity };
      return latest;
    },
    onStatus(callback) {
      const listener = (_event: Electron.IpcRendererEvent, activity: ActivityStatus) => {
        revision++; latest = { ...latest, activity }; callback(latest);
      };
      ipcRenderer.on('exam:activity-status', listener);
      return () => ipcRenderer.removeListener('exam:activity-status', listener);
    },
    action: (channel) => ipcRenderer.invoke(channel),
  };
  createRoot(container).render(createElement(Panel, { bridge, host }));
});
