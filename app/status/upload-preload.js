const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('uploadAPI', {
  status: () => ipcRenderer.invoke('exam:upload-status'),
  exit: () => ipcRenderer.invoke('exam:upload-exit'),
  onStatus: (callback) => ipcRenderer.on('exam:upload-status', (_, status) => callback(status)),
});
