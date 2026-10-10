const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { ProctorController } = require('../app/main/proctor-controller');
const { Transport } = require('../app/main/proctor-auth');
const { sign, digest, nonce, verify } = require('../app/main/proctor-crypto');
const { auth, trust, workspace, store, decryptLog } = require('./helpers');
const url = 'https://oj.example.com/d/exam/contest/1234567890abcdef12345678';
function fixture(t) {
  const directory = workspace(t), protectedStore = store(path.join(directory, 'secrets'));
  let offline = false, uid = 7, state = 'open', receipt, challenge, attempts = 0, loseResponse = false;
  const envelope = (payload) => ({ payload, signature: sign(payload, auth.privateKey) });
  const session = { fetch: async (url, request) => {
    if (offline) throw new Error('Network offline');
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    let response;
    if (String(url).endsWith('/proctor/identity')) response = envelope({ protocol: 'hydro-proctor/1', action: 'identity', keyId: trust.keyId, origin: 'https://oj.example.com',
      clientNonce: body.clientNonce, uid, domainId: 'exam', root: false, tid: body.tid || '', routePid: body.problem || '', pid: 100, proctorEnabled: true, expiresAt: new Date(Date.now() + 60000).toISOString() });
    else if (request.method === 'GET') response = { state, logUploaded: !!receipt, receipt };
    else if (body.operation === 'challenge') {
      if (body.version !== '1.0.0') return new Response(JSON.stringify({ error: { message: 'Client version mismatch' } }),
        { status: 403, headers: { 'content-type': 'application/json' } });
      challenge = { protocol: 'hydro-proctor/1', action: 'handshake', keyId: trust.keyId, origin: 'https://oj.example.com', uid, domainId: 'exam', tid: '1234567890abcdef12345678',
        fingerprint: body.fingerprint, version: body.version, publicKey: body.publicKey, deviceInfo: body.deviceInfo, clientNonce: body.clientNonce, challengeId: nonce(), serverNonce: nonce(), expiresAt: new Date(Date.now() + 120000).toISOString() };
      response = envelope(challenge);
    } else if (body.operation === 'handshake') {
      assert.ok(verify(challenge, body.signature, challenge.publicKey));
      if (receipt) response = { completed: true, receipt: receipt.id };
      else { const token = nonce(); response = { token, ...envelope({ protocol: 'hydro-proctor/1', action: 'session', keyId: trust.keyId, uid, domainId: 'exam', tid: challenge.tid,
        fingerprint: challenge.fingerprint, version: challenge.version, tokenHash: digest(token), attemptId: 'b'.repeat(24), refreshEnabled: true, expiresAt: new Date(Date.now() + 600000).toISOString() }) }; }
    } else if (body.operation === 'finish') { state = 'closing'; response = { ok: true }; }
    else if (body instanceof FormData) {
      attempts++; const file = body.get('file'); const bytes = Buffer.from(await file.arrayBuffer());
      const proof = JSON.parse(Buffer.from(request.headers['x-proctor-proof'], 'base64url'));
      assert.ok(verify(proof.payload, proof.signature, protectedStore.device().publicKey)); assert.equal(proof.payload.payloadHash, digest(require('../app/main/proctor-crypto').canonical({ filename: file.name, size: bytes.length, sha256: digest(bytes) })));
      receipt = { id: 'd'.repeat(24), sha256: digest(bytes) }; state = 'complete';
      if (loseResponse) throw new Error('Response lost'); response = { ok: true, receipt: receipt.id };
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
  return { options, statuses, get attempts() { return attempts; }, set offline(value) { offline = value; }, set uid(value) { uid = value; }, set loseResponse(value) { loseResponse = value; } };
}
test('offline finish persists immutable evidence; restart retries only as original account and saves receipt', async (t) => {
  const f = fixture(t), first = new ProctorController(f.options); await first.sync(url); f.offline = true;
  assert.equal(await first.finish(), false); const record = first.current;
  assert.equal(record.journal.state.phase, 'pending-upload'); const filename = path.join(record.journal.directory, 'final.hplog'); const bytes = fs.readFileSync(filename);
  assert.equal(f.statuses.at(-1).upload.phase, 'deferred');
  assert.ok(decryptLog(filename).some((entry) => entry.type === 'LOG_UPLOAD_DEFERRED'));
  first.shutdown(); f.offline = false; f.uid = 8;
  const restarted = new ProctorController(f.options); await restarted.sync('https://oj.example.com/d/exam/'); await restarted.retryUploads(); assert.equal(f.attempts, 0);
  f.uid = 7; await restarted.sync('https://oj.example.com/d/exam/'); record.journal.state.retryAfter = 0; record.journal.saveState();
  await restarted.retryUploads(); assert.equal(f.attempts, 1); assert.deepEqual(fs.readFileSync(filename), bytes);
  assert.ok(f.statuses.some((status) => status.upload?.percent === 50));
  assert.equal(f.statuses.at(-1).upload.phase, 'complete');
  const saved = JSON.parse(fs.readFileSync(record.journal.statePath)); assert.equal(saved.phase, 'uploaded'); assert.equal(saved.receipt, 'd'.repeat(24));
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
  f.offline = true; await assert.rejects(resumed.sync('https://oj.example.com/d/exam/'));
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
  f.offline = true;
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
