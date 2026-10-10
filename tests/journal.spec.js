const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const AuditLogger = require('../app/main/audit-logger');
const { ProtectedStore } = require('../app/main/device-store');
const { trust, workspace, store, decryptLog } = require('./helpers');
function fixture(t) {
  const directory = workspace(t), protectedStore = store(path.join(directory, 'secrets'));
  const binding = { uid: 7, domainId: 'exam', tid: 'c'.repeat(24), attemptId: 'b'.repeat(24), origin: 'https://oj.example.com', fingerprint: 'a'.repeat(64), publicKey: 'public' };
  return { directory, protectedStore, binding, logPublicKey: trust.logPublicKey, keyId: trust.keyId, nowBoot: 10000 };
}
test('journal stores ciphertext, final log decrypts with RSA OAEP/GCM and remains immutable on retry', async (t) => {
  const options = fixture(t); const logger = new AuditLogger(options);
  logger.append('TEST_PRIVATE_MARKER', { value: 'do-not-store-as-plaintext' });
  assert.ok(!fs.readFileSync(logger.journalPath).includes(Buffer.from('do-not-store-as-plaintext')));
  const filename = await logger.finalize(); const original = fs.readFileSync(filename);
  const records = decryptLog(filename); assert.equal(records[0].binding.uid, 7);
  assert.ok(records.some((record) => record.type === 'TEST_PRIVATE_MARKER'));
  assert.equal(records.at(-1).type, 'FINISH_REQUESTED'); assert.equal(logger.state.phase, 'pending-upload');
  logger.append('LATE_EVENT'); assert.equal(await logger.finalize(), filename); assert.deepEqual(fs.readFileSync(filename), original);
  const resumed = new AuditLogger(options); assert.deepEqual(fs.readFileSync(await resumed.finalize()), original);
  resumed.uploaded('d'.repeat(24)); assert.equal(resumed.state.phase, 'uploaded');
});
test('abnormal process exit resumes log, distinguishes OS reboot, and recovers an incomplete encrypted tail', async (t) => {
  const options = fixture(t); const first = new AuditLogger(options); first.append('BEFORE_CRASH');
  fs.appendFileSync(first.journalPath, '{"incomplete":');
  const second = new AuditLogger(options); second.append('AFTER_CRASH');
  const records = decryptLog(await second.finalize());
  assert.ok(records.some((record) => record.type === 'ABNORMAL_EXIT_DETECTED'));
  assert.ok(records.some((record) => record.type === 'JOURNAL_TAIL_RECOVERED'));
  assert.ok(!records.some((record) => record.type === 'SYSTEM_RESTART'));
  assert.ok(records.some((record) => record.type === 'AFTER_CRASH'));
  const nextOptions = fixture(t); new AuditLogger(nextOptions);
  const rebooted = new AuditLogger({ ...nextOptions, nowBoot: 30000 });
  assert.ok(decryptLog(await rebooted.finalize()).some((record) => record.type === 'SYSTEM_RESTART'));
});
test('journal rejects middle corruption, cross-user binding and unavailable OS secret storage', (t) => {
  const options = fixture(t); const first = new AuditLogger(options); first.append('SECOND');
  const lines = fs.readFileSync(first.journalPath, 'utf8').trim().split('\n'); lines[0] = '{}'; fs.writeFileSync(first.journalPath, `${lines.join('\n')}\n`);
  assert.throws(() => new AuditLogger(options));
  assert.throws(() => new AuditLogger({ ...options, binding: { ...options.binding, uid: 8 } }));
  assert.throws(() => new ProtectedStore(options.directory, { isEncryptionAvailable: () => false }).device());
});
