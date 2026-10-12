/** 持久化加密日志状态；只有收到服务端回执后才能进入 uploaded。 */
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
