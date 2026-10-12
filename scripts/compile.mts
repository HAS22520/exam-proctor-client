import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// 直接用 Node 擦除入口类型，干净源码目录无需保留任何 JavaScript 启动脚本。
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out');
fs.rmSync(output, { recursive: true, force: true });
for (const config of ['tsconfig.json', 'tsconfig.tests.json']) {
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
for (const name of ['unlock-firewall.ps1', 'restore-network.bat']) {
  fs.copyFileSync(path.join(root, 'scripts', name), path.join(output, 'scripts', name));
}
fs.mkdirSync(path.join(output, 'config'), { recursive: true });
for (const name of ['exam-config.json', 'build.example.json', 'entitlements.mac.plist']) {
  fs.copyFileSync(path.join(root, 'config', name), path.join(output, 'config', name));
}
fs.cpSync(path.join(root, 'native'), path.join(output, 'native'), { recursive: true });
fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(output, 'package-lock.json'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// 仅开发目录带 out/ 前缀；安装包和 ASAR 保留原有入口，兼容既有更新器。
pkg.main = pkg.main.replace(/^out\//, '');
// electron-builder 的双 package.json 模式要求应用元数据不含 build 配置。
// 构建配置仍由工程根目录提供；Docker 暂存工程则单独生成单目录配置。
delete pkg.build;
fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify(pkg, null, 2));
