const path = require('path');

class NetworkGuard {
  constructor(config, auditLogger = null) {
    this.allowedDomains = config.exam.allowedDomains || ['oj.hntou.fmcf.cc'];
    this.targetUrl = config.exam.targetUrl;
    this.auditLogger = auditLogger;
    this.blockedLogs = [];
  }

  isAllowed(hostname) {
    if (!hostname) return false;
    const cleanHost = hostname.toLowerCase();
    return this.allowedDomains.some(domain => {
      const d = domain.toLowerCase();
      return cleanHost === d || cleanHost.endsWith('.' + d);
    });
  }

  install(mainWindow) {
    const webContents = mainWindow.webContents;
    const targetSession = webContents.session;

    console.log('[NetworkGuard] [INFO] 正在激活客户端白名单拦截器...');
    console.log('[NetworkGuard] [INFO] 严格白名单域名:', this.allowedDomains);

    // 1. 拦截页面跳转事件 (防止页面自身或者通过 location.href 导航到外部域名)
    webContents.on('will-navigate', (event, url) => {
      try {
        const parsed = new URL(url);
        if (!this.isAllowed(parsed.hostname)) {
          event.preventDefault();
          console.warn(`[NetworkGuard] [BLOCKED] 阻止页面导航至非白名单地址: ${url}`);
          if (this.auditLogger) {
            this.auditLogger.logViolation({
              source: 'CLIENT',
              type: 'BLOCKED_NAVIGATE',
              target: url,
              detail: `考生试图在考试窗口内导航至外部网站: ${parsed.hostname}`
            });
          }
        }
      } catch (e) {
        event.preventDefault();
      }
    });

    // 2. 拦截重定向事件
    webContents.on('will-redirect', (event, url) => {
      try {
        const parsed = new URL(url);
        if (!this.isAllowed(parsed.hostname)) {
          event.preventDefault();
          console.warn(`[NetworkGuard] [BLOCKED] 阻止页面重定向至非白名单地址: ${url}`);
          if (this.auditLogger) {
            this.auditLogger.logViolation({
              source: 'CLIENT',
              type: 'BLOCKED_REDIRECT',
              target: url,
              detail: `页面试图重定向至外部网站: ${parsed.hostname}`
            });
          }
        }
      } catch (e) {
        event.preventDefault();
      }
    });

    // 3. 拦截所有的底层网络请求 (包括 API、静态资源等)
    targetSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        const url = new URL(details.url);

        // 放行本地内置协议 (例如 file:// 或 devtools://)
        if (url.protocol === 'file:' || url.protocol === 'devtools:' || url.protocol === 'chrome-extension:') {
          return callback({ cancel: false });
        }

        if (this.isAllowed(url.hostname)) {
          callback({ cancel: false });
        } else {
          console.warn(`[NetworkGuard] [BLOCKED] 拦截非白名单网络请求: ${details.url}`);
          this.blockedLogs.push({
            url: details.url,
            time: new Date().toISOString()
          });

          if (this.auditLogger) {
            this.auditLogger.logViolation({
              source: 'CLIENT',
              type: 'BLOCKED_RESOURCE_REQUEST',
              target: details.url,
              detail: `发起非白名单资源请求 [类型: ${details.resourceType || '未知'}, 方法: ${details.method || 'GET'}]`
            });
          }

          callback({ cancel: true });
        }
      } catch (err) {
        callback({ cancel: true });
      }
    });

    // 4. 拦截任何试图打开新窗口的行为 (如 target="_blank" 或 window.open)
    webContents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url);
        if (this.isAllowed(parsed.hostname)) {
          // 在当前窗口内加载，防止弹窗
          mainWindow.loadURL(url);
          return { action: 'deny' };
        }
      } catch (e) {}

      console.warn(`[NetworkGuard] [BLOCKED] 拦截打开外部窗口尝试: ${url}`);
      if (this.auditLogger) {
        this.auditLogger.logViolation({
          source: 'CLIENT',
          type: 'BLOCKED_WINDOW_OPEN',
          target: url,
          detail: `试图通过新标签页/弹窗打开非白名单外部网站`
        });
      }
      return { action: 'deny' };
    });
  }

  getBlockedLogs() {
    return this.blockedLogs;
  }
}

module.exports = NetworkGuard;
