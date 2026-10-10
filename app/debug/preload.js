const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('debugAPI', {
  logs: (after) => ipcRenderer.invoke('exam:debug-logs', after),
  devtools: () => ipcRenderer.invoke('exam:debug-devtools'),
});
