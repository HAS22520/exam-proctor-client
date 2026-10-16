import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Transport } from '../app/main/proctor/proctor-auth';
import { ProctorController } from '../app/main/proctor/proctor-controller';
import { canonical, digest, nonce, sign, verify } from '../app/main/proctor/proctor-crypto';
import { hasUnfinishedJournals } from '../app/main/updates/update-cache';
import { auth, decryptLog, forEachSerial, store, trust, workspace } from './helpers';

const contestUrl = 'https://oj.example.com/d/exam/contest/1234567890abcdef12345678';
function fixture(t, recordOptions: { tid?: string, rid?: string } = {}) {
    const directory = workspace(t);
    const protectedStore = store(path.join(directory, 'secrets'));
    let offline = false;
    let uid = 7;
    let challenge;
    let attempts = 0;
    let loseResponse = false;
    const accounts = new Map();
    const account = () => {
        if (!accounts.has(uid)) {
            accounts.set(uid, { state: 'open', attemptId: uid === 7 ? 'b'.repeat(24) : uid.toString(16).padStart(24, '0') });
        }
        return accounts.get(uid);
    };
    const requests = [];
    const tokens = new Map();
    const usedNonces = new Set();
    const envelope = (payload) => ({ payload, signature: sign(payload, auth.privateKey) });
    const examSession: any = {
        fetch: async (url, request) => {
            if (offline) throw new Error('网络已断开');
            const body = typeof request.body === 'string' ? JSON.parse(request.body.toString()) : request.body;
            requests.push({ url: String(url), method: request.method, operation: body?.operation });
            let response;
            if (String(url).endsWith('/proctor/identity')) {
                response = envelope({
                    protocol: 'hydro-proctor/1',
                    action: 'identity',
                    keyId: trust.keyId,
                    origin: 'https://oj.example.com',
                    clientNonce: body.clientNonce,
                    uid,
                    domainId: 'exam',
                    root: false,
                    tid: body.rid ? recordOptions.tid || '1234567890abcdef12345678' : body.tid || '',
                    ...(body.rid ? { rid: recordOptions.rid || body.rid } : {}),
                    routePid: body.problem || '',
                    pid: 100,
                    proctorEnabled: true,
                    expiresAt: new Date(Date.now() + 60000).toISOString(),
                });
            } else if (request.method === 'GET' && String(url).endsWith('/problems')) {
                const token = request.headers['x-proctor-token'];
                const proof = JSON.parse(Buffer.from(request.headers['x-proctor-proof'], 'base64url').toString());
                const session = tokens.get(token);
                const p = proof.payload;
                assert.equal(session.uid, uid);
                assert.equal(account().state, 'open');
                assert.equal(p.tokenHash, digest(token));
                assert.equal(p.action, 'contest_view');
                assert.equal(p.method, 'GET');
                assert.equal(p.path, new URL(url).pathname);
                assert.equal(p.version, '1.0.0');
                assert.equal(p.payloadHash, digest(canonical({ tid: '1234567890abcdef12345678' })));
                assert.ok(verify(p, proof.signature, protectedStore.device().publicKey));
                assert.ok(!usedNonces.has(p.nonce));
                usedNonces.add(p.nonce);
                response = { ok: true };
            } else if (request.method === 'GET') {
                response = { state: account().state, logUploaded: !!account().receipt, receipt: account().receipt };
            } else if (body.operation === 'challenge') {
                if (body.version !== '1.0.0') {
                    return new Response(
                        JSON.stringify({
                            error: {
                                name: 'ForbiddenError',
                                message: 'ForbiddenError',
                                code: 403,
                                params: ['Proctor client version mismatch.'],
                            },
                        }),
                        { status: 403, headers: { 'content-type': 'application/json' } },
                    );
                }
                challenge = {
                    protocol: 'hydro-proctor/1',
                    action: 'handshake',
                    keyId: trust.keyId,
                    origin: 'https://oj.example.com',
                    uid,
                    domainId: 'exam',
                    tid: '1234567890abcdef12345678',
                    fingerprint: body.fingerprint,
                    version: body.version,
                    publicKey: body.publicKey,
                    deviceInfo: body.deviceInfo,
                    clientNonce: body.clientNonce,
                    challengeId: nonce(),
                    serverNonce: nonce(),
                    expiresAt: new Date(Date.now() + 120000).toISOString(),
                };
                response = envelope(challenge);
            } else if (body.operation === 'handshake') {
                assert.ok(verify(challenge, body.signature, challenge.publicKey));
                if (account().receipt) response = { completed: true, receipt: account().receipt.id };
                else {
                    const token = nonce();
                    tokens.set(token, { uid });
                    response = {
                        token,
                        ...envelope({
                            protocol: 'hydro-proctor/1',
                            action: 'session',
                            keyId: trust.keyId,
                            uid,
                            domainId: 'exam',
                            tid: challenge.tid,
                            fingerprint: challenge.fingerprint,
                            version: challenge.version,
                            tokenHash: digest(token),
                            attemptId: account().attemptId,
                            refreshEnabled: true,
                            expiresAt: new Date(Date.now() + 600000).toISOString(),
                        }),
                    };
                }
            } else if (body.operation === 'finish') {
                account().state = 'closing';
                response = { ok: true };
            } else if (body instanceof FormData) {
                attempts++;
                const file = body.get('file') as File;
                const bytes = Buffer.from(await file.arrayBuffer());
                const proof = JSON.parse(Buffer.from(request.headers['x-proctor-proof'], 'base64url').toString());
                assert.ok(verify(proof.payload, proof.signature, protectedStore.device().publicKey));
                assert.equal(
                    proof.payload.payloadHash,
                    digest(
                        require('../app/main/proctor/proctor-crypto').canonical({
                            filename: file.name,
                            size: bytes.length,
                            sha256: digest(bytes),
                        }),
                    ),
                );
                account().receipt = { id: 'd'.repeat(24), sha256: digest(bytes) };
                account().state = 'complete';
                if (loseResponse) throw new Error('响应丢失');
                response = { ok: true, receipt: account().receipt.id };
            } else throw new Error('未预期的模拟请求');
            return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
        },
    };
    const config: any = { exam: { allowedOrigins: ['https://oj.example.com'] }, trust };
    const statuses = [];
    const options: any = {
        config,
        directory: path.join(directory, 'journals'),
        protectedStore,
        session: examSession,
        version: '1.0.0',
        onStatus: (status) => statuses.push(status),
        createTransport: (origin, timeout) => {
            const transport = new Transport(examSession, origin, timeout);
            transport.upload = async (target, { filename, uploadName, headers, onProgress }) => {
                const bytes = fs.readFileSync(filename);
                const body = new FormData();
                body.set('operation', 'upload');
                body.set('file', new Blob([bytes]), uploadName);
                onProgress({ phase: 'uploading', sent: Math.floor(bytes.length / 2), total: bytes.length, percent: 50 });
                onProgress({ phase: 'verifying', sent: bytes.length, total: bytes.length, percent: 100 });
                assert.notEqual(statuses.at(-1).upload.phase, 'complete');
                return transport.request(target, { body, headers });
            };
            return transport;
        },
    };
    return {
        options,
        statuses,
        requests,
        get attempts() {
            return attempts;
        },
        get offline() {
            return offline;
        },
        set offline(value) {
            offline = value;
        },
        get uid() {
            return uid;
        },
        set uid(value) {
            uid = value;
        },
        get loseResponse() {
            return loseResponse;
        },
        set loseResponse(value) {
            loseResponse = value;
        },
    };
}

test('登录变化立即撤销认证状态，同时保留可续写的加密日志', async (t) => {
    const f = fixture(t);
    const controller = new ProctorController(f.options);
    try {
        await controller.sync(contestUrl);
        const record = controller.current;
        assert.equal(f.statuses.at(-1).authenticated, true);
        controller.invalidateIdentity();
        assert.equal(f.statuses.at(-1).authenticated, false);
        assert.equal(f.statuses.at(-1).root, false);
        assert.equal(record.auth.session, null);
        assert.equal(record.journal.state.phase, 'open');
        assert.ok(controller.records.size);
    } finally {
        controller.shutdown();
    }
});

test('已结束握手为终态，不重复握手，其他账号仍可独立访问同场比赛', async (t) => {
    const f = fixture(t);
    const first = new ProctorController(f.options);
    await first.sync(contestUrl);
    assert.equal(await first.finish(), true);
    first.shutdown();
    assert.equal(hasUnfinishedJournals(path.dirname(f.options.directory)), false);
    const oldFile = path.join(first.current.journal.directory, 'final.hplog');
    const oldBytes = fs.readFileSync(oldFile);
    const controller = new ProctorController(f.options);
    await controller.sync(contestUrl);
    assert.equal(controller.current.completed, true);
    assert.equal(controller.current.auth.session, null);
    assert.equal(f.statuses.at(-1).phase, 'complete');
    assert.equal(f.statuses.at(-1).ended, true);
    assert.equal(f.statuses.at(-1).authenticated, false);
    assert.match(f.statuses.at(-1).message, /日志已上传/);
    const handshakes = () => f.requests.filter((request) => request.operation === 'handshake').length;
    const count = handshakes();
    const request: any = {
        action: 'contest_view',
        method: 'GET',
        path: '/d/exam/contest/1234567890abcdef12345678/problems',
        payload: { tid: '1234567890abcdef12345678' },
    };
    await forEachSerial([1, 2, 3], async () => {
        await assert.rejects(controller.headers(contestUrl, request), (error: any) => error.code === 'PROCTOR_ATTEMPT_COMPLETE');
        await controller.sync(contestUrl, { force: true });
    });
    assert.equal(handshakes(), count);
    f.uid = 8;
    controller.invalidateIdentity();
    await forEachSerial([1, 2], async () => {
        const headers = await controller.headers(contestUrl, request);
        assert.equal((await f.options.session.fetch(`${contestUrl}/problems`, { method: 'GET', headers })).status, 200);
        assert.equal(controller.current.login.uid, 8);
        assert.equal(controller.current.completed, undefined);
        assert.equal(f.statuses.at(-1).authenticated, true);
        assert.equal(f.statuses.at(-1).ended, false);
    });
    assert.equal(handshakes(), count + 1);
    assert.notEqual(controller.current.auth.attemptId, first.current.auth.attemptId);
    assert.deepEqual(fs.readFileSync(oldFile), oldBytes);
    const restarted = new ProctorController(f.options);
    const headers = await restarted.headers(contestUrl, request);
    assert.equal((await f.options.session.fetch(`${contestUrl}/problems`, { method: 'GET', headers })).status, 200);
    assert.equal(restarted.current.login.uid, 8);
    assert.equal(hasUnfinishedJournals(path.dirname(f.options.directory)), true);
});
test('同账号同路由的并发认证共享一次握手和进度', async (t) => {
    const ActivityProgress = require('../app/main/diagnostics/activity-progress');
    const f = fixture(t);
    const events = [];
    const progress = new ActivityProgress({ onChange: (value) => events.push(value) });
    const controller = new ProctorController({ ...f.options, activity: progress.run.bind(progress) });
    const requests = Array.from({ length: 8 }, () => controller.sync(contestUrl));
    assert.ok(requests.every((request) => request === requests[0]));
    const records = await Promise.all(requests);
    assert.equal(new Set(records).size, 1);
    assert.equal(controller.records.size, 1);
    assert.equal(f.requests.filter((request) => request.url.endsWith('/proctor/identity')).length, 1);
    assert.equal(f.requests.filter((request) => request.operation === 'handshake').length, 1);
    assert.equal(controller.pendingIdentities.size, 0);
    assert.equal(progress.snapshot(), null);
    assert.equal(events.filter((value) => value?.busy).length, 1);
    const cached = controller.sync(contestUrl);
    const forced = Array.from({ length: 4 }, () => controller.sync(contestUrl, { force: true }));
    assert.notEqual(cached, forced[0]);
    assert.ok(forced.every((request) => request === forced[0]));
    await Promise.all([cached, ...forced]);
    assert.equal(f.requests.filter((request) => request.url.endsWith('/proctor/identity')).length, 2);
    // 登录变化后必须获取新身份和新会话，不能共享旧会话。
    f.uid = 8;
    controller.invalidateIdentity();
    assert.equal((await controller.sync(contestUrl)).login.uid, 8);
});
test('断网撤销已认证标记且保留开放日志，签名恢复后清除错误', async (t) => {
    const f = fixture(t);
    const controller = new ProctorController(f.options);
    await controller.sync(contestUrl);
    const journal = controller.current.journal;
    const attempt = controller.current.auth.attemptId;
    assert.equal(f.statuses.at(-1).authenticated, true);
    controller.authenticationFailed(new Error('net::ERR_CONNECTION_CLOSED'));
    assert.equal(f.statuses.at(-1).authenticated, false);
    assert.equal(f.statuses.at(-1).phase, 'network-error');
    assert.match(f.statuses.at(-1).message, /无法连接 OJ/);
    controller.status();
    assert.match(f.statuses.at(-1).message, /无法连接 OJ/);
    assert.equal(journal.state.phase, 'open');
    f.offline = true;
    await assert.rejects(controller.sync(contestUrl));
    assert.equal(f.statuses.at(-1).authenticated, false);
    f.offline = false;
    await controller.sync(contestUrl);
    assert.equal(f.statuses.at(-1).authenticated, true);
    assert.equal(f.statuses.at(-1).message, '');
    assert.equal(controller.current.journal, journal);
    assert.equal(controller.current.auth.attemptId, attempt);
    assert.equal(journal.state.phase, 'open');
    controller.current.auth.session.expiresAt = new Date(Date.now() - 1).toISOString();
    controller.status();
    assert.equal(f.statuses.at(-1).authenticated, false);
});
test('签名身份返回期间 Cookie 变化时，握手前丢弃旧身份', async (t) => {
    const f = fixture(t);
    const identities = [];
    let enter, release;
    const waiting = new Promise((resolve) => {
        enter = resolve;
    });
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    let pause = true;
    const controller = new ProctorController({
        ...f.options,
        onIdentity: async (login) => identities.push(login),
        createTransport: (...args) => {
            const transport = f.options.createTransport(...args);
            const json = transport.json.bind(transport);
            transport.json = async (target, ...rest) => {
                const result = await json(target, ...rest);
                if (pause && target.endsWith('/proctor/identity')) {
                    pause = false;
                    enter();
                    await gate;
                }
                return result;
            };
            return transport;
        },
    });
    const first = controller.sync(contestUrl);
    const duplicate = controller.sync(contestUrl);
    assert.equal(duplicate, first);
    await waiting;
    f.uid = 8;
    controller.invalidateIdentity();
    const fresh = controller.sync(contestUrl);
    assert.notEqual(fresh, first);
    release();
    await assert.rejects(first, /登录状态已变化/);
    assert.equal(identities.length, 0);
    assert.equal(controller.records.size, 0);
    assert.equal(
        f.requests.some((request) => request.operation === 'challenge'),
        false,
    );
    assert.equal((await fresh).login.uid, 8);
});
test('离线结束持久保存不可变证据，重启后仅原账号可补传并保存回执', async (t) => {
    const f = fixture(t);
    const first = new ProctorController(f.options);
    await first.sync(contestUrl);
    f.offline = true;
    assert.equal(await first.finish(), false);
    const record = first.current;
    assert.equal(record.journal.state.phase, 'pending-upload');
    const filename = path.join(record.journal.directory, 'final.hplog');
    const bytes = fs.readFileSync(filename);
    assert.equal(hasUnfinishedJournals(path.dirname(f.options.directory)), true);
    assert.equal(f.statuses.at(-1).upload.phase, 'deferred');
    assert.ok(decryptLog(filename).some((entry) => entry.type === 'LOG_UPLOAD_DEFERRED'));
    first.shutdown();
    f.offline = false;
    f.uid = 8;
    const restarted = new ProctorController(f.options);
    await restarted.sync('https://oj.example.com/d/exam/');
    await restarted.retryUploads();
    assert.equal(f.attempts, 0);
    f.uid = 7;
    restarted.invalidateIdentity();
    await restarted.sync('https://oj.example.com/d/exam/');
    record.journal.state.retryAfter = 0;
    record.journal.saveState();
    await restarted.retryUploads();
    assert.equal(f.attempts, 1);
    assert.deepEqual(fs.readFileSync(filename), bytes);
    assert.ok(f.statuses.some((status) => status.upload?.percent === 50));
    assert.equal(f.statuses.at(-1).upload.phase, 'complete');
    const saved = JSON.parse(fs.readFileSync(record.journal.statePath).toString());
    assert.equal(saved.phase, 'uploaded');
    assert.equal(saved.receipt, 'd'.repeat(24));
    assert.equal(hasUnfinishedJournals(path.dirname(f.options.directory)), false);
});

test('结束流程在等待网络恢复前禁用新证明，再封存上传', async (t) => {
    const f = fixture(t);
    const controller = new ProctorController(f.options);
    await controller.sync(contestUrl);
    let restore;
    const pending = controller.finish(
        () =>
            new Promise((resolve) => {
                restore = resolve;
            }),
    );
    assert.equal(controller.finishing, true);
    assert.equal(controller.current.journal.state.phase, 'open');
    await assert.rejects(controller.headers(contestUrl, { action: 'contest_view' } as any), /禁止新提交/);
    assert.equal(f.attempts, 0);
    restore();
    assert.equal(await pending, true);
    assert.equal(f.attempts, 1);
});
test('上传响应丢失后按状态哈希确认成功，不上传替换日志', async (t) => {
    const f = fixture(t);
    const controller = new ProctorController(f.options);
    await controller.sync(contestUrl);
    f.loseResponse = true;
    assert.equal(await controller.finish(), true);
    assert.equal(f.attempts, 1);
    assert.equal(controller.current.journal.state.phase, 'uploaded');
    await controller.retryUploads();
    assert.equal(f.attempts, 1);
});
test('首页登录后恢复开放考试，离线身份请求期间仍记录日志', async (t) => {
    const f = fixture(t);
    const first = new ProctorController(f.options);
    await first.sync(contestUrl);
    const resumed = new ProctorController(f.options);
    await resumed.sync('https://oj.example.com/d/exam/');
    assert.equal(resumed.records.size, 1);
    resumed.logViolation({ source: 'CLIENT', type: 'HOME_PAGE_AUDIT', target: '', detail: '' });
    f.offline = true;
    await assert.rejects(resumed.sync('https://oj.example.com/d/exam/', { force: true }));
    resumed.logViolation({ source: 'CLIENT', type: 'OFFLINE_AUDIT', target: '', detail: '' });
    assert.equal(await resumed.finish(), false);
    const journal = [...resumed.records.values()][0].journal;
    const records = decryptLog(path.join(journal.directory, 'final.hplog'));
    for (const event of ['ABNORMAL_EXIT_DETECTED', 'CLIENT_RESTART', 'HOME_PAGE_AUDIT', 'OFFLINE_AUDIT']) {
        assert.ok(records.some((record) => record.type === event));
    }
});
test('显式重试仅对签名确认的当前账号解除策略暂停', async (t) => {
    const f = fixture(t);
    const controller = new ProctorController(f.options);
    await controller.sync(contestUrl);
    f.offline = true;
    await controller.finish();
    const journal = controller.current.journal;
    Object.assign(journal.state, {
        permanentError: true,
        failureVersion: '1.0.0',
        failureKeyId: trust.keyId,
        retryAfter: Date.now() + 3600000,
    });
    journal.saveState();
    f.offline = false;
    const restarted = new ProctorController(f.options);
    await restarted.sync('https://oj.example.com/d/exam/');
    await restarted.retryUploads();
    assert.equal(f.attempts, 0);
    await restarted.retryManually('https://oj.example.com/d/exam/');
    assert.equal(f.attempts, 1);
    assert.equal([...restarted.records.values()][0].journal.state.phase, 'uploaded');
});

test('受保护题目读取要求匹配客户端和开放会话，每次生成新 GET 证明', async (t) => {
    const f = fixture(t);
    const controller = new ProctorController(f.options);
    const request: any = {
        action: 'problem_view',
        method: 'GET',
        path: '/d/exam/p/100',
        payload: { tid: '1234567890abcdef12345678', pid: '100' },
    };
    const first = await controller.headers(contestUrl, request);
    const second = await controller.headers(contestUrl, request);
    const proof = JSON.parse(Buffer.from(first['x-proctor-proof'], 'base64url').toString());
    assert.ok(verify(proof.payload, proof.signature, f.options.protectedStore.device().publicKey));
    assert.equal(proof.payload.method, 'GET');
    assert.equal(proof.payload.action, 'problem_view');
    assert.notEqual(first['x-proctor-proof'], second['x-proctor-proof']);
    const contest = await controller.headers(contestUrl, {
        action: 'contest_view',
        method: 'GET',
        path: '/d/exam/contest/1234567890abcdef12345678/problems',
        payload: { tid: request.payload.tid },
    });
    assert.equal(JSON.parse(Buffer.from(contest['x-proctor-proof'], 'base64url').toString()).payload.action, 'contest_view');
    f.offline = true;
    controller.invalidateIdentity();
    await assert.rejects(controller.headers(contestUrl, request));
    f.offline = false;
    await controller.finish();
    await assert.rejects(controller.headers(contestUrl, request));
    await assert.rejects(controller.sync(contestUrl), /正在结束/);
    const wrongFixture = fixture(t);
    const wrong = new ProctorController({ ...wrongFixture.options, version: '0.9.0' });
    await assert.rejects(wrong.headers(contestUrl, request), /version mismatch/);
    assert.equal(wrong.records.size, 0);
    assert.equal(wrongFixture.statuses.at(-1).authenticated, false);
    assert.match(wrongFixture.statuses.at(-1).message, /版本不符合系统要求（当前：0\.9\.0）/);
});

test('未开始考试时退出报告没有待上传日志，不伪造服务端回执', async (t) => {
    const f = fixture(t);
    const controller = new ProctorController(f.options);
    assert.equal(await controller.finish(), true);
    assert.equal(f.statuses.at(-1).upload.empty, true);
    assert.equal(f.attempts, 0);
    assert.equal(controller.records.size, 0);
});

test('并发导航共享握手，重复读取复用签名身份但生成新证明', async (t) => {
    const f = fixture(t);
    const controller = new ProctorController(f.options);
    await Promise.all([controller.sync(contestUrl), controller.sync(`${contestUrl}/problems`), controller.sync(contestUrl)]);
    assert.equal(f.requests.filter((request) => request.url.endsWith('/proctor/identity')).length, 1);
    assert.equal(f.requests.filter((entry) => entry.operation === 'challenge').length, 1);
    const request: any = {
        action: 'contest_view',
        method: 'GET',
        path: '/d/exam/contest/1234567890abcdef12345678/problems',
        payload: { tid: '1234567890abcdef12345678' },
    };
    const before = f.requests.length;
    const first = await controller.headers(contestUrl, request);
    const second = await controller.headers(`${contestUrl}/problems`, request);
    assert.equal(f.requests.length, before);
    assert.notEqual(first['x-proctor-proof'], second['x-proctor-proof']);
    f.uid = 8;
    controller.invalidateIdentity();
    assert.equal((await controller.sync(contestUrl)).login.uid, 8);
    assert.equal(f.requests.filter((entry) => entry.operation === 'challenge').length, 2);
});

test('签名上下文过期或强制检查时联系服务端，不延长本地缓存', async (t) => {
    const f = fixture(t);
    const controller = new ProctorController(f.options);
    await controller.sync(contestUrl);
    for (const entry of controller.identityCache.values()) entry.validUntil = 0;
    await controller.sync(contestUrl);
    await controller.sync(contestUrl, { force: true });
    assert.equal(f.requests.filter((request) => request.url.endsWith('/proctor/identity')).length, 3);
    assert.equal(f.requests.filter((request) => request.operation === 'handshake').length, 1);
});

test('暂停保留服务端开放会话和加密日志，重启续写后再最终上传', async (t) => {
    const f = fixture(t);
    const first = new ProctorController(f.options);
    await first.sync(contestUrl);
    const record = first.current;
    const attemptId = record.auth.attemptId;
    record.journal.append('BEFORE_PAUSE');
    await first.pause();
    first.shutdown();
    assert.equal(f.attempts, 0);
    assert.equal(
        f.requests.some((item) => item.operation === 'finish'),
        false,
    );
    assert.equal(record.journal.state.phase, 'open');
    assert.equal(record.journal.state.clean, true);
    assert.equal(fs.existsSync(path.join(record.journal.directory, 'final.hplog')), false);
    const restarted = new ProctorController(f.options);
    const request: any = {
        action: 'contest_view',
        method: 'GET',
        path: '/d/exam/contest/1234567890abcdef12345678/problems',
        payload: { tid: '1234567890abcdef12345678' },
    };
    const headers = await restarted.headers(contestUrl, request);
    assert.equal((await f.options.session.fetch(`${contestUrl}/problems`, { method: 'GET', headers })).status, 200);
    assert.equal(restarted.current.auth.attemptId, attemptId);
    assert.equal(restarted.current.journal.directory, record.journal.directory);
    restarted.current.journal.append('AFTER_PAUSE');
    assert.equal(await restarted.finish(), true);
    assert.equal(f.attempts, 1);
    const records = decryptLog(path.join(record.journal.directory, 'final.hplog'));
    for (const type of ['BEFORE_PAUSE', 'CLIENT_PAUSED', 'CLIENT_SHUTDOWN', 'CLIENT_RESTART', 'AFTER_PAUSE']) {
        assert.ok(records.some((item) => item.type === type));
    }
    assert.equal(
        records.some((item) => item.type === 'ABNORMAL_EXIT_DETECTED'),
        false,
    );
});

export {};

test('记录、下载和回放依据服务端签名解析比赛，复用个人会话且每次读取生成独立证明', async (t) => {
    const f = fixture(t);
    const controller = new ProctorController(f.options);
    try {
        const rid = 'abcdef1234567890abcdef12';
        const url = `https://oj.example.com/d/exam/record/${rid}`;
        await controller.sync(url);
        assert.equal(controller.current.context.tid, '1234567890abcdef12345678');
        assert.ok(controller.current.journal);
        const nonces = new Set();
        await forEachSerial(['', '/replay', '/replay/data'], async (suffix) => {
            const requestPath = `/d/exam/record/${rid}${suffix}`;
            const headers = await controller.headers(url, { action: 'record_view', method: 'GET', path: requestPath, payload: { rid } });
            const proof = JSON.parse(Buffer.from(headers['x-proctor-proof'], 'base64url').toString());
            assert.equal(proof.payload.action, 'record_view');
            assert.equal(proof.payload.path, requestPath);
            assert.equal(proof.payload.payloadHash, digest(canonical({ rid })));
            assert.ok(verify(proof.payload, proof.signature, f.options.protectedStore.device().publicKey));
            nonces.add(proof.payload.nonce);
        });
        assert.equal(nonces.size, 3);
        assert.equal(controller.records.size, 1);
        assert.equal(f.requests.filter((request) => request.operation === 'handshake').length, 1);
    } finally {
        controller.shutdown();
    }
});

test('记录读取拒绝错误签名归属、跨比赛及已结束个人监考', async (t) => {
    const rid = 'abcdef1234567890abcdef12';
    const request = { action: 'record_view', method: 'GET', path: `/d/exam/record/${rid}`, payload: { rid } };
    const wrong = new ProctorController(fixture(t, { rid: 'f'.repeat(24) }).options);
    await assert.rejects(wrong.headers(contestUrl, request));
    const cross = new ProctorController(fixture(t, { tid: 'f'.repeat(24) }).options);
    await assert.rejects(cross.headers(contestUrl, request));
    const f = fixture(t);
    const controller = new ProctorController(f.options);
    await controller.sync(contestUrl);
    await controller.finish();
    await assert.rejects(controller.headers(contestUrl, request), /本场监考已结束|监考正在结束/);
    wrong.shutdown();
    cross.shutdown();
    controller.shutdown();
});
