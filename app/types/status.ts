import type { BuildIdentity, ClientConfig, Trust } from './config';

/** 主进程与 preload 共享的状态快照；上传完成与服务端确认是不同阶段。 */

export type TraceLevel = 'info' | 'warn' | 'error';

export type Trace = (level: TraceLevel, event: string, details?: Record<string, unknown>) => void;

export type ActivityRunner = <T>(kind: string, stage: string, action: () => T | Promise<T>) => Promise<T> | T;

export interface ActivityStatus {
    kind: string;
    stage: string;
    label: string;
    busy: boolean;
    elapsedMs?: number;
    estimatedMinMs?: number;
    estimatedMaxMs?: number;
    delayed?: boolean;
    hint?: string;
    finishedAt?: number;
}

export interface UploadProgress {
    phase: string;
    tid?: string;
    sent?: number;
    total?: number;
    percent?: number | null;
    empty?: boolean;
}

export interface UpdatePackage {
    version: string;
    buildVersion?: string;
    size: number;
    sha256: string;
    asarUrl?: string;
    fallbackUrl?: string;
}

export interface UpdateManifest {
    version: string;
    buildVersion: string;
    minClientVersion?: string;
    hotUpdate?: UpdatePackage;
    config?: { url: string, fallbackUrl?: string };
    fullUpdate?: {
        installerUrl?: string;
        portableUrl?: string;
        platforms?: Record<string, Record<string, { installerUrl?: string, portableUrl?: string }>>;
    };
}

export interface UpdateStatus {
    phase: string;
    available?: boolean;
    message?: string;
    percent?: number;
    enabled?: boolean;
    source?: string;
    rollback?: string;
    blocked?: boolean;
    blockedReason?: string;
    journalCounts?: { open: number, pending: number, unreadable: number };
    version?: string;
    buildVersion?: string;
    latestVersion?: string;
    latestBuildVersion?: string;
    minimumBlocked?: boolean;
    installerUrl?: string;
    installerWarning?: string;
    canHotUpdate?: boolean;
}

export interface ClientStatus {
    productName?: string;
    phase?: string;
    message?: string;
    authenticated?: boolean;
    ended?: boolean;
    createdAt?: string;
    root?: boolean;
    pendingUploads?: number;
    finishing?: boolean;
    upload?: UploadProgress;
    activity?: ActivityStatus;
    update?: UpdateStatus;
    debug?: boolean;
    allowRootDebug?: boolean;
    networkMode?: string;
    networkWarning?: string;
    exitReady?: boolean;
}

export interface DiagnosticEntry {
    id: number;
    time: string;
    utc: string;
    timeZone: string;
    level: TraceLevel;
    event: string;
    data: Record<string, string | number | boolean>;
}

export interface DiagnosticSnapshot {
    entries: DiagnosticEntry[];
    latest: number;
    file: string | null;
}

export interface ClientError extends Partial<Error> {
    code?: string;
    status?: number;
    publicMessage?: string;
    retryable?: boolean;
    killed?: boolean;
}

export interface UpdateAnchor {
    trust: Trust;
    config: ClientConfig;
    identity: BuildIdentity;
    electronVersion: string;
}

/** 文件发出不代表监考已结束，必须校验服务端确认回执。 */
export interface UploadReply {
    ok?: boolean;
    receipt?: string;
}
