const assert = require('node:assert/strict');
const { test } = require('node:test');
const { accessTarget, accessRequest } = require('../app/main/proctor-access');
const { contextFromUrl } = require('../app/main/config-policy');
const ProctorRequestGuard = require('../app/main/proctor-request-guard');
const { ProctorAuth } = require('../app/main/proctor-auth');
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
  const controller = { records: new Map([[tid, { context: { origin }, auth: { session: { token } } }]]),
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
