class NetworkGuard {
  constructor(config, auditLogger = null) {
    this.allowedOrigins = config.exam.allowedOrigins;
    this.auditLogger = auditLogger;
    this.debug = false;
  }

  isAllowed(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'blob:') return this.debug || this.allowedOrigins.includes(url.origin);
      if (url.protocol === 'data:') return true;
      if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol)) return false;
      if (url.protocol === 'wss:') url.protocol = 'https:';
      if (url.protocol === 'ws:') url.protocol = 'http:';
      return this.debug || this.allowedOrigins.includes(url.origin);
    } catch { return false; }
  }

  blocked(type, url) { this.auditLogger?.logViolation({ source: 'CLIENT', type, target: url, detail: '' }); }

  install(mainWindow) {
    const contents = mainWindow.webContents;
    for (const eventName of ['will-navigate', 'will-redirect']) {
      contents.on(eventName, (event, url) => {
        if (!this.isAllowed(url) || ['data:', 'blob:'].includes(new URL(url).protocol)) {
          event.preventDefault();
          this.blocked('BLOCKED_NAVIGATION', url);
        }
      });
    }
    contents.session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = this.isAllowed(details.url);
      if (!allowed) this.blocked('BLOCKED_RESOURCE_REQUEST', details.url);
      callback({ cancel: !allowed });
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (this.isAllowed(url) && /^https?:/.test(url)) mainWindow.loadURL(url);
      else this.blocked('BLOCKED_WINDOW_OPEN', url);
      return { action: 'deny' };
    });
  }
}

module.exports = NetworkGuard;
