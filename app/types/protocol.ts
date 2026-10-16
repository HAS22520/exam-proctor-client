/** 认证与请求证明的协议类型；网络和 IPC 输入仍必须经过运行时校验。 */
export interface RouteContext {
    rid?: string;
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
    rid?: string;
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

export interface ProofRequest {
    action: string;
    method: string;
    path: string;
    payload: Record<string, unknown>;
}

/** 提交内容仅在 submission 的现有字段、大小与账号校验通过后使用。 */
export interface SubmissionPayload {
    pid: number;
    lang: string;
    code: string;
    pretest: boolean;
    input: string[];
    fileHash: string;
}
export type SessionPayload = Omit<SessionIdentity, 'token' | 'renewAt'>;
export interface HandshakePayload {
    challengeId: string;
    serverNonce: string;
    expiresAt: string;
}
