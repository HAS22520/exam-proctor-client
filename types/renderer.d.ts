import type { ActivityStatus, ClientStatus, DiagnosticSnapshot } from '../app/types/status';

declare global {
  interface Window {
    hydroClientName?: string;
    dialogAPI: {
      model(): Promise<import('../app/types/dialog').DialogModel>;
      respond(response: number, checkboxChecked: boolean): Promise<void>;
    };
    debugAPI: { logs(after: number): Promise<DiagnosticSnapshot>; devtools(): Promise<void> };
    uploadAPI: {
      status(): Promise<ClientStatus>;
      exit(): Promise<void>;
      onStatus(callback: (status: ClientStatus) => void): () => void;
    };
    waitingAPI: { status(): Promise<ActivityStatus | null>; onStatus(callback: (status: ActivityStatus | null) => void): () => void };
    examAPI: {
      proctorHeaders(request: unknown): Promise<Record<string, string>>;
      requestQuit(): Promise<void>;
      status(): Promise<ClientStatus>;
    };
  }

}
export {};
