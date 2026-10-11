const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

function fixture(platform) {
  const events = [], commands = [], shortcuts = [], screen = new EventEmitter(), window = new EventEmitter();
  screen.getAllDisplays = () => [{}, {}];
  window.isDestroyed = () => false;
  window.focus = () => events.push({ type: 'FOCUS' });
  window.restore = () => events.push({ type: 'RESTORE' });
  const mocks = {
    electron: { screen, globalShortcut: { register: (value) => { shortcuts.push(value); return true; }, unregister: () => {} } },
    'node:child_process': { execFile: (file, args, options, callback) => {
      commands.push({ file, args });
      if (file === '/bin/ps') callback(null, '123 ForbiddenApp\n');
      else if (file === 'tasklist.exe') callback(null, '"ForbiddenApp","123"\n');
      else callback(null, '');
    } },
  };
  const module = { exports: {} };
  runInNewContext(fs.readFileSync(path.resolve(__dirname, '../app/main/anti-cheat.js'), 'utf8'), {
    module, require: (name) => mocks[name] || require(name), process: { platform, pid: 999 },
    setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  const guard = new module.exports(window, { window: { preventMinimize: true }, antiCheat: {
    blockShortcuts: ['Alt+Tab'], singleScreenOnly: true, terminateBlacklisted: true,
    processBlacklistByPlatform: { darwin: ['ForbiddenApp'], win32: ['ForbiddenApp'] },
  } }, { logViolation: (event) => events.push(event) });
  return { guard, events, commands, shortcuts, window };
}

test('macOS logs focus, displays and processes without intercepting shortcuts or terminating apps', () => {
  const f = fixture('darwin');
  f.guard.start(); f.window.emit('blur'); f.window.emit('minimize');
  assert.deepEqual(f.shortcuts, []);
  assert.deepEqual(f.commands.map((command) => command.file), ['/bin/ps']);
  for (const type of ['WINDOW_BLUR', 'WINDOW_MINIMIZED', 'MULTI_SCREEN_DETECTED', 'FORBIDDEN_PROCESS']) {
    assert.ok(f.events.some((event) => event.type === type));
  }
  assert.ok(f.events.every((event) => !['FOCUS', 'RESTORE', 'PROCESS_TERMINATED'].includes(event.type)));
  f.guard.stop();
  const count = f.events.length; f.window.emit('blur'); assert.equal(f.events.length, count);
});

test('Windows retains configured shortcuts, refocusing and explicit process termination', () => {
  const f = fixture('win32');
  f.guard.start(); f.window.emit('blur'); f.window.emit('minimize');
  assert.deepEqual(f.shortcuts, ['Alt+Tab']);
  assert.deepEqual(f.commands.map((command) => command.file), ['tasklist.exe', 'taskkill.exe']);
  assert.ok(f.events.some((event) => event.type === 'FOCUS'));
  assert.ok(f.events.some((event) => event.type === 'RESTORE'));
  f.guard.stop();
});
