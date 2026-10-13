async function resetLogin(session: Pick<Electron.Session, 'clearStorageData' | 'clearAuthCache' | 'cookies'>) {
  // 此分区只属于监考客户端；保留本地草稿、
  // 加密日志和受系统保护的设备身份，以便离线恢复。
  await session.clearStorageData({ storages: ['cookies', 'serviceworkers', 'cachestorage'] });
  await session.clearAuthCache();
  await session.cookies.flushStore();
}

function observeLogin(session: Pick<Electron.Session, 'cookies'>, origins: string[], onChanged: () => void) {
  const values = new Map();
  session.cookies.on('changed', (_event, cookie, cause, removed) => {
    if (!['sid', 'sid.sig'].includes(cookie.name)) return;
    const domain = cookie.domain.replace(/^\./, '');
    if (
      !origins.some((origin) => {
        const host = new URL(origin).hostname;
        return host === domain || host.endsWith(`.${domain}`);
      })
    )
      return;
    if (removed && cause === 'overwrite') return;
    const key = `${cookie.domain}:${cookie.path}:${cookie.name}`;
    const previous = values.get(key),
      next = removed ? null : cookie.value;
    if (previous === next) return;
    values.set(key, next);
    onChanged();
  });
}

export { resetLogin, observeLogin };
