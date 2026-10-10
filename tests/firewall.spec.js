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

test('policy paths containing spaces, apostrophes and shell characters stay literal through both encoded layers', (t) => {
  const directory = workspace(t), calls = [];
  const guard = new FirewallGuard({}, null, directory, { platform: 'win32', pid: 1234, exec: (...args) => calls.push(args) });
  guard.script = () => "C:\\试卷 & $test\\O'Brien\\lock-firewall.ps1";
  guard.statePath = "C:\\用户 O'Brien\\network-state.json";
  guard.run('lock-firewall.ps1', "C:\\用户 O'Brien\\network-policy.json");
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'powershell.exe');
  const { script } = decode(calls[0][1]);
  assert.equal(script, "& 'C:\\试卷 & $test\\O''Brien\\lock-firewall.ps1' -StatePath 'C:\\用户 O''Brien\\network-state.json' -PolicyPath 'C:\\用户 O''Brien\\network-policy.json' -ClientProcessId 1234");
  assert.equal(calls[0][2].windowsHide, true); assert.equal(calls[0][2].timeout, 90000);
});

test('new launches do not elevate without recovery state; saved policy is restored and retained if restoration fails', (t) => {
  const directory = workspace(t), calls = [];
  const guard = new FirewallGuard({}, null, directory, { platform: 'win32', exec: (...args) => calls.push(args) });
  guard.recover(); guard.unlock(); assert.equal(calls.length, 0);
  const saved = JSON.stringify({ group: 'HydroProctor-existing', profiles: [], rules: [] });
  fs.writeFileSync(guard.statePath, saved);
  guard.recover(); assert.equal(calls.length, 1);
  assert.match(decode(calls[0][1]).script, /unlock-firewall\.ps1/);
  guard.exec = () => { throw new Error('Command failed: powershell.exe -EncodedCommand PRIVATE_INTERNAL_COMMAND'); };
  assert.throws(() => guard.recover(), (error) => {
    assert.match(error.message, /无法恢复监考网络设置/); assert.match(error.message, /管理员授权/);
    assert.match(error.message, /restore-network\.bat/); assert.doesNotMatch(error.message, /EncodedCommand|PRIVATE_INTERNAL_COMMAND/);
    return true;
  });
  assert.equal(fs.readFileSync(guard.statePath, 'utf8'), saved);
});

test('successful lock is idempotent and failed application restores partial policy without claiming a lock', (t) => {
  const directory = workspace(t), calls = [], events = [];
  const guard = new FirewallGuard({ exam: { allowedOrigins: ['https://oj.example.com'] } },
    { logViolation: (event) => events.push(event) }, directory, { platform: 'win32', exec: (...args) => calls.push(args) });
  assert.equal(guard.lock(), true); assert.equal(guard.lock(), true); assert.equal(calls.length, 1);
  assert.equal(guard.isLocked, true);
  assert.equal(events[0].type, 'NETWORK_POLICY_APPLIED');
  const policy = JSON.parse(fs.readFileSync(path.join(directory, 'network-policy.json')));
  assert.deepEqual(policy.origins, ['https://oj.example.com']); assert.match(policy.group, /^HydroProctor-/);
  guard.isLocked = false;
  guard.exec = (command, args) => {
    calls.push([command, args]);
    if (decode(args).script.includes("' -PolicyPath '")) {
      fs.writeFileSync(guard.statePath, JSON.stringify({ group: policy.group }));
      throw Object.assign(new Error('policy timed out'), { code: 'ETIMEDOUT' });
    }
    fs.unlinkSync(guard.statePath);
  };
  assert.throws(() => guard.lock(), /操作超时/);
  assert.equal(guard.isLocked, false);
  assert.match(decode(calls.at(-1)[1]).script, /unlock-firewall\.ps1/);
  assert.equal(fs.existsSync(guard.statePath), false);
});

test('watchdog waits for policy completion before client exit; nested rollback cannot exit its caller', () => {
  const watch = fs.readFileSync(path.resolve(__dirname, '../scripts/watch-network.ps1'), 'utf8');
  const lock = fs.readFileSync(path.resolve(__dirname, '../scripts/lock-firewall.ps1'), 'utf8');
  const unlock = fs.readFileSync(path.resolve(__dirname, '../scripts/unlock-firewall.ps1'), 'utf8');
  assert.ok(lock.includes('-PolicyProcessId $PID')); assert.ok(lock.includes('-NonInteractive -WindowStyle Hidden'));
  assert.ok(watch.indexOf('Wait-Process -Id $PolicyProcessId') < watch.indexOf('Wait-Process -Id $ClientProcessId'));
  assert.ok(watch.indexOf('$restore =') < watch.indexOf('Wait-Process -Id $PolicyProcessId'));
  assert.ok(watch.indexOf('Wait-Process -Id $ClientProcessId') < watch.indexOf('& $restore -StatePath'));
  assert.doesNotMatch(unlock, /\bexit\s+0\b/);
});
