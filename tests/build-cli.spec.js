const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { run, parseArgs, buildEnvironment } = require('../scripts/build');
const { trust, auth, workspace } = require('./helpers');

function fixture(t) {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0', buildVersion: '2026101001' }));
  fs.writeFileSync(path.join(root, 'config/exam-config.json'), JSON.stringify({
    exam: { targetUrl: 'https://oj.example.com', allowedOrigins: ['https://oj.example.com'] },
    updater: { enabled: true, versionUrl: 'https://oj.example.com/version.json', allowedOrigins: ['https://oj.example.com'] },
    debug: { allowRoot: false },
  }));
  fs.writeFileSync(path.join(root, 'auth.pem'), trust.authPublicKey);
  fs.writeFileSync(path.join(root, 'log.pem'), trust.logPublicKey);
  const file = path.join(root, 'config/build.local.json');
  const config = { keyId: trust.keyId, version: '1.2.3', authPublicKeyFile: '../auth.pem', logPublicKeyFile: '../log.pem',
    targetUrl: 'https://oj.example.com/contest/123', allowedOrigins: ['https://oj.example.com'],
    updateOrigins: ['https://oj.example.com'], versionUrl: 'https://oj.example.com/version.json', allowRootDebug: true };
  fs.writeFileSync(file, JSON.stringify(config));
  return { root, file, config };
}

test('build JSON resolves PEM files relative to itself, with environment overrides and strict field types', (t) => {
  const { file, config } = fixture(t);
  const env = buildEnvironment(file, { PROCTOR_CLIENT_VERSION: '2.0.0', PROCTOR_ALLOW_ROOT_DEBUG: 'false' });
  assert.equal(env.PROCTOR_AUTH_PUBLIC_KEY, trust.authPublicKey);
  assert.equal(env.PROCTOR_LOG_PUBLIC_KEY, trust.logPublicKey);
  assert.equal(env.PROCTOR_CLIENT_VERSION, '2.0.0');
  assert.equal(env.PROCTOR_ALLOW_ROOT_DEBUG, 'false');
  assert.deepEqual(JSON.parse(env.PROCTOR_ALLOWED_ORIGINS), ['https://oj.example.com']);
  fs.writeFileSync(file, JSON.stringify({ ...config, authPublicKeyFile: 'missing.pem' }));
  assert.equal(buildEnvironment(file, { PROCTOR_AUTH_PUBLIC_KEY: trust.authPublicKey }).PROCTOR_AUTH_PUBLIC_KEY, trust.authPublicKey);
  for (const extra of [{ allowRootDebug: 'false' }, { allowedOrigins: 'https://oj.example.com' }, { unexpected: true }]) {
    fs.writeFileSync(file, JSON.stringify({ ...config, ...extra }));
    assert.throws(() => buildEnvironment(file, {}), /build config field/);
  }
});

test('documented JSON comments are accepted, never embedded, and cannot hide unknown build fields', async (t) => {
  const { root, file, config } = fixture(t);
  const example = require('../config/build.example.json');
  const fields = Object.keys(example).filter((field) => field !== '_comments');
  assert.deepEqual(Object.keys(example._comments).sort(), fields.sort());
  fs.writeFileSync(file, JSON.stringify({ ...config, _comments: example._comments }));
  const env = buildEnvironment(file, {});
  assert.ok(Object.keys(env).every((field) => field.startsWith('PROCTOR_')));
  await run(['--config', file, '--check'], { root, env: {}, build: async () => assert.fail('check must not package') });
  for (const name of ['config.json', 'trust.json']) {
    const generated = JSON.parse(fs.readFileSync(path.join(root, 'app/generated', name)));
    assert.ok(!Object.hasOwn(generated, '_comments'));
  }
  for (const comments of [null, [], 'comment', { unknownOption: 'explanation' }, { version: true }]) {
    fs.writeFileSync(file, JSON.stringify({ ...config, _comments: comments }));
    assert.throws(() => buildEnvironment(file, {}), /_comments/);
  }
  fs.writeFileSync(file, JSON.stringify({ ...config, _comments: example._comments, typoVersion: '2.0.0' }));
  assert.throws(() => buildEnvironment(file, {}), /Unknown build config field/);
});

test('check validates keys and origins before packaging; rejects conflicting targets and unsupported options', async (t) => {
  const { root, file, config } = fixture(t);
  let builds = 0;
  const dependencies = { root, env: {}, build: async () => { builds++; } };
  await run(['--config', file, '--mac', '--arm64', '--check'], dependencies);
  assert.equal(builds, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'app/generated/config.json'))).debug.allowRoot, true);
  fs.writeFileSync(path.join(root, 'auth.pem'), auth.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await assert.rejects(run(['--config', file, '--check'], dependencies));
  fs.writeFileSync(path.join(root, 'auth.pem'), trust.authPublicKey);
  fs.writeFileSync(file, JSON.stringify({ ...config, targetUrl: 'https://evil.example' }));
  await assert.rejects(run(['--config', file, '--win'], dependencies));
  assert.equal(builds, 0);
  for (const args of [['--win', '--mac'], ['--x64', '--arm64'], ['--config'], ['--config', '--win'], ['--unknown'],
    ['--portable'], ['--mac', '--portable'], ['--win', '--portable', '--dir']]) {
    assert.throws(() => parseArgs(args));
  }
  await assert.rejects(run(['--win', '--arm64'], dependencies), /x64 only/);
});
test('macOS packaging needs no developer account, profile files or native build', async (t) => {
  const { root, file, config } = fixture(t);
  const pkg = require('../package.json');
  assert.equal(pkg.build.extraResources, undefined);
  assert.equal(pkg.build.mac.sign, undefined); assert.equal(pkg.build.afterSign, undefined);
  assert.ok(pkg.build.win.extraResources.some((resource) => resource.to === 'native'));
  fs.writeFileSync(file, JSON.stringify({ ...config, macTeamId: 'old-team', macHostProfileFile: 'deleted.profile',
    macExtensionProfileFile: 'missing.profile', _comments: { macTeamId: 'Retired option' } }));
  const env = buildEnvironment(file, {});
  assert.equal(env.PROCTOR_MAC_TEAM_ID, undefined); assert.equal(env.PROCTOR_MAC_HOST_PROFILE, undefined);
  await run(['--config', file, '--mac', '--arm64'], { root, env: {}, build: async ({ config: settings }) => {
    assert.equal(settings.mac.identity, '-'); assert.equal(settings.mac.notarize, false);
    assert.equal(settings.afterPack, undefined);
    await settings.beforePack({ electronPlatformName: 'darwin', arch: 3, packager: { appInfo: { version: '1.2.3' } } });
    assert.equal(fs.existsSync(path.join(root, 'build/native')), false);
  } });
  await run(['--config', file, '--mac', '--x64'], { root, env: { CSC_LINK: 'certificate.p12' }, build: async ({ config: settings }) => {
    assert.equal(settings.mac.identity, undefined); assert.equal(settings.mac.notarize, undefined);
  } });
});

test('native build uses project root and dynamic version; beforePack keeps file-supplied trust', async (t) => {
  const { root, file } = fixture(t);
  for (const args of [['--win', '--x64'], ['--mac', '--arm64', '--dir'], ['--win', '--x64', '--portable']]) {
    let called = false;
    await run(['--config', file, ...args], { root, env: { PROCTOR_CLIENT_VERSION: '2.3.4' }, build: async (options) => {
      called = true;
      assert.equal(options.projectDir, root);
      assert.equal(options.publish, 'never');
      assert.equal(options.config.extraMetadata.version, '2.3.4');
      const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
      const { DebugLogger } = require('builder-util');
      await validateConfiguration({ ...require('../package.json').build, ...options.config }, new DebugLogger());
      const targets = [...options.targets.entries()];
      assert.equal(targets[0][0].name, args[0] === '--win' ? 'windows' : 'mac');
      const architectures = [...targets[0][1].entries()];
      assert.equal(architectures[0][0], args[0] === '--win' ? 1 : 3);
      if (args.includes('--dir')) assert.deepEqual(architectures[0][1], ['dir']);
      if (args.includes('--portable')) assert.deepEqual(architectures[0][1], ['portable']);
      await options.config.beforePack({ packager: { appInfo: { version: '2.3.4' } } });
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'app/generated/trust.json'))).authPublicKey, trust.authPublicKey);
      await assert.rejects(options.config.beforePack({ packager: { appInfo: { version: '1.0.0' } } }), /metadata/);
    } });
    assert.ok(called);
  }
});

test('electron-builder keeps the npm client isolated inside a Yarn workspace even with a Bun lock file', async (t) => {
  const parent = workspace(t), root = path.join(parent, 'client');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(parent, 'package.json'), JSON.stringify({
    name: 'unrelated-yarn-parent', version: '1.0.0', workspaces: ['packages/*'], packageManager: 'yarn@4.17.0',
    dependencies: { 'parent-only-module': '1.0.0' },
  }));
  fs.writeFileSync(path.join(parent, 'yarn.lock'), '__metadata:\n  version: 8\n');
  const pkg = require('../package.json');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg },
  }));
  fs.writeFileSync(path.join(root, 'bun.lock'), '{}');
  const { Packager } = require('app-builder-lib/out/packager');
  const { getCollectorByPackageManager } = require('app-builder-lib/out/node-module-collector');
  const packager = new Packager({ projectDir: root });
  t.after(() => packager.tempDirManager.cleanup());
  assert.equal(await packager.getWorkspaceRoot(), root);
  assert.equal(await packager.getPackageManager(), 'npm');
  const collector = getCollectorByPackageManager(await packager.getPackageManager(), root, packager.tempDirManager);
  const dependencies = await collector.getNodeModules({ packageName: pkg.name });
  assert.deepEqual(dependencies.nodeModules, []);
});
