import type { PackContext } from 'app-builder-lib';
import { buildNative } from './build-native';
import { prepare } from './prepare-build';

async function beforePack(context: PackContext): Promise<void> {
    const { version } = prepare();
    if (context.packager.appInfo.version !== version) {
        throw new Error('构建元数据与 PROCTOR_CLIENT_VERSION 不一致');
    }
    await buildNative(context.electronPlatformName, context.arch === 3 ? 'arm64' : 'x64');
}

export = beforePack;
