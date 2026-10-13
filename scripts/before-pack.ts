import type { PackContext } from 'app-builder-lib';
import { buildNative } from './build-native';
import { prepare } from './prepare-build';

async function beforePack(context: PackContext): Promise<void> {
    const { version } = prepare();
    if (context.packager.appInfo.version !== version) {
        throw new Error('Build metadata does not match PROCTOR_CLIENT_VERSION');
    }
    await buildNative(context.electronPlatformName, context.arch === 3 ? 'arm64' : 'x64');
}

export = beforePack;
