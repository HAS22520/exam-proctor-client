const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProtectedStore } = require('../app/main/device-store');
const auth = crypto.generateKeyPairSync('ed25519');
const logs = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const trust = { keyId: 'a'.repeat(32), authPublicKey: auth.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  logPublicKey: logs.publicKey.export({ type: 'spki', format: 'pem' }).toString(), allowedOrigins: ['https://oj.example.com'], updateOrigins: ['https://oj.example.com'] };
function workspace(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function store(directory) {
  const key = crypto.randomBytes(32);
  return new ProtectedStore(directory, { isEncryptionAvailable: () => true,
    encryptString: (text) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(text), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
    decryptString: (bytes) => { const c = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); c.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([c.update(bytes.subarray(28)), c.final()]).toString(); },
  });
}
function decryptLog(filename) {
  const bytes = fs.readFileSync(filename); const start = bytes.indexOf(10) + 1, end = bytes.indexOf(10, start);
  const header = JSON.parse(bytes.subarray(start, end));
  const key = crypto.privateDecrypt({ key: logs.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(header.wrappedKey, 'base64url'));
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64url'));
  cipher.setAAD(Buffer.from(`HYDRO-PROCTOR-LOG/1:${header.keyId}`)); cipher.setAuthTag(Buffer.from(header.tag, 'base64url'));
  return Buffer.concat([cipher.update(bytes.subarray(end + 1)), cipher.final()]).toString().trim().split('\n').map(JSON.parse);
}
module.exports = { auth, logs, trust, workspace, store, decryptLog };
