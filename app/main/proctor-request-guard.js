const { accessTarget, stripProctorHeaders } = require('./proctor-access');
const { proctorErrorMessage } = require('./proctor-auth');

class ProctorRequestGuard {
  constructor(controller, config, webContents, isBlocked = () => false) { Object.assign(this, { controller, config, webContents, isBlocked }); }

  async headers(details) {
    const url = new URL(details.url), origin = url.origin;
    const original = details.requestHeaders;
    const token = Object.entries(original).find(([name]) => name.toLowerCase() === 'x-proctor-token')?.[1];
    const owner = [...this.controller.records.values()].find((record) => record.auth?.session?.token === token && token);
    // Also applies to storage redirects and root-debug navigation to external sites.
    const sameUser = owner && owner.login.uid === this.controller.current?.login.uid;
    // Closing attempts still need their native refresh/finish/upload proofs.
    const protocol = details.method === 'POST' && url.pathname === owner?.context.proctorPath;
    const usable = sameUser && (protocol || !owner.completed && (!owner.journal || owner.journal.state.phase === 'open'));
    let headers = usable && owner.context.origin === origin ? { ...original } : stripProctorHeaders(original);
    if (details.method !== 'GET' || details.webContentsId !== this.webContents.id || !this.config.exam.allowedOrigins.includes(origin)) return headers;
    const target = accessTarget(details.url);
    if (!target) return headers;
    if (this.isBlocked()) {
      this.controller.status('客户端低于更新清单指定的最低版本，请安装新版');
      return stripProctorHeaders(headers);
    }
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    if (names.includes('x-proctor-token') && names.includes('x-proctor-proof')) return headers;
    const sourceUrl = details.resourceType === 'mainFrame' ? target.identityUrl : this.webContents.getURL();
    try {
      headers = { ...stripProctorHeaders(headers), ...await this.controller.headers(sourceUrl,
        { action: target.action, method: 'GET', path: target.path, payload: target.payload }) };
    } catch (error) {
      // The OJ returns a content-free 403 page, including on a deep link/refresh.
      this.controller.trace?.('warn', 'request.authentication-failed', { url: details.url, name: error.name, code: error.code, message: error.message });
      this.controller.status(proctorErrorMessage(error, this.controller.version));
      return stripProctorHeaders(headers);
    }
    return headers;
  }
}

module.exports = ProctorRequestGuard;
