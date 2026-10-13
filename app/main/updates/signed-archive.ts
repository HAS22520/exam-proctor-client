import * as crypto from 'node:crypto';
import { DEFAULT_PRODUCT_NAME, validateProductName } from '../../shared/branding';
import type { UpdateAnchor, UpdatePackage } from '../contracts';
import { canonical, verify } from '../proctor/proctor-crypto';
import { archiveFs as fs } from './archive-filesystem';
import { buildVersion } from './build-version';

interface AsarEntry {
    link?: string;
    unpacked?: boolean;
    files?: Record<string, AsarEntry>;
    size?: number;
    offset?: string;
}

// Electron 的 fs 会自动挂载 ASAR；original-fs 用于读取实际文件字节。

const MAX_ARCHIVE = 240 * 1024 * 1024;
const ENTRY = 'app/main/index.js';
async function hashFile(filename: string, options: { start?: number, end?: number } = {}) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename, options)) hash.update(chunk);
    return hash.digest('hex');
}
function readArchive(filename: string) {
    const size = fs.statSync(filename).size;
    if (size < 16 || size > MAX_ARCHIVE) throw new Error('ASAR 大小无效');
    const fd = fs.openSync(filename, 'r');
    try {
        const headerPrefix = Buffer.alloc(16);
        if (fs.readSync(fd, headerPrefix, 0, 16, 0) !== 16 || headerPrefix.readUInt32LE(0) !== 4) throw new Error('ASAR 头无效');
        const headerSize = headerPrefix.readUInt32LE(4);
        const jsonSize = headerPrefix.readUInt32LE(12);
        if (
            headerSize < 8
            || headerSize > 4 * 1024 * 1024
            || jsonSize < 2
            || jsonSize > headerSize - 8
            || headerPrefix.readUInt32LE(8) !== headerSize - 4
            || 8 + headerSize > size
        ) {
            throw new Error('ASAR 头超限');
        }
        const buffer = Buffer.alloc(jsonSize);
        if (fs.readSync(fd, buffer, 0, jsonSize, 16) !== jsonSize) throw new Error('ASAR 头不完整');
        const header = JSON.parse(buffer.toString('utf8'));
        const files = new Map<string, { size: number, start: number }>();
        function walk(
            node: {
                files?: Record<
                    string,
                    { link?: string, unpacked?: boolean, files?: Record<string, AsarEntry>, size?: number, offset?: string }
                >;
            },
            prefix = '',
            depth = 0,
        ) {
            if (depth > 24 || !node?.files || typeof node.files !== 'object' || Array.isArray(node.files)) {
                throw new Error('ASAR 目录无效');
            }
            for (const [name, entry] of Object.entries(node.files)) {
                if (
                    !name
                    || name === '.'
                    || name === '..'
                    || /[\\/:\0]/.test(name)
                    || /[. ]$/.test(name)
                    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
                ) {
                    throw new Error('ASAR 路径无效');
                }
                if (entry.link || entry.unpacked) throw new Error('热更新不支持链接或 unpacked 文件');
                const relative = prefix + name;
                if (entry.files) walk(entry, `${relative}/`, depth + 1);
                else {
                    if (
                        files.size >= 10000
                        || !Number.isSafeInteger(entry.size)
                        || entry.size < 0
                        || typeof entry.offset !== 'string'
                        || !/^\d+$/.test(entry.offset)
                        || !Number.isSafeInteger(Number(entry.offset))
                    ) {
                        throw new Error('ASAR 文件信息无效');
                    }
                    const start = 8 + headerSize + Number(entry.offset);
                    if (start + entry.size > size || /\.node$/i.test(relative)) throw new Error('ASAR 文件越界或包含原生模块');
                    files.set(relative, { size: entry.size, start });
                }
            }
        }
        walk(header);
        // Electron 和 Windows 可能忽略文件名大小写，因此拒绝大小写冲突。
        if (new Set([...files.keys()].map((name) => name.toLowerCase())).size !== files.size) {
            throw new Error('ASAR 路径大小写冲突');
        }
        const json = (name: string) => {
            const file = files.get(name);
            if (!file || file.size > 1024 * 1024) throw new Error(`ASAR 缺少元数据 ${name}`);
            const bytes = Buffer.alloc(file.size);
            if (fs.readSync(fd, bytes, 0, file.size, file.start) !== file.size) throw new Error('ASAR 文件不完整');
            return JSON.parse(bytes.toString('utf8'));
        };
        // 文件句柄打开时先读取少量元数据，再关闭句柄并异步计算哈希。
        return {
            files,
            release: files.has('release.json') ? json('release.json') : null,
            pkg: json('package.json'),
            identity: json('app/generated/build.json'),
            trust: json('app/generated/trust.json'),
            config: json('app/generated/config.json'),
        };
    } finally {
        fs.closeSync(fd);
    }
}
async function verifyArchive(filename: string, expected: UpdatePackage, anchor: UpdateAnchor) {
    if (
        !Number.isSafeInteger(expected.size)
        || expected.size < 1
        || expected.size > MAX_ARCHIVE
        || !/^[a-f0-9]{64}$/.test(expected.sha256 || '')
        || fs.statSync(filename).size !== expected.size
        || (await hashFile(filename)) !== expected.sha256
    ) {
        throw new Error('ASAR 文件校验失败');
    }
    buildVersion(expected.buildVersion);
    const archive = readArchive(filename);
    const payload = archive.release?.payload;
    if (!anchor.trust.updatePublicKey || !payload || !verify(payload, archive.release.signature, anchor.trust.updatePublicKey)) {
        throw new Error('ASAR 缺少有效的发布签名');
    }
    if (
        payload.action !== 'hydro-proctor-update/2'
        || payload.version !== expected.version
        || payload.buildVersion !== expected.buildVersion
        || payload.entry !== ENTRY
        || payload.electronVersion !== anchor.electronVersion
    ) {
        throw new Error('ASAR 版本、构建编号或 Electron 运行时不匹配，需要完整安装包');
    }
    if (payload.nativeNetworkVersion !== 1 || anchor.identity.nativeNetworkVersion !== 1) {
        throw new Error('ASAR 与已安装的系统网络组件不兼容，请先安装新版完整安装包');
    }
    if (!Array.isArray(payload.files) || payload.files.length !== archive.files.size - 1) {
        throw new Error('ASAR 签名文件列表不完整');
    }
    const seen = new Set();
    for await (const file of payload.files) {
        const entry = archive.files.get(file.path);
        if (
            file.path === 'release.json'
            || !entry
            || seen.has(file.path)
            || entry.size !== file.size
            || !/^[a-f0-9]{64}$/.test(file.sha256 || '')
        ) {
            throw new Error('ASAR 签名文件信息无效');
        }
        seen.add(file.path);
        const hash = entry.size
            ? await hashFile(filename, { start: entry.start, end: entry.start + entry.size - 1 })
            : crypto.createHash('sha256').digest('hex');
        if (hash !== file.sha256) throw new Error(`ASAR 文件签名校验失败：${file.path}`);
    }
    const name = validateProductName(archive.identity.productName ?? DEFAULT_PRODUCT_NAME);
    if (name !== (anchor.identity.productName || DEFAULT_PRODUCT_NAME)) {
        throw new Error('ASAR 软件名称与已安装客户端不一致，请使用完整安装包更名');
    }
    const expectedIdentity = {
        version: expected.version,
        buildVersion: expected.buildVersion,
        nativeNetworkVersion: 1,
        ...(archive.identity.productName === undefined ? {} : { productName: name }),
    };
    if (
        !seen.has(ENTRY)
        || archive.pkg.version !== expected.version
        || archive.pkg.buildVersion !== expected.buildVersion
        || canonical(archive.identity) !== canonical(expectedIdentity)
        || (archive.pkg.dependencies && Object.keys(archive.pkg.dependencies).length)
    ) {
        throw new Error('ASAR 应用身份无效');
    }
    if (
        canonical(archive.trust) !== canonical(anchor.trust)
        || canonical(archive.config.exam.allowedOrigins) !== canonical(anchor.config.exam.allowedOrigins)
        || canonical(archive.config.updater.allowedOrigins) !== canonical(anchor.config.updater.allowedOrigins)
        || canonical(archive.config.debug) !== canonical(anchor.config.debug)
    ) {
        throw new Error('ASAR 不能更换信任密钥、白名单或调试权限，请使用完整安装包');
    }
    return payload;
}
export { ENTRY, hashFile, readArchive, verifyArchive };
