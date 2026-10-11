const assert = require('node:assert/strict');
const { test } = require('node:test');
const { accessTarget, accessRequest } = require('../app/main/proctor-access');
const { contextFromUrl } = require('../app/main/config-policy');
const ProctorRequestGuard = require('../app/main/proctor-request-guard');
const { ProctorAuth, ProctorError } = require('../app/main/proctor-auth');
const { canonical, digest, verify } = require('../app/main/proctor-crypto');
const { auth } = require('./helpers');
const tid = '1234567890abcdef12345678', origin = 'https://oj.example.com';

test('protected read routes preserve raw paths and normalize only numeric display IDs', () => {
  for (const suffix of ['', '/submit', '/file/test%20data.zip']) {
    const target = accessTarget(`${origin}/d/exam/p/00100${suffix}?tid=${tid}&download=1`);
    assert.deepEqual(target.payload, { tid, pid: '100' });
    assert.equal(target.path, `/d/exam/p/00100${suffix}`);
    assert.equal(target.action, 'problem_view');
  }
  assert.equal(accessTarget(`${origin}/p/P100?tid=${tid}`).payload.pid, 'P100');
  for (const suffix of ['problems', 'print', 'api/printing/team', 'file/private/test.zip']) {
    const target = accessTarget(`${origin}/d/exam/contest/${tid}/${suffix}`);
    assert.equal(target.action, 'contest_view'); assert.deepEqual(target.payload, { tid });
  }
  for (const value of [`/p/100`, `/p/100?tid=${tid}&tid=${tid}`, `/p/%2f?tid=${tid}`, `/p/%00?tid=${tid}`,
    `/p/%20?tid=${tid}`, `/contest/${tid}`, `/contest/${tid}/proctor`, '/proctor/identity', `/contest/${tid}/file/public/test`]) {
    assert.equal(accessTarget(origin + value), null);
  }
});

test('read bridge refuses arbitrary paths, methods, payloads, domains and contests', () => {
  const source = contextFromUrl(`${origin}/d/exam/contest/${tid}`);
  const good = { action: 'problem_view', method: 'GET', path: '/d/exam/p/100/file/test.zip', payload: { tid, pid: '100' } };
  assert.equal(accessRequest(good, source).path, good.path);
  for (const changed of [{ method: 'POST' }, { action: 'submit' }, { path: '//evil.example/p/100' },
    { path: '/d/other/p/100' }, { path: '/d/exam/p/100?tid=' + tid }, { path: '/d/exam/p/100#fragment' },
    { path: '/d/exam/manage' }, { path: '/d/exam/p/100/../101' }, { payload: { tid, pid: 100 } },
    { payload: { tid, pid: '101' } }, { payload: { tid, pid: '100', extra: true } }, { payload: { tid: 'f'.repeat(24), pid: '100' } }]) {
    assert.throws(() => accessRequest({ ...good, ...changed }, source));
  }
});

test('GET proof binds read action/path/payload and generates a fresh nonce on every request', () => {
  const device = { privateKey: auth.privateKey, fingerprint: 'f'.repeat(64) };
  const signer = new ProctorAuth({ device, version: '1.0.0' });
  signer.session = { token: 't'.repeat(43), tokenHash: digest('t'.repeat(43)), expiresAt: new Date(Date.now() + 60000).toISOString() };
  const payload = { tid, pid: '100' }, path = '/d/exam/p/100';
  const first = JSON.parse(Buffer.from(signer.proof('problem_view', path, payload, 'GET')['x-proctor-proof'], 'base64url'));
  const second = JSON.parse(Buffer.from(signer.proof('problem_view', path, payload, 'GET')['x-proctor-proof'], 'base64url'));
  assert.ok(verify(first.payload, first.signature, auth.publicKey));
  assert.equal(first.payload.method, 'GET'); assert.equal(first.payload.path, path);
  assert.equal(first.payload.payloadHash, digest(canonical(payload))); assert.notEqual(first.payload.nonce, second.payload.nonce);
  assert.throws(() => signer.proof('problem_view', path, payload));
  assert.throws(() => signer.proof('submit', path, payload, 'GET'));
});

test('network guard authenticates deep links/refreshes and attachments, preserving bridge proofs', async () => {
  const calls = [], token = 't'.repeat(43), result = { 'x-proctor-token': token, 'x-proctor-proof': 'signed' };
  const controller = { current: { login: { uid: 7 } }, records: new Map([[tid, { login: { uid: 7 }, context: { origin }, auth: { session: { token } } }]]),
    headers: async (...args) => { calls.push(args); return result; }, status: () => {} };
  const guard = new ProctorRequestGuard(controller, { exam: { allowedOrigins: [origin] } },
    { id: 1, getURL: () => `${origin}/d/exam/contest/${tid}/problems` });
  const details = { url: `${origin}/d/exam/p/100?tid=${tid}`, method: 'GET', webContentsId: 1, resourceType: 'mainFrame', requestHeaders: { Accept: 'text/html' } };
  for (let i = 0; i < 2; i++) assert.equal((await guard.headers(details))['x-proctor-token'], token);
  assert.equal(calls.length, 2); assert.equal(calls[0][0], details.url);
  assert.equal(calls[0][1].action, 'problem_view');
  await guard.headers({ ...details, resourceType: 'other', url: `${origin}/d/exam/p/100/file/data.zip?tid=${tid}` });
  assert.equal(calls[2][0], `${origin}/d/exam/contest/${tid}/problems`);
  await guard.headers({ ...details, requestHeaders: result }); assert.equal(calls.length, 3);
  for (const changed of [{ url: `${origin}/d/exam/proctor/identity` }, { url: `${origin}/d/exam/contest/${tid}/proctor` },
    { method: 'POST' }, { webContentsId: -1 }]) await guard.headers({ ...details, ...changed });
  assert.equal(calls.length, 3); // Backend authentication must not recurse into the bridge.
  const external = await guard.headers({ ...details, url: 'https://storage.example.com/log', requestHeaders: { ...result, Cookie: 'other' } });
  assert.deepEqual(external, { Cookie: 'other' });
  controller.headers = async () => { throw new Error('Client version mismatch'); };
  assert.deepEqual(await guard.headers(details), details.requestHeaders);
  guard.isBlocked = () => true;
  assert.deepEqual(await guard.headers({ ...details, requestHeaders: { ...result, Accept: 'text/html' } }), { Accept: 'text/html' });
});

test('a prior account or closed attempt cannot forward its cached bridge proof', async () => {
  const previous = { login: { uid: 7 }, context: { origin }, auth: { session: { token: 'old-token' } } };
  const fresh = { 'x-proctor-token': 'new-token', 'x-proctor-proof': 'new-proof' }, calls = [];
  const controller = { current: { login: { uid: 8 } }, records: new Map([[tid, previous]]),
    headers: async () => { calls.push(1); return fresh; }, status: () => {} };
  const guard = new ProctorRequestGuard(controller, { exam: { allowedOrigins: [origin] } }, { id: 1, getURL: () => `${origin}/contest/${tid}` });
  const details = { url: `${origin}/contest/${tid}/problems`, method: 'GET', webContentsId: 1, resourceType: 'mainFrame',
    requestHeaders: { 'x-proctor-token': 'old-token', 'x-proctor-proof': 'old-proof' } };
  assert.deepEqual(await guard.headers(details), fresh);
  controller.current.login.uid = 7; previous.journal = { state: { phase: 'uploaded' } };
  assert.deepEqual(await guard.headers(details), fresh);
  assert.equal(calls.length, 2);
});

test('closing attempts retain native finish/refresh/upload proofs on their own protocol endpoint', async () => {
  const proctorPath = `/d/exam/contest/${tid}/proctor`, proof = { 'x-proctor-token': 'token', 'x-proctor-proof': 'signed' };
  const controller = { current: { login: { uid: 7 } }, records: new Map([[tid, { login: { uid: 7 }, context: { origin, proctorPath },
    journal: { state: { phase: 'closing' } }, auth: { session: { token: 'token' } } }]]), headers: () => assert.fail('protocol must not request new read proofs') };
  const guard = new ProctorRequestGuard(controller, { exam: { allowedOrigins: [origin] } }, { id: 1 });
  const details = { url: origin + proctorPath, method: 'POST', webContentsId: -1, requestHeaders: proof };
  assert.deepEqual(await guard.headers(details), proof);
  assert.deepEqual(await guard.headers({ ...details, url: 'https://other.example' + proctorPath }), {});
  controller.current.login.uid = 8;
  assert.deepEqual(await guard.headers(details), {});
});
test('a failed network/authentication state strips cached read proofs while keeping native recovery proofs', async () => {
  const error = new Error('net::ERR_CONNECTION_CLOSED'), proctorPath = `/contest/${tid}/proctor`;
  const controller = { current: { login: { uid: 7 } }, authenticationError: error, records: new Map([[tid, {
    login: { uid: 7 }, context: { origin, proctorPath }, journal: { state: { phase: 'open' } }, auth: { session: { token: 'token' } },
  }]]), headers: async () => { throw error; }, status: () => {} };
  const guard = new ProctorRequestGuard(controller, { exam: { allowedOrigins: [origin] } }, { id: 1, getURL: () => `${origin}/contest/${tid}` });
  const requestHeaders = { 'x-proctor-token': 'token', 'x-proctor-proof': 'cached-proof' };
  assert.deepEqual(await guard.headers({ url: `${origin}/contest/${tid}/problems`, method: 'GET', webContentsId: 1,
    resourceType: 'mainFrame', requestHeaders }), {});
  assert.deepEqual(await guard.headers({ url: origin + proctorPath, method: 'POST', webContentsId: -1, requestHeaders }), requestHeaders);
});

test('completed attempts show their specific reason and trace the failure without exposing request credentials', async () => {
  const messages = [], traces = [];
  const controller = { records: new Map(), trace: (...entry) => traces.push(entry), status: (message) => messages.push(message), headers: async () => {
    throw Object.assign(new Error('本场监考已结束且日志已上传'), { code: 'PROCTOR_ATTEMPT_COMPLETE', publicMessage: '本场监考已结束且日志已上传' });
  } };
  const guard = new ProctorRequestGuard(controller, { exam: { allowedOrigins: [origin] } }, { id: 1, getURL: () => `${origin}/contest/${tid}` });
  const headers = await guard.headers({ url: `${origin}/contest/${tid}/problems`, method: 'GET', webContentsId: 1,
    resourceType: 'mainFrame', requestHeaders: { Accept: 'text/html', 'x-proctor-token': 'private-token', 'x-proctor-proof': 'private-proof' } });
  assert.deepEqual(headers, { Accept: 'text/html' }); assert.equal(messages.at(-1), '本场监考已结束且日志已上传');
  assert.equal(traces[0][1], 'request.authentication-failed'); assert.equal(traces[0][2].code, 'PROCTOR_ATTEMPT_COMPLETE');
  assert.doesNotMatch(JSON.stringify(traces), /private-token|private-proof/);
});
test('protected reads show the rejected version and never forward credentials after version rejection', async () => {
  const messages = [];
  const controller = { version: '0.9.0', records: new Map(), status: (message) => messages.push(message), headers: async () => {
    throw new ProctorError('Proctor client version mismatch.', 403);
  } };
  const guard = new ProctorRequestGuard(controller, { exam: { allowedOrigins: [origin] } }, { id: 1, getURL: () => `${origin}/contest/${tid}` });
  const headers = await guard.headers({ url: `${origin}/contest/${tid}/problems`, method: 'GET', webContentsId: 1,
    resourceType: 'mainFrame', requestHeaders: { Accept: 'text/html', 'x-proctor-token': 'private-token', 'x-proctor-proof': 'private-proof' } });
  assert.deepEqual(headers, { Accept: 'text/html' });
  assert.match(messages.at(-1), /版本不符合系统要求（当前：0\.9\.0）/);
});
