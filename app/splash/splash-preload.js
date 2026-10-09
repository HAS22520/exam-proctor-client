const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splashAPI', {
  onStatus: (callback) => {
    ipcRenderer.on('splash:status', (event, data) => callback(data));
  }
});
