const { prepare } = require('./prepare-build');
const { buildNative } = require('./build-native');
module.exports = async (context) => {
  const { version } = prepare();
  if (context.packager.appInfo.version !== version) throw new Error('Build metadata does not match PROCTOR_CLIENT_VERSION');
  await buildNative(context.electronPlatformName, context.arch === 3 ? 'arm64' : 'x64');
};
