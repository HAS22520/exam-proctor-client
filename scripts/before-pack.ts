import { buildNative } from './build-native';
import { prepare } from './prepare-build';

export = async (context: import('app-builder-lib').PackContext) => {
  const { version } = prepare();
  if (context.packager.appInfo.version !== version)
    throw new Error('Build metadata does not match PROCTOR_CLIENT_VERSION');
  await buildNative(context.electronPlatformName, context.arch === 3 ? 'arm64' : 'x64');
};
