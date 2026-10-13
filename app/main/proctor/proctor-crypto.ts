import * as crypto from 'node:crypto';
import type { Trust } from '../contracts';

const PROTOCOL = 'hydro-proctor/1';
const LOG_MAGIC = 'HYDRO-PROCTOR-LOG/1';

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('协议 JSON 数据无效');
}

const digest = (value: crypto.BinaryLike) => crypto.createHash('sha256').update(value).digest('hex');
const nonce = () => crypto.randomBytes(32).toString('base64url');
const sign = (payload: unknown, key: crypto.KeyLike) =>
  crypto.sign(null, Buffer.from(canonical(payload)), key).toString('base64url');

function verify(payload: unknown, signature: unknown, key: crypto.KeyLike) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    return crypto.verify(null, Buffer.from(canonical(payload)), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

function publicKey(pem: string, type: 'ed25519' | 'rsa') {
  if (typeof pem !== 'string' || !pem.startsWith('-----BEGIN PUBLIC KEY-----') || pem.includes('PRIVATE KEY')) {
    throw new Error('构建必须使用 SPKI 公钥，不能传入私钥');
  }
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== type || (type === 'rsa' && key.asymmetricKeyDetails.modulusLength !== 3072)) {
    throw new Error(`${type} 公钥无效`);
  }
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

function validateTrust(raw: Trust): Trust {
  if (!raw || !/^[a-f0-9]{32}$/.test(raw.keyId || '')) throw new Error('监考认证 keyId 无效');
  return {
    ...raw,
    authPublicKey: publicKey(raw.authPublicKey, 'ed25519'),
    logPublicKey: publicKey(raw.logPublicKey, 'rsa'),
    ...(raw.updatePublicKey ? { updatePublicKey: publicKey(raw.updatePublicKey, 'ed25519') } : {}),
  };
}

// 类型断言只描述验签后的结果；签名、身份绑定和有效期校验必须全部保留。
function verifyEnvelope<T extends object = Record<string, unknown>>(
  response: unknown,
  key: crypto.KeyLike,
  expected: Record<string, unknown>,
  maxLifetime = 120000,
) {
  const envelope = response as { payload?: Record<string, unknown>; signature?: unknown };
  const payload = envelope?.payload;
  if (
    !payload ||
    !verify(payload, envelope.signature, key) ||
    Object.entries(expected).some(([field, value]) => canonical(payload[field]) !== canonical(value))
  ) {
    throw new Error('服务端签名或身份不匹配');
  }
  const expiry = Date.parse(payload.expiresAt as string);
  if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + maxLifetime + 60000) {
    throw new Error('服务端响应已过期或无效');
  }
  return payload as T;
}

export { PROTOCOL, LOG_MAGIC, canonical, digest, nonce, sign, verify, publicKey, validateTrust, verifyEnvelope };
