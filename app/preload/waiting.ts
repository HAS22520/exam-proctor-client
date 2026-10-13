import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('waitingAPI', {
    status: () => ipcRenderer.invoke('exam:waiting-status'),
    onStatus: (callback: (status: import('../main/contracts').ActivityStatus | null) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, status: import('../main/contracts').ActivityStatus | null) => callback(status);
        ipcRenderer.on('exam:waiting-status', listener);
        return () => ipcRenderer.removeListener('exam:waiting-status', listener);
    },
});
