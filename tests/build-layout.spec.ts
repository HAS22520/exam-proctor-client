import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { stageProject } from '../scripts/build-docker';
import { applicationRoot, projectRoot } from '../scripts/project-layout';
import { workspace } from './helpers';

function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? files(filename) : [filename];
  });
}

test('TypeScript sources stay free of JS; compiled assets and development/installed entries use separate roots', () => {
  for (const directory of ['app', 'scripts', 'tests']) {
    assert.deepEqual(
      files(path.join(projectRoot, directory)).filter((file) => file.endsWith('.js')),
      [],
    );
  }
  const output = applicationRoot();
  assert.equal(output, path.join(projectRoot, 'out'));
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const runtimePackage = JSON.parse(fs.readFileSync(path.join(output, 'package.json'), 'utf8'));
  assert.equal(sourcePackage.main, 'out/app/main/bootstrap.js');
  assert.equal(sourcePackage.build.directories.app, 'out');
  assert.equal(runtimePackage.main, 'app/main/bootstrap.js');
  assert.equal(runtimePackage.build, undefined);
  for (const entry of [
    'app/main/bootstrap.js',
    'app/preload/preload.js',
    'app/renderer/upload.html',
  ]) {
    assert.ok(fs.existsSync(path.join(output, entry)), `Compiled resource missing: ${entry}`);
  }
  assert.deepEqual(fs.readdirSync(path.join(output, 'config')).sort(), [
    'build.example.json',
    'entitlements.mac.plist',
    'exam-config.json',
    'installer.nsh',
  ]);
  assert.equal(fs.existsSync(path.join(output, '.env')), false);
  assert.equal(files(path.join(output, 'app')).some((file) => /\.pem$/.test(file)), false);
  assert.equal(files(output).some((file) => /\.(?:ps1|bat)$/.test(file)), false);
});

test('Docker stages the compiled application from the source project without TS, local config or stale trust', (t) => {
  const destination = path.join(workspace(t), 'stage');
  stageProject(projectRoot, destination);
  assert.equal(
    files(destination).some((file) => /\.(?:ts|mts|pem)$/.test(file)),
    false,
  );
  assert.ok(fs.existsSync(path.join(destination, 'scripts/project-layout.js')));
  assert.equal(fs.existsSync(path.join(destination, 'app/generated')), false);
  assert.equal(files(destination).some((file) => /\.(?:ps1|bat)$/.test(file)), false);
  const pkg = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'app/main/bootstrap.js');
  assert.ok(fs.existsSync(path.join(destination, pkg.main)));
  assert.equal(pkg.build.directories.app, undefined);
});

// 校验真实 electron-builder 的双 package.json 规则，不触发下载、打包或 UI。
test('electron-builder recognizes out as the application root and keeps npm isolated from the parent workspace', async (t) => {
  const { Packager } = require('app-builder-lib/out/packager');
  const packager = new Packager({ projectDir: projectRoot });
  t.after(() => packager.tempDirManager.cleanup());
  await packager.validateConfig();
  assert.equal(packager.appDir, applicationRoot());
  assert.equal(packager.metadata.main, 'app/main/bootstrap.js');
  assert.equal(packager.metadata.build, undefined);
  assert.equal(await packager.getPackageManager(), 'npm');
  assert.equal(await packager.getWorkspaceRoot(), projectRoot);
});
