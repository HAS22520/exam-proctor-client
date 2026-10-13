import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import ExamNetwork = require('../app/main/network/exam-network');

test('考试分区使用直连，加载前清理代理连接池', async () => {
    const calls = [];
    const network = new ExamNetwork(
        { setProxy: async (config) => calls.push(config), closeAllConnections: async () => calls.push('close') } as any,
        [],
    );
    await network.prepare();
    assert.deepEqual(calls, [{ mode: 'direct' }, 'close']);
    network.session.setProxy = async () => {
        throw new Error('代理设置失败');
    };
    await assert.rejects(network.prepare(), /代理设置失败/);
    assert.equal(calls.length, 2);
});

test('WFP 地址来自 Chromium DNS 和实际 HTTPS 连接，避免独立解析差异', async () => {
    const session: any = {
        resolveHost: async (host, options) => {
            assert.equal(host, 'oj.example.com');
            assert.deepEqual(options, { cacheUsage: 'allowed' });
            return {
                endpoints: [
                    { address: '203.0.113.2', family: 'ipv4' },
                    { address: '2001:db8::2', family: 'ipv6' },
                ],
            };
        },
    };
    const network = new ExamNetwork(session, ['https://oj.example.com']);
    network.observe({ url: 'https://oj.example.com/proctor/identity', ip: '203.0.113.1' });
    network.observe({ url: 'https://evil.example.com/', ip: '203.0.113.9' });
    network.observe({ url: 'https://oj.example.com/assets/x.js', ip: '203.0.113.8', fromCache: true });
    network.observe({ url: 'https://oj.example.com/', ip: 'invalid' });
    assert.deepEqual(await network.lookup('oj.example.com'), [
        { address: '203.0.113.2' },
        { address: '2001:db8::2' },
        { address: '203.0.113.1' },
    ]);
    session.resolveHost = async () => ({ endpoints: [{ address: 'invalid' }] });
    await assert.rejects(network.lookup('oj.example.com'), (error: any) => error.code === 'DNS_INVALID_RESULT');
});

export {};
