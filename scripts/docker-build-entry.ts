import { spawnSync } from 'node:child_process';
import { run } from './build';

async function main() {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 12)) {
        throw new Error(
            '构建容器需要 Node.js 22.12+，请将 PROCTOR_BUILDER_IMAGE 设置为兼容的 electronuserland/builder Wine 镜像',
        );
    }
    const install = spawnSync('npm', ['ci', '--cache', '/cache/npm'], { stdio: 'inherit' });
    if (install.error || install.status !== 0) throw new Error('容器内 npm ci 安装依赖失败');
    const { build } = require('electron-builder');
    await run(process.argv.slice(2), {
        build: (
            options: Omit<import('electron-builder').CliOptions, 'config'> & {
                config: import('electron-builder').Configuration;
            },
        ) => build({ ...options, config: { ...options.config, directories: { output: '/output' } } }),
    });
}
main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
