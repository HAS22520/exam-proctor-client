const { PROTOCOL, canonical, digest, nonce, sign, verifyEnvelope } = require('./proctor-crypto');
const { deviceInfo } = require('./device-store');

class ProctorError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
  get retryable() { return !this.status || this.status === 429 || this.status >= 500 || /in progress|retry/i.test(this.message); }
}

class Transport {
  constructor(session, origin, timeoutMs = 15000) { this.session = session; this.origin = origin; this.timeoutMs = timeoutMs; }

  async request(path, { method = 'POST', body, headers = {}, timeoutMs = this.timeoutMs } = {}) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || !path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid protocol target');
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await this.session.fetch(url.href, { method, redirect: 'manual', credentials: 'include', cache: 'no-store', signal,
      headers: { Accept: 'application/json', Origin: this.origin, ...headers }, body });
    if (response.status >= 300 && response.status < 400) throw new ProctorError('Login or redirect requires attention', response.status);
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw new ProctorError('Server did not return protocol JSON', response.status);
    const raw = await response.text();
    if (raw.length > 1024 * 1024) throw new ProctorError('Protocol response too large', 400);
    const data = JSON.parse(raw);
    if (!response.ok || data.error) {
      const reason = data.error?.params?.find((value) => typeof value === 'string') || data.error?.message || 'Proctor request rejected';
      // Do not forward raw responses, tokens, proofs or stacks to the renderer/log.
      throw new ProctorError(String(reason).slice(0, 300), response.status);
    }
    return data;
  }

  json(path, body, headers) {
    return this.request(path, { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
  }
}

async function identity(transport, context, trust) {
  const clientNonce = nonce();
  const response = await transport.json(context.identityPath, { clientNonce,
    ...(context.tid ? { tid: context.tid } : {}), ...(context.problem ? { problem: context.problem } : {}) });
  const payload = verifyEnvelope(response, trust.authPublicKey, { protocol: PROTOCOL, action: 'identity', keyId: trust.keyId,
    origin: context.origin, clientNonce, tid: context.tid, routePid: context.problem });
  if (!Number.isSafeInteger(payload.uid) || payload.uid < 0 || typeof payload.domainId !== 'string'
    || typeof payload.root !== 'boolean' || (payload.root && payload.uid === 0)) throw new Error('Invalid signed login identity');
  return payload;
}

class ProctorAuth {
  constructor({ transport, context, identity: login, trust, device, version, log = () => {}, attemptId = null }) {
    Object.assign(this, { transport, context, login, trust, device, version, log, attemptId });
    this.session = null;
    this.pending = null;
  }

  expected(action) {
    return { protocol: PROTOCOL, action, uid: this.login.uid, domainId: this.login.domainId, tid: this.context.tid,
      fingerprint: this.device.fingerprint, version: this.version, keyId: this.trust.keyId };
  }

  accept(response, previousAttempt) {
    if (typeof response.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(response.token)) throw new Error('Invalid session token');
    const payload = verifyEnvelope(response, this.trust.authPublicKey, { ...this.expected('session'), tokenHash: digest(response.token) }, 1800000);
    if (!/^[a-f0-9]{24}$/.test(payload.attemptId || '') || typeof payload.refreshEnabled !== 'boolean'
      || ((previousAttempt || this.attemptId) && payload.attemptId !== (previousAttempt || this.attemptId))) throw new Error('Session attempt mismatch');
    this.attemptId = payload.attemptId;
    this.session = { ...payload, token: response.token, renewAt: Date.now() + (Date.parse(payload.expiresAt) - Date.now()) * 2 / 3 };
    return this.session;
  }

  async handshake() {
    const clientNonce = nonce();
    const info = deviceInfo();
    const response = await this.transport.json(this.context.proctorPath, { operation: 'challenge', version: this.version,
      fingerprint: this.device.fingerprint, clientNonce, publicKey: this.device.publicKey, deviceInfo: info });
    const payload = verifyEnvelope(response, this.trust.authPublicKey, { ...this.expected('handshake'), origin: this.context.origin,
      clientNonce, publicKey: this.device.publicKey, deviceInfo: info });
    if (!/^[A-Za-z0-9_-]{43}$/.test(payload.challengeId || '') || !/^[A-Za-z0-9_-]{43}$/.test(payload.serverNonce || '')) {
      throw new Error('Invalid handshake challenge');
    }
    const result = await this.transport.json(this.context.proctorPath, { operation: 'handshake', challengeId: payload.challengeId,
      signature: sign(payload, this.device.privateKey) });
    if (result.completed === true) {
      if (!/^[a-f0-9]{24}$/.test(result.receipt || '')) throw new Error('Invalid completion receipt');
      return { completed: true, receipt: result.receipt };
    }
    const session = this.accept(result, this.session?.attemptId);
    this.log('HANDSHAKE_SUCCEEDED');
    return session;
  }

  async ensure() {
    if (this.pending) return this.pending;
    if (this.session && Date.now() < this.session.renewAt) return this.session;
    this.pending = (async () => {
      if (this.session && this.session.refreshEnabled && Date.now() < Date.parse(this.session.expiresAt)) {
        try {
          const result = await this.transport.json(this.context.proctorPath, { operation: 'refresh' }, this.proof('refresh', this.context.proctorPath, {}));
          const session = this.accept(result, this.session.attemptId);
          this.log('SESSION_REFRESHED');
          return session;
        } catch (error) {
          // A lost refresh response may have revoked the old token. Re-handshake,
          // never send another refresh concurrently or silently reuse that token.
          this.session = null;
          if (error.status === 403 && /version|environment|configured|key/i.test(error.message)) throw error;
        }
      }
      return this.handshake();
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }

  proof(action, path, payload) {
    if (!this.session || Date.now() >= Date.parse(this.session.expiresAt)) throw new Error('Session expired');
    const proof = { protocol: PROTOCOL, action, method: 'POST', path, tokenHash: this.session.tokenHash,
      fingerprint: this.device.fingerprint, version: this.version, payloadHash: digest(canonical(payload)), timestamp: Date.now(), nonce: nonce() };
    return { 'x-proctor-token': this.session.token,
      'x-proctor-proof': Buffer.from(JSON.stringify({ payload: proof, signature: sign(proof, this.device.privateKey) })).toString('base64url') };
  }

  async operation(action) {
    const session = await this.ensure();
    if (session.completed) return session;
    return this.transport.json(this.context.proctorPath, { operation: action }, this.proof(action, this.context.proctorPath, {}));
  }
}

module.exports = { ProctorAuth, Transport, ProctorError, identity };
