import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('debugAPI', {
    logs: (after: number) => ipcRenderer.invoke('exam:debug-logs', after),
    devtools: () => ipcRenderer.invoke('exam:debug-devtools'),
});
