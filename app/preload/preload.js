const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('examAPI', {
  proctorHeaders: (request) => ipcRenderer.invoke('exam:proctor-headers', request),
  requestQuit: () => ipcRenderer.invoke('exam:request-quit'),
  status: () => ipcRenderer.invoke('exam:status'),
});
window.addEventListener('DOMContentLoaded', () => {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  box.style.cssText = 'padding:12px;background:#172033;color:white;border-radius:12px;font:13px system-ui;box-shadow:0 4px 20px #0004;max-width:360px';
  const status = document.createElement('div');
  const end = document.createElement('button');
  end.textContent = '结束监考';
  end.style.cssText = 'margin-top:8px;padding:6px 12px;cursor:pointer';
  end.onclick = () => ipcRenderer.invoke('exam:request-quit').catch(() => {});
  const debug = document.createElement('button');
  debug.textContent = 'root 调试'; debug.hidden = true;
  debug.onclick = () => ipcRenderer.invoke('exam:debug').catch(() => {});
  const retry = document.createElement('button'); retry.textContent = '补传日志'; retry.hidden = true;
  retry.onclick = () => ipcRenderer.invoke('exam:retry').catch(() => {});
  box.append(status, end, retry, debug); shadow.append(box); document.documentElement.append(host);
  async function update() {
    try {
      const data = await ipcRenderer.invoke('exam:status');
      const elapsed = data.createdAt ? ` · ${Math.floor((Date.now() - Date.parse(data.createdAt)) / 60000)} 分钟` : '';
      status.textContent = `${data.debug ? 'root 调试模式' : data.authenticated ? '监考认证已连接' : '未建立监考会话'}${elapsed}${data.pendingUploads ? ` · 待补传 ${data.pendingUploads}` : ''}${data.message ? `\n${data.message}` : ''}`;
      status.style.whiteSpace = 'pre-line';
      debug.hidden = !(data.root && data.allowRootDebug);
      retry.hidden = !data.pendingUploads;
    } catch { status.textContent = '请返回考试系统查看监考状态'; }
  }
  update(); setInterval(update, 5000);
});
