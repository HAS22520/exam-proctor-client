import type { ActivityStatus, ClientStatus } from '../types/status';
import type { PanelBridge } from '../renderer/pages/Panel';

/** 浮窗私有 IPC 适配器：保留较新推送，拒绝迟到的旧轮询覆盖身份。 */
export function createPanelBridge(ipc: Pick<Electron.IpcRenderer, 'invoke' | 'on' | 'removeListener'>): PanelBridge {
  let latest: ClientStatus = {}, activityRevision = 0, statusRevision = 0, issued = 0, accepted = 0;
  return {
    async status() {
      const requestedActivity = activityRevision, requestedStatus = statusRevision, request = ++issued;
      const next: ClientStatus = await ipc.invoke('exam:status');
      if (requestedStatus !== statusRevision || request < accepted) return latest;
      accepted = request;
      latest = requestedActivity === activityRevision ? next : { ...next, activity: latest.activity };
      return latest;
    },
    onStatus(callback) {
      const activityListener = (_event: Electron.IpcRendererEvent, activity: ActivityStatus | null) => {
        activityRevision++; latest = { ...latest, activity: activity || undefined }; callback(latest);
      };
      const statusListener = (_event: Electron.IpcRendererEvent, status: ClientStatus) => {
        statusRevision++; activityRevision++; latest = status; callback(latest);
      };
      ipc.on('exam:activity-status', activityListener);
      ipc.on('exam:client-status', statusListener);
      return () => {
        ipc.removeListener('exam:activity-status', activityListener);
        ipc.removeListener('exam:client-status', statusListener);
      };
    },
    action: (channel) => ipc.invoke(channel),
  };
}
