import type { ClientConfig, RouteContext, Trust } from '../contracts';
import { validateTrust } from '../proctor/proctor-crypto';

function secureUrl(value: string) {
    const url = new URL(value);
    if (
        url.username
        || url.password
        || !['https:', 'http:'].includes(url.protocol)
        || (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    ) {
        throw new Error('远端地址必须使用 HTTPS，只有本机回环地址允许 HTTP');
    }
    return url;
}

function origins(values: string[]) {
    if (!Array.isArray(values) || !values.length || values.length > 100) {
        throw new Error('请配置允许访问的远端来源');
    }
    return [
        ...new Set(
            values.map((value) => {
                const url = secureUrl(value);
                if (url.pathname !== '/' || url.search || url.hash) {
                    throw new Error('允许地址必须是完整来源，不能包含路径');
                }
                return url.origin;
            }),
        ),
    ];
}

function validateConfig(
    raw: Omit<ClientConfig, 'exam'> & {
        exam: Omit<ClientConfig['exam'], 'allowedOrigins'> & { allowedOrigins?: string[] };
    },
    buildTrust: Trust,
): ClientConfig & { trust: Trust } {
    const trust = validateTrust(buildTrust);
    const allowed = origins(trust.allowedOrigins);
    const target = secureUrl(raw?.exam?.targetUrl);
    if (!allowed.includes(target.origin)) throw new Error('考试地址不在编译时白名单内');
    const updateOrigins = origins(trust.updateOrigins || allowed);
    const updater = { ...raw.updater };
    for (const key of ['versionUrl', 'fallbackVersionUrl'] as const) {
        if (updater[key] && !updateOrigins.includes(secureUrl(updater[key]).origin)) {
            throw new Error('更新地址不在信任范围内');
        }
    }
    if (raw.antiCheat?.processBlacklistHashes !== undefined
        && (!Array.isArray(raw.antiCheat.processBlacklistHashes)
            || raw.antiCheat.processBlacklistHashes.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))) {
        throw new Error('进程黑名单哈希必须为 SHA-256 小写十六进制数组');
    }
    return {
        ...raw,
        exam: { ...raw.exam, allowedOrigins: allowed, allowedDomains: allowed.map((value) => new URL(value).hostname) },
        updater: { ...updater, allowedOrigins: updateOrigins, signingPublicKey: trust.updatePublicKey || '' },
        debug: { allowRoot: raw.debug?.allowRoot === true },
        trust,
    };
}

function contextFromUrl(value: string): RouteContext {
    const url = secureUrl(value);
    const prefix = url.pathname.match(/^\/d\/([^/]+)(?=\/|$)/)?.[0] || '';
    const path = url.pathname.slice(prefix.length);
    const tid = path.match(/^\/contest\/([a-f0-9]{24})(?:\/|$)/)?.[1] || url.searchParams.get('tid') || '';
    const problem = path.match(/^\/p\/([^/]+)(?:\/submit)?$/)?.[1] || '';
    if (tid && !/^[a-f0-9]{24}$/.test(tid)) throw new Error('比赛编号无效');
    return {
        origin: url.origin,
        prefix,
        tid,
        problem: decodeURIComponent(problem),
        identityPath: `${prefix}/proctor/identity`,
        proctorPath: tid ? `${prefix}/contest/${tid}/proctor` : '',
        submitPath: problem ? `${prefix}/p/${problem}/submit` : '',
    };
}

export { contextFromUrl, origins, secureUrl, validateConfig };
