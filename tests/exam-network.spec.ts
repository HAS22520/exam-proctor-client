import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import ExamNetwork = require('../app/main/network/exam-network');

test('考试分区只使用受控转发器，回环不绕过代理，root 调试退出后恢复', async (t) => {
    const calls = [];
    const network = new ExamNetwork({
        setProxy: async (config) => calls.push(config), closeAllConnections: async () => calls.push('close'),
    } as any, ['https://oj.example.com']);
    t.after(() => network.close());
    await network.prepare();
    assert.equal(calls[0].mode, 'fixed_servers');
    assert.match(calls[0].proxyRules, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(calls[0].proxyBypassRules, '<-loopback>');
    assert.equal(calls[1], 'close');
    assert.ok(network.auxiliaryEndpoints.some((entry) => entry.endsWith('|dns')));
    await network.setDebug(true);
    assert.deepEqual(calls[2], { mode: 'direct' });
    await network.setDebug(false);
    assert.equal(calls[4].mode, 'fixed_servers');
    await assert.rejects(network.lookup('evil.example.com'), /白名单/);
});

export {};
