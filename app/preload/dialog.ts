import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dialogAPI', {
    model: () => ipcRenderer.invoke('exam:dialog-model'),
    respond: (response: number, checkboxChecked: boolean) => ipcRenderer.invoke('exam:dialog-response', response, checkboxChecked),
});
