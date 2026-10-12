// 仅重导出类型，方便主进程、preload 和测试使用同一组契约。
export type { BuildIdentity, Trust, ClientConfig } from '../types/config';
export type {
  RouteContext,
  DeviceIdentity,
  LoginIdentity,
  SessionIdentity,
  CompletedAttempt,
  ProofRequest,
  SubmissionPayload,
  SessionPayload,
  HandshakePayload,
} from '../types/protocol';
export type { JournalBinding, JournalPhase, JournalState, Violation, AuditSink } from '../types/audit';
export type {
  TraceLevel,
  Trace,
  ActivityRunner,
  ActivityStatus,
  UploadProgress,
  UploadReply,
  UpdatePackage,
  UpdateManifest,
  UpdateStatus,
  ClientStatus,
  DiagnosticEntry,
  DiagnosticSnapshot,
  ClientError,
  UpdateAnchor,
} from '../types/status';
