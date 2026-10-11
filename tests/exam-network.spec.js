const assert = require('node:assert/strict');
const { test } = require('node:test');
const ExamNetwork = require('../app/main/exam-network');

test('the exam partition uses direct connections and discards pooled proxy sockets before loading', async () => {
  const calls = [];
  const network = new ExamNetwork({ setProxy: async (config) => calls.push(config),
    closeAllConnections: async () => calls.push('close') }, []);
  await network.prepare();
  assert.deepEqual(calls, [{ mode: 'direct' }, 'close']);
  network.session.setProxy = async () => { throw new Error('proxy setting failed'); };
  await assert.rejects(network.prepare(), /proxy setting failed/);
  assert.equal(calls.length, 2);
});

test('WFP addresses match Chromium DNS and actual allowlisted HTTPS peers rather than independent DNS answers', async () => {
  const session = { resolveHost: async (host, options) => {
    assert.equal(host, 'oj.example.com'); assert.deepEqual(options, { cacheUsage: 'allowed' });
    return { endpoints: [{ address: '203.0.113.2', family: 'ipv4' }, { address: '2001:db8::2', family: 'ipv6' }] };
  } };
  const network = new ExamNetwork(session, ['https://oj.example.com']);
  network.observe({ url: 'https://oj.example.com/proctor/identity', ip: '203.0.113.1' });
  network.observe({ url: 'https://evil.example.com/', ip: '203.0.113.9' });
  network.observe({ url: 'https://oj.example.com/assets/x.js', ip: '203.0.113.8', fromCache: true });
  network.observe({ url: 'https://oj.example.com/', ip: 'invalid' });
  assert.deepEqual(await network.lookup('oj.example.com'), [
    { address: '203.0.113.2' }, { address: '2001:db8::2' }, { address: '203.0.113.1' },
  ]);
  session.resolveHost = async () => ({ endpoints: [{ address: 'invalid' }] });
  await assert.rejects(network.lookup('oj.example.com'), (error) => error.code === 'DNS_INVALID_RESULT');
});
