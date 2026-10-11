const { spawnSync } = require('node:child_process');
const path = require('node:path');
module.exports = async (context) => {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const checked = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  if (checked.status !== 0) throw new Error('Network Extension requires a correctly signed macOS installer');
  const identity = spawnSync('codesign', ['-d', '-vv', app], { encoding: 'utf8' });
  if (!/Authority=Developer ID Application:/.test(identity.stderr || '')) throw new Error('macOS network filtering requires Developer ID Application signing; unsigned/ad-hoc bundles cannot activate the extension');
};
