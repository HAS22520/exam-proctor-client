const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const asar = require('@electron/asar');

async function buildHotUpdate() {
  const rootDir = path.resolve(__dirname, '..');
  const appDir = path.join(rootDir, 'app');
  const updatesDir = path.join(rootDir, 'updates');
  const outputAsar = path.join(updatesDir, 'app.asar');
  const pkgPath = path.join(rootDir, 'package.json');
  const versionJsonPath = path.join(rootDir, 'version.json');

  if (!fs.existsSync(updatesDir)) {
    fs.mkdirSync(updatesDir, { recursive: true });
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const version = pkg.version || '1.0.0';

  console.log(`====================================================`);
  console.log(`  [HotUpdater Builder] 正在构建热更新补丁 v${version}`);
  console.log(`====================================================`);

  // 1. 打包 app/ 目录为 app.asar
  console.log(`[1/3] 正在压缩打包 app 目录为 updates/app.asar...`);
  await asar.createPackage(appDir, outputAsar);

  const stats = fs.statSync(outputAsar);
  const sizeKb = (stats.size / 1024).toFixed(2);
  console.log(`[OK] app.asar 构建成功！文件大小: ${sizeKb} KB (${stats.size} 字节)`);

  // 2. 计算 SHA256 哈希值
  const fileBuffer = fs.readFileSync(outputAsar);
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  console.log(`[2/3] SHA256 校验码: ${sha256}`);

  // 3. 更新 version.json
  console.log(`[3/3] 正在更新 version.json 远端版本描述信息...`);
  let versionInfo = {};
  if (fs.existsSync(versionJsonPath)) {
    versionInfo = JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'));
  }

  versionInfo.version = version;
  versionInfo.releaseDate = new Date().toISOString();
  versionInfo.hotUpdate = versionInfo.hotUpdate || {};
  versionInfo.hotUpdate.version = version;
  versionInfo.hotUpdate.size = stats.size;
  versionInfo.hotUpdate.sha256 = sha256;
  versionInfo.hotUpdate.asarUrl = `https://cdn.jsdelivr.net/gh/HAS22520/exam-proctor-client@main/updates/app.asar`;
  versionInfo.hotUpdate.fallbackUrl = `https://raw.githubusercontent.com/HAS22520/exam-proctor-client/main/updates/app.asar`;

  fs.writeFileSync(versionJsonPath, JSON.stringify(versionInfo, null, 2), 'utf-8');
  console.log(`[OK] version.json 已同步更新！`);

  console.log(`\n====================================================`);
  console.log(`🎉 热更新补丁已准备就绪！`);
  console.log(`您只需将更新推送到 GitHub，所有客户端即可自动拉取更新：`);
  console.log(`\n  git add -A`);
  console.log(`  git commit -m "release: v${version} hot-update"`);
  console.log(`  git push origin main`);
  console.log(`====================================================\n`);
}

buildHotUpdate().catch(err => {
  console.error('[ERROR] 构建热更新补丁失败:', err);
  process.exit(1);
});
