import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWrite } from '../app/main/audit/device-store';
import { validateConfig } from '../app/main/security/config-policy';
import { buildVersion as validateBuildVersion } from '../app/main/updates/build-version';
import { validateProductName } from '../app/shared/branding';
import { applicationRoot, projectRoot } from './project-layout';

const root = projectRoot;
function prepare(env = process.env, buildRoot = root) {
    const raw = JSON.parse(fs.readFileSync(path.join(buildRoot, 'config/exam-config.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(buildRoot, 'package.json'), 'utf8'));
    const productName = validateProductName(env.PROCTOR_PRODUCT_NAME ?? pkg.build?.productName);
    raw.exam.title = productName;
    const parseOrigins = (value: string | undefined, fallback: string[]) => (value ? JSON.parse(value) : fallback);
    const trust = {
        keyId: env.PROCTOR_KEY_ID,
        authPublicKey: env.PROCTOR_AUTH_PUBLIC_KEY,
        logPublicKey: env.PROCTOR_LOG_PUBLIC_KEY,
        updatePublicKey: env.PROCTOR_UPDATE_PUBLIC_KEY || '',
        allowedOrigins: parseOrigins(env.PROCTOR_ALLOWED_ORIGINS, raw.exam.allowedOrigins),
        updateOrigins: parseOrigins(env.PROCTOR_UPDATE_ORIGINS, raw.updater.allowedOrigins || raw.exam.allowedOrigins),
    };
    if (env.PROCTOR_TARGET_URL) raw.exam.targetUrl = env.PROCTOR_TARGET_URL;
    if (env.PROCTOR_VERSION_URL) {
        raw.updater.versionUrl = env.PROCTOR_VERSION_URL;
        raw.updater.fallbackVersionUrl = env.PROCTOR_VERSION_URL;
    }
    if (env.PROCTOR_ALLOW_ROOT_DEBUG) {
        if (!['true', 'false'].includes(env.PROCTOR_ALLOW_ROOT_DEBUG)) {
            throw new Error('PROCTOR_ALLOW_ROOT_DEBUG 必须为 true 或 false');
        }
        raw.debug = { allowRoot: env.PROCTOR_ALLOW_ROOT_DEBUG === 'true' };
    }
    const config = validateConfig(raw, trust);
    const generated = path.join(applicationRoot(buildRoot), 'app/generated');
    const normalizedTrust = config.trust;
    delete config.trust;
    atomicWrite(path.join(generated, 'trust.json'), JSON.stringify(normalizedTrust, null, 2));
    atomicWrite(path.join(generated, 'config.json'), JSON.stringify(config, null, 2));
    const version = env.PROCTOR_CLIENT_VERSION || pkg.version;
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('PROCTOR_CLIENT_VERSION 必须为 x.y.z 格式');
    const buildVersion = validateBuildVersion(env.PROCTOR_CLIENT_BUILD_VERSION || pkg.buildVersion);
    const nativeNetworkVersion = 1;
    atomicWrite(path.join(generated, 'build.json'), JSON.stringify({ version, buildVersion, nativeNetworkVersion, productName }));
    // 本地页面只读取公开展示名称，脚本与页面一起签名打包，不开放额外文件读取 IPC。
    atomicWrite(path.join(applicationRoot(buildRoot), 'app/renderer/assets/brand.js'), `window.hydroClientName = ${JSON.stringify(productName)};\n`);
    return { config, trust: normalizedTrust, version, buildVersion, nativeNetworkVersion, productName };
}
if (require.main === module) {
    try {
        const result = prepare();
        console.log(`监考客户端构建配置已通过校验：${result.version}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
export { prepare };
