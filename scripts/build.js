const { build, Platform, Arch } = require('electron-builder');
const { prepare } = require('./prepare-build');
async function run() {
  const { version } = prepare();
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--dir', '--win', '--mac', '--x64', '--arm64', '--publish=never'].includes(arg))) throw new Error('Unsupported build option');
  const platform = args.includes('--win') ? Platform.WINDOWS : args.includes('--mac') ? Platform.MAC : Platform.current();
  const arch = args.includes('--arm64') ? Arch.arm64 : Arch.x64;
  await build({ targets: platform.createTarget(args.includes('--dir') ? 'dir' : undefined, arch), publish: 'never',
    config: { extraMetadata: { version } } });
}
run().catch((error) => { console.error(error.message); process.exitCode = 1; });
