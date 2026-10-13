import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import FirewallGuard = require('../app/main/network/firewall-guard');
import { NativeNetwork, endpoints } from '../app/main/network/native-network';

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
test('Windows uses native policy, coalesces locks and restores without editing system firewall rules', async (t) => {
  for (const platform of ['win32'] as const) {
    const native = backend(),
      events = [];
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
  }
});
test('macOS records its passive mode without DNS, privilege checks, helpers or network progress', async (t) => {
  const native = backend(),
    events = [],
    guard = new FirewallGuard({}, { logViolation: (event) => events.push(event) }, {
      platform: 'darwin',
      native,
      lookup: () => assert.fail('macOS must not resolve firewall addresses'),
      activity: () => assert.fail('macOS must not wait for network operations'),
    });
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
test('network protection is ready only after OJ remains reachable; failure rolls back and retains recovery', async (t) => {
  const native = backend(),
    events = [];
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
  await assert.rejects(
    guard.lock(),
    (error: any) => error.code === 'NETWORK_OJ_UNREACHABLE' && /TUN/.test(error.message),
  );
  assert.equal(native.active, false);
  assert.equal(guard.isLocked, false);
  assert.equal(events.length, 0);
  assert.deepEqual(native.calls, [['lock', '127.0.0.1|8282'], 'unlock', 'close']);
  available = true;
  await guard.lock();
  assert.equal(guard.isLocked, true);
  assert.equal(events.length, 1);
});
test('queued unlock waits for lock to finish; failures never claim successful protection', async (t) => {
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
  const locking = guard.lock(),
    unlocking = guard.unlock();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(native.calls.length, 0);
  release();
  await locking;
  await unlocking;
  assert.equal(guard.isLocked, false);
  assert.equal(native.calls[0], 'unlock');
  native.lock = async () => {
    throw new Error('native unavailable');
  };
  await assert.rejects(guard.lock(), /native unavailable/);
  assert.equal(guard.isLocked, false);
});
test('confirmed exit cancels a pending resolution instead of applying a late network lock', async (t) => {
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
test('allowlist resolves all addresses concurrently, includes IPv6 and rejects malformed resolver results', async () => {
  const hosts = [];
  const result = await endpoints(
    ['https://oj.example', 'https://assets.example:8443', 'http://[::1]:8282'],
    async (host) => {
      hosts.push(host);
      return [{ address: '203.0.113.7' }, { address: '2001:db8::7' }];
    },
  );
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
test('non-elevated Windows reports administrator instructions without automatic UAC or PowerShell', async (t) => {
  const c = child(),
    network = new NativeNetwork({
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
  c.stdout.write('{"id":1,"protocol":1,"ok":false,"code":"ADMIN_REQUIRED"}\n');
  await assert.rejects(
    check,
    (error: any) => error.code === 'ADMIN_REQUIRED' && /关闭软件.*以管理员身份运行/.test(error.message),
  );
});
test('native protocol rejects mismatched replies, handles chunked lines and revokes protection on exit', async (t) => {
  const c = child(),
    errors = [],
    stages = [];
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
  c.stdout.write('{"id":1,"protocol":2,"ok":true}\n');
  await assert.rejects(first, /NATIVE_PROTOCOL_MISMATCH/);
  const lock = network.lock('127.0.0.1|443');
  c.stdout.write('{"event":"stage","phase":"apply-native-policy"}\n{"id":2,');
  c.stdout.write('"protocol":1,"ok":true}\n');
  await lock;
  assert.equal(network.active, true);
  assert.ok(stages.includes('apply-native-policy'));
  c.emit('exit', 1);
  assert.equal(network.active, false);
  assert.deepEqual(errors, ['HELPER_EXITED']);
});
test('native timeout closes the pipe and does not leave callers indefinitely pending', async (t) => {
  const c = child(),
    network = new NativeNetwork({ platform: 'win32', spawnProcess: () => c });
  t.after(() => c.emit('exit', 0));
  await assert.rejects(network.command('lock', '127.0.0.1|443', 10), (error: any) => error.code === 'ETIMEDOUT');
  assert.equal(c.stdin.writableEnded, true);
  assert.equal(network.active, false);
});
test('a long event-loop pause expires local protection readiness before another heartbeat can renew it', async (t) => {
  let now = 0;
  const c = child(),
    network = new NativeNetwork({ platform: 'win32', spawnProcess: () => c, now: () => now });
  t.after(() => {
    network.close();
    c.emit('exit', 0);
  });
  const locked = network.lock('127.0.0.1|443');
  c.stdout.write('{"id":1,"protocol":1,"ok":true}\n');
  await locked;
  assert.equal(network.healthy(), true);
  now = 9000;
  assert.equal(network.healthy(), false);
});

export {};
