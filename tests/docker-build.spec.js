const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { run, stageProject } = require('../scripts/build-docker');
const { workspace, trust } = require('./helpers');

function fixture(t) {
  const root = workspace(t), source = path.resolve(__dirname, '..');
  stageProject(source, root);
  fs.writeFileSync(path.join(root, '.env'), 'PRIVATE_SECRET=must-not-enter-container');
  fs.writeFileSync(path.join(root, 'config/server-private.pem'), 'PRIVATE KEY');
  fs.mkdirSync(path.join(root, 'node_modules/parent-only'), { recursive: true });
  return { root, env: { PROCTOR_AUTH_PUBLIC_KEY: trust.authPublicKey, PROCTOR_LOG_PUBLIC_KEY: trust.logPublicKey,
    PROCTOR_KEY_ID: trust.keyId, PROCTOR_CLIENT_VERSION: '2.3.4', PROCTOR_TARGET_URL: 'https://oj.example.com',
    PROCTOR_VERSION_URL: 'https://oj.example.com/version.json', PROCTOR_ALLOWED_ORIGINS: '["https://oj.example.com"]',
    PROCTOR_UPDATE_ORIGINS: '["https://oj.example.com"]', PROCTOR_ALLOW_ROOT_DEBUG: 'true' } };
}

test('Docker stages only build sources, injects public configuration and isolates dependencies/caches', (t) => {
  const f = fixture(t); let stage, calls = 0;
  run(['--win', '--x64', '--portable'], { ...f, spawn: (command, args, options) => {
    calls++; assert.equal(command, 'docker');
    assert.ok(args.includes('electronuserland/builder:22-wine'));
    assert.deepEqual(args.slice(-3), ['--win', '--x64', '--portable']);
    const mounts = args.filter((arg) => arg.startsWith('type=bind,'));
    assert.equal(mounts.length, 3);
    stage = mounts.find((arg) => arg.endsWith('target=/project')).match(/source=(.*),target=/)[1];
    assert.notEqual(stage, f.root);
    assert.deepEqual(fs.readdirSync(stage).sort(), ['app', 'config', 'package-lock.json', 'package.json', 'scripts']);
    assert.deepEqual(fs.readdirSync(path.join(stage, 'config')).sort(), ['entitlements.mac.plist', 'exam-config.json']);
    assert.ok(!fs.existsSync(path.join(stage, 'node_modules')));
    const generated = JSON.parse(fs.readFileSync(path.join(stage, 'app/generated/trust.json')));
    assert.equal(generated.authPublicKey, trust.authPublicKey);
    assert.equal(options.env.PROCTOR_CLIENT_VERSION, '2.3.4');
    assert.equal(options.env.PROCTOR_ALLOW_ROOT_DEBUG, 'true');
    assert.ok(args.includes('PROCTOR_AUTH_PUBLIC_KEY')); assert.ok(!args.some((arg) => arg.includes('BEGIN PUBLIC KEY')));
    assert.ok(!args.some((arg) => arg.includes('/home/magneto/code/Hydro/node_modules')));
    assert.ok(args.includes('WINEPREFIX=/cache/wine'));
    return { status: 0 };
  } });
  assert.equal(calls, 1); assert.equal(fs.existsSync(stage), false);
});

test('Docker validates before launching, supports pinned images and cleans staging on failure', (t) => {
  const f = fixture(t);
  run(['--check'], { ...f, spawn: () => assert.fail('check must not invoke Docker') });
  for (const args of [['--mac'], ['--arm64']]) assert.throws(() => run(args, f));
  assert.throws(() => run([], { ...f, env: { ...f.env, PROCTOR_AUTH_PUBLIC_KEY: '' } }));
  let stage;
  assert.throws(() => run([], { ...f, env: { ...f.env, PROCTOR_BUILDER_IMAGE: 'electronuserland/builder:22-wine@sha256:pinned' },
    spawn: (command, args) => {
      assert.ok(args.includes('electronuserland/builder:22-wine@sha256:pinned'));
      stage = args.find((arg) => arg.endsWith('target=/project')).match(/source=(.*),target=/)[1];
      return { status: 1 };
    } }), /Docker build failed/);
  assert.equal(fs.existsSync(stage), false);
});
