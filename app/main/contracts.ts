/** Wire and persisted shapes. Validation stays at the existing trust boundaries. */
export interface BuildIdentity {
  version: string;
  buildVersion: string;
  nativeNetworkVersion?: number;
}
export interface Trust {
  keyId: string;
  authPublicKey: string;
  logPublicKey: string;
  updatePublicKey?: string;
  allowedOrigins: string[];
  updateOrigins?: string[];
}
export interface ClientConfig {
  exam: { targetUrl: string; title?: string; allowedOrigins: string[]; allowedDomains?: string[] };
  updater: {
    enabled?: boolean;
    checkOnStartup?: boolean;
    timeoutMs?: number;
    versionUrl?: string;
    fallbackVersionUrl?: string;
    allowedOrigins?: string[];
    signingPublicKey?: string;
  };
  debug?: { allowRoot: boolean };
  window?: {
    kiosk?: boolean;
    alwaysOnTop?: boolean;
    preventMinimize?: boolean;
    disableDevTools?: boolean;
    width?: number;
    height?: number;
  };
  antiCheat?: {
    blockShortcuts?: string[];
    processBlacklist?: string[];
    processBlacklistByPlatform?: Record<string, string[]>;
    checkProcessIntervalMs?: number;
    singleScreenOnly?: boolean;
    terminateBlacklisted?: boolean;
  };
  globalFirewallLock?: { enabled: boolean };
  trust?: Trust;
}
export interface RouteContext {
  origin: string;
  prefix: string;
  tid: string;
  problem: string;
  identityPath: string;
  proctorPath: string;
  submitPath: string;
}
export interface DeviceIdentity {
  privateKey: string;
  publicKey: string;
  installationId: string;
  fingerprint: string;
}
export interface LoginIdentity {
  uid: number;
  domainId: string;
  root: boolean;
  proctorEnabled: boolean;
  tid: string;
  pid?: number;
  expiresAt: string;
  protocol: string;
  action: string;
  keyId: string;
  origin: string;
  clientNonce: string;
  routePid: string;
}
export interface SessionIdentity {
  attemptId: string;
  refreshEnabled: boolean;
  expiresAt: string;
  token: string;
  tokenHash: string;
  renewAt: number;
  uid: number;
  domainId: string;
  tid: string;
  fingerprint: string;
  version: string;
  completed?: false;
}
export interface CompletedAttempt {
  completed: true;
  receipt: string;
}
export interface JournalBinding {
  origin: string;
  uid: number;
  domainId: string;
  tid: string;
  attemptId: string;
  publicKey: string;
  fingerprint: string;
}
export type JournalPhase = 'open' | 'closing' | 'pending-upload' | 'uploaded';
export interface JournalState {
  binding: JournalBinding;
  keyId: string;
  phase: JournalPhase;
  clean: boolean;
  createdAt: string;
  bootId: string | null;
  finalFile?: string;
  receipt?: string;
  uploadError?: string;
  retryAfter?: number;
  retryCount?: number;
  permanentError?: boolean;
  failureVersion?: string;
  failureKeyId?: string;
}
export interface Violation {
  source?: string;
  type?: string;
  target?: string;
  detail?: string;
}
export interface AuditSink {
  logViolation(item: Violation): void;
}
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
  config?: { url: string; fallbackUrl?: string };
  fullUpdate?: {
    installerUrl?: string;
    portableUrl?: string;
    platforms?: Record<string, Record<string, { installerUrl?: string; portableUrl?: string }>>;
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
  journalCounts?: { open: number; pending: number; unreadable: number };
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
/** Payloads arrive from an untrusted renderer and are validated before signing. */
export interface ProofRequest {
  action: string;
  method: string;
  path: string;
  payload: Record<string, any>;
}
export interface UpdateAnchor {
  trust: Trust;
  config: ClientConfig;
  identity: BuildIdentity;
  electronVersion: string;
}
