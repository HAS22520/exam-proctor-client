import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import { test } from 'node:test';
import { ControlledProxy } from '../app/main/network/controlled-proxy';

async function listen(server: net.Server) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as net.AddressInfo).port;
}

test('受控解析仅接受完整白名单域名，缓存有效地址，拒绝未知域名和无效结果', async (t) => {
    const queried = [];
    const proxy = new ControlledProxy(['https://oj.example.com'], {
        resolve: async (host) => { queried.push(host); return [{ address: '203.0.113.7', ttl: 60 }]; },
    });
    t.after(() => proxy.close());
    assert.deepEqual(await proxy.lookup('oj.example.com'), [{ address: '203.0.113.7', ttl: 60 }]);
    await proxy.lookup('oj.example.com');
    assert.deepEqual(queried, ['oj.example.com']);
    for await (const host of ['payload.oj.example.com', 'oj.example.com.attacker.com', 'evil.example.com', '127.0.0.1']) {
        await assert.rejects(proxy.lookup(host), /白名单/);
    }
    assert.equal(queried.length, 1);
    const broken = new ControlledProxy(['https://oj.example.com'], { resolve: async () => [{ address: 'invalid' }] });
    t.after(() => broken.close());
    await assert.rejects(broken.lookup('oj.example.com'), /解析失败/);
});

test('HTTP 转发保持方法、路径、正文，并在连接前更新策略，拒绝白名单外端口', async (t) => {
    let policyReady = false;
    const target = http.createServer((request, response) => {
        assert.equal(policyReady, true);
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/submit?pid=3');
        let body = '';
        request.on('data', (part) => { body += part; });
        request.on('end', () => {
            assert.equal(body, 'code');
            response.end('accepted');
        });
    });
    const port = await listen(target);
    t.after(() => target.close());
    const proxy = new ControlledProxy([`http://127.0.0.1:${port}`], { beforeConnect: async () => { policyReady = true; } });
    await proxy.start();
    t.after(() => proxy.close());
    const proxyPort = Number(proxy.localEndpoint.split('|')[1]);
    const request = (url: string) => new Promise<{ status: number, body: string }>((resolve, reject) => {
        const outgoing = http.request({ host: '127.0.0.1', port: proxyPort, method: 'POST', path: url }, (response) => {
            let body = '';
            response.on('data', (part) => { body += part; });
            response.on('end', () => resolve({ status: response.statusCode, body }));
        });
        outgoing.on('error', reject);
        outgoing.end('code');
    });
    assert.deepEqual(await request(`http://127.0.0.1:${port}/submit?pid=3`), { status: 200, body: 'accepted' });
    assert.equal((await request('http://127.0.0.1:11434/')).status, 502);
});

test('CONNECT 原样传输加密字节，不接受代理用户信息或未知目标', async (t) => {
    const target = net.createServer((socket) => socket.pipe(socket));
    const port = await listen(target);
    t.after(() => target.close());
    const proxy = new ControlledProxy([`https://127.0.0.1:${port}`]);
    await proxy.start();
    t.after(() => proxy.close());
    const bytes = Buffer.from([22, 3, 3, 0, 5, 0, 255, 128, 10, 0]);
    await new Promise<void>((resolve, reject) => {
        const socket = net.connect(Number(proxy.localEndpoint.split('|')[1]), '127.0.0.1');
        let response = Buffer.alloc(0);
        let connected = false;
        socket.setTimeout(5000, () => socket.destroy(new Error('隧道测试超时')));
        socket.on('error', reject);
        socket.on('connect', () => socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
        socket.on('data', (chunk) => {
            response = Buffer.concat([response, chunk]);
            if (!connected && response.includes(Buffer.from('\r\n\r\n'))) {
                assert.match(response.toString(), /200 Connection Established/);
                response = Buffer.alloc(0);
                connected = true;
                socket.write(bytes);
            } else if (connected && response.length >= bytes.length) {
                assert.deepEqual(response, bytes);
                socket.destroy();
                resolve();
            }
        });
    });
    for await (const authority of ['evil.example.com:443', `user:password@127.0.0.1:${port}`]) {
        await new Promise<void>((resolve, reject) => {
            const socket = net.connect(Number(proxy.localEndpoint.split('|')[1]), '127.0.0.1');
            socket.on('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\n\r\n`));
            socket.on('data', () => reject(new Error('未知目标被错误放行')));
            socket.on('error', () => {});
            socket.on('close', () => resolve());
        });
    }
});

test('转发使用受控解析地址并快速回退，不再次调用系统解析器', async (t) => {
    const target = http.createServer((_request, response) => response.end('resolved'));
    const port = await listen(target);
    t.after(() => target.close());
    const proxy = new ControlledProxy([`http://oj.example.test:${port}`], {
        resolve: async () => [{ address: '127.0.0.2' }, { address: '127.0.0.1' }],
    });
    await proxy.start();
    t.after(() => proxy.close());
    const result = await new Promise<string>((resolve, reject) => {
        const request = http.get({
            host: '127.0.0.1', port: Number(proxy.localEndpoint.split('|')[1]), path: `http://oj.example.test:${port}/`,
        }, (response) => {
            let body = '';
            response.on('data', (part) => { body += part; });
            response.on('end', () => resolve(body));
        });
        request.on('error', reject);
    });
    assert.equal(result, 'resolved');
});
