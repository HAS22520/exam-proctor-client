const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { ProctorController } = require('../app/main/proctor-controller');
const { Transport } = require('../app/main/proctor-auth');
const { canonical, sign, digest, nonce, verify } = require('../app/main/proctor-crypto');
const { auth, trust, workspace, store, decryptLog } = require('./helpers');
const url = 'https://oj.example.com/d/exam/contest/1234567890abcdef12345678';
function fixture(t) {
  const directory = workspace(t), protectedStore = store(path.join(directory, 'secrets'));
  let offline = false, uid = 7, challenge, attempts = 0, loseResponse = false;
  const accounts = new Map();
  const account = () => {
    if (!accounts.has(uid)) accounts.set(uid, { state: 'open', attemptId: uid === 7 ? 'b'.repeat(24) : uid.toString(16).padStart(24, '0') });
    return accounts.get(uid);
  };
  const requests = [];
  const tokens = new Map(), usedNonces = new Set();
  const envelope = (payload) => ({ payload, signature: sign(payload, auth.privateKey) });
  const session = { fetch: async (url, request) => {
    if (offline) throw new Error('Network offline');
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    requests.push({ url: String(url), method: request.method, operation: body?.operation });
    let response;
    if (String(url).endsWith('/proctor/identity')) response = envelope({ protocol: 'hydro-proctor/1', action: 'identity', keyId: trust.keyId, origin: 'https://oj.example.com',
      clientNonce: body.clientNonce, uid, domainId: 'exam', root: false, tid: body.tid || '', routePid: body.problem || '', pid: 100, proctorEnabled: true, expiresAt: new Date(Date.now() + 60000).toISOString() });
    else if (request.method === 'GET' && String(url).endsWith('/problems')) {
      const token = request.headers['x-proctor-token'], proof = JSON.parse(Buffer.from(request.headers['x-proctor-proof'], 'base64url'));
      const session = tokens.get(token), p = proof.payload;
      assert.equal(session.uid, uid); assert.equal(account().state, 'open');
      assert.equal(p.tokenHash, digest(token)); assert.equal(p.action, 'contest_view'); assert.equal(p.method, 'GET');
      assert.equal(p.path, new URL(url).pathname); assert.equal(p.version, '1.0.0');
      assert.equal(p.payloadHash, digest(canonical({ tid: '1234567890abcdef12345678' })));
      assert.ok(verify(p, proof.signature, protectedStore.device().publicKey));
      assert.ok(!usedNonces.has(p.nonce)); usedNonces.add(p.nonce); response = { ok: true };
    } else if (request.method === 'GET') response = { state: account().state, logUploaded: !!account().receipt, receipt: account().receipt };
    else if (body.operation === 'challenge') {
      if (body.version !== '1.0.0') return new Response(JSON.stringify({ error: { message: 'Client version mismatch' } }),
        { status: 403, headers: { 'content-type': 'application/json' } });
      challenge = { protocol: 'hydro-proctor/1', action: 'handshake', keyId: trust.keyId, origin: 'https://oj.example.com', uid, domainId: 'exam', tid: '1234567890abcdef12345678',
        fingerprint: body.fingerprint, version: body.version, publicKey: body.publicKey, deviceInfo: body.deviceInfo, clientNonce: body.clientNonce, challengeId: nonce(), serverNonce: nonce(), expiresAt: new Date(Date.now() + 120000).toISOString() };
      response = envelope(challenge);
    } else if (body.operation === 'handshake') {
      assert.ok(verify(challenge, body.signature, challenge.publicKey));
      if (account().receipt) response = { completed: true, receipt: account().receipt.id };
      else { const token = nonce(); tokens.set(token, { uid }); response = { token, ...envelope({ protocol: 'hydro-proctor/1', action: 'session', keyId: trust.keyId, uid, domainId: 'exam', tid: challenge.tid,
        fingerprint: challenge.fingerprint, version: challenge.version, tokenHash: digest(token), attemptId: account().attemptId, refreshEnabled: true, expiresAt: new Date(Date.now() + 600000).toISOString() }) }; }
    } else if (body.operation === 'finish') { account().state = 'closing'; response = { ok: true }; }
    else if (body instanceof FormData) {
      attempts++; const file = body.get('file'); const bytes = Buffer.from(await file.arrayBuffer());
      const proof = JSON.parse(Buffer.from(request.headers['x-proctor-proof'], 'base64url'));
      assert.ok(verify(proof.payload, proof.signature, protectedStore.device().publicKey)); assert.equal(proof.payload.payloadHash, digest(require('../app/main/proctor-crypto').canonical({ filename: file.name, size: bytes.length, sha256: digest(bytes) })));
      account().receipt = { id: 'd'.repeat(24), sha256: digest(bytes) }; account().state = 'complete';
      if (loseResponse) throw new Error('Response lost'); response = { ok: true, receipt: account().receipt.id };
    } else throw new Error('Unexpected mock request');
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  } };
  const config = { exam: { allowedOrigins: ['https://oj.example.com'] }, trust };
  const statuses = [];
  const options = { config, directory: path.join(directory, 'journals'), protectedStore, session, version: '1.0.0',
    onStatus: (status) => statuses.push(status), createTransport: (origin, timeout) => {
      const transport = new Transport(session, origin, timeout);
      transport.upload = async (target, { filename, uploadName, headers, onProgress }) => {
        const bytes = fs.readFileSync(filename), body = new FormData();
        body.set('operation', 'upload'); body.set('file', new Blob([bytes]), uploadName);
        onProgress({ phase: 'uploading', sent: Math.floor(bytes.length / 2), total: bytes.length, percent: 50 });
        onProgress({ phase: 'verifying', sent: bytes.length, total: bytes.length, percent: 100 });
        assert.notEqual(statuses.at(-1).upload.phase, 'complete');
        return transport.request(target, { body, headers });
      };
      return transport;
    } };
  return { options, statuses, requests, get attempts() { return attempts; }, set offline(value) { offline = value; }, set uid(value) { uid = value; }, set loseResponse(value) { loseResponse = value; } };
}

test('completed handshake is a terminal state, avoids repeat handshakes, and another account can read the same contest', async (t) => {
  const f = fixture(t), first = new ProctorController(f.options);
  await first.sync(url); assert.equal(await first.finish(), true); first.shutdown();
  const oldFile = path.join(first.current.journal.directory, 'final.hplog'), oldBytes = fs.readFileSync(oldFile);
  const controller = new ProctorController(f.options);
  await controller.sync(url);
  assert.equal(controller.current.completed, true); assert.equal(controller.current.auth.session, null);
  assert.equal(f.statuses.at(-1).phase, 'complete'); assert.equal(f.statuses.at(-1).ended, true);
  assert.equal(f.statuses.at(-1).authenticated, false); assert.match(f.statuses.at(-1).message, /日志已上传/);
  const handshakes = () => f.requests.filter((request) => request.operation === 'handshake').length;
  const count = handshakes();
  const request = { action: 'contest_view', method: 'GET', path: '/d/exam/contest/1234567890abcdef12345678/problems',
    payload: { tid: '1234567890abcdef12345678' } };
  for (let i = 0; i < 3; i++) {
    await assert.rejects(controller.headers(url, request), (error) => error.code === 'PROCTOR_ATTEMPT_COMPLETE');
    await controller.sync(url, { force: true });
  }
  assert.equal(handshakes(), count);
  f.uid = 8; controller.invalidateIdentity();
  for (let i = 0; i < 2; i++) {
    const headers = await controller.headers(url, request);
    assert.equal((await f.options.session.fetch(`${url}/problems`, { method: 'GET', headers })).status, 200);
    assert.equal(controller.current.login.uid, 8); assert.equal(controller.current.completed, undefined);
    assert.equal(f.statuses.at(-1).authenticated, true); assert.equal(f.statuses.at(-1).ended, false);
  }
  assert.equal(handshakes(), count + 1);
  assert.notEqual(controller.current.auth.attemptId, first.current.auth.attemptId);
  assert.deepEqual(fs.readFileSync(oldFile), oldBytes);
  const restarted = new ProctorController(f.options);
  const headers = await restarted.headers(url, request);
  assert.equal((await f.options.session.fetch(`${url}/problems`, { method: 'GET', headers })).status, 200);
  assert.equal(restarted.current.login.uid, 8);
});
test('a cookie change during a signed identity response discards the old identity before handshake', async (t) => {
  const f = fixture(t), identities = [];
  let enter, release;
  const waiting = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let pause = true;
  const controller = new ProctorController({ ...f.options, onIdentity: async (login) => identities.push(login), createTransport: (...args) => {
    const transport = f.options.createTransport(...args), json = transport.json.bind(transport);
    transport.json = async (target, ...rest) => {
      const result = await json(target, ...rest);
      if (pause && target.endsWith('/proctor/identity')) { pause = false; enter(); await gate; }
      return result;
    };
    return transport;
  } });
  const first = controller.sync(url);
  await waiting; f.uid = 8; controller.invalidateIdentity(); release();
  await assert.rejects(first, /登录状态已变化/);
  assert.equal(identities.length, 0); assert.equal(controller.records.size, 0);
  assert.equal(f.requests.some((request) => request.operation === 'challenge'), false);
  assert.equal((await controller.sync(url)).login.uid, 8);
});
test('offline finish persists immutable evidence; restart retries only as original account and saves receipt', async (t) => {
  const f = fixture(t), first = new ProctorController(f.options); await first.sync(url); f.offline = true;
  assert.equal(await first.finish(), false); const record = first.current;
  assert.equal(record.journal.state.phase, 'pending-upload'); const filename = path.join(record.journal.directory, 'final.hplog'); const bytes = fs.readFileSync(filename);
  assert.equal(f.statuses.at(-1).upload.phase, 'deferred');
  assert.ok(decryptLog(filename).some((entry) => entry.type === 'LOG_UPLOAD_DEFERRED'));
  first.shutdown(); f.offline = false; f.uid = 8;
  const restarted = new ProctorController(f.options); await restarted.sync('https://oj.example.com/d/exam/'); await restarted.retryUploads(); assert.equal(f.attempts, 0);
  f.uid = 7; restarted.invalidateIdentity(); await restarted.sync('https://oj.example.com/d/exam/'); record.journal.state.retryAfter = 0; record.journal.saveState();
  await restarted.retryUploads(); assert.equal(f.attempts, 1); assert.deepEqual(fs.readFileSync(filename), bytes);
  assert.ok(f.statuses.some((status) => status.upload?.percent === 50));
  assert.equal(f.statuses.at(-1).upload.phase, 'complete');
  const saved = JSON.parse(fs.readFileSync(record.journal.statePath)); assert.equal(saved.phase, 'uploaded'); assert.equal(saved.receipt, 'd'.repeat(24));
});

test('finish disables new proofs while awaiting network restoration before sealing or uploading', async (t) => {
  const f = fixture(t), controller = new ProctorController(f.options);
  await controller.sync(url);
  let restore;
  const pending = controller.finish(() => new Promise((resolve) => { restore = resolve; }));
  assert.equal(controller.finishing, true);
  assert.equal(controller.current.journal.state.phase, 'open');
  await assert.rejects(controller.headers(url, { action: 'contest_view' }), /禁止新提交/);
  assert.equal(f.attempts, 0);
  restore(); assert.equal(await pending, true); assert.equal(f.attempts, 1);
});
test('lost upload response is recovered by matching status hash and never uploads a replacement log', async (t) => {
  const f = fixture(t), controller = new ProctorController(f.options); await controller.sync(url); f.loseResponse = true;
  assert.equal(await controller.finish(), true); assert.equal(f.attempts, 1); assert.equal(controller.current.journal.state.phase, 'uploaded');
  await controller.retryUploads(); assert.equal(f.attempts, 1);
});
test('open exam resumes on home-page login and continues audit during offline identity requests', async (t) => {
  const f = fixture(t), first = new ProctorController(f.options); await first.sync(url);
  const resumed = new ProctorController(f.options); await resumed.sync('https://oj.example.com/d/exam/');
  assert.equal(resumed.records.size, 1); resumed.logViolation({ source: 'CLIENT', type: 'HOME_PAGE_AUDIT', target: '', detail: '' });
  f.offline = true; await assert.rejects(resumed.sync('https://oj.example.com/d/exam/', { force: true }));
  resumed.logViolation({ source: 'CLIENT', type: 'OFFLINE_AUDIT', target: '', detail: '' });
  assert.equal(await resumed.finish(), false);
  const journal = [...resumed.records.values()][0].journal;
  const records = decryptLog(path.join(journal.directory, 'final.hplog'));
  for (const event of ['ABNORMAL_EXIT_DETECTED', 'CLIENT_RESTART', 'HOME_PAGE_AUDIT', 'OFFLINE_AUDIT']) assert.ok(records.some((record) => record.type === event));
});
test('explicit retry clears a policy pause only for the signed current account', async (t) => {
  const f = fixture(t), controller = new ProctorController(f.options); await controller.sync(url); f.offline = true;
  await controller.finish(); const journal = controller.current.journal;
  Object.assign(journal.state, { permanentError: true, failureVersion: '1.0.0', failureKeyId: trust.keyId, retryAfter: Date.now() + 3600000 }); journal.saveState();
  f.offline = false; const restarted = new ProctorController(f.options);
  await restarted.sync('https://oj.example.com/d/exam/'); await restarted.retryUploads(); assert.equal(f.attempts, 0);
  await restarted.retryManually('https://oj.example.com/d/exam/'); assert.equal(f.attempts, 1);
  assert.equal([...restarted.records.values()][0].journal.state.phase, 'uploaded');
});

test('protected problem reads require a matching client and open attempt, with fresh GET proofs', async (t) => {
  const f = fixture(t), controller = new ProctorController(f.options);
  const request = { action: 'problem_view', method: 'GET', path: '/d/exam/p/100',
    payload: { tid: '1234567890abcdef12345678', pid: '100' } };
  const first = await controller.headers(url, request), second = await controller.headers(url, request);
  const proof = JSON.parse(Buffer.from(first['x-proctor-proof'], 'base64url'));
  assert.ok(verify(proof.payload, proof.signature, f.options.protectedStore.device().publicKey));
  assert.equal(proof.payload.method, 'GET'); assert.equal(proof.payload.action, 'problem_view');
  assert.notEqual(first['x-proctor-proof'], second['x-proctor-proof']);
  const contest = await controller.headers(url, { action: 'contest_view', method: 'GET',
    path: '/d/exam/contest/1234567890abcdef12345678/problems', payload: { tid: request.payload.tid } });
  assert.equal(JSON.parse(Buffer.from(contest['x-proctor-proof'], 'base64url')).payload.action, 'contest_view');
  f.offline = true; controller.invalidateIdentity();
  await assert.rejects(controller.headers(url, request));
  f.offline = false; await controller.finish();
  await assert.rejects(controller.headers(url, request));
  await assert.rejects(controller.sync(url), /正在结束/);
  const wrong = new ProctorController({ ...fixture(t).options, version: '0.9.0' });
  await assert.rejects(wrong.headers(url, request), /version mismatch/);
  assert.equal(wrong.records.size, 0);
});

test('exit before starting an exam reports no pending logs rather than inventing a server receipt', async (t) => {
  const f = fixture(t), controller = new ProctorController(f.options);
  assert.equal(await controller.finish(), true);
  assert.equal(f.statuses.at(-1).upload.empty, true); assert.equal(f.attempts, 0);
  assert.equal(controller.records.size, 0);
});

test('concurrent navigation shares one handshake and repeated protected reads reuse signed context with fresh proofs', async (t) => {
  const f = fixture(t), controller = new ProctorController(f.options);
  await Promise.all([controller.sync(url), controller.sync(`${url}/problems`), controller.sync(url)]);
  assert.equal(f.requests.filter((request) => request.url.endsWith('/proctor/identity')).length, 1);
  assert.equal(f.requests.filter((request) => request.operation === 'challenge').length, 1);
  const request = { action: 'contest_view', method: 'GET', path: '/d/exam/contest/1234567890abcdef12345678/problems',
    payload: { tid: '1234567890abcdef12345678' } };
  const before = f.requests.length;
  const first = await controller.headers(url, request), second = await controller.headers(`${url}/problems`, request);
  assert.equal(f.requests.length, before); assert.notEqual(first['x-proctor-proof'], second['x-proctor-proof']);
  f.uid = 8; controller.invalidateIdentity();
  assert.equal((await controller.sync(url)).login.uid, 8);
  assert.equal(f.requests.filter((request) => request.operation === 'challenge').length, 2);
});

test('expired signed contexts and forced checks contact the server instead of extending cached identity', async (t) => {
  const f = fixture(t), controller = new ProctorController(f.options);
  await controller.sync(url);
  for (const entry of controller.identityCache.values()) entry.validUntil = 0;
  await controller.sync(url); await controller.sync(url, { force: true });
  assert.equal(f.requests.filter((request) => request.url.endsWith('/proctor/identity')).length, 3);
  assert.equal(f.requests.filter((request) => request.operation === 'handshake').length, 1);
});


test('pause preserves the open server attempt and encrypted journal, restart resumes it before final upload', async (t) => {
  const f = fixture(t), first = new ProctorController(f.options);
  await first.sync(url);
  const record = first.current, attemptId = record.auth.attemptId;
  record.journal.append('BEFORE_PAUSE');
  await first.pause(); first.shutdown();
  assert.equal(f.attempts, 0); assert.equal(f.requests.some((item) => item.operation === 'finish'), false);
  assert.equal(record.journal.state.phase, 'open'); assert.equal(record.journal.state.clean, true);
  assert.equal(fs.existsSync(path.join(record.journal.directory, 'final.hplog')), false);
  const restarted = new ProctorController(f.options);
  const request = { action: 'contest_view', method: 'GET', path: '/d/exam/contest/1234567890abcdef12345678/problems',
    payload: { tid: '1234567890abcdef12345678' } };
  const headers = await restarted.headers(url, request);
  assert.equal((await f.options.session.fetch(`${url}/problems`, { method: 'GET', headers })).status, 200);
  assert.equal(restarted.current.auth.attemptId, attemptId);
  assert.equal(restarted.current.journal.directory, record.journal.directory);
  restarted.current.journal.append('AFTER_PAUSE');
  assert.equal(await restarted.finish(), true); assert.equal(f.attempts, 1);
  const records = decryptLog(path.join(record.journal.directory, 'final.hplog'));
  for (const type of ['BEFORE_PAUSE', 'CLIENT_PAUSED', 'CLIENT_SHUTDOWN', 'CLIENT_RESTART', 'AFTER_PAUSE']) assert.ok(records.some((item) => item.type === type));
  assert.equal(records.some((item) => item.type === 'ABNORMAL_EXIT_DETECTED'), false);
});
