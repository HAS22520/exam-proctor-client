const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { buildVersion } = require('../app/main/build-version');
const { prepare } = require('../scripts/prepare-build');
const { buildArchive } = require('../scripts/build-hot-update');
const { verifyArchive, readArchive } = require('../app/main/signed-archive');
const { UpdateCache, hasUnfinishedJournals, journalUpdateState } = require('../app/main/update-cache');
const { validateConfig } = require('../app/main/config-policy');
const Updater = require('../app/main/updater');
const { trust, workspace } = require('./helpers');
const updatesKey = crypto.generateKeyPairSync('ed25519');
const updatePublicKey = updatesKey.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const updatePrivateKey = updatesKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const base = { exam: { targetUrl: 'https://oj.example.com' }, updater: { enabled: true, versionUrl: 'https://oj.example.com/version.json' }, debug: { allowRoot: false } };
const environment = { PROCTOR_AUTH_PUBLIC_KEY: trust.authPublicKey, PROCTOR_LOG_PUBLIC_KEY: trust.logPublicKey, PROCTOR_KEY_ID: trust.keyId,
  PROCTOR_UPDATE_PUBLIC_KEY: updatePublicKey, PROCTOR_UPDATE_PRIVATE_KEY: updatePrivateKey,
  PROCTOR_ALLOWED_ORIGINS: '["https://oj.example.com"]', PROCTOR_UPDATE_ORIGINS: '["https://oj.example.com"]',
  PROCTOR_CLIENT_VERSION: '1.0.0', PROCTOR_CLIENT_BUILD_VERSION: '2026101001' };
function fixture(t) {
  const root = workspace(t), directory = workspace(t);
  fs.mkdirSync(path.join(root, 'config')); fs.mkdirSync(path.join(root, 'app/main'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config/exam-config.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'test-update', version: '1.0.0', buildVersion: '2026101001', main: 'app/main/bootstrap.js', devDependencies: { electron: '44.7.0' } }));
  fs.writeFileSync(path.join(root, 'app/main/index.js'), 'module.exports = "signed application entry";');
  fs.writeFileSync(path.join(root, 'app/main/bootstrap.js'), 'require("./index");');
  const prepared = prepare(environment, root);
  const config = { ...prepared.config }; delete config.trust;
  return { root, directory, anchor: { trust: prepared.trust, config, identity: { version: prepared.version, buildVersion: prepared.buildVersion }, electronVersion: '44.7.0' } };
}
async function release(f, extra = {}) { return buildArchive({ ...environment, PROCTOR_CLIENT_BUILD_VERSION: '2026101002', ...extra }, f.root); }
function unfinished(f, phase = 'open') {
  const journal = path.join(f.directory, 'journals', 'a'.repeat(64)); fs.mkdirSync(journal, { recursive: true });
  fs.writeFileSync(path.join(journal, 'state.json'), JSON.stringify({ phase })); return journal;
}

test('build identifiers validate real calendar dates and never accept numbers or semver', () => {
  for (const value of ['2026101001', '2024022900', '2026123199']) assert.equal(buildVersion(value), value);
  for (const value of [2026101001, '1.0.0', '', '202610100', '2026131001', '2026022901', '2026100001']) assert.throws(() => buildVersion(value));
});
test('build ordering alone determines new releases; policies and remote config refresh even for older/same builds', async (t) => {
  const directory = workspace(t), config = validateConfig(base, trust);
  let manifest = { version: '0.9.0', buildVersion: '2026101002', minClientVersion: '1.1.0', config: { url: 'https://oj.example.com/config.json' } };
  const updater = new Updater(config, { directory, trust, version: '1.0.0', buildVersion: '2026101001',
    fetch: async (url) => new Response(JSON.stringify(String(url).endsWith('/config.json') ? { ...base, window: { width: 1300 } } : manifest)) });
  await updater.check(); assert.equal(updater.snapshot().available, true); assert.equal(updater.minimumBlocked, true);
  assert.equal(updater.snapshot().version, '1.0.0'); assert.equal(updater.snapshot().buildVersion, '2026101001');
  manifest = { ...manifest, version: '9.0.0', buildVersion: '2026101001', minClientVersion: '0.9.0' };
  await updater.check(); assert.equal(updater.snapshot().available, false); assert.equal(updater.minimumBlocked, false);
  assert.equal(JSON.parse(fs.readFileSync(updater.policyPath)).buildVersion, '2026101001');
  assert.ok(fs.existsSync(path.join(directory, 'config/exam-config.json')));
  manifest = { ...manifest, buildVersion: '2026100901' };
  await updater.check(); assert.equal(updater.snapshot().phase, 'current');
  for (const value of [undefined, 2026101003, 'bad']) {
    manifest = { ...manifest, buildVersion: value };
    await updater.check(); assert.equal(updater.snapshot().phase, 'incompatible'); assert.equal(updater.snapshot().available, false);
  }
  const legacy = new Updater(config, { directory: workspace(t), trust, version: '0.1.0', fetch: async () => new Response(JSON.stringify({ version: '1.0.0', buildVersion: '2026101002' })) });
  await legacy.check(); assert.equal(legacy.snapshot().phase, 'incompatible');
});
test('actual ASAR contains a signed release and no private key; altered bytes fail despite a matching external hash', async (t) => {
  const f = fixture(t), result = await release(f);
  await verifyArchive(result.filename, result, f.anchor);
  const archive = readArchive(result.filename);
  assert.equal(archive.pkg.main, 'app/main/bootstrap.js'); assert.equal(archive.release.payload.buildVersion, '2026101002');
  assert.equal(fs.readFileSync(result.filename).includes(Buffer.from('BEGIN PRIVATE KEY')), false);
  const entry = archive.files.get('app/main/index.js'), bytes = fs.readFileSync(result.filename); bytes[entry.start] ^= 1; fs.writeFileSync(result.filename, bytes);
  await assert.rejects(verifyArchive(result.filename, { ...result, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, f.anchor), /文件签名校验失败/);
});
test('signed archives cannot change trusted keys, allowlists, debug permission, build identity or Electron', async (t) => {
  const f = fixture(t), result = await release(f);
  for (const anchor of [{ ...f.anchor, electronVersion: '45.0.0' }, { ...f.anchor, trust: { ...f.anchor.trust, updatePublicKey: trust.authPublicKey } },
    { ...f.anchor, trust: { ...f.anchor.trust, updatePublicKey: '' } }]) await assert.rejects(verifyArchive(result.filename, result, anchor));
  await assert.rejects(verifyArchive(result.filename, { ...result, buildVersion: '2026101003' }, f.anchor), /不匹配/);
  const debug = await release(f, { PROCTOR_ALLOW_ROOT_DEBUG: 'true' });
  await assert.rejects(verifyArchive(debug.filename, debug, f.anchor), /调试权限/);
  const origins = await release(f, { PROCTOR_ALLOWED_ORIGINS: '["https://oj.example.com","https://other.example.com"]' });
  await assert.rejects(verifyArchive(origins.filename, origins, f.anchor), /白名单/);
  const unsigned = await release(f, { PROCTOR_UPDATE_PRIVATE_KEY: '' });
  await assert.rejects(verifyArchive(unsigned.filename, unsigned, f.anchor), /发布签名/);
  await assert.rejects(release(f, { PROCTOR_UPDATE_PRIVATE_KEY: '', PROCTOR_REQUIRE_SIGNED_UPDATE: 'true' }), /requires/);
  await assert.rejects(release(f, { PROCTOR_UPDATE_PRIVATE_KEY: crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }), /does not match/);
});
test('verified download stays pending until boot, failed first boot rolls back, successful boot commits actual identity', async (t) => {
  const f = fixture(t), result = await release(f), cache = new UpdateCache(f.directory, f.anchor);
  await cache.stage(result, result.filename);
  assert.equal(cache.read('active'), null); assert.equal(cache.anchor.identity.buildVersion, '2026101001');
  assert.equal((await cache.select()).buildVersion, '2026101002'); assert.ok(cache.read('launch'));
  assert.equal(await cache.select(), null); assert.match(cache.read('failure').message, /回退/);
  cache.write('pending', result);
  assert.equal((await cache.select()).buildVersion, '2026101002'); cache.ready();
  assert.equal(cache.read('launch'), null); assert.equal((await cache.select()).buildVersion, '2026101002');
  const next = await release(f, { PROCTOR_CLIENT_BUILD_VERSION: '2026101003' });
  await cache.stage(next, next.filename); assert.equal((await cache.select()).buildVersion, '2026101003');
  cache.rollback('test crash'); assert.equal((await cache.select()).buildVersion, '2026101002');
});
test('unfinished journals block staging and boot activation; an already active archive remains usable for resume', async (t) => {
  const f = fixture(t), result = await release(f), cache = new UpdateCache(f.directory, f.anchor);
  const journal = unfinished(f);
  assert.equal(hasUnfinishedJournals(f.directory), true);
  for (const phase of ['open', 'closing', 'pending-upload', 'unknown', undefined]) {
    fs.writeFileSync(path.join(journal, 'state.json'), JSON.stringify({ phase }));
    await assert.rejects(cache.stage(result, result.filename), /监考日志/);
  }
  fs.writeFileSync(path.join(journal, 'state.json'), JSON.stringify({ phase: 'uploaded' }));
  await cache.stage(result, result.filename);
  fs.writeFileSync(path.join(journal, 'state.json'), '{broken');
  assert.equal(await cache.select(), null); assert.ok(cache.read('pending'));
  fs.writeFileSync(path.join(journal, 'state.json'), JSON.stringify({ phase: 'uploaded' }));
  assert.equal((await cache.select()).buildVersion, '2026101002'); cache.ready();
  fs.writeFileSync(path.join(journal, 'state.json'), JSON.stringify({ phase: 'open' }));
  assert.equal((await cache.select()).buildVersion, '2026101002');
});
test('update blockers distinguish unfinished logs across accounts from Finder metadata and uploaded evidence', (t) => {
  const directory = workspace(t), journals = path.join(directory, 'journals');
  assert.equal(journalUpdateState(directory).blocked, false);
  fs.mkdirSync(journals);
  fs.writeFileSync(path.join(journals, '.DS_Store'), 'Finder metadata');
  fs.writeFileSync(path.join(journals, 'notes.txt'), 'not an attempt');
  fs.mkdirSync(path.join(journals, 'metadata'));
  assert.equal(hasUnfinishedJournals(directory), false);
  const save = (id, state) => {
    const folder = path.join(journals, id.repeat(64)); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'state.json'), JSON.stringify(state));
  };
  save('a', { phase: 'open', binding: { uid: 7 } });
  save('b', { phase: 'closing', binding: { uid: 8 } });
  save('c', { phase: 'pending-upload', binding: { uid: 8 } });
  save('d', { phase: 'uploaded', binding: { uid: 9 } });
  fs.mkdirSync(path.join(journals, 'e'.repeat(64))); // Damaged real attempt lacks state.
  save('f', { phase: 'unknown' });
  const status = journalUpdateState(directory);
  assert.equal(status.open, 1); assert.equal(status.pending, 2); assert.equal(status.unreadable, 2);
  assert.equal(status.blocked, true);
  assert.match(status.message, /1 份未结束、2 份待上传、2 份需恢复/);
  assert.match(status.message, /本机所有账号/); assert.match(status.message, /补传日志/);
  assert.match(status.message, /退出但不上传/);
  fs.writeFileSync(path.join(journals, 'e'.repeat(64), 'state.json'), '{broken');
  assert.equal(journalUpdateState(directory).unreadable, 2);
});
test('update availability stays separate from journal blocking and clears immediately after upload', (t) => {
  const directory = workspace(t), config = validateConfig(base, trust);
  const updater = new Updater(config, { directory, trust, version: '1.0.0', buildVersion: '2026101001', cache: {} });
  updater.manifest = { hotUpdate: { asarUrl: 'https://oj.example.com/update.asar' } };
  updater.state = { phase: 'available', available: true, message: '发现新版本' };
  const journal = unfinished({ directory });
  const blocked = updater.snapshot();
  assert.equal(blocked.phase, 'available'); assert.equal(blocked.canHotUpdate, true);
  assert.equal(blocked.blocked, true); assert.equal(blocked.journalCounts.open, 1);
  assert.match(blocked.blockedReason, /上传并结束/);
  fs.writeFileSync(path.join(journal, 'state.json'), JSON.stringify({ phase: 'pending-upload' }));
  assert.equal(updater.snapshot().journalCounts.pending, 1);
  assert.match(updater.snapshot().blockedReason, /补传日志/);
  fs.writeFileSync(path.join(journal, 'state.json'), JSON.stringify({ phase: 'uploaded' }));
  const ready = updater.snapshot();
  assert.equal(ready.blocked, false); assert.equal(ready.blockedReason, '');
  assert.deepEqual(ready.journalCounts, { open: 0, pending: 0, unreadable: 0 });
  assert.equal(ready.phase, 'available'); assert.equal(ready.canHotUpdate, true);
});
test('updater downloads and stages signed ASAR, reports progress, keeps running version, and rechecks journal state', async (t) => {
  const f = fixture(t), result = await release(f), cache = new UpdateCache(f.directory, f.anchor), states = [];
  const bytes = fs.readFileSync(result.filename), manifest = { version: result.version, buildVersion: result.buildVersion, hotUpdate: { ...result, asarUrl: 'https://oj.example.com/update.asar' } };
  const updater = new Updater(validateConfig(base, f.anchor.trust), { directory: f.directory, trust: f.anchor.trust, ...f.anchor.identity, cache,
    onStatus: (state) => states.push(state), fetch: async (url) => new Response(String(url).endsWith('.asar') ? bytes : JSON.stringify(manifest)) });
  await updater.check(); await updater.stage();
  assert.equal(updater.snapshot().phase, 'ready'); assert.equal(updater.snapshot().buildVersion, '2026101001');
  assert.equal(cache.read('active'), null); assert.equal(cache.read('pending').buildVersion, '2026101002');
  assert.ok(states.some((state) => state.phase === 'downloading' && state.percent === 100));
  unfinished(f); await assert.rejects(updater.stage(), /监考日志/);
});

test('installed bootstrap selects cached ASAR entry and exposes its actual version; failed require relaunches the previous build', async (t) => {
  const { runInNewContext } = require('node:vm');
  const f = fixture(t), result = await release(f, { PROCTOR_CLIENT_VERSION: '0.9.0' }), cache = new UpdateCache(f.directory, f.anchor);
  await cache.stage(result, result.filename);
  // The installed bootstrap's generated files are immutable native build files.
  for (const [name, value] of [['build', f.anchor.identity], ['trust', f.anchor.trust], ['config', f.anchor.config]]) fs.writeFileSync(path.join(f.root, `app/generated/${name}.json`), JSON.stringify(value));
  const source = fs.readFileSync(path.resolve(__dirname, '../app/main/bootstrap.js'), 'utf8');
  async function boot(fail = false) {
    let resolve; const done = new Promise((r) => { resolve = r; }), loaded = [];
    const context = { JSON, __dirname: path.join(f.root, 'app/main'), process: { versions: { electron: '44.7.0' } } };
    let relaunch = 0;
    const app = { setName: () => {}, requestSingleInstanceLock: () => true, getPath: () => f.directory,
      whenReady: async () => {}, relaunch: () => { relaunch++; }, exit: () => resolve() };
    context.require = (name) => {
      if (name === 'electron') return { app, dialog: { showErrorBox: (_title, message) => assert.fail(message) } };
      if (name === './update-cache') return require('../app/main/update-cache');
      if (name === './signed-archive') return require('../app/main/signed-archive');
      if (name === './index' || name.endsWith('.asar/app/main/index.js')) {
        loaded.push(name);
        if (fail) throw new Error('broken updated main');
        context.__hydroProctorRuntime.markReady(); resolve(); return {};
      }
      return require(name);
    };
    runInNewContext(source, context); await done;
    return { loaded, runtime: context.__hydroProctorRuntime, relaunch };
  }
  const updated = await boot();
  assert.ok(updated.loaded[0].endsWith('.asar/app/main/index.js')); assert.equal(updated.runtime.source, 'asar');
  assert.deepEqual({ ...updated.runtime.identity }, { version: '0.9.0', buildVersion: '2026101002' });
  const next = await release(f, { PROCTOR_CLIENT_BUILD_VERSION: '2026101003' }); await cache.stage(next, next.filename);
  // release() rewrites build outputs, restore the native identity once more.
  fs.writeFileSync(path.join(f.root, 'app/generated/build.json'), JSON.stringify(f.anchor.identity));
  const failed = await boot(true); assert.equal(failed.relaunch, 1); assert.equal(cache.read('active').buildVersion, '2026101002');
  const restored = await boot(); assert.equal(restored.runtime.identity.buildVersion, '2026101002');
});

test('full client sources build a signed portable-code archive validated against installed trust', async (t) => {
  const { stageProject } = require('../scripts/build-docker');
  const root = workspace(t); stageProject(path.resolve(__dirname, '..'), root);
  const prepared = prepare(environment, root);
  const anchor = { trust: prepared.trust, config: prepared.config, identity: { version: prepared.version, buildVersion: prepared.buildVersion }, electronVersion: '44.7.0' };
  const result = await buildArchive({ ...environment, PROCTOR_CLIENT_BUILD_VERSION: '2026101002' }, root);
  await verifyArchive(result.filename, result, anchor);
  const archive = readArchive(result.filename);
  assert.ok(archive.files.has('app/main/bootstrap.js')); assert.ok(archive.files.has('app/preload/preload.js'));
  assert.equal([...archive.files.keys()].some((file) => file.startsWith('scripts/')), false);
});


test('update key helper produces independent signing keys outside the repository and preserves existing trust', (t) => {
  const { run } = require('../scripts/update-keys');
  const directory = path.join(workspace(t), 'keys'), result = run(['--out-dir', directory]);
  const privateKey = fs.readFileSync(result.privateFile, 'utf8'), publicKey = fs.readFileSync(result.publicFile, 'utf8');
  assert.equal(crypto.createPrivateKey(privateKey).asymmetricKeyType, 'ed25519');
  const bytes = Buffer.from('release proof');
  assert.ok(crypto.verify(null, bytes, publicKey, crypto.sign(null, bytes, privateKey)));
  assert.notEqual(publicKey, trust.authPublicKey);
  assert.throws(() => run(['--out-dir', directory]), /already exist/);
  assert.equal(fs.readFileSync(result.privateFile, 'utf8'), privateKey);
  assert.throws(() => run(['--out-dir', path.resolve(__dirname, '../app/generated')]), /outside/);
});


test('ASAR signing rejects public keys, malformed PEM and RSA before creating release outputs', async (t) => {
  const f = fixture(t);
  await assert.rejects(release(f, { PROCTOR_UPDATE_PRIVATE_KEY: updatePublicKey }), /需要更新签名私钥.*传入了公钥/);
  await assert.rejects(release(f, { PROCTOR_UPDATE_PRIVATE_KEY: 'broken private PEM' }), /完整、未加密.*PKCS#8/);
  const { logs } = require('./helpers');
  await assert.rejects(release(f, { PROCTOR_UPDATE_PRIVATE_KEY: logs.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }), /Ed25519.*RSA/);
  assert.equal(fs.existsSync(path.join(f.root, 'updates')), false);
});
