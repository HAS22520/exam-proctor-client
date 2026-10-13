import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextFromUrl, validateConfig } from '../app/main/security/config-policy';
import NetworkGuard = require('../app/main/network/network-guard');
import { identity, parseReply, ProctorAuth, proctorErrorMessage, Transport } from '../app/main/proctor/proctor-auth';
import { submission } from '../app/main/proctor/proctor-controller';
import { canonical, digest, nonce, sign, validateTrust, verify } from '../app/main/proctor/proctor-crypto';
import { auth, forEachSerial, store, trust, workspace } from './helpers';

const context = contextFromUrl('https://oj.example.com/d/exam/p/P100?tid=1234567890abcdef12345678');
const login: any = { uid: 7, domainId: 'exam', pid: 100, proctorEnabled: true };
const version = '1.0.0';
function server(device, overrides: any = {}): any {
    let challenge;
    let refreshes = 0;
    const envelope = (payload) => ({
        payload: { ...payload, ...overrides },
        signature: sign({ ...payload, ...overrides }, auth.privateKey),
    });
    const session = () => {
        const token = nonce();
        return {
            token,
            ...envelope({
                protocol: 'hydro-proctor/1',
                action: 'session',
                uid: 7,
                domainId: 'exam',
                tid: context.tid,
                version,
                fingerprint: device.fingerprint,
                keyId: trust.keyId,
                tokenHash: digest(token),
                attemptId: 'b'.repeat(24),
                refreshEnabled: true,
                expiresAt: new Date(Date.now() + 600000).toISOString(),
            }),
        };
    };
    return {
        get refreshes() {
            return refreshes;
        },
        json: async (target, body, headers) => {
            assert.equal(target, context.proctorPath);
            if (body.operation === 'challenge') {
                challenge = {
                    protocol: 'hydro-proctor/1',
                    action: 'handshake',
                    uid: 7,
                    domainId: 'exam',
                    tid: context.tid,
                    keyId: trust.keyId,
                    origin: context.origin,
                    fingerprint: body.fingerprint,
                    version: body.version,
                    publicKey: body.publicKey,
                    deviceInfo: body.deviceInfo,
                    clientNonce: body.clientNonce,
                    challengeId: nonce(),
                    serverNonce: nonce(),
                    expiresAt: new Date(Date.now() + 120000).toISOString(),
                };
                challenge = { ...challenge, ...overrides };
                return envelope(challenge);
            }
            if (body.operation === 'handshake') {
                assert.ok(verify(challenge, body.signature, device.publicKey));
                return session();
            }
            if (body.operation === 'refresh') {
                refreshes++;
                const proof = JSON.parse(Buffer.from(headers['x-proctor-proof'], 'base64url').toString());
                assert.ok(verify(proof.payload, proof.signature, device.publicKey));
                assert.equal(proof.payload.payloadHash, digest('{}'));
                await new Promise((resolve) => setTimeout(resolve, 10));
                return session();
            }
            throw new Error('未预期的协议操作');
        },
    };
}
test('规范化数据和公钥校验拒绝含糊数据及私钥输入', () => {
    assert.equal(canonical({ z: [{ b: 2, a: 1 }], a: '\n' }), '{"a":"\\n","z":[{"a":1,"b":2}]}');
    for (const value of [undefined, Number.NaN, { x: undefined }, new Date()]) assert.throws(() => canonical(value));
    assert.throws(() => validateTrust({ ...trust, authPublicKey: auth.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }));
});
test('设备持久化，握手验证完整数据，刷新合并执行，提交证明绑定内容', async (t) => {
    const protectedStore = store(workspace(t));
    const device = protectedStore.device();
    assert.deepEqual(protectedStore.device(), device);
    const transport = server(device);
    const client = new ProctorAuth({ transport, context, identity: login, trust, device, version });
    const first = await client.ensure();
    client.session.renewAt = 0;
    const results = await Promise.all(Array.from({ length: 10 }, () => client.ensure()));
    assert.equal(transport.refreshes, 1);
    assert.equal(new Set(results.map((value) => value.token)).size, 1);
    assert.notEqual(results[0].token, first.token);
    const payload: any = { pid: 100, lang: 'cpp', code: 'x\r\n', pretest: false, input: [], fileHash: '' };
    const headers = client.proof('submit', context.submitPath, payload);
    const proof = JSON.parse(Buffer.from(headers['x-proctor-proof'], 'base64url').toString());
    assert.ok(verify(proof.payload, proof.signature, device.publicKey));
    assert.equal(proof.payload.path, '/d/exam/p/P100/submit');
    assert.equal(proof.payload.payloadHash, digest(canonical(payload)));
    assert.notEqual(proof.payload.payloadHash, digest(canonical({ ...payload, code: 'x\n' })));
});
test('已签名响应中的版本或环境不同则拒绝', async (t) => {
    const device = store(workspace(t)).device();
    await forEachSerial(
        [{ version: '2.0.0' }, { fingerprint: '0'.repeat(64) }, { origin: 'https://evil.example' }, { uid: 1 }],
        async (overrides) => {
            const client = new ProctorAuth({
                transport: server(device, overrides),
                context,
                identity: login,
                trust,
                device,
                version,
            });
            await assert.rejects(client.ensure());
            assert.equal(client.session, null);
        },
    );
});
test('身份校验拒绝篡改的 root 权限', async () => {
    const c = contextFromUrl('https://oj.example.com/');
    const transport: any = {
        json: async (_, request) => {
            const payload: any = {
                protocol: 'hydro-proctor/1',
                action: 'identity',
                keyId: trust.keyId,
                origin: c.origin,
                clientNonce: request.clientNonce,
                uid: 7,
                domainId: 'exam',
                root: false,
                tid: '',
                routePid: '',
                expiresAt: new Date(Date.now() + 60000).toISOString(),
            };
            return { payload: { ...payload, root: true }, signature: sign(payload, auth.privateKey) };
        },
    };
    await assert.rejects(identity(transport, c, trust));
});
test('桥限制数字题号、准确域路径、动作和业务字段', () => {
    const request: any = {
        action: 'submit',
        method: 'POST',
        path: context.submitPath,
        payload: { pid: 100, lang: 'cpp', code: '', pretest: true, input: [], fileHash: '' },
    };
    assert.equal(submission(request, context, login), request.payload);
    for (const change of [
        { path: '/p/P100/submit' },
        { action: 'upload' },
        { payload: { ...request.payload, pid: 101 } },
        { payload: { ...request.payload, extra: 1 } },
    ]) {
        assert.throws(() => submission({ ...request, ...change }, context, login));
    }
});
test('来源策略校验协议和端口，root 调试仅绕过应用网络策略', () => {
    const config = validateConfig({ exam: { targetUrl: 'https://oj.example.com' }, updater: {}, debug: { allowRoot: true } }, trust);
    const guard = new NetworkGuard(config);
    assert.ok(guard.isAllowed('wss://oj.example.com/activity'));
    assert.ok(!guard.isAllowed('https://oj.example.com:444'));
    assert.ok(!guard.isAllowed('https://oj.example.com.evil.com'));
    guard.debug = true;
    assert.ok(guard.isAllowed('https://example.com'));
    assert.ok(!guard.isAllowed('file:///etc/passwd'));
    assert.throws(() => validateConfig({ exam: { targetUrl: 'http://oj.example.com' } } as any, trust));
});
test('传输拒绝重定向和非 JSON 响应，不泄露响应正文', async () => {
    await forEachSerial(
        [
            new Response('token-secret', { status: 302, headers: { location: '/login' } }),
            new Response('token-secret', { headers: { 'content-type': 'text/html' } }),
        ],
        async (response) => {
            const transport = new Transport({ fetch: async () => response } as any, context.origin);
            await assert.rejects(transport.request('/contest/x'), (error: any) => !error.message.includes('token-secret'));
        },
    );
});
test('Hydro 版本拒绝保留 params，生成诊断码并提供中文更新说明', async () => {
    const traces = [];
    const transport = new Transport(
        {
            fetch: async () =>
                new Response(
                    JSON.stringify({
                        error: {
                            name: 'ForbiddenError',
                            message: 'ForbiddenError',
                            code: 403,
                            params: ['Proctor client version mismatch.'],
                        },
                    }),
                    { status: 403, headers: { 'content-type': 'application/json' } },
                ),
        } as any,
        context.origin,
        15000,
        (...entry) => traces.push(entry),
    );
    await assert.rejects(transport.json(context.proctorPath, { operation: 'challenge', version: '0.9.0' }), (error: any) => {
        assert.equal(error.message, 'Proctor client version mismatch.');
        assert.equal(error.status, 403);
        assert.equal(error.code, 'PROCTOR_VERSION_MISMATCH');
        assert.equal(error.retryable, false);
        assert.match(proctorErrorMessage(error, '0.9.0'), /版本不符合系统要求（当前：0\.9\.0）/);
        assert.match(error.publicMessage, /请安装/);
        return true;
    });
    const failure = traces.find((entry) => entry[1] === 'protocol.failed')[2];
    assert.equal(failure.code, 'PROCTOR_VERSION_MISMATCH');
    assert.equal(failure.operation, 'challenge');
});
test('无具体原因的 ForbiddenError 或会话过期不被误判为确定的版本错误', () => {
    for (const params of [undefined, [], {}, 'invalid', [null, 403]]) {
        assert.throws(
            () => parseReply(JSON.stringify({ error: { message: 'ForbiddenError', params } }), 403, 'application/json'),
            (error: any) => {
                assert.equal(error.status, 403);
                assert.equal(error.code, undefined);
                assert.match(proctorErrorMessage(error, version), /服务端未提供具体原因/);
                assert.doesNotMatch(error.publicMessage, /版本不符合/);
                return true;
            },
        );
    }
    assert.throws(
        () =>
            parseReply(
                JSON.stringify({
                    error: { message: 'ForbiddenError', params: ['Proctor session expired or client version mismatch.'] },
                }),
                403,
                'application/json',
            ),
        (error: any) => {
            assert.equal(error.code, 'PROCTOR_SESSION_REJECTED');
            assert.match(error.publicMessage, /会话已过期或/);
            return true;
        },
    );
});
test('未参加比赛与网络中断显示不同的可执行说明', () => {
    assert.throws(
        () =>
            parseReply(
                JSON.stringify({
                    error: { message: 'ForbiddenError', params: ['Attend the contest before starting proctoring.'] },
                }),
                403,
                'application/json',
            ),
        (error: any) => {
            assert.equal(error.code, 'PROCTOR_ATTEND_REQUIRED');
            assert.match(error.publicMessage, /请先报名/);
            return true;
        },
    );
    assert.match(proctorErrorMessage(new Error('net::ERR_CONNECTION_CLOSED'), version), /无法连接 OJ/);
    assert.doesNotMatch(proctorErrorMessage(new Error('net::ERR_CONNECTION_CLOSED'), version), /客户端版本及认证密钥/);
});
test('服务端未提供拒绝原因时显示中文说明，并保留通用拒绝语义', () => {
    assert.throws(() => parseReply('{}', 403, 'application/json'), (error: any) => {
        assert.equal(error.message, '监考请求被拒绝');
        assert.equal(error.status, 403);
        assert.match(proctorErrorMessage(error), /服务端未提供具体原因/);
        return true;
    });
});

test('令牌失效后保留会话绑定，不能为其他会话签名', async (t) => {
    const device = store(workspace(t)).device();
    const client = new ProctorAuth({ transport: server(device), context, identity: login, trust, device, version });
    await client.ensure();
    client.session = null;
    client.transport = server(device, { attemptId: 'c'.repeat(24) });
    await assert.rejects(client.ensure(), /监考会话编号不匹配/);
    assert.equal(client.session, null);
});

export {};
