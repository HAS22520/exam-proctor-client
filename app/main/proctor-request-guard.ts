import type { ClientConfig } from './contracts';
import proctorControllerModule = require('./proctor-controller');
import proctorAccessModule = require('./proctor-access');
const { accessTarget, stripProctorHeaders } = proctorAccessModule;
import proctorAuthModule = require('./proctor-auth');
const { proctorErrorMessage } = proctorAuthModule;

class ProctorRequestGuard {
  declare controller: InstanceType<typeof proctorControllerModule.ProctorController>;
  declare config: { exam: Pick<ClientConfig['exam'], 'allowedOrigins'> };
  declare webContents: Pick<Electron.WebContents, 'id'> & Partial<Pick<Electron.WebContents, 'getURL'>>;
  declare isBlocked: () => boolean;

  constructor(
    controller: ProctorRequestGuard['controller'],
    config: ProctorRequestGuard['config'],
    webContents: ProctorRequestGuard['webContents'],
    isBlocked: () => boolean = () => false,
  ) {
    Object.assign(this, { controller, config, webContents, isBlocked });
  }

  async headers(
    details: Pick<Electron.OnBeforeSendHeadersListenerDetails, 'url' | 'method' | 'requestHeaders'> &
      Partial<Pick<Electron.OnBeforeSendHeadersListenerDetails, 'webContentsId' | 'resourceType'>>,
  ) {
    const url = new URL(details.url),
      origin = url.origin;
    const original = details.requestHeaders;
    const token = Object.entries(original).find(([name]) => name.toLowerCase() === 'x-proctor-token')?.[1];
    const owner = [...this.controller.records.values()].find(
      (record) => record.auth?.session?.token === token && token,
    );
    // Also applies to storage redirects and root-debug navigation to external sites.
    const sameUser = owner && owner.login.uid === this.controller.current?.login.uid;
    // Closing attempts still need their native refresh/finish/upload proofs.
    const protocol = details.method === 'POST' && url.pathname === owner?.context.proctorPath;
    const usable =
      sameUser &&
      (protocol ||
        (!this.controller.authenticationError &&
          !owner.completed &&
          (!owner.journal || owner.journal.state.phase === 'open')));
    let headers = usable && owner.context.origin === origin ? { ...original } : stripProctorHeaders(original);
    if (
      details.method !== 'GET' ||
      details.webContentsId !== this.webContents.id ||
      !this.config.exam.allowedOrigins.includes(origin)
    )
      return headers;
    const target = accessTarget(details.url);
    if (!target) return headers;
    if (this.isBlocked()) {
      this.controller.status('客户端低于更新清单指定的最低版本，请安装新版');
      return stripProctorHeaders(headers);
    }
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    if (names.includes('x-proctor-token') && names.includes('x-proctor-proof')) return headers;
    const sourceUrl = details.resourceType === 'mainFrame' ? target.identityUrl : this.webContents.getURL();
    const epoch = this.controller.identityEpoch;
    try {
      headers = {
        ...stripProctorHeaders(headers),
        ...(await this.controller.headers(sourceUrl, {
          action: target.action,
          method: 'GET',
          path: target.path,
          payload: target.payload,
        })),
      };
    } catch (error) {
      // The OJ returns a content-free 403 page, including on a deep link/refresh.
      this.controller.trace?.('warn', 'request.authentication-failed', {
        url: details.url,
        name: error.name,
        code: error.code,
        message: error.message,
      });
      if (epoch === this.controller.identityEpoch)
        this.controller.status(proctorErrorMessage(error, this.controller.version));
      return stripProctorHeaders(headers);
    }
    return headers;
  }
}

export = ProctorRequestGuard;
