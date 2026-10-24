import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { validateProductName } from '../app/shared/branding.ts';
import { generateIcons } from './generate-icons.mts';

// 直接用 Node 擦除入口类型，干净源码目录无需保留任何 JavaScript 启动脚本。
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out');
try {
    fs.rmSync(output, { recursive: true, force: true });
} catch {
    if (fs.existsSync(output)) {
        const trash = path.join(root, `.out-trash-${Date.now()}`);
        fs.renameSync(output, trash);
    }
}
for (const config of ['tsconfig.json', 'tsconfig.tests.json', 'tsconfig.renderer.json']) {
    const child = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', config], {
        cwd: root,
        stdio: 'inherit',
    });
    if (child.error) throw child.error;
    if (child.status !== 0) process.exit(child.status ?? 1);
}

// 资源复制采用明确清单，防止把本地配置、PEM 或上次构建的信任配置带入产物。
const assetTypes = new Set([
    '.html',
    '.css',
    '.svg',
    '.png',
    '.ico',
    '.icns',
    '.jpg',
    '.jpeg',
    '.webp',
    '.woff',
    '.woff2',
]);
fs.cpSync(path.join(root, 'app'), path.join(output, 'app'), {
    recursive: true,
    filter: (source) =>
        fs.statSync(source).isDirectory()
            ? source !== path.join(root, 'app/generated')
            : assetTypes.has(path.extname(source)),
});
fs.mkdirSync(path.join(output, 'config'), { recursive: true });
for (const name of ['exam-config.json', 'build.example.json', 'entitlements.mac.plist']) {
    fs.copyFileSync(path.join(root, 'config', name), path.join(output, 'config', name));
}
fs.copyFileSync(path.join(root, 'config/installer.nsh'), path.join(output, 'config/installer.nsh'));
generateIcons(root, output);
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const productName = validateProductName(process.env.PROCTOR_PRODUCT_NAME ?? metadata.build?.productName);
fs.writeFileSync(path.join(output, 'app/renderer/assets/brand.js'), `window.hydroClientName = ${JSON.stringify(productName)};\n`);
// React 和页面依赖完全打入 bundle；sandbox preload 只保留 electron 的内置 require。
await build({
    absWorkingDir: root,
    entryPoints: ['upload', 'waiting', 'console', 'dialog'].map((page) => `app/renderer/entries/${page}.tsx`),
    outdir: path.join(output, 'app/renderer/entries'),
    bundle: true, platform: 'browser', format: 'iife', target: 'chrome148',
    minify: true, legalComments: 'eof', define: { 'process.env.NODE_ENV': '"production"' },
});
await build({
    absWorkingDir: root,
    entryPoints: ['preload', 'upload', 'waiting', 'debug', 'dialog'].map((bridge) => `app/preload/${bridge}.ts`),
    outdir: path.join(output, 'app/preload'),
    bundle: true, platform: 'browser', format: 'cjs', external: ['electron'], target: 'chrome148',
    loader: { '.css': 'text' }, minify: true, legalComments: 'eof', define: { 'process.env.NODE_ENV': '"production"' },
});
fs.cpSync(path.join(root, 'native'), path.join(output, 'native'), { recursive: true });
fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(output, 'package-lock.json'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// 仅开发目录带 out/ 前缀；安装包和 ASAR 保留原有入口，兼容既有更新器。
pkg.main = pkg.main.replace(/^out\//, '');
// electron-builder 的双 package.json 模式要求应用元数据不含 build 配置。
// 构建配置仍由工程根目录提供；Docker 暂存工程则单独生成单目录配置。
delete pkg.build;
fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify(pkg, null, 2));
