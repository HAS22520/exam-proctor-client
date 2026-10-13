import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessRequest, accessTarget } from '../app/main/proctor/proctor-access';
import { ProctorAuth, ProctorError } from '../app/main/proctor/proctor-auth';
import { canonical, digest, verify } from '../app/main/proctor/proctor-crypto';
import { contextFromUrl } from '../app/main/security/config-policy';
import ProctorRequestGuard = require('../app/main/proctor/proctor-request-guard');
import { auth, forEachSerial } from './helpers';

const tid = '1234567890abcdef12345678';
const origin = 'https://oj.example.com';

test('受保护读取保留原始路径，只规范化数字题号', () => {
    for (const suffix of ['', '/submit', '/file/test%20data.zip']) {
        const target = accessTarget(`${origin}/d/exam/p/00100${suffix}?tid=${tid}&download=1`);
        assert.deepEqual(target.payload, { tid, pid: '100' });
        assert.equal(target.path, `/d/exam/p/00100${suffix}`);
        assert.equal(target.action, 'problem_view');
    }
    assert.equal(accessTarget(`${origin}/p/P100?tid=${tid}`).payload.pid, 'P100');
    for (const suffix of ['problems', 'print', 'api/printing/team', 'file/private/test.zip']) {
        const target = accessTarget(`${origin}/d/exam/contest/${tid}/${suffix}`);
        assert.equal(target.action, 'contest_view');
        assert.deepEqual(target.payload, { tid });
    }
    for (const value of [
        '/p/100',
        `/p/100?tid=${tid}&tid=${tid}`,
        `/p/%2f?tid=${tid}`,
        `/p/%00?tid=${tid}`,
        `/p/%20?tid=${tid}`,
        `/contest/${tid}`,
        `/contest/${tid}/proctor`,
        '/proctor/identity',
        `/contest/${tid}/file/public/test`,
    ]) {
        assert.equal(accessTarget(origin + value), null);
    }
});

test('读取桥拒绝任意路径、方法、内容以及跨域和跨比赛请求', () => {
    const source = contextFromUrl(`${origin}/d/exam/contest/${tid}`);
    const good: any = {
        action: 'problem_view',
        method: 'GET',
        path: '/d/exam/p/100/file/test.zip',
        payload: { tid, pid: '100' },
    };
    assert.equal(accessRequest(good, source).path, good.path);
    for (const changed of [
        { method: 'POST' },
        { action: 'submit' },
        { path: '//evil.example/p/100' },
        { path: '/d/other/p/100' },
        { path: `/d/exam/p/100?tid=${tid}` },
        { path: '/d/exam/p/100#fragment' },
        { path: '/d/exam/manage' },
        { path: '/d/exam/p/100/../101' },
        { payload: { tid, pid: 100 } },
        { payload: { tid, pid: '101' } },
        { payload: { tid, pid: '100', extra: true } },
        { payload: { tid: 'f'.repeat(24), pid: '100' } },
    ]) {
        assert.throws(() => accessRequest({ ...good, ...changed }, source));
    }
});

test('GET 证明绑定动作、路径和内容，并为每次请求生成新随机数', () => {
    const device: any = { privateKey: auth.privateKey, fingerprint: 'f'.repeat(64) };
    const signer = new ProctorAuth({ device, version: '1.0.0' } as any);
    signer.session = {
        token: 't'.repeat(43),
        tokenHash: digest('t'.repeat(43)),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
    } as any;
    const payload: any = { tid, pid: '100' };
    const path = '/d/exam/p/100';
    const first = JSON.parse(Buffer.from(signer.proof('problem_view', path, payload, 'GET')['x-proctor-proof'], 'base64url').toString());
    const second = JSON.parse(Buffer.from(signer.proof('problem_view', path, payload, 'GET')['x-proctor-proof'], 'base64url').toString());
    assert.ok(verify(first.payload, first.signature, auth.publicKey));
    assert.equal(first.payload.method, 'GET');
    assert.equal(first.payload.path, path);
    assert.equal(first.payload.payloadHash, digest(canonical(payload)));
    assert.notEqual(first.payload.nonce, second.payload.nonce);
    assert.throws(() => signer.proof('problem_view', path, payload));
    assert.throws(() => signer.proof('submit', path, payload, 'GET'));
});

test('网络策略校验直接访问、刷新和附件请求，并保留桥生成的证明', async () => {
    const calls = [];
    const token = 't'.repeat(43);
    const result: any = { 'x-proctor-token': token, 'x-proctor-proof': 'signed' };
    const controller: any = {
        current: { login: { uid: 7 } },
        records: new Map([[tid, { login: { uid: 7 }, context: { origin }, auth: { session: { token } } }]]),
        headers: async (...args) => {
            calls.push(args);
            return result;
        },
        status: () => {},
    };
    const guard = new ProctorRequestGuard(
        controller,
        { exam: { allowedOrigins: [origin] } },
        { id: 1, getURL: () => `${origin}/d/exam/contest/${tid}/problems` },
    );
    const details: any = {
        url: `${origin}/d/exam/p/100?tid=${tid}`,
        method: 'GET',
        webContentsId: 1,
        resourceType: 'mainFrame',
        requestHeaders: { Accept: 'text/html' },
    };
    await forEachSerial([1, 2], async () => {
        assert.equal((await guard.headers(details))['x-proctor-token'], token);
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], details.url);
    assert.equal(calls[0][1].action, 'problem_view');
    await guard.headers({ ...details, resourceType: 'other', url: `${origin}/d/exam/p/100/file/data.zip?tid=${tid}` });
    assert.equal(calls[2][0], `${origin}/d/exam/contest/${tid}/problems`);
    await guard.headers({ ...details, requestHeaders: result });
    assert.equal(calls.length, 3);
    await forEachSerial(
        [
            { url: `${origin}/d/exam/proctor/identity` },
            { url: `${origin}/d/exam/contest/${tid}/proctor` },
            { method: 'POST' },
            { webContentsId: -1 },
        ],
        async (changed) => {
            await guard.headers({ ...details, ...changed });
        },
    );
    assert.equal(calls.length, 3); // 后台认证不能递归调用页面桥。
    const external = await guard.headers({
        ...details,
        url: 'https://storage.example.com/log',
        requestHeaders: { ...result, Cookie: 'other' },
    });
    assert.deepEqual(external, { Cookie: 'other' });
    controller.headers = async () => {
        throw new Error('Client version mismatch');
    };
    assert.deepEqual(await guard.headers(details), details.requestHeaders);
    guard.isBlocked = () => true;
    assert.deepEqual(await guard.headers({ ...details, requestHeaders: { ...result, Accept: 'text/html' } }), {
        Accept: 'text/html',
    });
});

test('旧账号或已结束会话不能转发缓存的读取证明', async () => {
    const previous: any = { login: { uid: 7 }, context: { origin }, auth: { session: { token: 'old-token' } } };
    const fresh: any = { 'x-proctor-token': 'new-token', 'x-proctor-proof': 'new-proof' };
    const calls = [];
    const controller: any = {
        current: { login: { uid: 8 } },
        records: new Map([[tid, previous]]),
        headers: async () => {
            calls.push(1);
            return fresh;
        },
        status: () => {},
    };
    const guard = new ProctorRequestGuard(
        controller,
        { exam: { allowedOrigins: [origin] } },
        { id: 1, getURL: () => `${origin}/contest/${tid}` },
    );
    const details: any = {
        url: `${origin}/contest/${tid}/problems`,
        method: 'GET',
        webContentsId: 1,
        resourceType: 'mainFrame',
        requestHeaders: { 'x-proctor-token': 'old-token', 'x-proctor-proof': 'old-proof' },
    };
    assert.deepEqual(await guard.headers(details), fresh);
    controller.current.login.uid = 7;
    previous.journal = { state: { phase: 'uploaded' } };
    assert.deepEqual(await guard.headers(details), fresh);
    assert.equal(calls.length, 2);
});

test('结束中的会话保留自身协议接口所需的结束、刷新和上传证明', async () => {
    const proctorPath = `/d/exam/contest/${tid}/proctor`;
    const proof: any = { 'x-proctor-token': 'token', 'x-proctor-proof': 'signed' };
    const controller: any = {
        current: { login: { uid: 7 } },
        records: new Map([
            [
                tid,
                {
                    login: { uid: 7 },
                    context: { origin, proctorPath },
                    journal: { state: { phase: 'closing' } },
                    auth: { session: { token: 'token' } },
                },
            ],
        ]),
        headers: () => assert.fail('协议请求不能重新生成读取证明'),
    };
    const guard = new ProctorRequestGuard(controller, { exam: { allowedOrigins: [origin] } }, { id: 1 });
    const details: any = { url: origin + proctorPath, method: 'POST', webContentsId: -1, requestHeaders: proof };
    assert.deepEqual(await guard.headers(details), proof);
    assert.deepEqual(await guard.headers({ ...details, url: `https://other.example${proctorPath}` }), {});
    controller.current.login.uid = 8;
    assert.deepEqual(await guard.headers(details), {});
});
test('网络或认证失败时移除读取证明，同时保留原生恢复证明', async () => {
    const error = new Error('net::ERR_CONNECTION_CLOSED');
    const proctorPath = `/contest/${tid}/proctor`;
    const controller: any = {
        current: { login: { uid: 7 } },
        authenticationError: error,
        records: new Map([
            [
                tid,
                {
                    login: { uid: 7 },
                    context: { origin, proctorPath },
                    journal: { state: { phase: 'open' } },
                    auth: { session: { token: 'token' } },
                },
            ],
        ]),
        headers: async () => {
            throw error;
        },
        status: () => {},
    };
    const guard = new ProctorRequestGuard(
        controller,
        { exam: { allowedOrigins: [origin] } },
        { id: 1, getURL: () => `${origin}/contest/${tid}` },
    );
    const requestHeaders: any = { 'x-proctor-token': 'token', 'x-proctor-proof': 'cached-proof' };
    assert.deepEqual(
        await guard.headers({
            url: `${origin}/contest/${tid}/problems`,
            method: 'GET',
            webContentsId: 1,
            resourceType: 'mainFrame',
            requestHeaders,
        }),
        {},
    );
    assert.deepEqual(await guard.headers({ url: origin + proctorPath, method: 'POST', webContentsId: -1, requestHeaders }), requestHeaders);
});

test('已结束会话显示具体原因，诊断不暴露请求凭据', async () => {
    const messages = [];
    const traces = [];
    const controller: any = {
        records: new Map(),
        trace: (...entry) => traces.push(entry),
        status: (message) => messages.push(message),
        headers: async () => {
            throw Object.assign(new Error('本场监考已结束且日志已上传'), {
                code: 'PROCTOR_ATTEMPT_COMPLETE',
                publicMessage: '本场监考已结束且日志已上传',
            });
        },
    };
    const guard = new ProctorRequestGuard(
        controller,
        { exam: { allowedOrigins: [origin] } },
        { id: 1, getURL: () => `${origin}/contest/${tid}` },
    );
    const headers = await guard.headers({
        url: `${origin}/contest/${tid}/problems`,
        method: 'GET',
        webContentsId: 1,
        resourceType: 'mainFrame',
        requestHeaders: { Accept: 'text/html', 'x-proctor-token': 'private-token', 'x-proctor-proof': 'private-proof' },
    });
    assert.deepEqual(headers, { Accept: 'text/html' });
    assert.equal(messages.at(-1), '本场监考已结束且日志已上传');
    assert.equal(traces[0][1], 'request.authentication-failed');
    assert.equal(traces[0][2].code, 'PROCTOR_ATTEMPT_COMPLETE');
    assert.doesNotMatch(JSON.stringify(traces), /private-token|private-proof/);
});
test('受保护读取显示被拒绝的版本，版本拒绝后不转发凭据', async () => {
    const messages = [];
    const controller: any = {
        version: '0.9.0',
        records: new Map(),
        status: (message) => messages.push(message),
        headers: async () => {
            throw new ProctorError('Proctor client version mismatch.', 403);
        },
    };
    const guard = new ProctorRequestGuard(
        controller,
        { exam: { allowedOrigins: [origin] } },
        { id: 1, getURL: () => `${origin}/contest/${tid}` },
    );
    const headers = await guard.headers({
        url: `${origin}/contest/${tid}/problems`,
        method: 'GET',
        webContentsId: 1,
        resourceType: 'mainFrame',
        requestHeaders: { Accept: 'text/html', 'x-proctor-token': 'private-token', 'x-proctor-proof': 'private-proof' },
    });
    assert.deepEqual(headers, { Accept: 'text/html' });
    assert.match(messages.at(-1), /版本不符合系统要求（当前：0\.9\.0）/);
});

export {};
