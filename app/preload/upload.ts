import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('uploadAPI', {
    status: () => ipcRenderer.invoke('exam:upload-status'),
    exit: () => ipcRenderer.invoke('exam:upload-exit'),
    onStatus: (callback: (status: import('../main/contracts').ClientStatus) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, status: import('../main/contracts').ClientStatus) => callback(status);
        ipcRenderer.on('exam:upload-status', listener);
        return () => ipcRenderer.removeListener('exam:upload-status', listener);
    },
});
