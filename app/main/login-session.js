async function resetLogin(session) {
  // This partition belongs only to the exam client. Preserve local drafts,
  // encrypted journals and OS-protected device identity for offline recovery.
  await session.clearStorageData({ storages: ['cookies', 'serviceworkers', 'cachestorage'] });
  await session.clearAuthCache();
  await session.cookies.flushStore();
}

function observeLogin(session, origins, onChanged) {
  const values = new Map();
  session.cookies.on('changed', (_event, cookie, cause, removed) => {
    if (!['sid', 'sid.sig'].includes(cookie.name)) return;
    const domain = cookie.domain.replace(/^\./, '');
    if (!origins.some((origin) => { const host = new URL(origin).hostname; return host === domain || host.endsWith(`.${domain}`); })) return;
    if (removed && cause === 'overwrite') return;
    const key = `${cookie.domain}:${cookie.path}:${cookie.name}`;
    const previous = values.get(key), next = removed ? null : cookie.value;
    if (previous === next) return;
    values.set(key, next); onChanged();
  });
}

module.exports = { resetLogin, observeLogin };
