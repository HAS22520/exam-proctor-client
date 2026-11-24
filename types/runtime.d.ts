declare global {
  var __hydroProctorRuntime:
    | {
        identity: import('../app/main/contracts').BuildIdentity;
        markReady(): void;
        takeWaitingWindow?(): InstanceType<typeof import('../app/main/windows/waiting-window')>;
        singleInstanceLocked?: boolean;
        source: string;
        failure: { message: string } | null;
        cache?: InstanceType<typeof import('../app/main/updates/update-cache').UpdateCache>;
      }
    | undefined;
}
export {};
