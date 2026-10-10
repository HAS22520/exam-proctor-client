const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const { Diagnostics, localTimestamp, redact } = require('../app/main/diagnostics');
const { Transport } = require('../app/main/proctor-auth');
const { workspace } = require('./helpers');

test('diagnostic time includes the local UTC offset and preserves readable localhost routes', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Asia/Hong_Kong';
  try {
    assert.equal(localTimestamp(new Date('2026-10-10T10:50:45.841Z')), '2026-10-10T18:50:45.841+08:00');
    const entry = new Diagnostics().log('info', 'time');
    assert.equal(entry.timeZone, 'Asia/Hong_Kong'); assert.match(entry.time, /\+08:00$/);
    assert.equal(Date.parse(entry.time), Date.parse(entry.utc));
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  const url = 'http://localhost:8282/d/exam/contest/1234567890abcdef12345678/problems';
  assert.equal(redact(url), url);
});

test('diagnostics redact credentials, queries, keys and unapproved fields in memory and on disk', async (t) => {
  const logger = new Diagnostics(), directory = workspace(t), token = 'T'.repeat(43);
  logger.log('error', 'protocol.failed', { url: `https://user:pass@oj.example.com/proctor?token=${token}#secret`,
    message: `token=${token} -----BEGIN PRIVATE KEY-----\nVERY_SECRET_KEY\n-----END PRIVATE KEY-----`,
    body: 'submitted source code', headers: { token }, privateKey: 'secret' });
  await logger.enable(directory); await logger.pending;
  const entry = logger.snapshot().entries[0];
  assert.equal(entry.data.url, 'https://oj.example.com/proctor');
  const memory = JSON.stringify(entry), file = await fs.promises.readFile(logger.file, 'utf8');
  for (const secret of [token, 'VERY_SECRET_KEY', 'submitted source code', 'user:pass', '#secret']) {
    assert.ok(!memory.includes(secret)); assert.ok(!file.includes(secret));
  }
});

test('diagnostics retain bounded history and record duration on failed operations', async () => {
  const logger = new Diagnostics();
  for (let i = 0; i < 1005; i++) logger.log('info', 'tick');
  assert.equal(logger.snapshot().entries.length, 1000);
  assert.equal(logger.snapshot(1004).entries.length, 1);
  await assert.rejects(logger.span('operation', async () => { throw new Error('failed'); }), /failed/);
  const entry = logger.snapshot().entries.at(-1);
  assert.equal(entry.event, 'operation.failed'); assert.equal(entry.level, 'error');
  assert.equal(typeof entry.data.durationMs, 'number');
});

test('protocol tracing distinguishes handshake stages without logging request or response secrets', async () => {
  const logger = new Diagnostics(), token = 'T'.repeat(43);
  const transport = new Transport({ fetch: async () => ({ status: 200, headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ token }) }) }, 'https://oj.example.com', 1000, logger.log.bind(logger));
  const response = await transport.json('/proctor', { operation: 'handshake', signature: 'private proof', code: 'source code' });
  assert.equal(response.token, token);
  const entries = logger.snapshot().entries;
  assert.equal(entries[0].data.operation, 'handshake'); assert.equal(entries[1].event, 'protocol.response');
  assert.equal(entries[1].data.status, 200);
  assert.doesNotMatch(JSON.stringify(entries), /private proof|source code|TTTT/);
});
