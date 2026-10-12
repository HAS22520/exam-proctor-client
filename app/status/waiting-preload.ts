import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('waitingAPI', {
  status: () => ipcRenderer.invoke('exam:waiting-status'),
  onStatus: (callback: (status: import('../main/contracts').ActivityStatus) => void) =>
    ipcRenderer.on('exam:waiting-status', (_, status) => callback(status)),
});
