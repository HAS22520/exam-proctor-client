const { spawnSync } = require('node:child_process');
const { run } = require('./build');

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('Builder container requires Node.js 22.12+. Set PROCTOR_BUILDER_IMAGE to a compatible electronuserland/builder Wine image.');
  const install = spawnSync('npm', ['ci', '--cache', '/cache/npm'], { stdio: 'inherit' });
  if (install.error || install.status !== 0) throw new Error('Container npm ci failed');
  const { build } = require('electron-builder');
  await run(process.argv.slice(2), { build: (options) => build({ ...options,
    config: { ...options.config, directories: { output: '/output' } } }) });
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
