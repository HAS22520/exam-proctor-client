const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const asar = require('@electron/asar');

// 递增版本号 (如 1.0.0 -> 1.0.1)
function bumpVersion(ver, type = 'patch') {
  const parts = ver.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);

  if (type === 'major') {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  } else if (type === 'minor') {
    parts[1] += 1;
    parts[2] = 0;
  } else {
    // 默认 patch
    parts[2] += 1;
  }
  return parts.join('.');
}

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
  let currentVersion = pkg.version || '1.0.0';

  let versionInfo = {};
  if (fs.existsSync(versionJsonPath)) {
    try {
      versionInfo = JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'));
    } catch (e) {}
  }

  // 参数解析: 可以是具体版本号 (如 1.0.2) 或类型 (patch / minor / major)
  const arg = process.argv[2];
  let targetVersion = currentVersion;

  if (arg && /^\d+\.\d+\.\d+$/.test(arg)) {
    targetVersion = arg;
  } else if (arg === 'minor' || arg === 'major') {
    targetVersion = bumpVersion(currentVersion, arg);
  } else {
    // 默认如果当前版本与已发布的 version.json 一致，则自动递增 patch (+1)
    if (versionInfo.version && versionInfo.version === currentVersion) {
      targetVersion = bumpVersion(currentVersion, 'patch');
    }
  }

  console.log(`====================================================`);
  console.log(`  [HotUpdater Builder] 正在构建热更新补丁`);
  console.log(`  当前版本: v${currentVersion} -> 发布目标版本: v${targetVersion}`);
  console.log(`====================================================`);

  // 1. 同步更新 package.json
  pkg.version = targetVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');

  // 2. 打包 app/ 目录为 app.asar
  console.log(`[1/3] 正在压缩打包 app 目录为 updates/app.asar...`);
  await asar.createPackage(appDir, outputAsar);

  const stats = fs.statSync(outputAsar);
  const sizeKb = (stats.size / 1024).toFixed(2);
  console.log(`[OK] app.asar 构建成功！文件大小: ${sizeKb} KB (${stats.size} 字节)`);

  // 3. 计算 SHA256 哈希值
  const fileBuffer = fs.readFileSync(outputAsar);
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  console.log(`[2/3] SHA256 校验码: ${sha256}`);

  // 4. 更新 version.json
  console.log(`[3/3] 正在更新 version.json 远端版本描述信息...`);
  versionInfo.version = targetVersion;
  versionInfo.releaseDate = new Date().toISOString();
  versionInfo.hotUpdate = versionInfo.hotUpdate || {};
  versionInfo.hotUpdate.version = targetVersion;
  versionInfo.hotUpdate.size = stats.size;
  versionInfo.hotUpdate.sha256 = sha256;
  versionInfo.hotUpdate.asarUrl = `https://cdn.jsdelivr.net/gh/HAS22520/exam-proctor-client@main/updates/app.asar`;
  versionInfo.hotUpdate.fallbackUrl = `https://raw.githubusercontent.com/HAS22520/exam-proctor-client/main/updates/app.asar`;

  fs.writeFileSync(versionJsonPath, JSON.stringify(versionInfo, null, 2), 'utf-8');
  console.log(`[OK] version.json 已同步更新为 v${targetVersion}！`);

  console.log(`\n====================================================`);
  console.log(`🎉 热更新补丁 v${targetVersion} 已就绪！`);
  console.log(`复制并运行以下命令推送到 GitHub 即可对所有学生端生效：\n`);
  console.log(`  git add -A`);
  console.log(`  git commit -m "release: v${targetVersion} hot-update"`);
  console.log(`  git push origin main`);
  console.log(`====================================================\n`);
}

buildHotUpdate().catch(err => {
  console.error('[ERROR] 构建热更新补丁失败:', err);
  process.exit(1);
});
