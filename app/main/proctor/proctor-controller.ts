import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { waitWhile } from '../../shared/async';
import AuditLogger = require('../audit/audit-logger');
import type { ProtectedStore } from '../audit/device-store';
import { atomicWrite } from '../audit/device-store';
import { scanJournals } from '../audit/journal-scan';
import type {
    ActivityRunner,
    ClientConfig,
    ClientError,
    ClientStatus,
    DeviceIdentity,
    LoginIdentity,
    LogRetryStatus,
    ProofRequest,
    RouteContext,
    SubmissionPayload,
    Trace,
    UploadProgress,
    Violation,
} from '../contracts';
import { contextFromUrl } from '../security/config-policy';
import { accessRequest } from './proctor-access';
import { identity, isNetworkError, ProctorAuth, proctorErrorMessage, Transport } from './proctor-auth';
import { canonical, digest } from './proctor-crypto';

interface ControllerRecord {
    login: LoginIdentity;
    context: RouteContext;
    transport: Transport;
    auth?: ProctorAuth;
    journal?: AuditLogger;
    completed?: boolean;
    previousAttemptId?: string;
}
interface ControllerOptions {
    config: Pick<ClientConfig, 'trust'> & { exam: Pick<ClientConfig['exam'], 'allowedOrigins'> };
    directory: string;
    protectedStore: ProtectedStore;
    session: Electron.Session;
    version: string;
    onIdentity?: (login: LoginIdentity | null) => Promise<unknown>;
    onStatus?: (status: ClientStatus) => void;
    trace?: Trace;
    activity?: ActivityRunner;
    createTransport?: (origin: string, timeout?: number) => Transport;
}

interface SyncOptions {
    force?: boolean;
    restoreJournals?: boolean;
}

function submission(request: ProofRequest, context: RouteContext, login: LoginIdentity) {
    if (
        request?.action !== 'submit'
        || request.method !== 'POST'
        || request.path !== context.submitPath
        || !login.proctorEnabled
        || !context.tid
        || !context.problem
    ) {
        throw new Error('监考提交目标无效');
    }
    const p = request.payload as Partial<SubmissionPayload>;
    if (
        !p
        || Object.keys(p).sort().join(',') !== 'code,fileHash,input,lang,pid,pretest'
        || p.pid !== login.pid
        || !Number.isSafeInteger(p.pid)
        || p.pid < 1
        || typeof p.lang !== 'string'
        || !/^[\w.+-]{1,64}$/.test(p.lang)
        || typeof p.code !== 'string'
        || Buffer.byteLength(p.code) > 512 * 1024
        || typeof p.pretest !== 'boolean'
        || !Array.isArray(p.input)
        || p.input.length > 100
        || p.input.some((value) => typeof value !== 'string')
        || Buffer.byteLength(canonical(p.input)) > 512 * 1024
        || typeof p.fileHash !== 'string'
        || (p.fileHash !== '' && !/^[a-f0-9]{64}$/.test(p.fileHash))
    ) {
        throw new Error('监考提交内容无效');
    }
    return p as SubmissionPayload;
}

function requireOpenAttempt(record: ControllerRecord) {
    let message, code;
    if (record.completed || record.journal?.state.phase === 'uploaded') {
        message = '本场监考已结束且日志已上传。如需继续本场比赛，请联系管理员允许继续比赛后重新验证；旧日志将保留。';
        code = 'PROCTOR_ATTEMPT_COMPLETE';
    } else if (!record.journal || record.journal.state.phase !== 'open') {
        message = '本场监考已结束，日志尚待上传。请使用原账号补传日志；不能继续做题。';
        code = 'PROCTOR_ATTEMPT_CLOSED';
    }
    if (message) throw Object.assign(new Error(message), { code, publicMessage: message });
}

class ProctorController {
    declare config: ControllerOptions['config'];
    declare directory: string;
    declare protectedStore: ProtectedStore;
    declare electronSession: Electron.Session;
    declare version: string;
    declare onIdentity: ControllerOptions['onIdentity'];
    declare onStatus: ControllerOptions['onStatus'];
    declare trace: Trace;
    declare activity: ActivityRunner;
    declare createTransport: ControllerOptions['createTransport'];
    declare device: DeviceIdentity;
    declare current: ControllerRecord | null;
    declare records: Map<string, ControllerRecord>;
    declare inFlight: Set<number>;
    declare syncPending: Promise<ControllerRecord> | null;
    declare finishing: boolean;
    declare retryPending: Promise<void> | null;
    declare manualRetryPending: Promise<LogRetryStatus> | null;
    declare logRetry: LogRetryStatus | null;
    declare proofPending: Promise<void>;
    declare uploadProgress: UploadProgress | null;
    declare identityCache: Map<string, { record: ControllerRecord, login: LoginIdentity, validUntil: number }>;
    // 登录变化使旧的异步认证结果失效，避免串行任务恢复前一个账号的身份。
    declare identityEpoch: number;
    declare identityWork: Promise<void>;
    declare pendingIdentities: Map<string, Promise<ControllerRecord>>;
    declare authenticationError: ClientError | null;
    declare lastUrl: string;

    constructor({
        config,
        directory,
        protectedStore,
        session,
        version,
        onIdentity = async () => {},
        onStatus = () => {},
        trace = () => {},
        activity = (_kind, _stage, action) => action(),
        createTransport = (origin, timeout) => new Transport(session, origin, timeout, trace),
    }: ControllerOptions) {
        Object.assign(this, {
            config,
            directory,
            protectedStore,
            electronSession: session,
            version,
            onIdentity,
            onStatus,
            trace,
            activity,
        });
        this.createTransport = createTransport;
        this.device = protectedStore.device();
        this.current = null;
        this.records = new Map();
        this.inFlight = new Set();
        this.syncPending = null;
        this.finishing = false;
        this.retryPending = null;
        this.manualRetryPending = null;
        this.logRetry = null;
        this.proofPending = Promise.resolve();
        this.uploadProgress = null;
        this.identityCache = new Map();
        this.identityEpoch = 0;
        this.identityWork = Promise.resolve();
        this.pendingIdentities = new Map();
        this.authenticationError = null;
    }

    invalidateIdentity() {
        this.authenticationError = null;
        this.identityEpoch++;
        this.identityCache.clear();
        this.pendingIdentities.clear();
        this.current = null;
        this.lastUrl = null;
        this.logRetry = null;
        for (const record of this.records.values()) if (record.auth) record.auth.session = null;
        this.status('登录状态已变化，请重新验证身份。');
    }

    identityKey(url: string) {
        const { origin, prefix, tid, problem, rid } = contextFromUrl(url);
        if (!this.config.exam.allowedOrigins.includes(origin)) throw new Error('考试地址不在信任范围内');
        return canonical({ origin, prefix, tid, problem, rid: rid || '' });
    }

    async cachedIdentity(url: string, key: string) {
        const entry = this.identityCache.get(key);
        if (!entry || entry.validUntil <= Date.now() || Date.parse(entry.login.expiresAt) <= Date.now() + 5000) return null;
        // 终态不复用缓存，管理员恢复比赛后下一次导航即可发现新的签名轮次。
        if (entry.record.completed || (entry.record.journal && entry.record.journal.state.phase !== 'open')) return null;
        const current = { ...entry.record, context: contextFromUrl(url), login: entry.login };
        if (current.auth && !current.completed && !current.auth.session) return null;
        if (current.context.rid && current.login.tid) {
            current.context = { ...current.context, tid: current.login.tid,
                proctorPath: `${current.context.prefix}/contest/${current.login.tid}/proctor` };
        }
        this.current = current;
        this.lastUrl = url;
        await this.onIdentity(current.login);
        this.authenticationError = null;
        this.status();
        return current;
    }

    status(message = '') {
        const active =
            this.current?.journal || this.current?.completed
                ? this.current
                : [...this.records.values()].find(
                    (record) => record.login.uid === this.current?.login.uid && record.journal?.state.phase === 'open',
                );
        const pendingUploads = scanJournals(this.directory, this.current?.login.uid, this.config.exam.allowedOrigins)
            .entries.filter(({ state }) => ['closing', 'pending-upload'].includes(state.phase)).length;
        const ended = !!active?.completed || (!!active?.journal && active.journal.state.phase !== 'open');
        const phase =
            !ended && this.authenticationError
                ? isNetworkError(this.authenticationError)
                    ? 'network-error'
                    : 'authentication-error'
                : active?.completed
                    ? 'complete'
                    : active?.journal?.state.phase || 'idle';
        const fallback =
            active?.completed || phase === 'uploaded'
                ? '本轮监考已结束且日志已上传。管理员允许继续比赛后，重新验证即可开启新一轮监考，旧日志保留。'
                : ended
                    ? '本场监考已结束，日志尚待上传。请使用原账号补传日志。'
                    : active?.previousAttemptId ? '已恢复监考，正在记录本轮新日志；之前的日志保持不变。' : '';
        const session = active?.auth?.session;
        this.onStatus({
            authenticated: !ended && !this.authenticationError && !!session && Date.parse(session.expiresAt) > Date.now(),
            phase,
            ended,
            createdAt: active?.journal?.state.createdAt || null,
            root: !!this.current?.login.root,
            pendingUploads,
            loggedIn: !!this.current?.login.uid,
            retrying: !!this.manualRetryPending || !!this.retryPending || ['scanning', 'uploading'].includes(this.logRetry?.phase),
            logRetry: this.logRetry && { ...this.logRetry },
            finishing: this.finishing,
            upload: this.uploadProgress,
            message:
                message || (!ended && this.authenticationError ? proctorErrorMessage(this.authenticationError, this.version) : fallback),
        });
    }

    authenticationFailed(error: ClientError) {
        this.authenticationError = error;
        this.identityCache.clear();
        this.status(proctorErrorMessage(error, this.version));
    }

    sync(url: string, options: SyncOptions = {}) {
        const epoch = this.identityEpoch;
        let key;
        try {
            key = `${this.identityEpoch}:${!!options.force}:${options.restoreJournals !== false}:${this.identityKey(url)}`;
        } catch (error) {
            return Promise.reject(error);
        }
        if (this.pendingIdentities.has(key)) return this.pendingIdentities.get(key);
        const work = this.identityWork
            .catch(() => {})
            .then(() => this.activity('auth', 'identity', () => this.syncSerial(url, options)))
            .catch((error) => {
                if (epoch === this.identityEpoch) this.authenticationFailed(error);
                throw error;
            });
        this.pendingIdentities.set(key, work);
        this.identityWork = work.then(
            () => {},
            () => {},
        );
        this.syncPending = work;
        work.finally(() => {
            if (this.syncPending === work) this.syncPending = null;
            if (this.pendingIdentities.get(key) === work) this.pendingIdentities.delete(key);
        }).catch(() => {});
        return work;
    }

    async syncSerial(url: string, { force = false, restoreJournals = true }: SyncOptions = {}) {
        if (this.finishing) throw new Error('监考正在结束，请等待日志处理完成');
        const key = this.identityKey(url);
        const epoch = this.identityEpoch;
        if (!force) {
            const cached = await this.cachedIdentity(url, key);
            if (epoch !== this.identityEpoch) throw new Error('登录状态已变化，请重新认证');
            if (cached) return cached;
        }
        const record = await this.syncNow(url, epoch, restoreJournals);
        if (epoch !== this.identityEpoch) throw new Error('登录状态已变化，请重新认证');
        // 补传只验证账号，不能让这次检查阻止下一次正常导航恢复开放监考。
        if (!restoreJournals) return record;
        this.identityCache.set(key, { record, login: record.login, validUntil: Date.now() + 20000 });
        if (this.identityCache.size > 64) this.identityCache.delete(this.identityCache.keys().next().value);
        return record;
    }

    async syncNow(url: string, epoch: number, restoreJournals = true) {
        const context = contextFromUrl(url);
        if (!this.config.exam.allowedOrigins.includes(context.origin)) throw new Error('考试地址不在信任范围内');
        const transport = this.createTransport(context.origin);
        let login;
        try {
            login = await identity(transport, context, this.config.trust);
        } catch (error) {
            this.identityCache.clear();
            await this.onIdentity(null);
            this.status('无法验证登录身份，请确认 OJ 认证密钥和连接');
            throw error;
        }
        if (epoch !== this.identityEpoch) throw new Error('登录状态已变化，请重新认证');
        if (context.rid && login.tid) {
            context.tid = login.tid;
            context.proctorPath = `${context.prefix}/contest/${login.tid}/proctor`;
        }
        if (this.current && this.current.login.uid !== login.uid) this.identityCache.clear();
        if (login.root || !login.uid || !login.proctorEnabled) await this.onIdentity(login);
        this.lastUrl = url;
        if (!login.uid || !login.proctorEnabled || !context.tid) {
            this.current = { login, context, transport };
            if (login.uid && restoreJournals) await this.resumeOpen();
            if (epoch !== this.identityEpoch) throw new Error('登录状态已变化，请重新认证');
            await this.onIdentity(login);
            this.authenticationError = null;
            this.status(login.root ? '已验证 root 身份' : '请登录并进入启用监考的比赛');
            return this.current;
        }
        const scope = { origin: context.origin, uid: login.uid, domainId: login.domainId, tid: context.tid };
        let recordKey = digest(canonical(scope));
        const prior = [...this.records.entries()].find(([, item]) => item.login.uid === login.uid
            && item.login.domainId === login.domainId && item.context.origin === context.origin && item.context.tid === context.tid
            && (!login.attemptId || (item.journal?.binding.attemptId || item.auth?.attemptId || item.login.attemptId) === login.attemptId));
        let record = prior?.[1];
        if (prior) recordKey = prior[0];
        if (!record) {
            record = { login, context, transport };
            record.auth = new ProctorAuth({
                transport,
                context,
                identity: login,
                trust: this.config.trust,
                device: this.device,
                version: this.version,
                log: (event) => record.journal?.append(event),
            });
            const session = await record.auth.ensure();
            if (epoch !== this.identityEpoch) throw new Error('登录状态已变化，请重新认证');
            if (session.completed) {
                record.completed = true;
                if (login.attemptId) recordKey = digest(canonical({ ...scope, attemptId: login.attemptId }));
                this.records.set(recordKey, record);
                this.current = record;
                await this.onIdentity(login);
                this.authenticationError = null;
                this.status();
                return record;
            }
            if (login.attemptId && session.attemptId !== login.attemptId) throw new Error('监考轮次已变化，请重新验证');
            const binding = {
                origin: context.origin,
                uid: login.uid,
                domainId: login.domainId,
                tid: context.tid,
                attemptId: session.attemptId,
                publicKey: this.device.publicKey,
                fingerprint: this.device.fingerprint,
            };
            // 每轮独立存储；旧版按比赛命名的目录仍按绑定轮次定位并续写，绝不覆盖最终文件。
            const journals = scanJournals(this.directory, login.uid, this.config.exam.allowedOrigins).entries;
            const existing = journals
                .find(({ state }) => state.binding.origin === context.origin && state.binding.domainId === login.domainId
                    && state.binding.tid === context.tid && state.binding.attemptId === session.attemptId);
            recordKey = existing?.key || digest(canonical({ ...scope, attemptId: session.attemptId }));
            record.journal = new AuditLogger({
                directory: path.join(this.directory, recordKey),
                binding,
                protectedStore: this.protectedStore,
                logPublicKey: this.config.trust.logPublicKey,
                keyId: this.config.trust.keyId,
            });
            const previous = journals.filter(({ state }) => state.binding.origin === context.origin
                && state.binding.domainId === login.domainId && state.binding.tid === context.tid
                && state.binding.attemptId !== session.attemptId && state.phase !== 'open')
                .sort((a, b) => Date.parse(b.state.createdAt) - Date.parse(a.state.createdAt)
                    || b.state.binding.attemptId.localeCompare(a.state.binding.attemptId))[0];
            if (previous) {
                record.previousAttemptId = previous.state.binding.attemptId;
                record.journal.append('PROCTOR_RESUMED', { previousAttemptId: record.previousAttemptId });
            }
            record.journal.append('HANDSHAKE_SUCCEEDED');
            const remote = await transport.request(`${context.proctorPath}?attemptId=${session.attemptId}`, { method: 'GET' });
            if (remote.state !== 'open' && record.journal.state.phase === 'open') record.journal.close();
            this.records.set(recordKey, record);
        }
        Object.assign(record, { login, context });
        record.auth.login = login;
        record.auth.context = context;
        if (record.completed) {
            this.current = record;
            await this.onIdentity(login);
            this.authenticationError = null;
            this.status();
            return record;
        }
        const renewed = await record.auth.ensure();
        if (epoch !== this.identityEpoch) throw new Error('登录状态已变化，请重新认证');
        if (renewed.completed) record.completed = true;
        this.current = record;
        await this.onIdentity(login);
        this.authenticationError = null;
        this.status();
        return record;
    }

    async resumeOpen() {
        if (!fs.existsSync(this.directory)) return;
        const current = this.current;
        const epoch = this.identityEpoch;
        const { entries } = scanJournals(this.directory, current.login.uid, this.config.exam.allowedOrigins, this.trace);
        for await (const { key: entry, directory, state } of entries) {
            if (epoch !== this.identityEpoch) throw new Error('登录状态已变化，请重新认证');
            if (this.records.has(entry)) continue;
            if (
                state.phase !== 'open'
                || state.binding.uid !== current.login.uid
                || !this.config.exam.allowedOrigins.includes(state.binding.origin)
            ) {
                continue;
            }
            const prefix =
                current.context.origin === state.binding.origin && current.login.domainId === state.binding.domainId
                    ? current.context.prefix
                    : `/d/${encodeURIComponent(state.binding.domainId)}`;
            const context = contextFromUrl(`${state.binding.origin}${prefix}/contest/${state.binding.tid}`);
            const transport = this.createTransport(context.origin);
            const login = await identity(transport, context, this.config.trust);
            if (login.uid !== state.binding.uid || login.domainId !== state.binding.domainId) continue;
            const auth = new ProctorAuth({
                context,
                transport,
                identity: login,
                trust: this.config.trust,
                device: this.device,
                version: this.version,
                attemptId: state.binding.attemptId,
            });
            const session = await auth.ensure();
            if (session.completed) continue;
            if (session.attemptId !== state.binding.attemptId) throw new Error('恢复的监考会话编号不匹配');
            const journal = new AuditLogger({
                directory,
                binding: state.binding,
                protectedStore: this.protectedStore,
                logPublicKey: this.config.trust.logPublicKey,
                keyId: this.config.trust.keyId,
            });
            auth.log = (event) => journal.append(event);
            journal.append('HANDSHAKE_SUCCEEDED');
            const status = await transport.request(`${context.proctorPath}?attemptId=${state.binding.attemptId}`, { method: 'GET' });
            if (status.state !== 'open') journal.close();
            this.records.set(entry, { context, login, transport, auth, journal });
        }
    }

    headers(url: string, request: ProofRequest) {
        const epoch = this.identityEpoch;
        const work = this.proofPending
            .catch(() => {})
            .then(async () => {
                if (epoch !== this.identityEpoch) throw new Error('登录状态已变化，请重新认证');
                if (this.finishing) throw new Error('监考正在结束，禁止新提交');
                if (['problem_view', 'contest_view', 'record_view'].includes(request?.action)) return this.accessHeaders(url, request);
                const record = await this.sync(url);
                const payload = submission(request, record.context, record.login);
                requireOpenAttempt(record);
                const session = await record.auth.ensure();
                if (epoch !== this.identityEpoch) throw new Error('登录状态已变化，请重新认证');
                if (session.completed || this.finishing) throw new Error('本场监考已结束');
                this.status();
                record.journal.append(payload.pretest ? 'SELF_TEST_REQUESTED' : 'SUBMISSION_REQUESTED', { pid: payload.pid });
                return record.auth.proof('submit', request.path, payload);
            })
            .catch((error) => {
                if (epoch === this.identityEpoch && !error.code?.startsWith('PROCTOR_ATTEMPT_')) {
                    this.authenticationFailed(error);
                }
                throw error;
            });
        this.proofPending = work.then(
            () => {},
            () => {},
        );
        return work;
    }

    async accessHeaders(url: string, request: ProofRequest) {
        const source = contextFromUrl(url);
        const target = accessRequest(request, source);
        const epoch = this.identityEpoch;
        const current = await this.sync(url);
        if (!current.login.uid) throw new Error('请登录后验证监考客户端');
        const uid = current.login.uid;
        const domainId = current.login.domainId;
        // 有明确比赛上下文时，在握手前让服务端核对记录归属，不能先开启另一场监考。
        const identityUrl = target.action === 'record_view' && source.tid
            ? `${target.identityUrl}?tid=${source.tid}` : target.identityUrl;
        const record = this.identityKey(url) === this.identityKey(identityUrl) ? current : await this.sync(identityUrl);
        if (record.login.uid !== uid || record.login.domainId !== domainId) throw new Error('登录身份已变更，请重新验证');
        if (source.tid && record.context.tid !== source.tid) throw new Error('记录不属于当前比赛');
        if (!record.login.proctorEnabled) return {};
        if (this.finishing) throw new Error('监考正在结束，不能继续做题');
        requireOpenAttempt(record);
        const session = await record.auth.ensure();
        if (epoch !== this.identityEpoch) throw new Error('登录状态已变化，请重新认证');
        if (session.completed || this.finishing) throw new Error('本场监考已结束');
        this.status();
        // 实际受保护的 GET 请求会在 OJ 校验当前监考会话；
        // 每个资源额外查询一次状态只会增加延迟，不会提供额外授权。
        record.journal.append(request.action === 'record_view' ? 'RECORD_VIEW'
            : request.action === 'problem_view' ? 'PROBLEM_VIEW' : 'CONTEST_VIEW', target.payload);
        return record.auth.proof(request.action, request.path, target.payload, 'GET');
    }

    progress(phase: string, record?: ControllerRecord, details: Partial<UploadProgress> = {}) {
        this.uploadProgress = {
            phase,
            tid: record?.journal?.binding.tid || '',
            sent: 0,
            total: 0,
            percent: null,
            ...details,
        };
        this.status();
    }

    async confirmedUpload(record: ControllerRecord, sha256: string) {
        const status = await record.transport.request(`${record.context.proctorPath}?attemptId=${record.journal.binding.attemptId}`,
            { method: 'GET' });
        if (
            status.state === 'complete'
            && status.logUploaded
            && status.receipt?.sha256 === sha256
            && /^[a-f0-9]{24}$/.test(status.receipt.id || '')
        ) {
            record.journal.uploaded(status.receipt.id);
            return true;
        }
        return false;
    }

    async upload(record: ControllerRecord, assertIdentity: () => void = () => {}) {
        assertIdentity();
        this.progress('preparing', record);
        const filename = await record.journal.finalize();
        assertIdentity();
        const size = fs.statSync(filename).size;
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
        assertIdentity();
        const sha256 = hash.digest('hex');
        if (await this.confirmedUpload(record, sha256)) {
            assertIdentity();
            this.progress('complete', record, { percent: 100 });
            return;
        }
        assertIdentity();
        const session = await record.auth.ensure();
        assertIdentity();
        if (session.completed) {
            if (!(await this.confirmedUpload(record, sha256))) throw new Error('服务端回执与本地日志不匹配');
            this.progress('complete', record, { percent: 100 });
            return;
        }
        const uploadName = `proctor-${record.journal.binding.attemptId}.hplog`;
        this.progress('uploading', record, { total: size });
        try {
            const result = await record.transport.upload(record.context.proctorPath, {
                filename,
                uploadName,
                onProgress: (progress: UploadProgress) => this.progress(progress.phase, record, progress),
                headers: record.auth.proof('upload', record.context.proctorPath, { filename: uploadName, size, sha256 }),
            });
            if (result.ok !== true || !/^[a-f0-9]{24}$/.test(result.receipt || '')) {
                throw new Error('缺少日志上传回执');
            }
            record.journal.uploaded(result.receipt);
            this.progress('complete', record, { sent: size, total: size, percent: 100 });
        } catch (error) {
            if (!(await this.confirmedUpload(record, sha256).catch(() => false))) throw error;
            this.progress('complete', record, { sent: size, total: size, percent: 100 });
        }
    }

    async pause() {
        if (this.finishing) throw new Error('日志仍在处理中');
        this.finishing = true;
        // 先停止生成新证明，再等待已排队的认证和提交完成。
        await this.proofPending.catch(() => {});
        if (this.syncPending) await this.syncPending.catch(() => {});
        if (this.manualRetryPending) await this.manualRetryPending.catch(() => {});
        const deadline = Date.now() + 30000;
        await waitWhile(() => this.inFlight.size > 0, deadline);
        for (const record of this.records.values()) {
            if (record.journal?.state.phase === 'open') {
                record.journal.append('CLIENT_PAUSED', { reason: 'exit-without-upload' });
            }
        }
        // 暂停时保持会话开放，不发送结束请求、不封存上传日志，也不生成新会话编号。
        this.status('日志已保留，重新登录原账号后可继续监考；上传成功才算结束');
    }

    async finish(beforeFinish: () => Promise<void> = async () => {}) {
        if (this.finishing) return false;
        this.finishing = true;
        this.progress('closing');
        // 等待异步网络恢复前，先禁止生成新证明。
        await beforeFinish();
        await this.proofPending;
        if (this.syncPending) await this.syncPending.catch(() => {});
        if (this.manualRetryPending) await this.manualRetryPending.catch(() => {});
        if (this.retryPending) await this.retryPending;
        const active = [...this.records.values()].filter((record) => record.journal && record.journal.state.phase !== 'uploaded');
        const deadline = Date.now() + 30000;
        await waitWhile(() => this.inFlight.size > 0, deadline);
        if (!active.length) {
            this.progress('complete', null, { percent: 100, empty: true });
            this.status('本次没有需要上传的监考日志');
            return true;
        }
        let allUploaded = true;
        for await (const record of active) {
            this.progress('closing', record);
            record.journal.close();
            try {
                if (this.inFlight.size) throw new Error('提交仍在处理中，日志将在联网后补传');
                const login = await identity(record.transport, record.context, this.config.trust);
                if (login.uid !== record.login.uid) throw new Error('请使用原考试账号补传日志');
                if (record.journal.state.phase === 'closing') {
                    try {
                        await record.auth.operation('finish');
                        record.journal.append('SERVER_FINISH_CONFIRMED');
                    } catch (error) {
                        record.journal.append('SERVER_FINISH_DEFERRED');
                        throw error;
                    }
                }
                await this.upload(record);
            } catch (error) {
                this.trace('error', 'logs.upload-deferred', { name: error.name, status: error.status, message: error.message });
                allUploaded = false;
                record.journal.append('LOG_UPLOAD_DEFERRED');
                await record.journal.finalize();
                Object.assign(record.journal.state, {
                    uploadError: '日志未上传，成绩待确认；请使用原账号联网补传',
                    retryAfter: Date.now() + 60000,
                });
                record.journal.saveState();
                this.progress('deferred', record);
            }
        }
        this.status(allUploaded ? '日志上传完成' : '日志未上传，成绩待确认；将在联网后补传');
        return allUploaded;
    }

    retryManually(url: string) {
        if (this.finishing) return Promise.reject(new Error('监考正在结束，请等待日志处理完成'));
        // 主进程合并重复点击，不能只依赖按钮的禁用状态。
        if (this.manualRetryPending) return this.manualRetryPending;
        this.manualRetryPending = this.retryManuallyNow(url).finally(() => {
            this.manualRetryPending = null;
            this.status();
        });
        return this.manualRetryPending;
    }

    private async retryManuallyNow(url: string) {
        const epoch = this.identityEpoch;
        const result: LogRetryStatus = { phase: 'scanning', total: 0, uploaded: 0, failed: 0, unreadable: 0, open: 0 };
        this.logRetry = result;
        this.uploadProgress = null;
        this.status('正在验证账号并扫描本机待补传日志');
        try {
            // 显式补传不使用缓存身份；服务端仍校验每场比赛的账号、会话和日志签名。
            const context = contextFromUrl(url);
            // 使用域首页验证登录即可；历史开放监考的握手失败不能阻塞已封存日志的补传。
            await this.sync(`${context.origin}${context.prefix}/`, { force: true, restoreJournals: false });
            const uid = this.current?.login.uid;
            if (!uid || this.finishing) throw new Error('请登录原考试账号后补传');
            if (this.retryPending) await this.retryPending;
            if (epoch !== this.identityEpoch || this.current?.login.uid !== uid) throw new Error('登录状态已变化，请重新补传');
            const { entries, unreadable } = scanJournals(this.directory, uid, this.config.exam.allowedOrigins, this.trace);
            result.unreadable = unreadable;
            result.open = entries.filter(({ state }) => state.phase === 'open').length;
            const pending = entries.filter(({ state }) => ['closing', 'pending-upload'].includes(state.phase));
            result.total = pending.length;
            for (const { key, directory, state } of pending) {
                state.permanentError = false;
                state.retryAfter = 0;
                atomicWrite(path.join(directory, 'state.json'), JSON.stringify(state));
                const journal = this.records.get(key)?.journal;
                if (journal) Object.assign(journal.state, { permanentError: false, retryAfter: 0 });
            }
            result.phase = 'uploading';
            this.status();
            await this.retryUploads(true);
            if (epoch !== this.identityEpoch) throw new Error('登录状态已变化，请重新补传');
            result.phase = 'complete';
            this.status();
            return { ...result };
        } catch (error) {
            result.phase = 'failed';
            if (epoch === this.identityEpoch) this.status();
            throw error;
        }
    }

    async retryUploads(manual = false) {
        if (this.retryPending || this.finishing || !this.current?.login.uid || (this.manualRetryPending && !manual)) return;
        this.retryPending = this.retryUploadsNow(manual);
        try {
            await this.retryPending;
        } finally {
            this.retryPending = null;
            this.status();
        }
    }

    async retryUploadsNow(manual = false) {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const current = this.current;
        const epoch = this.identityEpoch;
        const { entries } = scanJournals(this.directory, current.login.uid, this.config.exam.allowedOrigins, this.trace);
        for await (const { key: entry, directory, state } of entries) {
            if (epoch !== this.identityEpoch) throw new Error('登录状态已变化，请重新补传');
            if (
                !['closing', 'pending-upload'].includes(state.phase)
                || state.retryAfter > Date.now()
                || (state.permanentError && state.failureVersion === this.version && state.failureKeyId === this.config.trust.keyId)
                || state.binding.uid !== current.login.uid
                || !this.config.exam.allowedOrigins.includes(state.binding.origin)
            ) {
                continue;
            }
            let record;
            try {
                const prefix =
                    current.context.origin === state.binding.origin && current.login.domainId === state.binding.domainId
                        ? current.context.prefix
                        : `/d/${encodeURIComponent(state.binding.domainId)}`;
                const context = contextFromUrl(`${state.binding.origin}${prefix}/contest/${state.binding.tid}`);
                const transport = this.createTransport(context.origin, 120000);
                const login = await identity(transport, context, this.config.trust);
                if (epoch !== this.identityEpoch) throw new Error('登录状态已变化，请重新补传');
                if (login.uid !== state.binding.uid || login.domainId !== state.binding.domainId) {
                    throw new Error('该比赛的登录账号与原考试账号不一致');
                }
                record = this.records.get(entry) || {
                    context,
                    login,
                    transport,
                    journal: new AuditLogger({
                        directory,
                        binding: state.binding,
                        protectedStore: this.protectedStore,
                        logPublicKey: this.config.trust.logPublicKey,
                        keyId: this.config.trust.keyId,
                    }),
                };
                record.journal ||= new AuditLogger({
                    directory,
                    binding: state.binding,
                    protectedStore: this.protectedStore,
                    logPublicKey: this.config.trust.logPublicKey,
                    keyId: this.config.trust.keyId,
                });
                record.auth ||= new ProctorAuth({
                    context,
                    identity: login,
                    transport,
                    trust: this.config.trust,
                    device: this.device,
                    version: this.version,
                    attemptId: state.binding.attemptId,
                });
                this.records.set(entry, record);
                await this.upload(record, () => {
                    if (epoch !== this.identityEpoch) throw new Error('登录状态已变化，请重新补传');
                });
                if (manual && this.logRetry) this.logRetry.uploaded++;
            } catch (error) {
                if (epoch !== this.identityEpoch) throw error;
                if (manual && this.logRetry) this.logRetry.failed++;
                this.trace('error', 'logs.retry-failed', { name: error.name, status: error.status, message: error.message });
                if (record?.journal) {
                    const count = (record.journal.state.retryCount || 0) + 1;
                    Object.assign(record.journal.state, {
                        uploadError: '日志补传失败，请检查账号、版本及服务端策略',
                        retryCount: count,
                        retryAfter: Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(count, 6)),
                        permanentError: error.retryable === false,
                        failureVersion: this.version,
                        failureKeyId: this.config.trust.keyId,
                    });
                    record.journal.saveState();
                    this.progress('deferred', record);
                }
                this.status('存在待补传日志；版本、密钥或环境错误需管理员处理');
            }
            this.status();
        }
        const pending = [...this.records.values()].some((record) => record.journal?.state.phase === 'pending-upload');
        this.status(pending ? '日志尚未上传，成绩待确认；请检查联网、账号和服务端策略' : '');
    }

    logViolation(item: Violation) {
        const uid = this.current?.login.uid;
        for (const record of this.records.values()) {
            if (record.login.uid === uid && ['open', 'closing'].includes(record.journal?.state.phase)) {
                record.journal.logViolation(item);
            }
        }
    }

    shutdown() {
        for (const record of this.records.values()) record.journal?.cleanShutdown();
    }
}

export { ProctorController, submission };
