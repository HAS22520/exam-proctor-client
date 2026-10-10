const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { uploadFile } = require('../app/main/upload-transport');
const { workspace } = require('./helpers');

function fixture(t, mode = 'ok') {
  const directory = workspace(t), filename = path.join(directory, 'final.hplog');
  const bytes = Buffer.from('encrypted evidence'); fs.writeFileSync(filename, bytes);
  const headers = {}, chunks = [], statuses = [], request = new EventEmitter();
  let uploaded = 0, target;
  request.setHeader = (name, value) => { headers[name] = value; };
  request.getUploadProgress = () => ({ active: true, started: true, current: uploaded });
  request.write = (chunk, encoding, callback) => {
    if (mode === 'write-error') { callback(new Error('Body write failed')); return; }
    chunks.push(Buffer.from(chunk)); callback();
  };
  request.abort = () => { request.aborted = true; request.emit('abort'); };
  request.end = (chunk) => {
    chunks.push(chunk);
    if (mode === 'electron44') { request.writableFinished = true; request.emit('close'); }
    if (mode === 'redirect') { request.emit('redirect'); return; }
    if (mode === 'lost') { request.emit('close'); return; }
    if (mode === 'timeout') return;
    // write callbacks ran already, but only network-reported bytes count as upload progress.
    uploaded = Math.floor(Buffer.concat(chunks).length / 2);
    setTimeout(() => {
      const response = new EventEmitter();
      response.statusCode = 200; response.headers = { 'content-type': mode === 'electron44' ? 'application/json' : ['application/json'] };
      request.emit('response', response);
      response.emit('data', Buffer.from(mode === 'large' ? 'x'.repeat(1024 * 1024 + 1) : JSON.stringify({ ok: true, receipt: 'd'.repeat(24) })));
      response.emit('end'); request.emit('close');
    }, 230);
  };
  return { bytes, chunks, headers, request, statuses, get target() { return target; },
    options: { session: { id: 'exam-session' }, origin: 'https://oj.example.com', path: '/contest/' + 'a'.repeat(24) + '/proctor',
      filename, uploadName: 'proctor-' + 'b'.repeat(24) + '.hplog', headers: { 'x-proctor-token': 'token', 'x-proctor-proof': 'proof' },
      onProgress: (status) => statuses.push(status), createRequest: (options) => { target = options; return request; } } };
}

test('streaming multipart uses exam cookies and native network progress, then waits for the JSON receipt', async (t) => {
  const f = fixture(t), response = await uploadFile(f.options);
  assert.equal(response.receipt, 'd'.repeat(24));
  assert.equal(f.target.session.id, 'exam-session'); assert.equal(f.target.useSessionCookies, true);
  assert.equal(f.target.redirect, 'manual'); assert.equal(f.request.chunkedEncoding, true);
  assert.equal(f.headers['x-proctor-proof'], 'proof'); assert.equal(f.headers['Content-Length'], undefined);
  const multipart = Buffer.concat(f.chunks).toString();
  assert.match(multipart, /name="operation"\r\n\r\nupload/);
  assert.ok(multipart.includes(f.options.uploadName)); assert.ok(multipart.includes(f.bytes.toString()));
  assert.ok(f.statuses.some((value) => value.phase === 'uploading' && value.percent >= 49 && value.percent <= 50));
  assert.equal(f.statuses.at(-1).phase, 'verifying');
  assert.ok(f.statuses.every((value) => value.sent < value.total));
});

test('upload never follows redirects or reports lost/timed-out/oversized responses as success', async (t) => {
  for (const mode of ['redirect', 'lost', 'timeout', 'large', 'write-error']) {
    const f = fixture(t, mode);
    await assert.rejects(uploadFile({ ...f.options, timeoutMs: mode === 'timeout' ? 10 : 2000 }));
    assert.ok(!f.statuses.some((value) => value.phase === 'complete'));
    if (mode !== 'lost') assert.equal(f.request.aborted, true);
  }
});

test('Electron 44 body close before response and string headers still produce a confirmed receipt', async (t) => {
  const f = fixture(t, 'electron44');
  assert.equal((await uploadFile(f.options)).receipt, 'd'.repeat(24));
  assert.equal(f.request.aborted, undefined);
});

test('upload target refuses foreign origins, protocol-relative paths and unsafe filenames', async (t) => {
  const f = fixture(t);
  for (const extra of [{ path: 'https://other.example/upload' }, { path: '//other.example/upload' }, { uploadName: 'file\r\nheader.hplog' }]) {
    await assert.rejects(uploadFile({ ...f.options, ...extra }));
  }
  assert.equal(f.target, undefined);
});
