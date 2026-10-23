export type { AuditSink, JournalBinding, JournalPhase, JournalState, Violation } from '../types/audit';
// 仅重导出类型，方便主进程、preload 和测试使用同一组契约。
export type { BuildIdentity, ClientConfig, Trust } from '../types/config';
export type {
    CompletedAttempt,
    DeviceIdentity,
    HandshakePayload,
    LoginIdentity,
    ProofRequest,
    RouteContext,
    SessionIdentity,
    SessionPayload,
    SubmissionPayload,
} from '../types/protocol';
export type {
    ActivityRunner,
    ActivityStatus,
    ClientError,
    ClientStatus,
    DiagnosticEntry,
    DiagnosticSnapshot,
    LogRetryStatus,
    Trace,
    TraceLevel,
    UpdateAnchor,
    UpdateManifest,
    UpdatePackage,
    UpdateStatus,
    UploadProgress,
    UploadReply,
} from '../types/status';
