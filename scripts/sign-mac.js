const fs = require('node:fs');
const path = require('node:path');
const { signAsync } = require('@electron/osx-sign');
const { execFileSync } = require('node:child_process');

module.exports = async (options) => {
  const native = path.resolve(__dirname, '../build/native');
  const defaults = options.optionsForFile;
  const extension = path.join(options.app, 'Contents/Library/SystemExtensions/com.exam.proctor.network-filter.systemextension');
  const args = ['--force', '--sign', options.identity, '--timestamp', '--options', 'runtime', '--entitlements', path.join(native, 'extension-entitlements.plist')];
  if (options.keychain) args.push('--keychain', options.keychain);
  execFileSync('codesign', [...args, path.join(extension, 'Contents/MacOS/HydroNetworkFilter')], { stdio: 'inherit' });
  execFileSync('codesign', [...args, extension], { stdio: 'inherit' });
  // osx-sign does not treat .systemextension as a bundle. Sign it explicitly
  // and prevent the outer app traversal from re-signing its executable alone.
  await signAsync({ ...options, preAutoEntitlements: false,
    ignore: (filename) => filename === extension || filename.startsWith(extension + path.sep) || options.ignore?.(filename),
    optionsForFile: (filename) => {
    const base = defaults?.(filename) || {};
    if (filename.includes('com.exam.proctor.network-filter.systemextension')) {
      return { ...base, entitlements: path.join(native, 'extension-entitlements.plist') };
    }
    if (filename === options.app || path.basename(filename) === 'HydroNetworkHost') {
      return { ...base, entitlements: path.join(native, 'host-entitlements.plist'),
        ...(path.basename(filename) === 'HydroNetworkHost' ? { additionalArguments: [...(base.additionalArguments || []), '--identifier', 'com.exam.proctor'] } : {}) };
    }
    return base;
  } });
  if (!fs.existsSync(path.join(options.app, 'Contents/Library/SystemExtensions/com.exam.proctor.network-filter.systemextension'))) {
    throw new Error('Signed application is missing its Network Extension');
  }
};
