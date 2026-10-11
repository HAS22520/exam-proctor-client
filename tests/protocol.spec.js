const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ProctorAuth, Transport, identity, parseReply, proctorErrorMessage } = require('../app/main/proctor-auth');
const { canonical, sign, verify, digest, nonce, validateTrust } = require('../app/main/proctor-crypto');
const { contextFromUrl, validateConfig } = require('../app/main/config-policy');
const { submission } = require('../app/main/proctor-controller');
const NetworkGuard = require('../app/main/network-guard');
const { auth, trust, workspace, store } = require('./helpers');
const context = contextFromUrl('https://oj.example.com/d/exam/p/P100?tid=1234567890abcdef12345678');
const login = { uid: 7, domainId: 'exam', pid: 100, proctorEnabled: true };
const version = '1.0.0';
function server(device, overrides = {}) {
  let challenge, refreshes = 0;
  const envelope = (payload) => ({ payload: { ...payload, ...overrides }, signature: sign({ ...payload, ...overrides }, auth.privateKey) });
  const session = () => {
    const token = nonce();
    return { token, ...envelope({ protocol: 'hydro-proctor/1', action: 'session', uid: 7, domainId: 'exam', tid: context.tid,
      version, fingerprint: device.fingerprint, keyId: trust.keyId, tokenHash: digest(token), attemptId: 'b'.repeat(24), refreshEnabled: true, expiresAt: new Date(Date.now() + 600000).toISOString() }) };
  };
  return { get refreshes() { return refreshes; }, json: async (target, body, headers) => {
    assert.equal(target, context.proctorPath);
    if (body.operation === 'challenge') {
      challenge = { protocol: 'hydro-proctor/1', action: 'handshake', uid: 7, domainId: 'exam', tid: context.tid, keyId: trust.keyId,
        origin: context.origin, fingerprint: body.fingerprint, version: body.version, publicKey: body.publicKey, deviceInfo: body.deviceInfo,
        clientNonce: body.clientNonce, challengeId: nonce(), serverNonce: nonce(), expiresAt: new Date(Date.now() + 120000).toISOString() };
      challenge = { ...challenge, ...overrides };
      return envelope(challenge);
    }
    if (body.operation === 'handshake') { assert.ok(verify(challenge, body.signature, device.publicKey)); return session(); }
    if (body.operation === 'refresh') {
      refreshes++; const proof = JSON.parse(Buffer.from(headers['x-proctor-proof'], 'base64url'));
      assert.ok(verify(proof.payload, proof.signature, device.publicKey)); assert.equal(proof.payload.payloadHash, digest('{}'));
      await new Promise((resolve) => setTimeout(resolve, 10)); return session();
    }
    throw new Error('Unexpected operation');
  } };
}
test('canonical payload and public key validation reject ambiguous or private inputs', () => {
  assert.equal(canonical({ z: [{ b: 2, a: 1 }], a: '\n' }), '{"a":"\\n","z":[{"a":1,"b":2}]}');
  for (const value of [undefined, NaN, { x: undefined }, new Date()]) assert.throws(() => canonical(value));
  assert.throws(() => validateTrust({ ...trust, authPublicKey: auth.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }));
});
test('device persists, handshake verifies transcript, refresh is single flight, submission proof binds content', async (t) => {
  const protectedStore = store(workspace(t)); const device = protectedStore.device(); assert.deepEqual(protectedStore.device(), device);
  const transport = server(device); const client = new ProctorAuth({ transport, context, identity: login, trust, device, version });
  const first = await client.ensure(); client.session.renewAt = 0;
  const results = await Promise.all(Array.from({ length: 10 }, () => client.ensure()));
  assert.equal(transport.refreshes, 1); assert.equal(new Set(results.map((value) => value.token)).size, 1); assert.notEqual(results[0].token, first.token);
  const payload = { pid: 100, lang: 'cpp', code: 'x\r\n', pretest: false, input: [], fileHash: '' };
  const headers = client.proof('submit', context.submitPath, payload);
  const proof = JSON.parse(Buffer.from(headers['x-proctor-proof'], 'base64url'));
  assert.ok(verify(proof.payload, proof.signature, device.publicKey)); assert.equal(proof.payload.path, '/d/exam/p/P100/submit');
  assert.equal(proof.payload.payloadHash, digest(canonical(payload))); assert.notEqual(proof.payload.payloadHash, digest(canonical({ ...payload, code: 'x\n' })));
});
test('signed response with a different version or environment is rejected', async (t) => {
  const device = store(workspace(t)).device();
  for (const overrides of [{ version: '2.0.0' }, { fingerprint: '0'.repeat(64) }, { origin: 'https://evil.example' }, { uid: 1 }]) {
    const client = new ProctorAuth({ transport: server(device, overrides), context, identity: login, trust, device, version });
    await assert.rejects(client.ensure()); assert.equal(client.session, null);
  }
});
test('identity rejects tampered root privileges', async () => {
  const c = contextFromUrl('https://oj.example.com/');
  const transport = { json: async (_, request) => {
    const payload = { protocol: 'hydro-proctor/1', action: 'identity', keyId: trust.keyId, origin: c.origin,
      clientNonce: request.clientNonce, uid: 7, domainId: 'exam', root: false, tid: '', routePid: '', expiresAt: new Date(Date.now() + 60000).toISOString() };
    return { payload: { ...payload, root: true }, signature: sign(payload, auth.privateKey) };
  } };
  await assert.rejects(identity(transport, c, trust));
});
test('bridge scopes numeric PID, exact domain path, action and semantic fields', () => {
  const request = { action: 'submit', method: 'POST', path: context.submitPath, payload: { pid: 100, lang: 'cpp', code: '', pretest: true, input: [], fileHash: '' } };
  assert.equal(submission(request, context, login), request.payload);
  for (const change of [{ path: '/p/P100/submit' }, { action: 'upload' }, { payload: { ...request.payload, pid: 101 } }, { payload: { ...request.payload, extra: 1 } }]) assert.throws(() => submission({ ...request, ...change }, context, login));
});
test('origin policy checks scheme and port, root debug bypasses only application network policy', () => {
  const config = validateConfig({ exam: { targetUrl: 'https://oj.example.com' }, updater: {}, debug: { allowRoot: true } }, trust);
  const guard = new NetworkGuard(config);
  assert.ok(guard.isAllowed('wss://oj.example.com/activity')); assert.ok(!guard.isAllowed('https://oj.example.com:444'));
  assert.ok(!guard.isAllowed('https://oj.example.com.evil.com')); guard.debug = true;
  assert.ok(guard.isAllowed('https://example.com')); assert.ok(!guard.isAllowed('file:///etc/passwd'));
  assert.throws(() => validateConfig({ exam: { targetUrl: 'http://oj.example.com' } }, trust));
});
test('transport refuses redirects and non JSON replies without disclosing response body', async () => {
  for (const response of [new Response('token-secret', { status: 302, headers: { location: '/login' } }), new Response('token-secret', { headers: { 'content-type': 'text/html' } })]) {
    const transport = new Transport({ fetch: async () => response }, context.origin);
    await assert.rejects(transport.request('/contest/x'), (error) => !error.message.includes('token-secret'));
  }
});
test('Hydro version rejection preserves params, emits a diagnostic code and provides a Chinese update instruction', async () => {
  const traces = [];
  const transport = new Transport({ fetch: async () => new Response(JSON.stringify({ error: {
    name: 'ForbiddenError', message: 'ForbiddenError', code: 403, params: ['Proctor client version mismatch.'],
  } }), { status: 403, headers: { 'content-type': 'application/json' } }) }, context.origin, 15000,
  (...entry) => traces.push(entry));
  await assert.rejects(transport.json(context.proctorPath, { operation: 'challenge', version: '0.9.0' }), (error) => {
    assert.equal(error.message, 'Proctor client version mismatch.'); assert.equal(error.status, 403);
    assert.equal(error.code, 'PROCTOR_VERSION_MISMATCH'); assert.equal(error.retryable, false);
    assert.match(proctorErrorMessage(error, '0.9.0'), /版本不符合系统要求（当前：0\.9\.0）/);
    assert.match(error.publicMessage, /请安装/); return true;
  });
  const failure = traces.find((entry) => entry[1] === 'protocol.failed')[2];
  assert.equal(failure.code, 'PROCTOR_VERSION_MISMATCH'); assert.equal(failure.operation, 'challenge');
});
test('bare ForbiddenError and expired-session responses never claim a definite version mismatch', () => {
  for (const params of [undefined, [], {}, 'invalid', [null, 403]]) {
    assert.throws(() => parseReply(JSON.stringify({ error: { message: 'ForbiddenError', params } }), 403, 'application/json'), (error) => {
      assert.equal(error.status, 403); assert.equal(error.code, undefined);
      assert.match(proctorErrorMessage(error, version), /服务端未提供具体原因/);
      assert.doesNotMatch(error.publicMessage, /版本不符合/); return true;
    });
  }
  assert.throws(() => parseReply(JSON.stringify({ error: { message: 'ForbiddenError',
    params: ['Proctor session expired or client version mismatch.'] } }), 403, 'application/json'), (error) => {
    assert.equal(error.code, 'PROCTOR_SESSION_REJECTED');
    assert.match(error.publicMessage, /会话已过期或/); return true;
  });
});
test('attempt binding survives token invalidation and never signs a different attempt', async (t) => {
  const device = store(workspace(t)).device();
  const client = new ProctorAuth({ transport: server(device), context, identity: login, trust, device, version });
  await client.ensure(); client.session = null;
  client.transport = server(device, { attemptId: 'c'.repeat(24) });
  await assert.rejects(client.ensure(), /attempt mismatch/); assert.equal(client.session, null);
});
