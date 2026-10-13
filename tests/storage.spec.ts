import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { configureStorage, dataDirectory, migrateStorage, restoreBrowserProfile } from '../app/main/storage';
import { workspace } from './helpers';

test('installation data resolves beside installed and portable executables, outside signed macOS bundles', () => {
  const base = { packaged: true, env: {}, platform: 'win32' as NodeJS.Platform, executable: '/installed/client.exe' };
  assert.equal(dataDirectory(base), path.join('/installed', 'data'));
  assert.equal(dataDirectory({ ...base, executable: '/temp/extracted/client.exe', env: { PORTABLE_EXECUTABLE_DIR: '/chosen' } }), path.join('/chosen', 'data'));
  assert.equal(dataDirectory({ ...base, executable: '/temp/extracted/client.exe', env: { PORTABLE_EXECUTABLE_FILE: '/chosen/portable.exe' } }), path.join('/chosen', 'data'));
  assert.equal(dataDirectory({ ...base, platform: 'darwin', executable: '/Applications/Client.app/Contents/MacOS/Client' }), path.resolve('/Applications', 'Client.data'));
  assert.equal(dataDirectory({ ...base, packaged: false, developmentRoot: '/project' }), path.join('/project', '.proctor-data'));
});

test('storage config redirects application, Chromium, temp, logs and crashes; read-only location never silently uses AppData', (t) => {
  const directory = workspace(t), paths = new Map<string, string>();
  const app: any = { isPackaged: true, getPath: (name) => name === 'exe' ? path.join(directory, 'client.exe') : '/old-data', setPath: (name, value) => paths.set(name, value) };
  const result = configureStorage(app, {}, 'win32');
  assert.equal(result.previous, '/old-data');
  assert.equal(paths.size, 5);
  for (const value of paths.values()) assert.equal(path.relative(result.root, value).startsWith('..'), false);
  app.getPath = (name) => name === 'exe' ? path.join(directory, 'occupied', 'client.exe') : '/old-data';
  fs.writeFileSync(path.join(directory, 'occupied'), 'file');
  assert.throws(() => configureStorage(app, {}, 'win32'), /无法写入客户端数据目录/);
});

test('migration preserves device ciphertext, resumable journals and raw ASAR, retains old evidence, and never merges identities', async (t) => {
  const root = workspace(t), old = path.join(root, 'old'), next = path.join(root, 'next');
  fs.mkdirSync(path.join(old, 'secrets'), { recursive: true });
  fs.mkdirSync(path.join(old, 'journals/attempt'), { recursive: true });
  fs.mkdirSync(path.join(old, 'updates'), { recursive: true });
  fs.writeFileSync(path.join(old, 'secrets/device.bin'), Buffer.from([0, 255, 128]));
  fs.writeFileSync(path.join(old, 'journals/attempt/state.json'), '{"phase":"open"}');
  fs.writeFileSync(path.join(old, 'updates/application.asar'), Buffer.from([0, 17, 33]));
  fs.mkdirSync(path.join(old, 'Partitions/hydro-exam/Local Storage'), { recursive: true });
  fs.writeFileSync(path.join(old, 'Partitions/hydro-exam/Local Storage/draft'), 'unfinished draft');
  fs.writeFileSync(path.join(old, 'Partitions/hydro-exam/Cookies'), 'old login');
  fs.writeFileSync(path.join(old, 'network-state.json'), '{"restore":true}');
  fs.mkdirSync(next);
  await migrateStorage(old, next);
  assert.equal(fs.readFileSync(path.join(next, 'browser/Partitions/hydro-exam/Local Storage/draft'), 'utf8'), 'unfinished draft');
  assert.equal(fs.existsSync(path.join(next, 'browser/Partitions/hydro-exam/Cookies')), false);
  for (const name of ['secrets/device.bin', 'journals/attempt/state.json', 'updates/application.asar', 'network-state.json'])
    assert.deepEqual(fs.readFileSync(path.join(next, name)), fs.readFileSync(path.join(old, name)));
  fs.writeFileSync(path.join(next, 'secrets/device.bin'), 'new identity');
  await migrateStorage(old, next);
  assert.equal(fs.readFileSync(path.join(next, 'secrets/device.bin'), 'utf8'), 'new identity');
  const independent = path.join(root, 'independent');
  fs.mkdirSync(path.join(independent, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(independent, 'secrets/device.bin'), 'different identity');
  await migrateStorage(old, independent);
  assert.equal(fs.existsSync(path.join(independent, 'journals')), false);
});

test('browser partition migration commits before creating sessions, retries after restart and preserves existing browser data', async (t) => {
  const root = workspace(t), state = path.join(root, 'state'), browser = path.join(root, 'browser');
  fs.mkdirSync(path.join(state, 'browser/Partitions/hydro-exam'), { recursive: true });
  fs.mkdirSync(browser);
  fs.writeFileSync(path.join(state, 'browser/Partitions/hydro-exam/draft'), 'saved draft');
  await restoreBrowserProfile(state, browser);
  assert.equal(fs.readFileSync(path.join(browser, 'Partitions/hydro-exam/draft'), 'utf8'), 'saved draft');
  assert.equal(fs.existsSync(path.join(state, 'browser/Partitions')), false);
  await restoreBrowserProfile(state, browser);
  fs.mkdirSync(path.join(state, 'browser/Partitions/hydro-exam'), { recursive: true });
  fs.writeFileSync(path.join(state, 'browser/Partitions/hydro-exam/draft'), 'older backup');
  await restoreBrowserProfile(state, browser);
  assert.equal(fs.readFileSync(path.join(browser, 'Partitions/hydro-exam/draft'), 'utf8'), 'saved draft');
});

test('a failed migration publishes no partial identity or logs and leaves the original files untouched', async (t) => {
  const root = workspace(t), old = path.join(root, 'old'), next = path.join(root, 'next');
  for (const folder of ['secrets', 'journals']) fs.mkdirSync(path.join(old, folder), { recursive: true });
  fs.writeFileSync(path.join(old, 'secrets/device.bin'), 'encrypted original identity');
  const original = fs.promises.cp;
  let copies = 0;
  t.mock.method(fs.promises, 'cp', async (...args: Parameters<typeof original>) => {
    if (++copies === 2) throw new Error('simulated interrupted copy');
    return original(...args);
  });
  await assert.rejects(migrateStorage(old, next), /迁移失败/);
  assert.equal(fs.existsSync(next), false);
  assert.equal(fs.readFileSync(path.join(old, 'secrets/device.bin'), 'utf8'), 'encrypted original identity');
  assert.equal(fs.readdirSync(root).some((name) => name.includes('.migration-')), false);
});
