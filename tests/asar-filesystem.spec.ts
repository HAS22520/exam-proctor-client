import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as mountedFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { UpdateCache } from '../app/main/updates/update-cache';
import { migrateStorage } from '../app/main/storage';
import Updater = require('../app/main/updates/updater');
import { prepare } from '../scripts/prepare-build';
import { trust } from './helpers';

const fs = process.versions.electron ? require('original-fs') : mountedFs;

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-electron-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'),
    directory = path.join(root, 'data');
  fs.mkdirSync(path.join(project, 'config'), { recursive: true });
  fs.mkdirSync(path.join(project, 'app', 'main'), { recursive: true });
  fs.writeFileSync(path.join(project, 'app', 'main', 'index.js'), 'module.exports = "updated application";');
  fs.writeFileSync(
    path.join(project, 'package.json'),
    JSON.stringify({
      name: 'runtime-update-test',
      version: '1.0.0',
      buildVersion: '2026101001',
      main: 'app/main/index.js',
      devDependencies: { electron: '44.7.0' },
    }),
  );
  fs.writeFileSync(
    path.join(project, 'config', 'exam-config.json'),
    JSON.stringify({
      exam: { targetUrl: 'https://oj.example.com' },
      updater: { enabled: true, versionUrl: 'https://oj.example.com/version.json' },
    }),
  );
  const keys = crypto.generateKeyPairSync('ed25519');
  const env: any = {
    PROCTOR_AUTH_PUBLIC_KEY: trust.authPublicKey,
    PROCTOR_LOG_PUBLIC_KEY: trust.logPublicKey,
    PROCTOR_KEY_ID: trust.keyId,
    PROCTOR_ALLOWED_ORIGINS: JSON.stringify(trust.allowedOrigins),
    PROCTOR_UPDATE_ORIGINS: JSON.stringify(trust.updateOrigins),
    PROCTOR_UPDATE_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    PROCTOR_UPDATE_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    PROCTOR_CLIENT_VERSION: '1.0.0',
    PROCTOR_CLIENT_BUILD_VERSION: '2026101001',
  };
  const prepared = prepare(env, project);
  const anchor: any = {
    trust: prepared.trust,
    config: prepared.config,
    identity: { version: '1.0.0', buildVersion: '2026101001', nativeNetworkVersion: 1 },
    electronVersion: '44.7.0',
  };
  // Release creation runs in ordinary Node, as it does in the actual build.
  // Only download, verification, caching and activation run inside Electron.
  const builder = JSON.stringify(path.resolve(__dirname, '../scripts/build-hot-update.js'));
  const built = spawnSync(
    process.env.PROCTOR_TEST_NODE_EXE,
    [
      '-e',
      `require(${builder}).buildArchive(JSON.parse(process.env.PROCTOR_TEST_ENV), process.argv[1]).then(result => console.log(JSON.stringify(result)));`,
      project,
    ],
    {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        PROCTOR_TEST_ENV: JSON.stringify({ ...env, PROCTOR_CLIENT_BUILD_VERSION: '2026101002' }),
      },
    },
  );
  assert.equal(built.error, undefined);
  assert.equal(built.status, 0, built.stderr);
  const result = JSON.parse(built.stdout.toString());
  const bytes = fs.readFileSync(result.filename);
  const manifest: any = {
    version: result.version,
    buildVersion: result.buildVersion,
    hotUpdate: { ...result, asarUrl: 'https://oj.example.com/update.asar' },
  };
  const cache = new UpdateCache(directory, anchor);
  const updater = new Updater(anchor.config, {
    directory,
    trust: anchor.trust,
    ...anchor.identity,
    cache,
    fetch: async (url) => new Response(String(url).endsWith('.asar') ? bytes : JSON.stringify(manifest)),
  });
  return { directory, anchor, cache, updater };
}

test(
  'Electron stages, cleans and activates a signed ASAR despite the virtual-directory view',
  { skip: !process.versions.electron },
  async (t) => {
    const { directory, cache, updater } = await fixture(t);
    const stage = cache.stage.bind(cache);
    let downloaded;
    cache.stage = async (info, filename) => {
      downloaded = filename;
      assert.equal(fs.statSync(filename).isFile(), true);
      assert.equal(mountedFs.statSync(filename).isDirectory(), true);
      await stage(info, filename);
    };
    await updater.check();
    await updater.stage();
    assert.equal(updater.snapshot().phase, 'ready');
    assert.equal(updater.busy, false);
    assert.equal(fs.existsSync(downloaded), false);
    assert.equal(
      fs.readdirSync(path.join(directory, 'updates')).some((name) => name.startsWith('download-')),
      false,
    );
    const pending = cache.read('pending');
    assert.equal(fs.statSync(cache.filename(pending)).isFile(), true);
    assert.equal((await cache.select()).buildVersion, '2026101002');
    assert.equal(require(path.join(cache.filename(pending), 'app', 'main', 'index.js')), 'updated application');
    const migrated = `${directory}-migrated`;
    t.after(() => fs.rmSync(migrated, { recursive: true, force: true }));
    fs.mkdirSync(migrated);
    await migrateStorage(directory, migrated);
    const destination = path.join(migrated, 'updates', path.basename(cache.filename(pending)));
    assert.equal(fs.statSync(destination).isFile(), true);
    assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(cache.filename(pending)));
    cache.ready();
    assert.equal(cache.read('launch'), null);
  },
);

test(
  'Electron rejects a bad ASAR signature, cleans the file and retains the verification error',
  { skip: !process.versions.electron },
  async (t) => {
    const { directory, anchor, updater, cache } = await fixture(t);
    anchor.trust = {
      ...anchor.trust,
      updatePublicKey: crypto
        .generateKeyPairSync('ed25519')
        .publicKey.export({ type: 'spki', format: 'pem' })
        .toString(),
    };
    await updater.check();
    await assert.rejects(updater.stage(), /ASAR 缺少有效的发布签名/);
    assert.equal(updater.snapshot().phase, 'failed');
    assert.match(updater.snapshot().message, /发布签名/);
    assert.equal(updater.busy, false);
    assert.equal(cache.read('pending'), null);
    assert.equal(
      fs.readdirSync(path.join(directory, 'updates')).some((name) => name.startsWith('download-')),
      false,
    );
  },
);

export {};
