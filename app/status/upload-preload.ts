import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('uploadAPI', {
  status: () => ipcRenderer.invoke('exam:upload-status'),
  exit: () => ipcRenderer.invoke('exam:upload-exit'),
  onStatus: (callback: (status: import('../main/contracts').ClientStatus) => void) =>
    ipcRenderer.on('exam:upload-status', (_, status) => callback(status)),
});
