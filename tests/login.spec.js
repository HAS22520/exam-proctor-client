const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { resetLogin, observeLogin } = require('../app/main/login-session');

test('startup clears cookies, HTTP auth and stale service worker login caches before flushing cookies', async () => {
  const calls = [], session = { clearStorageData: async (options) => calls.push(options),
    clearAuthCache: async () => calls.push('auth'), cookies: { flushStore: async () => calls.push('flush') } };
  await resetLogin(session);
  assert.deepEqual(calls, [{ storages: ['cookies', 'serviceworkers', 'cachestorage'] }, 'auth', 'flush']);
});

test('OJ sid changes invalidate identity; unchanged values, unrelated cookies and external hosts do not', () => {
  const cookies = new EventEmitter();
  let changed = 0;
  observeLogin({ cookies }, ['https://oj.example.com'], () => changed++);
  const sid = { name: 'sid', domain: '.example.com', path: '/', value: 'first-login' };
  const emit = (cookie, cause = 'explicit', removed = false) => cookies.emit('changed', {}, cookie, cause, removed);
  emit(sid); assert.equal(changed, 1);
  emit(sid, 'overwrite', true); emit(sid); assert.equal(changed, 1);
  emit({ ...sid, value: 'next-login' }); assert.equal(changed, 2);
  emit({ ...sid, name: 'theme' }); emit({ ...sid, domain: '.external.com' }); assert.equal(changed, 2);
  emit({ ...sid, value: 'next-login' }, 'expired', true); assert.equal(changed, 3);
});
