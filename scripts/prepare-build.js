const fs = require('node:fs');
const path = require('node:path');
const { validateConfig } = require('../app/main/config-policy');
const { atomicWrite } = require('../app/main/device-store');
const { buildVersion: validateBuildVersion } = require('../app/main/build-version');
const root = path.resolve(__dirname, '..');
function prepare(env = process.env, buildRoot = root) {
  const raw = JSON.parse(fs.readFileSync(path.join(buildRoot, 'config/exam-config.json'), 'utf8'));
  const parseOrigins = (value, fallback) => value ? JSON.parse(value) : fallback;
  const trust = { keyId: env.PROCTOR_KEY_ID, authPublicKey: env.PROCTOR_AUTH_PUBLIC_KEY,
    logPublicKey: env.PROCTOR_LOG_PUBLIC_KEY, updatePublicKey: env.PROCTOR_UPDATE_PUBLIC_KEY || '',
    allowedOrigins: parseOrigins(env.PROCTOR_ALLOWED_ORIGINS, raw.exam.allowedOrigins),
    updateOrigins: parseOrigins(env.PROCTOR_UPDATE_ORIGINS, raw.updater.allowedOrigins || raw.exam.allowedOrigins) };
  if (env.PROCTOR_TARGET_URL) raw.exam.targetUrl = env.PROCTOR_TARGET_URL;
  if (env.PROCTOR_VERSION_URL) { raw.updater.versionUrl = env.PROCTOR_VERSION_URL; raw.updater.fallbackVersionUrl = env.PROCTOR_VERSION_URL; }
  if (env.PROCTOR_ALLOW_ROOT_DEBUG) {
    if (!['true', 'false'].includes(env.PROCTOR_ALLOW_ROOT_DEBUG)) throw new Error('PROCTOR_ALLOW_ROOT_DEBUG must be true or false');
    raw.debug = { allowRoot: env.PROCTOR_ALLOW_ROOT_DEBUG === 'true' };
  }
  const config = validateConfig(raw, trust);
  const generated = path.join(buildRoot, 'app/generated');
  const normalizedTrust = config.trust; delete config.trust;
  atomicWrite(path.join(generated, 'trust.json'), JSON.stringify(normalizedTrust, null, 2));
  atomicWrite(path.join(generated, 'config.json'), JSON.stringify(config, null, 2));
  const pkg = JSON.parse(fs.readFileSync(path.join(buildRoot, 'package.json'), 'utf8'));
  const version = env.PROCTOR_CLIENT_VERSION || pkg.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('PROCTOR_CLIENT_VERSION must be x.y.z');
  const buildVersion = validateBuildVersion(env.PROCTOR_CLIENT_BUILD_VERSION || pkg.buildVersion);
  const nativeNetworkVersion = 1;
  atomicWrite(path.join(generated, 'build.json'), JSON.stringify({ version, buildVersion, nativeNetworkVersion }));
  return { config, trust: normalizedTrust, version, buildVersion, nativeNetworkVersion };
}
if (require.main === module) {
  try { const result = prepare(); console.log(`Validated proctor build ${result.version}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { prepare };
