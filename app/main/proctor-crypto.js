const crypto = require('node:crypto');

const PROTOCOL = 'hydro-proctor/1';
const LOG_MAGIC = 'HYDRO-PROCTOR-LOG/1';

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Invalid protocol JSON value');
}

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const nonce = () => crypto.randomBytes(32).toString('base64url');
const sign = (payload, key) => crypto.sign(null, Buffer.from(canonical(payload)), key).toString('base64url');

function verify(payload, signature, key) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try { return crypto.verify(null, Buffer.from(canonical(payload)), key, Buffer.from(signature, 'base64url')); }
  catch { return false; }
}

function publicKey(pem, type) {
  if (typeof pem !== 'string' || !pem.startsWith('-----BEGIN PUBLIC KEY-----') || pem.includes('PRIVATE KEY')) {
    throw new Error('Build requires SPKI public keys, never private keys');
  }
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== type || (type === 'rsa' && key.asymmetricKeyDetails.modulusLength !== 3072)) {
    throw new Error(`Invalid ${type} public key`);
  }
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

function validateTrust(raw) {
  if (!raw || !/^[a-f0-9]{32}$/.test(raw.keyId || '')) throw new Error('Invalid proctor keyId');
  return { ...raw, authPublicKey: publicKey(raw.authPublicKey, 'ed25519'), logPublicKey: publicKey(raw.logPublicKey, 'rsa'),
    ...(raw.updatePublicKey ? { updatePublicKey: publicKey(raw.updatePublicKey, 'ed25519') } : {}) };
}

function verifyEnvelope(response, key, expected, maxLifetime = 120000) {
  const payload = response?.payload;
  if (!payload || !verify(payload, response.signature, key)
    || Object.entries(expected).some(([field, value]) => canonical(payload[field]) !== canonical(value))) {
    throw new Error('Server signature or identity mismatch');
  }
  const expiry = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + maxLifetime + 60000) {
    throw new Error('Server response expired or invalid');
  }
  return payload;
}

module.exports = { PROTOCOL, LOG_MAGIC, canonical, digest, nonce, sign, verify, publicKey, validateTrust, verifyEnvelope };
