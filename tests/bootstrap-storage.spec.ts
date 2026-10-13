import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { workspace } from './helpers';

// 模拟慢迁移时 ready 已发出，无需启动 Electron 或窗口。
test('bootstrap fixes all Electron paths before an asynchronous migration can yield to ready', async (t) => {
  const root = workspace(t), directory = path.join(root, 'state'), calls = [];
  let ready = false, loaded, failed;
  const done = new Promise<void>((resolve, reject) => { loaded = resolve; failed = reject; });
  const setPath = (name, filename) => { assert.equal(ready, false, `${name} must be set before ready`); calls.push([name, filename]); };
  const app: any = {
    setName: () => {}, requestSingleInstanceLock: () => true, setPath, whenReady: async () => {},
    exit: () => failed(new Error('startup must succeed')),
  };
  const source = path.resolve(__dirname, '../app/main/bootstrap.js');
  const context: any = { exports: {}, console, __dirname: path.dirname(source), process: { versions: { electron: '44.7.0' } }, require(name) {
    if (name === 'electron') return { app, ipcMain: { removeHandler: () => {} } };
    if (name === './storage') return {
      configureStorage: () => { setPath('sessionData', path.join(root, 'browser')); return { root, directory, previous: '/old' }; },
      migrateStorage: async () => { ready = true; await new Promise((resolve) => setImmediate(resolve)); },
      restoreBrowserProfile: async (state, browser) => { assert.equal(state, directory); assert.equal(browser, path.join(root, 'browser')); },
    };
    if (name === 'node:fs') return { ...fs, readFileSync: () => '{}' };
    if (name === './updates/update-cache') return { UpdateCache: class { async select() { return null; } read() { return null; } } };
    if (name === './updates/signed-archive') return { ENTRY: 'app/main/index.js' };
    if (name === './windows/dialog-service') return { DialogService: class { async show() {} } };
    if (name === './index') { loaded(); return {}; }
    return require(name);
  } };
  runInNewContext(fs.readFileSync(source, 'utf8'), context);
  await done;
  assert.deepEqual(calls.map(([name]) => name), ['sessionData', 'userData']);
  assert.equal(calls[1][1], directory);
});
