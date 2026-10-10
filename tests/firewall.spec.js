const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const FirewallGuard = require('../app/main/firewall-guard');
const { powerShellArgs } = FirewallGuard;
const { workspace } = require('./helpers');

function decode(args) {
  assert.equal(args.at(-2), '-EncodedCommand');
  const launcher = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  const encoded = launcher.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)[1];
  return { launcher, script: Buffer.from(encoded, 'base64').toString('utf16le') };
}

test('elevation waits for the policy process only, leaving the watchdog alive until client exit', () => {
  const args = powerShellArgs("& 'C:\\客户端\\lock-firewall.ps1' -StatePath 'C:\\用户\\network-state.json'");
  const { launcher, script } = decode(args);
  const command = launcher.split('\n').find((line) => line.trim().startsWith('$p = Start-Process'));
  assert.ok(command.includes('-Verb RunAs')); assert.ok(command.includes('-PassThru'));
  assert.doesNotMatch(command, /-Wait\b/);
  assert.ok(launcher.includes('$p.WaitForExit()')); assert.ok(launcher.includes('exit $p.ExitCode'));
  assert.match(script, /客户端/); assert.match(script, /用户/);
  assert.ok(args.includes('-NonInteractive'));
  assert.equal(args[args.indexOf('-WindowStyle') + 1], 'Hidden');
  assert.match(command, /-WindowStyle Hidden/); assert.match(command, /'-NonInteractive'/);
  assert.match(launcher, /WindowsBuiltInRole\]::Administrator/);
  assert.ok(!launcher.includes('net.exe')); assert.ok(!args.includes('-Command'));
});

test('policy paths containing spaces, apostrophes and shell characters stay literal through both encoded layers', async (t) => {
  const directory = workspace(t), calls = [];
  const guard = new FirewallGuard({}, null, directory, { platform: 'win32', pid: 1234, exec: (...args) => { calls.push(args); args.at(-1)(null); } });
  guard.script = () => "C:\\试卷 & $test\\O'Brien\\lock-firewall.ps1";
  guard.statePath = "C:\\用户 O'Brien\\network-state.json";
  await guard.run('lock-firewall.ps1', "C:\\用户 O'Brien\\network-policy.json");
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'powershell.exe');
  const { script } = decode(calls[0][1]);
  assert.equal(script, "& 'C:\\试卷 & $test\\O''Brien\\lock-firewall.ps1' -StatePath 'C:\\用户 O''Brien\\network-state.json' -PolicyPath 'C:\\用户 O''Brien\\network-policy.json' -ClientProcessId 1234");
  assert.equal(calls[0][2].windowsHide, true); assert.equal(calls[0][2].timeout, 45000);
});

test('new launches do not elevate without recovery state; saved policy is restored and retained if restoration fails', async (t) => {
  const directory = workspace(t), calls = [];
  const guard = new FirewallGuard({}, null, directory, { platform: 'win32', exec: (...args) => { calls.push(args); args.at(-1)(null); } });
  await guard.recover(); await guard.unlock(); assert.equal(calls.length, 0);
  const saved = JSON.stringify({ group: 'HydroProctor-existing', profiles: [], rules: [] });
  fs.writeFileSync(guard.statePath, saved);
  await guard.recover(); assert.equal(calls.length, 1);
  assert.match(decode(calls[0][1]).script, /unlock-firewall\.ps1/);
  guard.exec = () => { throw new Error('Command failed: powershell.exe -EncodedCommand PRIVATE_INTERNAL_COMMAND'); };
  await assert.rejects(guard.recover(), (error) => {
    assert.match(error.message, /无法恢复监考网络设置/); assert.match(error.message, /管理员授权/);
    assert.match(error.message, /restore-network\.bat/); assert.doesNotMatch(error.message, /EncodedCommand|PRIVATE_INTERNAL_COMMAND/);
    return true;
  });
  assert.equal(fs.readFileSync(guard.statePath, 'utf8'), saved);
});

test('successful lock is idempotent and failed application restores partial policy without claiming a lock', async (t) => {
  const directory = workspace(t), calls = [], events = [];
  const guard = new FirewallGuard({ exam: { allowedOrigins: ['https://oj.example.com'] } },
    { logViolation: (event) => events.push(event) }, directory, { platform: 'win32', exec: (...args) => { calls.push(args); args.at(-1)(null); } });
  assert.equal(await guard.lock(), true); assert.equal(await guard.lock(), true); assert.equal(calls.length, 1);
  assert.equal(guard.isLocked, true);
  assert.equal(events[0].type, 'NETWORK_POLICY_APPLIED');
  const policyName = fs.readdirSync(directory).find((name) => /^network-policy-[a-f0-9-]+\.json$/.test(name));
  const policy = JSON.parse(fs.readFileSync(path.join(directory, policyName)));
  assert.deepEqual(policy.origins, ['https://oj.example.com']); assert.match(policy.group, /^HydroProctor-/);
  guard.isLocked = false;
  guard.exec = (command, args, options, callback) => {
    calls.push([command, args]);
    if (decode(args).script.includes("' -PolicyPath '")) {
      fs.writeFileSync(guard.statePath, JSON.stringify({ group: policy.group }));
      callback(Object.assign(new Error('policy timed out'), { code: 'ETIMEDOUT' })); return;
    }
    fs.unlinkSync(guard.statePath); callback(null);
  };
  await assert.rejects(guard.lock(), /操作超时/);
  assert.equal(guard.isLocked, false);
  assert.match(decode(calls.at(-1)[1]).script, /unlock-firewall\.ps1/);
  assert.equal(fs.existsSync(guard.statePath), false);
});

test('watchdog caches recovery, stops stalled policy before rollback and accepts explicit restore requests', () => {
  const watch = fs.readFileSync(path.resolve(__dirname, '../scripts/watch-network.ps1'), 'utf8');
  const lock = fs.readFileSync(path.resolve(__dirname, '../scripts/lock-firewall.ps1'), 'utf8');
  const unlock = fs.readFileSync(path.resolve(__dirname, '../scripts/unlock-firewall.ps1'), 'utf8');
  assert.ok(lock.includes("'-PolicyProcessId',$PID"));
  assert.ok(watch.indexOf('$restore =') < watch.indexOf('while (Test-Path'));
  assert.ok(watch.indexOf('Stop-Process') < watch.indexOf('& $restore -StatePath'));
  assert.ok(watch.includes('.restore-request.json')); assert.ok(watch.includes('$client.HasExited'));
  assert.ok(lock.includes('Disable-NetFirewallRule -PolicyStore PersistentStore -Name $rules'));
  assert.ok(unlock.includes('Enable-NetFirewallRule -PolicyStore PersistentStore -Name $existing'));
  assert.ok(unlock.indexOf('Set-NetFirewallProfile') < unlock.indexOf('Enable-NetFirewallRule'));
  assert.doesNotMatch(unlock, /\bexit\s+0\b/);
});

test('pending elevation leaves the event loop responsive and serializes lock and unlock', async (t) => {
  const directory = workspace(t), calls = [];
  let release;
  const guard = new FirewallGuard({ exam: { allowedOrigins: ['https://oj.example.com'] } }, null, directory,
    { platform: 'win32', exec: (command, args, options, callback) => {
      calls.push(decode(args).script);
      if (calls.length === 1) { fs.writeFileSync(guard.statePath, '{}'); release = callback; }
      else { fs.unlinkSync(guard.statePath); callback(null); }
    } });
  const locking = guard.lock(), unlocking = guard.unlock();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.equal(guard.isLocked, false);
  release(null);
  assert.equal(await locking, true); await unlocking;
  assert.equal(calls.length, 2); assert.match(calls[1], /unlock-firewall/);
  assert.equal(guard.isLocked, false); assert.equal(fs.existsSync(guard.statePath), false);
});

test('concurrent recovery uses the elevated watchdog once, ignores stale replies and avoids a new elevation', async (t) => {
  const directory = workspace(t), group = `HydroProctor-${'a'.repeat(8)}`;
  const guard = new FirewallGuard({}, null, directory, { platform: 'win32', exec: () => assert.fail('must reuse the watchdog') });
  fs.writeFileSync(guard.statePath, JSON.stringify({ group }));
  fs.writeFileSync(`${guard.statePath}.watch.json`, JSON.stringify({ group, pid: 123 }));
  const first = guard.unlock(), second = guard.unlock();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(fs.readFileSync(`${guard.statePath}.restore-request.json`));
  assert.equal(request.group, group); assert.match(request.id, /^[a-f0-9]{32}$/);
  fs.writeFileSync(`${guard.statePath}.restore-result.json`, JSON.stringify({ id: 'stale', ok: false, message: 'old error' }));
  fs.unlinkSync(guard.statePath);
  await first; assert.equal(guard.isLocked, false);
});

test('failed watchdog restoration retains state and suppresses immediate repeated recovery requests', async (t) => {
  const directory = workspace(t), group = 'HydroProctor-aaaa';
  const guard = new FirewallGuard({}, null, directory, { platform: 'win32', exec: () => assert.fail('must not elevate again') });
  fs.writeFileSync(guard.statePath, JSON.stringify({ group }));
  fs.writeFileSync(`${guard.statePath}.watch.json`, JSON.stringify({ group, pid: 123 }));
  const recovery = guard.unlock();
  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(fs.readFileSync(`${guard.statePath}.restore-request.json`));
  fs.writeFileSync(`${guard.statePath}.restore-result.json`, JSON.stringify({ id: request.id, ok: false, message: 'Firewall service stopped' }));
  await assert.rejects(recovery, /Firewall service stopped/);
  assert.equal(fs.existsSync(guard.statePath), true);
  await assert.rejects(guard.unlock(), /Firewall service stopped/);
  await assert.rejects(guard.lock(), /Firewall service stopped/);
  assert.equal(fs.readdirSync(directory).some((name) => name.startsWith('network-policy-')), false);
  assert.equal(JSON.parse(fs.readFileSync(`${guard.statePath}.restore-request.json`)).id, request.id);
});
