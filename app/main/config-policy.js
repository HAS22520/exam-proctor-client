const { validateTrust } = require('./proctor-crypto');

function secureUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)
    || (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Remote addresses require HTTPS (HTTP is allowed only on localhost)');
  }
  return url;
}

function origins(values) {
  if (!Array.isArray(values) || !values.length || values.length > 100) throw new Error('Configure allowed remote origins');
  return [...new Set(values.map((value) => {
    const url = secureUrl(value);
    if (url.pathname !== '/' || url.search || url.hash) throw new Error('Allowed addresses must be origins, without paths');
    return url.origin;
  }))];
}

function validateConfig(raw, buildTrust) {
  const trust = validateTrust(buildTrust);
  const allowed = origins(trust.allowedOrigins);
  const target = secureUrl(raw?.exam?.targetUrl);
  if (!allowed.includes(target.origin)) throw new Error('Exam origin is outside the build allowlist');
  const updateOrigins = origins(trust.updateOrigins || allowed);
  const updater = { ...raw.updater };
  for (const key of ['versionUrl', 'fallbackVersionUrl']) {
    if (updater[key] && !updateOrigins.includes(secureUrl(updater[key]).origin)) throw new Error('Untrusted update origin');
  }
  return { ...raw, exam: { ...raw.exam, allowedOrigins: allowed, allowedDomains: allowed.map((value) => new URL(value).hostname) },
    updater: { ...updater, allowedOrigins: updateOrigins, signingPublicKey: trust.updatePublicKey || '' },
    debug: { allowRoot: raw.debug?.allowRoot === true }, trust };
}

function contextFromUrl(value) {
  const url = secureUrl(value);
  const prefix = url.pathname.match(/^\/d\/([^/]+)(?=\/|$)/)?.[0] || '';
  const path = url.pathname.slice(prefix.length);
  const tid = path.match(/^\/contest\/([a-f0-9]{24})(?:\/|$)/)?.[1] || url.searchParams.get('tid') || '';
  const problem = path.match(/^\/p\/([^/]+)(?:\/submit)?$/)?.[1] || '';
  if (tid && !/^[a-f0-9]{24}$/.test(tid)) throw new Error('Invalid contest ID');
  return { origin: url.origin, prefix, tid, problem: decodeURIComponent(problem), identityPath: `${prefix}/proctor/identity`,
    proctorPath: tid ? `${prefix}/contest/${tid}/proctor` : '', submitPath: problem ? `${prefix}/p/${problem}/submit` : '' };
}

module.exports = { secureUrl, origins, validateConfig, contextFromUrl };
