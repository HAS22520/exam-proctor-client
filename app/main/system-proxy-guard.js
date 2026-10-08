const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

class SystemProxyGuard {
  constructor(config, auditLogger = null) {
    this.allowedDomains = config.exam.allowedDomains || ['oj.hntou.fmcf.cc'];
    this.port = config.systemNetworkLock?.proxyPort || 18899;
    this.auditLogger = auditLogger;
    this.server = null;
    this.isActive = false;
    this.notifyScript = path.resolve(__dirname, '../../scripts/notify-wininet.ps1');
  }

  isDomainAllowed(hostname) {
    if (!hostname) return false;
    const cleanHost = hostname.toLowerCase().split(':')[0];
    return this.allowedDomains.some(domain => {
      const d = domain.toLowerCase();
      return cleanHost === d || cleanHost.endsWith('.' + d);
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      // 1. 创建本地白名单代理服务
      this.server = http.createServer((req, res) => {
        // 普通 HTTP 请求检查
        const host = req.headers.host;
        if (this.isDomainAllowed(host)) {
          // 白名单请求：转发
          const options = {
            hostname: host.split(':')[0],
            port: host.split(':')[1] || 80,
            path: req.url,
            method: req.method,
            headers: req.headers
          };
          const proxyReq = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          });
          req.pipe(proxyReq);
          proxyReq.on('error', () => {
            res.writeHead(502);
            res.end('[ExamGuard] Bad Gateway');
          });
        } else {
          console.warn(`[SystemGuard] [BLOCKED] 阻止整机访问外网: ${host}`);
          if (this.auditLogger) {
            this.auditLogger.logViolation({
              source: 'SYSTEM_PROXY',
              type: 'BLOCKED_EXTERNAL_HTTP',
              target: `http://${host}${req.url}`,
              detail: `本机应用试图访问外部 HTTP 网址 (方法: ${req.method})`
            });
          }
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('[ExamGuard] 考试期间禁止访问该网站，仅允许访问考试网站！');
        }
      });

      // 2. HTTPS 隧道 (CONNECT 请求) 拦截
      this.server.on('connect', (req, clientSocket, head) => {
        const [host, port] = req.url.split(':');
        if (!this.isDomainAllowed(host)) {
          console.warn(`[SystemGuard] [BLOCKED] 阻止整机访问外网 HTTPS: ${host}`);
          if (this.auditLogger) {
            this.auditLogger.logViolation({
              source: 'SYSTEM_PROXY',
              type: 'BLOCKED_EXTERNAL_HTTPS',
              target: `https://${host}`,
              detail: `本机外部应用 (如 Edge/Chrome/通讯软件) 试图建立外网 HTTPS 隧道`
            });
          }
          clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          clientSocket.destroy();
          return;
        }

        // 白名单域名：建立正向代理隧道
        const targetSocket = net.connect(port || 443, host, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length > 0) targetSocket.write(head);
          clientSocket.pipe(targetSocket);
          targetSocket.pipe(clientSocket);
        });

        targetSocket.on('error', () => {
          clientSocket.destroy();
        });
        clientSocket.on('error', () => {
          targetSocket.destroy();
        });
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        console.log(`[SystemGuard] [INFO] 本地白名单代理服务已启动 (127.0.0.1:${this.port})`);
        this.enableSystemProxy();
        this.isActive = true;
        resolve();
      });

      this.server.on('error', (err) => {
        console.error('[SystemGuard] [ERROR] 代理服务器启动失败:', err);
        reject(err);
      });
    });
  }

  enableSystemProxy() {
    if (process.platform !== 'win32') return;
    try {
      execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`, { stdio: 'ignore' });
      execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:${this.port}" /f`, { stdio: 'ignore' });
      if (fs.existsSync(this.notifyScript)) {
        execSync(`powershell -ExecutionPolicy Bypass -File "${this.notifyScript}"`, { stdio: 'ignore' });
      }
      console.log('[SystemGuard] [INFO] 已开启 Windows 全局白名单网络拦截并刷新生效');
    } catch (e) {
      console.error('[SystemGuard] [ERROR] 设置系统代理失败:', e.message);
    }
  }

  disableSystemProxy() {
    if (process.platform !== 'win32') return;
    try {
      execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`, { stdio: 'ignore' });
      if (fs.existsSync(this.notifyScript)) {
        execSync(`powershell -ExecutionPolicy Bypass -File "${this.notifyScript}"`, { stdio: 'ignore' });
      }
      console.log('[SystemGuard] [INFO] 已关闭 Windows 系统代理并刷新 WinINet 缓存，网络恢复正常');
    } catch (e) {
      console.error('[SystemGuard] [ERROR] 恢复系统代理失败:', e.message);
    }
  }

  stop() {
    if (!this.isActive) return;
    this.disableSystemProxy();
    if (this.server) {
      try {
        this.server.close();
      } catch (e) {}
      this.server = null;
    }
    this.isActive = false;
  }
}

module.exports = SystemProxyGuard;
