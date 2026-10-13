import * as fs from 'node:fs';
import * as path from 'node:path';

interface RuntimeMetadata {
    main?: string;
    build?: import('electron-builder').Configuration;
    [field: string]: unknown;
}

const compiledRoot = path.resolve(__dirname, '..');
// 脚本既会在工程 out/ 内运行，也会在 Docker 的独立暂存工程中运行。
const projectRoot =
    path.basename(compiledRoot) === 'out' && fs.existsSync(path.join(compiledRoot, '..', 'tsconfig.json'))
        ? path.resolve(compiledRoot, '..')
        : compiledRoot;

function applicationRoot(project = projectRoot): string {
    return fs.existsSync(path.join(project, 'tsconfig.json')) ? path.join(project, 'out') : project;
}

function runtimePackage(pkg: RuntimeMetadata): RuntimeMetadata {
    const result: RuntimeMetadata = { ...pkg, main: pkg.main?.replace(/^out\//, '') };
    if (pkg.build) {
        const directories = { ...pkg.build.directories };
        delete directories.app;
        result.build = { ...pkg.build, directories, beforePack: './scripts/before-pack.js',
            win: { ...pkg.build.win, icon: pkg.build.win?.icon?.replace(/^out\//, '') },
            mac: { ...pkg.build.mac, icon: pkg.build.mac?.icon?.replace(/^out\//, '') },
        };
    }
    return result;
}

export { applicationRoot, projectRoot, runtimePackage };

/** 页面逻辑已经打入入口 bundle；不向发布包复制未打包的 React 测试模块。 */
export function includeApplicationFile(source: string, appRoot: string) {
    const relative = path.relative(appRoot, source).split(path.sep);
    return (relative[0] !== 'renderer' || !['components', 'hooks', 'lib', 'pages'].includes(relative[1]))
        && !/\.(?:ts|tsx|map)$/.test(source);
}
