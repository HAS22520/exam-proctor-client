import type { ActivityStatus, ClientStatus, DiagnosticSnapshot } from '../app/main/contracts';

declare global {
  interface Window {
    debugAPI: { logs(after: number): Promise<DiagnosticSnapshot>; devtools(): Promise<void> };
    uploadAPI: {
      status(): Promise<ClientStatus>;
      exit(): Promise<void>;
      onStatus(callback: (status: ClientStatus) => void): void;
    };
    waitingAPI: { status(): Promise<ActivityStatus>; onStatus(callback: (status: ActivityStatus) => void): void };
    examAPI: {
      proctorHeaders(request: unknown): Promise<Record<string, string>>;
      requestQuit(): Promise<void>;
      status(): Promise<ClientStatus>;
    };
  }
  var __hydroProctorRuntime:
    | {
        identity: import('../app/main/contracts').BuildIdentity;
        markReady(): void;
        singleInstanceLocked?: boolean;
        source: string;
        failure: { message: string } | null;
        cache?: InstanceType<typeof import('../app/main/update-cache').UpdateCache>;
      }
    | undefined;
}
export {};
