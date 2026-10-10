const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AuditLogger = require('./audit-logger');
const { atomicWrite } = require('./device-store');
const { canonical, digest } = require('./proctor-crypto');
const { contextFromUrl } = require('./config-policy');
const { ProctorAuth, Transport, identity } = require('./proctor-auth');

function submission(request, context, login) {
  if (request?.action !== 'submit' || request.method !== 'POST' || request.path !== context.submitPath
    || !login.proctorEnabled || !context.tid || !context.problem) throw new Error('Invalid proctor submission target');
  const p = request.payload;
  if (!p || Object.keys(p).sort().join(',') !== 'code,fileHash,input,lang,pid,pretest' || p.pid !== login.pid
    || !Number.isSafeInteger(p.pid) || p.pid < 1 || typeof p.lang !== 'string' || !/^[\w.+-]{1,64}$/.test(p.lang)
    || typeof p.code !== 'string' || Buffer.byteLength(p.code) > 512 * 1024 || typeof p.pretest !== 'boolean'
    || !Array.isArray(p.input) || p.input.length > 100 || p.input.some((value) => typeof value !== 'string')
    || Buffer.byteLength(canonical(p.input)) > 512 * 1024
    || typeof p.fileHash !== 'string' || (p.fileHash !== '' && !/^[a-f0-9]{64}$/.test(p.fileHash))) {
    throw new Error('Invalid proctor submission payload');
  }
  return p;
}

class ProctorController {
  constructor({ config, directory, protectedStore, session, version, onIdentity = async () => {}, onStatus = () => {} }) {
    Object.assign(this, { config, directory, protectedStore, electronSession: session, version, onIdentity, onStatus });
    this.device = protectedStore.device();
    this.current = null;
    this.records = new Map();
    this.inFlight = new Set();
    this.syncPending = null;
    this.finishing = false;
    this.retryPending = null;
    this.proofPending = Promise.resolve();
  }

  status(message = '') {
    const active = this.current?.journal ? this.current : [...this.records.values()].find((record) =>
      record.login.uid === this.current?.login.uid && record.journal?.state.phase === 'open');
    let pendingUploads = 0;
    if (fs.existsSync(this.directory)) for (const entry of fs.readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}$/.test(entry)) continue;
      try {
        const state = JSON.parse(fs.readFileSync(path.join(this.directory, entry, 'state.json'), 'utf8'));
        if (['closing', 'pending-upload'].includes(state.phase) && state.binding.uid === this.current?.login.uid) pendingUploads++;
      } catch { /* Damaged states are handled by recovery, never replaced here. */ }
    }
    this.onStatus({ authenticated: !!active?.auth?.session, phase: active?.journal?.state.phase || 'idle',
      createdAt: active?.journal?.state.createdAt || null, root: !!this.current?.login.root, message, pendingUploads });
  }

  async sync(url) {
    if (this.syncPending) {
      await this.syncPending;
      if (this.lastUrl === url) return this.current;
    }
    this.syncPending = this.syncNow(url);
    try { return await this.syncPending; } finally { this.syncPending = null; }
  }

  async syncNow(url) {
    const context = contextFromUrl(url);
    if (!this.config.exam.allowedOrigins.includes(context.origin)) throw new Error('Untrusted exam origin');
    const transport = new Transport(this.electronSession, context.origin);
    let login;
    try { login = await identity(transport, context, this.config.trust); }
    catch (error) {
      await this.onIdentity(null);
      this.status('无法验证登录身份，请确认 OJ 认证密钥和连接');
      throw error;
    }
    if (login.root || !login.uid || !login.proctorEnabled) await this.onIdentity(login);
    this.lastUrl = url;
    if (!login.uid || !login.proctorEnabled || !context.tid) {
      this.current = { login, context, transport };
      if (login.uid) await this.resumeOpen();
      await this.onIdentity(login);
      this.status(login.root ? '已验证 root 身份' : '请登录并进入启用监考的比赛');
      return this.current;
    }
    const recordKey = digest(canonical({ origin: context.origin, uid: login.uid, domainId: login.domainId, tid: context.tid }));
    let record = this.records.get(recordKey);
    if (!record) {
      record = { login, context, transport };
      record.auth = new ProctorAuth({ transport, context, identity: login, trust: this.config.trust, device: this.device, version: this.version,
        log: (event) => record.journal?.append(event) });
      const session = await record.auth.ensure();
      if (session.completed) {
        record.completed = true;
        this.records.set(recordKey, record);
        this.current = record;
        this.status('监考日志已经上传，本场考试已结束');
        return record;
      }
      const binding = { origin: context.origin, uid: login.uid, domainId: login.domainId, tid: context.tid,
        attemptId: session.attemptId, publicKey: this.device.publicKey, fingerprint: this.device.fingerprint };
      record.journal = new AuditLogger({ directory: path.join(this.directory, recordKey), binding, protectedStore: this.protectedStore,
        logPublicKey: this.config.trust.logPublicKey, keyId: this.config.trust.keyId });
      record.journal.append('HANDSHAKE_SUCCEEDED');
      const remote = await transport.request(context.proctorPath, { method: 'GET' });
      if (remote.state !== 'open' && record.journal.state.phase === 'open') record.journal.close();
      this.records.set(recordKey, record);
    }
    Object.assign(record, { login, context });
    record.auth.login = login;
    record.auth.context = context;
    this.current = record;
    await this.onIdentity(login);
    this.status();
    return record;
  }

  async resumeOpen() {
    if (!fs.existsSync(this.directory)) return;
    const current = this.current;
    for (const entry of fs.readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}$/.test(entry) || this.records.has(entry)) continue;
      const directory = path.join(this.directory, entry);
      const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
      if (state.phase !== 'open' || state.binding.uid !== current.login.uid
        || !this.config.exam.allowedOrigins.includes(state.binding.origin)) continue;
      const prefix = current.context.origin === state.binding.origin && current.login.domainId === state.binding.domainId
        ? current.context.prefix : `/d/${encodeURIComponent(state.binding.domainId)}`;
      const context = contextFromUrl(`${state.binding.origin}${prefix}/contest/${state.binding.tid}`);
      const transport = new Transport(this.electronSession, context.origin);
      const login = await identity(transport, context, this.config.trust);
      if (login.uid !== state.binding.uid || login.domainId !== state.binding.domainId) continue;
      const auth = new ProctorAuth({ context, transport, identity: login, trust: this.config.trust, device: this.device, version: this.version, attemptId: state.binding.attemptId });
      const session = await auth.ensure();
      if (session.completed) continue;
      if (session.attemptId !== state.binding.attemptId) throw new Error('Restored attempt mismatch');
      const journal = new AuditLogger({ directory, binding: state.binding, protectedStore: this.protectedStore,
        logPublicKey: this.config.trust.logPublicKey, keyId: this.config.trust.keyId });
      auth.log = (event) => journal.append(event);
      journal.append('HANDSHAKE_SUCCEEDED');
      const status = await transport.request(context.proctorPath, { method: 'GET' });
      if (status.state !== 'open') journal.close();
      this.records.set(entry, { context, login, transport, auth, journal });
    }
  }

  headers(url, request) {
    const work = this.proofPending.catch(() => {}).then(async () => {
      if (this.finishing) throw new Error('监考正在结束，禁止新提交');
      const record = await this.sync(url);
      const payload = submission(request, record.context, record.login);
      if (!record.journal || record.journal.state.phase !== 'open' || record.completed) throw new Error('本场监考已结束');
      const session = await record.auth.ensure();
      if (session.completed || this.finishing) throw new Error('本场监考已结束');
      record.journal.append(payload.pretest ? 'SELF_TEST_REQUESTED' : 'SUBMISSION_REQUESTED', { pid: payload.pid });
      return record.auth.proof('submit', request.path, payload);
    });
    this.proofPending = work.then(() => {}, () => {});
    return work;
  }

  async confirmedUpload(record, sha256) {
    const status = await record.transport.request(record.context.proctorPath, { method: 'GET' });
    if (status.state === 'complete' && status.logUploaded && status.receipt?.sha256 === sha256
      && /^[a-f0-9]{24}$/.test(status.receipt.id || '')) {
      record.journal.uploaded(status.receipt.id);
      return true;
    }
    return false;
  }

  async upload(record) {
    const filename = await record.journal.finalize();
    const blob = await fs.openAsBlob(filename);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    if (await this.confirmedUpload(record, sha256)) return;
    const session = await record.auth.ensure();
    if (session.completed) {
      if (!await this.confirmedUpload(record, sha256)) throw new Error('Server receipt does not match the local log');
      return;
    }
    const uploadName = `proctor-${record.journal.binding.attemptId}.hplog`;
    const form = new FormData();
    form.set('operation', 'upload');
    form.set('file', blob, uploadName);
    try {
      const result = await record.transport.request(record.context.proctorPath, { body: form, timeoutMs: 120000,
        headers: record.auth.proof('upload', record.context.proctorPath, { filename: uploadName, size: blob.size, sha256 }) });
      if (result.ok !== true || !/^[a-f0-9]{24}$/.test(result.receipt || '')) throw new Error('Missing log upload receipt');
      record.journal.uploaded(result.receipt);
    } catch (error) {
      if (!await this.confirmedUpload(record, sha256).catch(() => false)) throw error;
    }
  }

  async finish() {
    if (this.finishing) return false;
    this.finishing = true;
    await this.proofPending;
    if (this.syncPending) await this.syncPending.catch(() => {});
    if (this.retryPending) await this.retryPending;
    const active = [...this.records.values()].filter((record) => record.journal && record.journal.state.phase !== 'uploaded');
    const deadline = Date.now() + 30000;
    while (this.inFlight.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    let allUploaded = true;
    for (const record of active) {
      record.journal.close();
      try {
        if (this.inFlight.size) throw new Error('提交仍在处理中，日志将在联网后补传');
        const login = await identity(record.transport, record.context, this.config.trust);
        if (login.uid !== record.login.uid) throw new Error('请使用原考试账号补传日志');
        if (record.journal.state.phase === 'closing') {
          try { await record.auth.operation('finish'); record.journal.append('SERVER_FINISH_CONFIRMED'); }
          catch (error) { record.journal.append('SERVER_FINISH_DEFERRED'); throw error; }
        }
        await this.upload(record);
      } catch {
        allUploaded = false;
        record.journal.append('LOG_UPLOAD_DEFERRED');
        await record.journal.finalize();
        Object.assign(record.journal.state, { uploadError: '日志未上传，成绩待确认；请使用原账号联网补传', retryAfter: Date.now() + 60000 });
        record.journal.saveState();
      }
    }
    this.status(allUploaded ? '日志上传完成' : '日志未上传，成绩待确认；将在联网后补传');
    return allUploaded;
  }

  async retryManually(url) {
    await this.sync(url);
    const uid = this.current?.login.uid;
    if (!uid || this.finishing) throw new Error('请登录原考试账号后补传');
    if (this.retryPending) await this.retryPending;
    if (fs.existsSync(this.directory)) for (const entry of fs.readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}$/.test(entry)) continue;
      const filename = path.join(this.directory, entry, 'state.json');
      const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (state.binding.uid !== uid || !['closing', 'pending-upload'].includes(state.phase)) continue;
      state.permanentError = false;
      state.retryAfter = 0;
      atomicWrite(filename, JSON.stringify(state));
    }
    await this.retryUploads();
  }

  async retryUploads() {
    if (this.retryPending || this.finishing || !this.current?.login.uid) return;
    this.retryPending = this.retryUploadsNow();
    try { await this.retryPending; } finally { this.retryPending = null; }
  }

  async retryUploadsNow() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}$/.test(entry)) continue;
      const directory = path.join(this.directory, entry);
      const filename = path.join(directory, 'state.json');
      if (!fs.existsSync(filename)) continue;
      const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!['closing', 'pending-upload'].includes(state.phase) || state.retryAfter > Date.now() || (state.permanentError && state.failureVersion === this.version && state.failureKeyId === this.config.trust.keyId)
        || state.binding.uid !== this.current.login.uid || !this.config.exam.allowedOrigins.includes(state.binding.origin)) continue;
      let record;
      try {
        const prefix = this.current.context.origin === state.binding.origin && this.current.login.domainId === state.binding.domainId
          ? this.current.context.prefix : `/d/${encodeURIComponent(state.binding.domainId)}`;
        const context = contextFromUrl(`${state.binding.origin}${prefix}/contest/${state.binding.tid}`);
        const transport = new Transport(this.electronSession, context.origin, 120000);
        const login = await identity(transport, context, this.config.trust);
        if (login.uid !== state.binding.uid || login.domainId !== state.binding.domainId) continue;
        record = this.records.get(entry) || { context, login, transport,
          journal: new AuditLogger({ directory, binding: state.binding, protectedStore: this.protectedStore,
            logPublicKey: this.config.trust.logPublicKey, keyId: this.config.trust.keyId }) };
        record.journal ||= new AuditLogger({ directory, binding: state.binding, protectedStore: this.protectedStore,
          logPublicKey: this.config.trust.logPublicKey, keyId: this.config.trust.keyId });
        record.auth ||= new ProctorAuth({ context, identity: login, transport, trust: this.config.trust, device: this.device, version: this.version, attemptId: state.binding.attemptId });
        this.records.set(entry, record);
        await this.upload(record);
      } catch (error) {
        if (record?.journal) {
          const count = (record.journal.state.retryCount || 0) + 1;
          Object.assign(record.journal.state, { uploadError: '日志补传失败，请检查账号、版本及服务端策略', retryCount: count,
            retryAfter: Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(count, 6)), permanentError: error.retryable === false, failureVersion: this.version, failureKeyId: this.config.trust.keyId });
          record.journal.saveState();
        }
        this.status('存在待补传日志；版本、密钥或环境错误需管理员处理');
      }
    }
    const pending = [...this.records.values()].some((record) => record.journal?.state.phase === 'pending-upload');
    this.status(pending ? '日志尚未上传，成绩待确认；请检查联网、账号和服务端策略' : '');
  }

  logViolation(item) {
    const uid = this.current?.login.uid;
    for (const record of this.records.values()) {
      if (record.login.uid === uid && ['open', 'closing'].includes(record.journal?.state.phase)) record.journal.logViolation(item);
    }
  }
  shutdown() { for (const record of this.records.values()) record.journal?.cleanShutdown(); }
}

module.exports = { ProctorController, submission };
