const assert = require('node:assert/strict');
const { test } = require('node:test');
const ActivityProgress = require('../app/main/activity-progress');
const FirewallGuard = require('../app/main/firewall-guard');
const { workspace } = require('./helpers');

test('network activity explains an authentication wait, keeps elapsed time across stages, and returns to authentication', async () => {
  let now = 100, releaseAuth, releaseNetwork;
  const statuses = [], progress = new ActivityProgress({ now: () => now, onChange: (value) => statuses.push(value) });
  const auth = progress.run('auth', 'identity', () => new Promise((resolve) => { releaseAuth = resolve; }));
  now += 500; progress.stage('auth', 'challenge');
  assert.equal(progress.snapshot().stage, 'challenge'); assert.equal(progress.snapshot().elapsedMs, 500);
  const network = progress.run('network', 'lock', () => new Promise((resolve) => { releaseNetwork = resolve; }));
  now += 5000; progress.stage('network', 'snapshot-policy');
  assert.equal(progress.snapshot().kind, 'network'); assert.equal(progress.snapshot().elapsedMs, 5000);
  assert.equal(progress.snapshot().estimatedMaxMs, 30000);
  now += 30000; assert.equal(progress.snapshot().delayed, true);
  releaseNetwork(); await network;
  assert.equal(progress.snapshot().kind, 'auth'); assert.equal(progress.snapshot().elapsedMs, 35500);
  releaseAuth(); await auth; assert.equal(progress.snapshot(), null);
  assert.ok(statuses.some((value) => value?.stage === 'snapshot-policy'));
});
test('failures leave a brief explanation without leaking error contents or leaving an endless spinner', async () => {
  let now = 0;
  const progress = new ActivityProgress({ now: () => now });
  await assert.rejects(progress.run('network', 'restore', async () => { throw new Error('PRIVATE_TOKEN'); }));
  assert.equal(progress.snapshot().busy, false);
  assert.equal(JSON.stringify(progress.snapshot()).includes('PRIVATE_TOKEN'), false);
  now = 8001; assert.equal(progress.snapshot(), null);
  await progress.run('auth', 'identity', async () => 1); assert.equal(progress.snapshot(), null);
});
test('queued firewall recovery does not replace the running lock indicator until recovery actually starts', async (t) => {
  const progress = new ActivityProgress(), statuses = [];
  progress.onChange = (value) => statuses.push(value);
  const guard = new FirewallGuard({}, null, workspace(t), { platform: 'darwin', activity: progress.run.bind(progress) });
  let release;
  guard.applyLock = () => new Promise((resolve) => { release = resolve; });
  const lock = guard.lock(), restore = guard.unlock();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(progress.snapshot().stage, 'lock');
  release(); await lock; await restore;
  assert.equal(progress.snapshot(), null);
  assert.ok(statuses.some((value) => value?.stage === 'restore'));
});
test('unchanged firewall protection and recovery with no saved state do not start a waiting indicator or another command', async (t) => {
  const progress = new ActivityProgress(), statuses = [];
  progress.onChange = (value) => statuses.push(value);
  let commands = 0;
  const guard = new FirewallGuard({ exam: { allowedOrigins: ['https://oj.example.com'] } }, null, workspace(t), {
    platform: 'win32', activity: progress.run.bind(progress), exec: (_command, _args, _options, callback) => { commands++; callback(null); },
  });
  await guard.recover(); await guard.unlock(); assert.equal(statuses.length, 0);
  await guard.lock(); assert.equal(commands, 1);
  const count = statuses.length;
  await guard.lock(); assert.equal(commands, 1); assert.equal(statuses.length, count);
});
test('preparation finishing during native progress page loading cannot leave a late window on screen', async () => {
  const { EventEmitter } = require('node:events');
  const WaitingWindow = require('../app/main/waiting-window');
  let release;
  class Window extends EventEmitter {
    constructor() {
      super(); this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {};
    }
    loadFile() { return new Promise((resolve) => { release = resolve; }); }
    isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; }
    show() { assert.fail('preparation already completed'); }
  }
  const progress = new WaitingWindow(Window), showing = progress.show(), window = progress.window;
  progress.close(); release(); await showing;
  assert.equal(window.destroyed, true); assert.equal(progress.window, null);
});
