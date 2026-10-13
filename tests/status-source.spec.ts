import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createPanelBridge } from '../app/preload/panel-bridge';
import { subscribeStatus } from '../app/renderer/lib/status-source';

function deferred<T = any>() {
    let resolve: (value: T) => void, reject: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve: resolve!, reject: reject! };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('最新上传推送优先于迟到的初始读取失败，清理时移除监听器', async () => {
    const initial = deferred();
    const values = [];
    const errors = [];
    let listener;
    let removed = false;
    const stop = subscribeStatus(
        {
            status: () => initial.promise,
            onStatus: (callback) => {
                listener = callback;
                return () => {
                    removed = true;
                };
            },
        },
        (value) => values.push(value),
        () => errors.push('failed'),
    );
    listener({ exitReady: true });
    initial.reject(new Error('迟到的 IPC 请求失败'));
    await flush();
    assert.deepEqual(values, [{ exitReady: true }]);
    assert.deepEqual(errors, []);
    stop();
    listener({ exitReady: false });
    assert.equal(removed, true);
    assert.equal(values.length, 1);
});

test('初始读取失败可由后续推送恢复，不持续用错误遮盖回执', async () => {
    const initial = deferred();
    let listener;
    let error = '';
    let value;
    const stop = subscribeStatus(
        {
            status: () => initial.promise,
            onStatus: (callback) => {
                listener = callback;
                return () => {};
            },
        },
        (next) => {
            value = next;
            error = '';
        },
        () => {
            error = 'failed';
        },
    );
    initial.reject(new Error('网络断开'));
    await flush();
    assert.equal(error, 'failed');
    listener({ upload: { phase: 'complete' }, exitReady: true });
    assert.equal(error, '');
    assert.equal(value.exitReady, true);
    stop();
});

test('浮窗立即接收认证及更新推送，旧轮询不能恢复已撤销的认证标记', async () => {
    const ipc: any = new EventEmitter();
    const requests = [];
    ipc.invoke = () => {
        const request = deferred();
        requests.push(request);
        return request.promise;
    };
    const bridge = createPanelBridge(ipc);
    const values = [];
    const stop = bridge.onStatus((value) => values.push(value));
    const pending = bridge.status();
    ipc.emit(
        'exam:client-status',
        {},
        { authenticated: false, phase: 'authentication-error', message: '版本不匹配', update: { phase: 'available' } },
    );
    requests[0].resolve({ authenticated: true });
    assert.equal((await pending).authenticated, false);
    assert.equal(values.at(-1).message, '版本不匹配');
    assert.equal(values.at(-1).update.phase, 'available');
    const first = bridge.status();
    const second = bridge.status();
    requests[2].resolve({ authenticated: false, message: '较新状态' });
    await second;
    requests[1].resolve({ authenticated: true, message: '较旧状态' });
    assert.equal((await first).message, '较新状态');
    stop();
    assert.equal(ipc.listenerCount('exam:client-status'), 0);
    assert.equal(ipc.listenerCount('exam:activity-status'), 0);
});

test('首次轮询合并较新进度推送时保留认证字段', async () => {
    const ipc: any = new EventEmitter();
    const pending = deferred();
    ipc.invoke = () => pending.promise;
    const bridge = createPanelBridge(ipc);
    const stop = bridge.onStatus(() => {});
    const result = bridge.status();
    ipc.emit('exam:activity-status', {}, { kind: 'auth', stage: 'handshake', label: '握手', busy: true });
    pending.resolve({ authenticated: true, activity: { stage: 'identity' } });
    const status = await result;
    assert.equal(status.authenticated, true);
    assert.equal(status.activity.stage, 'handshake');
    stop();
});
