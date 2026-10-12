import prepareBuildModule = require('./prepare-build');
const { prepare } = prepareBuildModule;
import buildNativeModule = require('./build-native');
const { buildNative } = buildNativeModule;
export = async (context: import('app-builder-lib').PackContext) => {
  const { version } = prepare();
  if (context.packager.appInfo.version !== version)
    throw new Error('Build metadata does not match PROCTOR_CLIENT_VERSION');
  await buildNative(context.electronPlatformName, context.arch === 3 ? 'arm64' : 'x64');
};
