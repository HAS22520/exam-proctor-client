import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import FirewallGuard = require('../app/main/network/firewall-guard');
import { endpoints, NativeNetwork } from '../app/main/network/native-network';

function backend() {
    return {
        active: false,
        calls: [],
        async check() {
            this.calls.push('check');
        },
        async lock(policy) {
            this.calls.push(['lock', policy]);
            this.active = true;
        },
        async unlock() {
            this.calls.push('unlock');
            this.active = false;
        },
        close() {
            this.active = false;
            this.calls.push('close');
        },
    };
}
test('Windows 使用原生策略，合并网络启用请求，恢复时不改系统防火墙规则', async () => {
    const platform = 'win32';
    const native = backend();
    const events = [];
    const guard = new FirewallGuard(
        { exam: { allowedOrigins: ['https://127.0.0.1:8282'] } },
        { logViolation: (event) => events.push(event) },
        { platform, native },
    );
    const lock = guard.lock();
    assert.equal(lock, guard.lock());
    assert.equal(await lock, true);
    assert.equal(await guard.lock(), true);
    assert.equal(native.calls.length, 1);
    assert.equal(guard.isLocked, true);
    assert.equal(events[0].target, 'windows-wfp');
    await guard.unlock();
    await guard.unlock();
    assert.equal(native.calls.length, 2);
    assert.equal(guard.isLocked, false);
    if (platform === 'win32') {
        await guard.checkPrivileges();
        assert.equal(native.calls.at(-1), 'check');
    }
});
test('macOS 记录被动模式，不执行 DNS、权限检查或网络辅助操作', async () => {
    const native = backend();
    const events = [];
    const guard = new FirewallGuard(
        {},
        { logViolation: (event) => events.push(event) },
        {
            platform: 'darwin',
            native,
            lookup: () => assert.fail('macOS 不能解析防火墙地址'),
            activity: () => assert.fail('macOS 不能等待网络操作'),
        },
    );
    await guard.checkPrivileges();
    await guard.recover();
    assert.equal(await guard.lock(), false);
    await guard.lock();
    assert.equal(guard.isLocked, false);
    assert.equal(guard.mode, 'macos-audit-only');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'NETWORK_AUDIT_ONLY');
    await guard.unlock();
    await guard.lock();
    assert.equal(events.length, 2);
    guard.cancelPendingLock();
    guard.close();
    assert.deepEqual(native.calls, []);
});
test('OJ 仍可访问后才确认网络保护成功，失败时回滚并保留恢复能力', async () => {
    const native = backend();
    const events = [];
    let available = false;
    const guard = new FirewallGuard(
        { exam: { allowedOrigins: ['https://127.0.0.1:8282'] } },
        { logViolation: (event) => events.push(event) },
        {
            platform: 'win32',
            native,
            verifyConnectivity: async () => {
                assert.equal(native.active, true);
                assert.equal(guard.isLocked, false);
                if (!available) throw new Error('net::ERR_CONNECTION_CLOSED');
            },
        },
    );
    await assert.rejects(guard.lock(), (error: any) => error.code === 'NETWORK_OJ_UNREACHABLE' && /TUN/.test(error.message));
    assert.equal(native.active, false);
    assert.equal(guard.isLocked, false);
    assert.equal(events.length, 0);
    assert.deepEqual(native.calls, [['lock', '127.0.0.1|8282'], 'unlock', 'close']);
    available = true;
    await guard.lock();
    assert.equal(guard.isLocked, true);
    assert.equal(events.length, 1);
});
test('排队的恢复等待限制启用结束，失败时不宣称保护成功', async () => {
    const native = backend();
    let release;
    native.lock = () =>
        new Promise((resolve) => {
            release = () => {
                native.active = true;
                resolve();
            };
        });
    const guard = new FirewallGuard({ exam: { allowedOrigins: ['https://127.0.0.1'] } }, null, {
        platform: 'win32',
        native,
    });
    const locking = guard.lock();
    const unlocking = guard.unlock();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(native.calls.length, 0);
    release();
    await locking;
    await unlocking;
    assert.equal(guard.isLocked, false);
    assert.equal(native.calls[0], 'unlock');
    native.lock = async () => {
        throw new Error('原生网络组件不可用');
    };
    await assert.rejects(guard.lock(), /原生网络组件不可用/);
    assert.equal(guard.isLocked, false);
});
test('确认退出后取消待完成的解析，避免迟到的网络限制', async () => {
    const native = backend();
    let release;
    const guard = new FirewallGuard({ exam: { allowedOrigins: ['https://oj.example'] } }, null, {
        platform: 'win32',
        native,
        lookup: () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    });
    const pending = guard.lock();
    await new Promise((resolve) => setImmediate(resolve));
    guard.cancelPendingLock();
    release([{ address: '203.0.113.7' }]);
    await assert.rejects(pending, (error: any) => error.code === 'NETWORK_CANCELLED');
    await guard.unlock();
    assert.equal(guard.isLocked, false);
    assert.deepEqual(native.calls, ['close']);
});
test('白名单并发解析所有地址，支持 IPv6 并拒绝无效结果', async () => {
    const hosts = [];
    const result = await endpoints(['https://oj.example', 'https://assets.example:8443', 'http://[::1]:8282'], async (host) => {
        hosts.push(host);
        return [{ address: '203.0.113.7' }, { address: '2001:db8::7' }];
    });
    assert.deepEqual(hosts, ['oj.example', 'assets.example']);
    assert.equal(result, '203.0.113.7|443;2001:db8::7|443;203.0.113.7|8443;2001:db8::7|8443;::1|8282');
    await assert.rejects(
        endpoints(['https://oj.example'], async () => [{ address: 'invalid\ncommand' }]),
        /INVALID_ADDRESS/,
    );
});
function child() {
    const c: any = new EventEmitter();
    c.stdin = new PassThrough();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.kill = () => c.emit('exit', 1);
    return c;
}
test('Windows 非管理员启动显示重开说明，不自动触发 UAC 或 PowerShell', async (t) => {
    const c = child();
    const network = new NativeNetwork({
        platform: 'win32',
        spawnProcess: (file, args) => {
            assert.match(file, /hydro-network\.exe$/);
            assert.deepEqual(args, ['--parent', String(process.pid)]);
            return c;
        },
    });
    t.after(() => {
        network.close();
        c.emit('exit', 0);
    });
    const check = network.check();
    c.stdout.write('{"id":1,"protocol":2,"ok":false,"code":"ADMIN_REQUIRED"}\n');
    await assert.rejects(check, (error: any) => error.code === 'ADMIN_REQUIRED' && /关闭软件.*以管理员身份运行/.test(error.message));
});
test('原生协议拒绝不匹配响应，支持分块读取，并在进程退出后撤销保护', async (t) => {
    const c = child();
    const errors = [];
    const stages = [];
    const network = new NativeNetwork({
        platform: 'win32',
        spawnProcess: () => c,
        onFailure: (error: any) => errors.push(error.code),
        trace: (_level, _event, details) => stages.push(details.phase),
    });
    t.after(() => {
        network.close();
        c.emit('exit', 0);
    });
    const first = network.check();
    c.stdout.write('{"id":1,"protocol":9,"ok":true}\n');
    await assert.rejects(first, (error: any) => error.code === 'NATIVE_PROTOCOL_MISMATCH' && /完整 Windows 安装包/.test(error.message));
    const lock = network.lock('127.0.0.1|443');
    c.stdout.write('{"event":"stage","phase":"apply-native-policy"}\n{"id":2,');
    c.stdout.write('"protocol":2,"ok":true}\n');
    await lock;
    assert.equal(network.active, true);
    assert.ok(stages.includes('apply-native-policy'));
    c.emit('exit', 1);
    assert.equal(network.active, false);
    assert.deepEqual(errors, ['HELPER_EXITED']);
});
test('原生操作超时关闭管道，不让调用方无限等待', async (t) => {
    const c = child();
    const network = new NativeNetwork({ platform: 'win32', spawnProcess: () => c });
    t.after(() => c.emit('exit', 0));
    await assert.rejects(network.command('lock', '127.0.0.1|443', 10), (error: any) => error.code === 'ETIMEDOUT');
    assert.equal(c.stdin.writableEnded, true);
    assert.equal(network.active, false);
});
test('事件循环长期暂停时，本地网络保护先过期再允许新心跳', async (t) => {
    let now = 0;
    const c = child();
    const network = new NativeNetwork({ platform: 'win32', spawnProcess: () => c, now: () => now });
    t.after(() => {
        network.close();
        c.emit('exit', 0);
    });
    const locked = network.lock('127.0.0.1|443');
    c.stdout.write('{"id":1,"protocol":2,"ok":true}\n');
    await locked;
    assert.equal(network.healthy(), true);
    now = 9000;
    assert.equal(network.healthy(), false);
});

export {};

test('地址刷新合并并复用动态会话，恢复排队后不重新加锁', async () => {
    const native = backend();
    let address = '203.0.113.7';
    const guard = new FirewallGuard({ exam: { allowedOrigins: ['https://oj.example'] } }, null, {
        platform: 'win32', native, lookup: async () => [{ address }], auxiliaryEndpoints: () => ['192.0.2.53|53|dns', '127.0.0.1|12345'],
    });
    await guard.lock();
    await guard.refresh();
    assert.equal(native.calls.length, 1);
    address = '203.0.113.8';
    const refresh = guard.refresh();
    assert.equal(refresh, guard.refresh());
    await refresh;
    assert.equal(native.calls.length, 2);
    assert.match(native.calls[1][1], /203\.0\.113\.8/);
    const recovering = guard.unlock();
    await guard.refresh();
    await recovering;
    assert.equal(native.active, false);
    assert.equal(native.calls.length, 3);
});
