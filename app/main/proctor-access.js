const { secureUrl } = require('./config-policy');

function accessTarget(value) {
  const url = secureUrl(value);
  const prefix = url.pathname.match(/^\/d\/[^/]+(?=\/|$)/)?.[0] || '';
  const pathname = url.pathname.slice(prefix.length);
  const problem = pathname.match(/^\/p\/([^/]+)(?:\/submit|\/file\/.+)?$/);
  if (problem) {
    const tids = url.searchParams.getAll('tid');
    if (tids.length !== 1 || !/^[a-f0-9]{24}$/i.test(tids[0])) return null;
    let pid;
    try { pid = decodeURIComponent(problem[1]); } catch { return null; }
    if (!pid || pid.length > 128 || /[\x00-\x20/\\?#]/.test(pid) || ['.', '..'].includes(pid)) return null;
    const displayPid = Number.isSafeInteger(+pid) ? String(+pid) : pid;
    const tid = tids[0].toLowerCase();
    return { origin: url.origin, prefix, identityUrl: `${url.origin}${prefix}/p/${encodeURIComponent(pid)}?tid=${tid}`,
      action: 'problem_view', method: 'GET', path: url.pathname, payload: { tid, pid: displayPid } };
  }
  const contest = pathname.match(/^\/contest\/([a-f0-9]{24})\/(?:problems|print|api\/printing\/team|file\/private\/.+)$/i);
  if (!contest) return null;
  const tid = contest[1].toLowerCase();
  return { origin: url.origin, prefix, identityUrl: `${url.origin}${prefix}/contest/${tid}`,
    action: 'contest_view', method: 'GET', path: url.pathname, payload: { tid } };
}

function accessRequest(request, source) {
  if (!['problem_view', 'contest_view'].includes(request?.action) || request.method !== 'GET'
    || typeof request.path !== 'string' || !request.path.startsWith('/') || request.path.startsWith('//')
    || !request.payload || !/^[a-f0-9]{24}$/.test(request.payload.tid || '')) throw new Error('Invalid proctor access request');
  const url = new URL(request.path, source.origin);
  if (url.pathname !== request.path || url.search || url.hash || url.origin !== source.origin) throw new Error('Invalid proctor access path');
  if (request.action === 'problem_view') url.searchParams.set('tid', request.payload.tid);
  const target = accessTarget(url.href);
  if (!target || target.action !== request.action || target.prefix !== source.prefix
    || (source.tid && source.tid !== target.payload.tid)
    || Object.keys(request.payload).sort().join(',') !== Object.keys(target.payload).sort().join(',')
    || Object.entries(target.payload).some(([key, value]) => request.payload[key] !== value)) throw new Error('Proctor access is outside the current domain/contest');
  return target;
}

function stripProctorHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !['x-proctor-token', 'x-proctor-proof'].includes(key.toLowerCase())));
}

module.exports = { accessTarget, accessRequest, stripProctorHeaders };
