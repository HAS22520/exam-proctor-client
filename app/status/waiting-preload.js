const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('waitingAPI', {
  status: () => ipcRenderer.invoke('exam:waiting-status'),
  onStatus: (callback) => ipcRenderer.on('exam:waiting-status', (_, status) => callback(status)),
});
