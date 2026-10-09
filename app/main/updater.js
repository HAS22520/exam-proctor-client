const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

class HotUpdater {
  constructor(config = {}, auditLogger = null) {
    this.config = config.updater || {};
    this.auditLogger = auditLogger;
    this.localVersion = this.getLocalVersion();
    this.timeoutMs = this.config.timeoutMs || 4000;
  }

  getLocalVersion() {
    try {
      const pkgPath = path.resolve(__dirname, '../../package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return pkg.version || '1.0.0';
      }
    } catch (e) {}
    return '1.0.0';
  }

  // 版本语义号比较: 返回 1 (v1 > v2), -1 (v1 < v2), 0 (v1 == v2)
  compareVersions(v1, v2) {
    const p1 = (v1 || '0.0.0').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const p2 = (v2 || '0.0.0').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(p1.length, p2.length, 3); i++) {
      const a = p1[i] || 0;
      const b = p2[i] || 0;
      if (a > b) return 1;
      if (a < b) return -1;
    }
    return 0;
  }

  // 通用网络请求 (自动处理 301/302/307 重定向及超时)
  fetchUrl(targetUrl, timeoutMs = 4000, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        return reject(new Error('Too many redirects'));
      }

      const client = targetUrl.startsWith('https') ? https : http;
      const req = client.get(targetUrl, {
        headers: { 'User-Agent': 'exam-proctor-client-updater' },
        timeout: timeoutMs
      }, (res) => {
        // 重定向跟随
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          return resolve(this.fetchUrl(res.headers.location, timeoutMs, maxRedirects - 1));
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP Error ${res.statusCode}: ${res.statusMessage}`));
        }

        let data = '';
        res.setEncoding('utf-8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      });

      req.on('error', err => reject(err));
    });
  }

  // 下载二进制文件到指定路径 (支持下载进度回调)
  downloadBinary(targetUrl, destPath, onProgress, timeoutMs = 15000, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        return reject(new Error('Too many redirects'));
      }

      const client = targetUrl.startsWith('https') ? https : http;
      const req = client.get(targetUrl, {
        headers: { 'User-Agent': 'exam-proctor-client-updater' },
        timeout: timeoutMs
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          return resolve(this.downloadBinary(res.headers.location, destPath, onProgress, timeoutMs, maxRedirects - 1));
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP Error ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let receivedBytes = 0;

        const fileStream = fs.createWriteStream(destPath);
        res.on('data', chunk => {
          receivedBytes += chunk.length;
          if (totalBytes > 0 && onProgress) {
            const percent = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
            onProgress(percent);
          }
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => resolve(destPath));
        });

        fileStream.on('error', err => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Download timeout'));
      });

      req.on('error', err => reject(err));
    });
  }

  // 执行完整的远端更新检测与应用
  async checkAndApplyUpdate(statusCallback = () => {}) {
    statusCallback({
      message: '正在检查云端安全策略与更新...',
      percent: -1,
      version: this.localVersion
    });

    const primaryUrl = this.config.versionUrl || 'https://cdn.jsdelivr.net/gh/HAS22520/exam-proctor-client@main/version.json';
    const fallbackUrl = this.config.fallbackVersionUrl || 'https://raw.githubusercontent.com/HAS22520/exam-proctor-client/main/version.json';

    let versionInfo = null;

    // 1. 获取远端 version.json
    try {
      console.log(`[HotUpdater] [INFO] 正在尝试从主源获取版本信息: ${primaryUrl}`);
      const rawJson = await this.fetchUrl(primaryUrl, this.timeoutMs);
      versionInfo = JSON.parse(rawJson);
    } catch (err1) {
      console.warn(`[HotUpdater] [WARN] 主更新源连接失败 (${err1.message})，尝试备用源: ${fallbackUrl}`);
      try {
        const rawJson = await this.fetchUrl(fallbackUrl, this.timeoutMs);
        versionInfo = JSON.parse(rawJson);
      } catch (err2) {
        console.warn(`[HotUpdater] [WARN] 备用源连接失败 (${err2.message})，已切换至本地离线模式`);
        statusCallback({
          message: '已加载本地离线安全环境，准备就绪...',
          percent: 100,
          version: this.localVersion
        });
        return { updated: false, reason: 'OFFLINE_OR_TIMEOUT' };
      }
    }

    if (!versionInfo || !versionInfo.version) {
      return { updated: false, reason: 'INVALID_VERSION_INFO' };
    }

    // 2. 动态更新配置（即使版本号未变更，也能热同步云端黑名单与白名单）
    if (versionInfo.config?.url) {
      this.syncRemoteConfig(versionInfo.config.url).catch(() => {});
    }

    const remoteVer = versionInfo.version;
    console.log(`[HotUpdater] [INFO] 检查完成: 本地版本 v${this.localVersion}, 云端版本 v${remoteVer}`);

    // 3. 比较版本号
    if (this.compareVersions(remoteVer, this.localVersion) > 0) {
      console.log(`[HotUpdater] [UPDATE FOUND] 检测到新版本 v${remoteVer}，准备执行热更新...`);
      statusCallback({
        message: `发现新版本 v${remoteVer}，准备下载更新...`,
        percent: 0,
        version: remoteVer
      });

      const asarUrl = versionInfo.hotUpdate?.asarUrl || versionInfo.hotUpdate?.fallbackUrl;
      if (!asarUrl) {
        console.log('[HotUpdater] [INFO] 远端未提供热更新 asar 地址，跳过热更新');
        return { updated: false, reason: 'NO_ASAR_URL' };
      }

      // 4. 下载 app.asar 热补丁
      const tempAsar = path.join(app.getPath('temp'), `exam_app_${Date.now()}.asar`);
      try {
        console.log(`[HotUpdater] [DOWNLOADING] 正在下载热补丁: ${asarUrl}`);
        await this.downloadBinary(asarUrl, tempAsar, (percent) => {
          statusCallback({
            message: `正在极速下载更新补丁 (${percent}%)...`,
            percent: percent,
            version: remoteVer
          });
        }, 30000);

        // 校验下载的 asar 完整性 (必须大于 10KB)
        const stat = fs.statSync(tempAsar);
        if (stat.size < 10240) {
          throw new Error(`下载的文件尺寸异常 (${stat.size} 字节)`);
        }

        console.log(`[HotUpdater] [SUCCESS] 热更新补丁下载完成 (${stat.size} 字节)，正在应用...`);
        statusCallback({
          message: '热更新补丁已就绪，正在应用并重启客户端...',
          percent: 100,
          version: remoteVer
        });

        // 5. 应用热更新并重启应用
        await this.applyHotPatch(tempAsar);
        return { updated: true, newVersion: remoteVer };
      } catch (dlErr) {
        console.error('[HotUpdater] [ERROR] 热补丁下载或应用失败:', dlErr.message);
        try { fs.unlinkSync(tempAsar); } catch (e) {}
        statusCallback({
          message: '更新下载遇到轻微波动，已使用当前版本启动...',
          percent: 100,
          version: this.localVersion
        });
        return { updated: false, reason: dlErr.message };
      }
    }

    // 已经是最新版本
    statusCallback({
      message: `当前已是最新版本 (v${this.localVersion})，正在进入考场...`,
      percent: 100,
      version: this.localVersion
    });
    return { updated: false, reason: 'ALREADY_LATEST' };
  }

  // 远端配置动态热同步 (保存到用户数据目录供 index.js 优先加载)
  async syncRemoteConfig(configUrl) {
    try {
      const raw = await this.fetchUrl(configUrl, 3000);
      const parsed = JSON.parse(raw);
      if (parsed.exam?.targetUrl) {
        const userCfgDir = path.join(app.getPath('userData'), 'config');
        if (!fs.existsSync(userCfgDir)) fs.mkdirSync(userCfgDir, { recursive: true });
        const userCfgPath = path.join(userCfgDir, 'exam-config.json');
        fs.writeFileSync(userCfgPath, JSON.stringify(parsed, null, 2), 'utf-8');
        console.log('[HotUpdater] [CONFIG] 云端考试配置热同步成功！');
      }
    } catch (e) {}
  }

  // 在 Windows 上通过独立后台进程安全替换 app.asar 并重启
  async applyHotPatch(tempAsarPath) {
    if (!app.isPackaged) {
      console.log('[HotUpdater] [DEV MODE] 当前处于开发模式，已模拟热补丁成功，无需替换文件。');
      await new Promise(r => setTimeout(r, 1200));
      return;
    }

    const targetAsar = path.join(process.resourcesPath, 'app.asar');
    const exePath = process.execPath;
    const procId = process.pid;

    console.log(`[HotUpdater] [RESTART] 启动无缝热更新进程替换: ${targetAsar}`);

    // 生成 Base64 编码的免转义独立 PowerShell 重启脚本
    const psScript = `
      $procId = ${procId}
      $newAsar = '${tempAsarPath.replace(/'/g, "''")}'
      $targetAsar = '${targetAsar.replace(/'/g, "''")}'
      $exePath = '${exePath.replace(/'/g, "''")}'
      
      # 等待原客户端进程退出并释放 app.asar 句柄
      Wait-Process -Id $procId -Timeout 10 -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 400
      
      # 替换 app.asar
      Copy-Item -Path $newAsar -Destination $targetAsar -Force
      Remove-Item -Path $newAsar -Force -ErrorAction SilentlyContinue
      
      # 重新启动客户端
      Start-Process -FilePath $exePath
    `;

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-WindowStyle', 'Hidden',
      '-EncodedCommand', encoded
    ], {
      detached: true,
      stdio: 'ignore'
    });

    child.unref();

    // 留出时间让后台脚本启动，然后主进程退出
    await new Promise(r => setTimeout(r, 300));
    app.exit(0);
  }
}

module.exports = HotUpdater;
