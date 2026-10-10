const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const Updater = require('../app/main/updater');
const { validateConfig } = require('../app/main/config-policy');
const { prepare } = require('../scripts/prepare-build');
const { buildArchive, run: buildHotUpdate } = require('../scripts/build-hot-update');
const { trust, workspace } = require('./helpers');
const base = { exam: { targetUrl: 'https://oj.example.com' }, updater: { versionUrl: 'https://oj.example.com/version.json', enabled: true }, debug: { allowRoot: false } };
const environment = { PROCTOR_AUTH_PUBLIC_KEY: trust.authPublicKey, PROCTOR_LOG_PUBLIC_KEY: trust.logPublicKey, PROCTOR_KEY_ID: trust.keyId,
  PROCTOR_ALLOWED_ORIGINS: '["https://oj.example.com"]', PROCTOR_UPDATE_ORIGINS: '["https://oj.example.com"]', PROCTOR_CLIENT_VERSION: '1.2.3', PROCTOR_CLIENT_BUILD_VERSION: '2026101001' };
test('build fails without public trust, accepts dynamic version/origins, archive preserves root package and entry', async (t) => {
  const root = workspace(t); fs.mkdirSync(path.join(root, 'config')); fs.mkdirSync(path.join(root, 'app/main'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config/exam-config.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', buildVersion: '2026101001', main: 'app/main/index.js' }));
  fs.writeFileSync(path.join(root, 'app/main/index.js'), 'module.exports = 1;'); fs.writeFileSync(path.join(root, '.env'), 'PRIVATE_BUILD_SECRET');
  assert.throws(() => prepare({}, root));
  for (const field of ['PROCTOR_AUTH_PUBLIC_KEY', 'PROCTOR_LOG_PUBLIC_KEY', 'PROCTOR_KEY_ID']) assert.throws(() => prepare({ ...environment, [field]: '' }, root));
  const { version, config } = prepare({ ...environment, PROCTOR_ALLOW_ROOT_DEBUG: 'true' }, root);
  assert.equal(version, '1.2.3'); assert.ok(config.debug.allowRoot);
  assert.throws(() => prepare({ ...environment, PROCTOR_TARGET_URL: 'https://evil.example' }, root));
  const result = await buildArchive(environment, root); const asar = require('@electron/asar');
  const pkg = JSON.parse(asar.extractFile(result.filename, 'package.json'));
  assert.equal(pkg.version, '1.2.3'); assert.equal(pkg.main, 'app/main/index.js');
  assert.equal(asar.extractFile(result.filename, pkg.main).toString(), 'module.exports = 1;');
  assert.ok(!asar.listPackage(result.filename).includes('/.env'));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(result.filename)).digest('hex'), result.sha256);
});
test('updater really falls back, checks byte length/hash before publishing a download', async (t) => {
  const config = validateConfig(base, trust), directory = workspace(t); const bytes = Buffer.from('archive-bytes'); const calls = [];
  const fetch = async (url) => { calls.push(String(url)); return String(url).endsWith('/bad') ? new Response('failed', { status: 503 }) : new Response(bytes); };
  const updater = new Updater(config, { directory, trust, version: '1.0.0', fetch });
  const info = { asarUrl: 'https://oj.example.com/bad', fallbackUrl: 'https://oj.example.com/good', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const filename = path.join(directory, 'archive'); await updater.downloadPackage(info, filename); assert.deepEqual(fs.readFileSync(filename), bytes); assert.equal(calls.length, 2);
  fs.rmSync(filename); await assert.rejects(updater.downloadPackage({ ...info, sha256: '0'.repeat(64) }, filename)); assert.ok(!fs.existsSync(filename));
  await assert.rejects(updater.downloadPackage({ ...info, size: bytes.length - 1 }, filename)); assert.ok(!fs.existsSync(filename));
});
test('ASAR CLI reads relative public keys from JSON and uses environment overrides in archive metadata', async (t) => {
  const root = workspace(t), configDirectory = path.join(root, 'config');
  fs.mkdirSync(configDirectory); fs.mkdirSync(path.join(root, 'app/main'), { recursive: true });
  fs.writeFileSync(path.join(configDirectory, 'exam-config.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', buildVersion: '2026101001', main: 'app/main/index.js' }));
  fs.writeFileSync(path.join(root, 'app/main/index.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(configDirectory, 'auth.pem'), trust.authPublicKey);
  fs.writeFileSync(path.join(configDirectory, 'log.pem'), trust.logPublicKey);
  const configFile = path.join(configDirectory, 'build.local.json');
  fs.writeFileSync(configFile, JSON.stringify({ keyId: trust.keyId, version: '1.2.3', authPublicKeyFile: 'auth.pem', logPublicKeyFile: 'log.pem',
    allowedOrigins: ['https://oj.example.com'], updateOrigins: ['https://oj.example.com'], allowRootDebug: true }));
  const result = await buildHotUpdate(['--config', configFile], { env: { PROCTOR_CLIENT_VERSION: '1.2.4' }, root, log: () => {} });
  assert.equal(result.version, '1.2.4');
  const asar = require('@electron/asar');
  assert.equal(JSON.parse(asar.extractFile(result.filename, 'package.json')).version, '1.2.4');
  assert.equal(JSON.parse(asar.extractFile(result.filename, 'app/generated/config.json')).debug.allowRoot, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'updates/app-1.2.4-2026101001.json'))),
    { version: result.version, buildVersion: '2026101001', signed: false, size: result.size, sha256: result.sha256 });
  assert.ok(!asar.listPackage(result.filename).some((file) => /build\.local\.json|\.pem$/.test(file)));
  await assert.rejects(buildHotUpdate(['--win'], { env: {}, root }), /Unsupported ASAR build option/);
  await assert.rejects(buildHotUpdate(['--config'], { env: {}, root }), /requires exactly one file/);
  const help = [];
  await buildHotUpdate(['--help'], { env: {}, log: (value) => help.push(value) });
  assert.match(help[0], /release:hot/);
});
test('update redirects cannot escape allowlist or downgrade HTTPS; size bounds apply without Content-Length', async (t) => {
  const config = validateConfig(base, trust), directory = workspace(t);
  for (const redirect of ['https://evil.example/file', 'http://oj.example.com/file']) {
    const updater = new Updater(config, { directory, trust, version: '1.0.0', fetch: async () => new Response('', { status: 302, headers: { location: redirect } }) });
    await assert.rejects(updater.json('https://oj.example.com/version.json'));
  }
  const updater = new Updater(config, { directory, trust, version: '1.0.0', fetch: async () => new Response('a'.repeat(256 * 1024 + 1)) });
  await assert.rejects(updater.json('https://oj.example.com/version.json'));
});
test('unsigned ASAR never executes; manifest minimum version blocks proofs and remote config cannot enable root debug', async (t) => {
  const directory = workspace(t), config = validateConfig(base, trust);
  const manifest = { version: '1.2.3', minClientVersion: '1.2.0', hotUpdate: { version: '1.2.3', asarUrl: 'https://evil.example/payload' }, config: { url: 'https://oj.example.com/config.json' } };
  const updater = new Updater(config, { directory, trust, version: '1.0.0', fetch: async (url) => new Response(JSON.stringify(String(url).endsWith('config.json') ? { ...base, debug: { allowRoot: true } } : manifest)) });
  await updater.check(); assert.ok(updater.minimumBlocked); assert.equal(updater.snapshot().canHotUpdate, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'config/exam-config.json'))).debug.allowRoot, false);
  assert.ok(!fs.existsSync(path.join(directory, 'app.asar')));
});
test('native build configuration validates and installer/portable artifact names stay distinct', async () => {
  const pkg = require('../package.json');
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const { expandMacro } = require('app-builder-lib/out/util/macroExpander');
  const { DebugLogger } = require('builder-util');
  await validateConfiguration(pkg.build, new DebugLogger());
  const expand = (pattern, os, ext) => expandMacro(pattern, 'x64', { version: '1.2.3' }, { os, ext });
  const installer = expand(pkg.build.nsis.artifactName, 'win', 'exe');
  const portable = expand(pkg.build.portable.artifactName, 'win', 'exe');
  assert.notEqual(installer, portable); assert.equal(installer, 'HydroProctor-1.2.3-win-x64-setup.exe');
  assert.equal(expand(pkg.build.artifactName, 'mac', 'dmg'), 'HydroProctor-1.2.3-mac-x64.dmg');
});
