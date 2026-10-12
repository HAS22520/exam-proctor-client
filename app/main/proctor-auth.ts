import type {
  DeviceIdentity,
  HandshakePayload,
  LoginIdentity,
  RouteContext,
  SessionIdentity,
  SessionPayload,
  Trust,
} from './contracts';
import { deviceInfo } from './device-store';
import { PROTOCOL, canonical, digest, nonce, sign, verifyEnvelope } from './proctor-crypto';
import { ProctorError, isNetworkError, parseReply, proctorErrorMessage } from './protocol-errors';
import { Transport } from './protocol-transport';

interface ProctorAuthOptions {
  transport: Transport;
  context: RouteContext;
  identity: LoginIdentity;
  trust: Trust;
  device: DeviceIdentity;
  version: string;
  log?: (event: string) => void;
  attemptId?: string;
}

async function identity(transport: Transport, context: RouteContext, trust: Trust): Promise<LoginIdentity> {
  const clientNonce = nonce();
  const response = await transport.json(context.identityPath, {
    clientNonce,
    ...(context.tid ? { tid: context.tid } : {}),
    ...(context.problem ? { problem: context.problem } : {}),
  });
  const payload = verifyEnvelope<LoginIdentity>(response, trust.authPublicKey, {
    protocol: PROTOCOL,
    action: 'identity',
    keyId: trust.keyId,
    origin: context.origin,
    clientNonce,
    tid: context.tid,
    routePid: context.problem,
  });
  if (
    !Number.isSafeInteger(payload.uid) ||
    payload.uid < 0 ||
    typeof payload.domainId !== 'string' ||
    typeof payload.root !== 'boolean' ||
    (payload.root && payload.uid === 0)
  )
    throw new Error('Invalid signed login identity');
  transport.trace?.('info', 'identity.verified', {
    uid: payload.uid,
    domainId: payload.domainId,
    tid: payload.tid,
    root: payload.root,
  });
  return payload;
}

class ProctorAuth {
  declare transport: Transport;
  declare context: RouteContext;
  declare login: LoginIdentity;
  declare trust: Trust;
  declare device: DeviceIdentity;
  declare version: string;
  declare log: (event: string) => void;
  declare attemptId: string;
  declare session: SessionIdentity | null;
  declare pending: Promise<
    Omit<Partial<SessionIdentity>, 'completed'> & { completed?: boolean; receipt?: string }
  > | null;

  constructor({
    transport,
    context,
    identity: login,
    trust,
    device,
    version,
    log = () => {},
    attemptId = null,
  }: ProctorAuthOptions) {
    Object.assign(this, { transport, context, login, trust, device, version, log, attemptId });
    this.session = null;
    this.pending = null;
  }

  expected(action: string) {
    return {
      protocol: PROTOCOL,
      action,
      uid: this.login.uid,
      domainId: this.login.domainId,
      tid: this.context.tid,
      fingerprint: this.device.fingerprint,
      version: this.version,
      keyId: this.trust.keyId,
    };
  }

  accept(reply: unknown, previousAttempt?: string) {
    const response = reply as { token?: string };
    if (typeof response.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(response.token))
      throw new Error('Invalid session token');
    const payload = verifyEnvelope<SessionPayload>(
      response,
      this.trust.authPublicKey,
      { ...this.expected('session'), tokenHash: digest(response.token) },
      1800000,
    );
    if (
      !/^[a-f0-9]{24}$/.test(payload.attemptId || '') ||
      typeof payload.refreshEnabled !== 'boolean' ||
      ((previousAttempt || this.attemptId) && payload.attemptId !== (previousAttempt || this.attemptId))
    )
      throw new Error('Session attempt mismatch');
    this.attemptId = payload.attemptId;
    this.session = {
      ...payload,
      token: response.token,
      renewAt: Date.now() + ((Date.parse(payload.expiresAt) - Date.now()) * 2) / 3,
    };
    this.transport.trace?.('info', 'auth.session-accepted', {
      uid: payload.uid,
      domainId: payload.domainId,
      tid: payload.tid,
      version: payload.version,
    });
    return this.session;
  }

  async handshake() {
    const clientNonce = nonce();
    const info = deviceInfo();
    const response = await this.transport.json(this.context.proctorPath, {
      operation: 'challenge',
      version: this.version,
      fingerprint: this.device.fingerprint,
      clientNonce,
      publicKey: this.device.publicKey,
      deviceInfo: info,
    });
    const payload = verifyEnvelope<HandshakePayload>(response, this.trust.authPublicKey, {
      ...this.expected('handshake'),
      origin: this.context.origin,
      clientNonce,
      publicKey: this.device.publicKey,
      deviceInfo: info,
    });
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(payload.challengeId || '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(payload.serverNonce || '')
    ) {
      throw new Error('Invalid handshake challenge');
    }
    const result = await this.transport.json(this.context.proctorPath, {
      operation: 'handshake',
      challengeId: payload.challengeId,
      signature: sign(payload, this.device.privateKey),
    });
    if (result.completed === true) {
      if (!/^[a-f0-9]{24}$/.test(result.receipt || '')) throw new Error('Invalid completion receipt');
      this.session = null;
      this.transport.trace?.('info', 'auth.attempt-complete', {
        uid: this.login.uid,
        domainId: this.login.domainId,
        tid: this.context.tid,
        version: this.version,
        completed: true,
      });
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
          const result = await this.transport.json(
            this.context.proctorPath,
            { operation: 'refresh' },
            this.proof('refresh', this.context.proctorPath, {}),
          );
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
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  proof(action: string, path: string, payload: unknown, method = 'POST') {
    if (method !== (['problem_view', 'contest_view'].includes(action) ? 'GET' : 'POST'))
      throw new Error('Invalid proctor proof method');
    if (!this.session || Date.now() >= Date.parse(this.session.expiresAt)) throw new Error('Session expired');
    const proof = {
      protocol: PROTOCOL,
      action,
      method,
      path,
      tokenHash: this.session.tokenHash,
      fingerprint: this.device.fingerprint,
      version: this.version,
      payloadHash: digest(canonical(payload)),
      timestamp: Date.now(),
      nonce: nonce(),
    };
    return {
      'x-proctor-token': this.session.token,
      'x-proctor-proof': Buffer.from(
        JSON.stringify({ payload: proof, signature: sign(proof, this.device.privateKey) }),
      ).toString('base64url'),
    };
  }

  async operation(action: string) {
    const session = await this.ensure();
    if (session.completed) return session;
    return this.transport.json(
      this.context.proctorPath,
      { operation: action },
      this.proof(action, this.context.proctorPath, {}),
    );
  }
}

export { ProctorAuth, Transport, ProctorError, identity, parseReply, proctorErrorMessage, isNetworkError };
