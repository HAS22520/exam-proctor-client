import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createPanelBridge } from '../app/preload/panel-bridge';
import { subscribeStatus } from '../app/renderer/lib/status-source';

function deferred<T = any>() {
  let resolve: (value: T) => void, reject: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve: resolve!, reject: reject! };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('new live upload status wins over a late failed initial read and cleanup removes the listener', async () => {
  const initial = deferred(), values = [], errors = [];
  let listener, removed = false;
  const stop = subscribeStatus({ status: () => initial.promise, onStatus: (callback) => { listener = callback; return () => { removed = true; }; } },
    (value) => values.push(value), () => errors.push('failed'));
  listener({ exitReady: true });
  initial.reject(new Error('late IPC failure'));
  await flush();
  assert.deepEqual(values, [{ exitReady: true }]); assert.deepEqual(errors, []);
  stop(); listener({ exitReady: false });
  assert.equal(removed, true); assert.equal(values.length, 1);
});

test('an initial failure can recover by a later live status rather than permanently covering the receipt with an error', async () => {
  const initial = deferred();
  let listener, error = '', value;
  const stop = subscribeStatus({ status: () => initial.promise, onStatus: (callback) => { listener = callback; return () => {}; } },
    (next) => { value = next; error = ''; }, () => { error = 'failed'; });
  initial.reject(new Error('offline')); await flush(); assert.equal(error, 'failed');
  listener({ upload: { phase: 'complete' }, exitReady: true });
  assert.equal(error, ''); assert.equal(value.exitReady, true); stop();
});

test('panel receives authentication and update pushes immediately; stale polls cannot restore an authenticated badge', async () => {
  const ipc: any = new EventEmitter(), requests = [];
  ipc.invoke = () => { const request = deferred(); requests.push(request); return request.promise; };
  const bridge = createPanelBridge(ipc), values = [];
  const stop = bridge.onStatus((value) => values.push(value));
  const pending = bridge.status();
  ipc.emit('exam:client-status', {}, { authenticated: false, phase: 'authentication-error', message: '版本不匹配', update: { phase: 'available' } });
  requests[0].resolve({ authenticated: true });
  assert.equal((await pending).authenticated, false);
  assert.equal(values.at(-1).message, '版本不匹配');
  assert.equal(values.at(-1).update.phase, 'available');
  const first = bridge.status(), second = bridge.status();
  requests[2].resolve({ authenticated: false, message: 'newer' }); await second;
  requests[1].resolve({ authenticated: true, message: 'older' });
  assert.equal((await first).message, 'newer');
  stop(); assert.equal(ipc.listenerCount('exam:client-status'), 0); assert.equal(ipc.listenerCount('exam:activity-status'), 0);
});

test('a first poll retains authentication fields while merging a newer activity push', async () => {
  const ipc: any = new EventEmitter(), pending = deferred(); ipc.invoke = () => pending.promise;
  const bridge = createPanelBridge(ipc), stop = bridge.onStatus(() => {});
  const result = bridge.status();
  ipc.emit('exam:activity-status', {}, { kind: 'auth', stage: 'handshake', label: '握手', busy: true });
  pending.resolve({ authenticated: true, activity: { stage: 'identity' } });
  const status = await result;
  assert.equal(status.authenticated, true); assert.equal(status.activity.stage, 'handshake'); stop();
});
