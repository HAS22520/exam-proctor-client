import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { observeLogin, resetLogin } from '../app/main/security/login-session';

test('启动时清除 Cookie、HTTP 认证和旧 Service Worker 登录缓存，再刷新 Cookie', async () => {
    const calls = [];
    const session: any = {
        clearStorageData: async (options) => calls.push(options),
        clearAuthCache: async () => calls.push('auth'),
        cookies: { flushStore: async () => calls.push('flush') },
    };
    await resetLogin(session);
    assert.deepEqual(calls, [{ storages: ['cookies', 'serviceworkers', 'cachestorage'] }, 'auth', 'flush']);
});

test('OJ sid 变化撤销身份，未变化值、无关 Cookie 和外站不触发撤销', () => {
    const cookies: any = new EventEmitter();
    let changed = 0;
    observeLogin({ cookies }, ['https://oj.example.com'], () => changed++);
    const sid: any = { name: 'sid', domain: '.example.com', path: '/', value: 'first-login' };
    const emit = (cookie, cause = 'explicit', removed = false) => cookies.emit('changed', {}, cookie, cause, removed);
    emit(sid);
    assert.equal(changed, 1);
    emit(sid, 'overwrite', true);
    emit(sid);
    assert.equal(changed, 1);
    emit({ ...sid, value: 'next-login' });
    assert.equal(changed, 2);
    emit({ ...sid, name: 'theme' });
    emit({ ...sid, domain: '.external.com' });
    assert.equal(changed, 2);
    emit({ ...sid, value: 'next-login' }, 'expired', true);
    assert.equal(changed, 3);
});

export {};
