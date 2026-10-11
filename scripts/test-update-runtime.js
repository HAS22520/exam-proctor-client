const path = require('node:path');
const { spawnSync } = require('node:child_process');
// Run only filesystem/update tests in Electron's Node mode; no windows or UI.
const electron = require('electron');
const child = spawnSync(electron, ['--test', 'tests/asar-filesystem.spec.js'], {
  cwd: path.resolve(__dirname, '..'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PROCTOR_TEST_NODE_EXE: process.execPath }, stdio: 'inherit',
});
if (child.error) { console.error(child.error.message); process.exitCode = 1; }
else process.exitCode = child.status ?? 1;
