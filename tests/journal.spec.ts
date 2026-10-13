import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import AuditLogger = require('../app/main/audit/audit-logger');
import { ProtectedStore } from '../app/main/audit/device-store';
import { decryptLog, store, trust, workspace } from './helpers';

function fixture(t) {
    const directory = workspace(t);
    const protectedStore = store(path.join(directory, 'secrets'));
    const binding: any = {
        uid: 7,
        domainId: 'exam',
        tid: 'c'.repeat(24),
        attemptId: 'b'.repeat(24),
        origin: 'https://oj.example.com',
        fingerprint: 'a'.repeat(64),
        publicKey: 'public',
    };
    return { directory, protectedStore, binding, logPublicKey: trust.logPublicKey, keyId: trust.keyId, nowBoot: 10000 };
}
test('日志以密文保存，最终文件可用 RSA OAEP 和 GCM 解密，重试不改变文件', async (t) => {
    const options = fixture(t);
    const logger = new AuditLogger(options);
    logger.append('TEST_PRIVATE_MARKER', { value: 'do-not-store-as-plaintext' });
    assert.ok(!fs.readFileSync(logger.journalPath).includes(Buffer.from('do-not-store-as-plaintext')));
    const filename = await logger.finalize();
    const original = fs.readFileSync(filename);
    const records = decryptLog(filename);
    assert.equal(records[0].binding.uid, 7);
    assert.ok(records.some((record) => record.type === 'TEST_PRIVATE_MARKER'));
    assert.equal(records.at(-1).type, 'FINISH_REQUESTED');
    assert.equal(logger.state.phase, 'pending-upload');
    logger.append('LATE_EVENT');
    assert.equal(await logger.finalize(), filename);
    assert.deepEqual(fs.readFileSync(filename), original);
    const resumed = new AuditLogger(options);
    assert.deepEqual(fs.readFileSync(await resumed.finalize()), original);
    resumed.uploaded('d'.repeat(24));
    assert.equal(resumed.state.phase, 'uploaded');
});
test('异常退出后续写日志，区分系统重启并恢复不完整的加密尾部', async (t) => {
    const options = fixture(t);
    const first = new AuditLogger(options);
    first.append('BEFORE_CRASH');
    fs.appendFileSync(first.journalPath, '{"incomplete":');
    const second = new AuditLogger(options);
    second.append('AFTER_CRASH');
    const records = decryptLog(await second.finalize());
    assert.ok(records.some((record) => record.type === 'ABNORMAL_EXIT_DETECTED'));
    assert.ok(records.some((record) => record.type === 'JOURNAL_TAIL_RECOVERED'));
    assert.ok(!records.some((record) => record.type === 'SYSTEM_RESTART'));
    assert.ok(records.some((record) => record.type === 'AFTER_CRASH'));
    const nextOptions = fixture(t);
    const beforeReboot = new AuditLogger(nextOptions);
    beforeReboot.append('BEFORE_REBOOT');
    const rebooted = new AuditLogger({ ...nextOptions, nowBoot: 30000 });
    assert.ok(decryptLog(await rebooted.finalize()).some((record) => record.type === 'SYSTEM_RESTART'));
});
test('日志拒绝中段损坏、跨用户绑定及系统密钥存储不可用的情况', (t) => {
    const options = fixture(t);
    const first = new AuditLogger(options);
    first.append('SECOND');
    const lines = fs.readFileSync(first.journalPath, 'utf8').trim().split('\n');
    lines[0] = '{}';
    fs.writeFileSync(first.journalPath, `${lines.join('\n')}\n`);
    assert.throws(() => new AuditLogger(options));
    assert.throws(() => new AuditLogger({ ...options, binding: { ...options.binding, uid: 8 } }));
    assert.throws(() => new ProtectedStore(options.directory, { isEncryptionAvailable: () => false } as any).device());
});

export {};
