import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sign, verify } from '../app/main/proctor/proctor-crypto';
import { ENTRY } from '../app/main/updates/signed-archive';
import { buildEnvironment } from './build';
import { prepare } from './prepare-build';
import { applicationRoot, includeApplicationFile, projectRoot, runtimePackage } from './project-layout';

const help = `用法：npm run release:hot -- [--config FILE] [--sign-key FILE] [--help]

--config FILE   读取构建 JSON，公钥路径相对于配置文件。
--sign-key FILE 传入 Ed25519 更新签名私钥，例如 update-private.pem；私钥不进入客户端。
--help          显示帮助，无需密钥。

PROCTOR_* 环境变量优先于 JSON 配置。
产物：updates/app-<version>-<buildVersion>.asar 及对应 JSON。
签名归档仅供内置相同更新公钥的客户端使用。
更换 Electron、原生组件或信任配置时，需要发布完整安装包。`;
function readSigningKey(pem: string) {
    if (/-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(pem)) {
        throw new Error(
            '--sign-key / PROCTOR_UPDATE_PRIVATE_KEY 需要更新签名私钥（update-private.pem），你传入了公钥。update-public.pem 应用于 build 配置的 updatePublicKeyFile。',
        );
    }
    let key;
    try {
        key = crypto.createPrivateKey(pem);
    } catch {
        throw new Error(
            '无法读取更新签名私钥：请提供完整、未加密的 Ed25519 PKCS#8 PEM（BEGIN PRIVATE KEY），不要传入公钥。',
        );
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('更新签名私钥必须是 Ed25519，不能使用日志解密的 RSA 私钥。');
    return key;
}
async function buildArchive(env = process.env, root = projectRoot) {
    // 先校验，再生成配置、暂存源码或创建发布文件。
    const key = env.PROCTOR_UPDATE_PRIVATE_KEY ? readSigningKey(env.PROCTOR_UPDATE_PRIVATE_KEY) : null;
    const { version, buildVersion, trust, nativeNetworkVersion } = prepare(env, root);
    if (env.PROCTOR_REQUIRE_SIGNED_UPDATE === 'true' && !env.PROCTOR_UPDATE_PRIVATE_KEY) {
        throw new Error('签名 ASAR 需要设置 PROCTOR_UPDATE_PRIVATE_KEY');
    }
    if (env.PROCTOR_UPDATE_PRIVATE_KEY && !trust.updatePublicKey) {
        throw new Error('签名 ASAR 需要设置独立的 PROCTOR_UPDATE_PUBLIC_KEY');
    }
    const asar = require('@electron/asar');
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hydro-proctor-asar-'));
    const output = path.join(root, 'updates');
    fs.mkdirSync(output, { recursive: true });
    try {
        fs.cpSync(path.join(applicationRoot(root), 'app'), path.join(staging, 'app'), {
            recursive: true,
            filter: (source) => includeApplicationFile(source, path.join(applicationRoot(root), 'app')),
        });
        const original = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        fs.writeFileSync(
            path.join(staging, 'package.json'),
            JSON.stringify({ name: original.name, version, buildVersion, main: runtimePackage(original).main }),
        );
        const filename = path.join(output, `app-${version}-${buildVersion}.asar`);
        if (env.PROCTOR_UPDATE_PRIVATE_KEY) {
            const files: { path: string, size: number, sha256: string }[] = [];
            function collect(directory: string, prefix = '') {
                for (const name of fs.readdirSync(directory).sort()) {
                    const source = path.join(directory, name);
                    const relative = prefix + name;
                    const stat = fs.lstatSync(source);
                    if (stat.isSymbolicLink()) throw new Error('ASAR 不支持符号链接');
                    if (stat.isDirectory()) collect(source, `${relative}/`);
                    else {
                        files.push({
                            path: relative,
                            size: stat.size,
                            sha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
                        });
                    }
                }
            }
            collect(staging);
            const payload = {
                action: 'hydro-proctor-update/2',
                version,
                buildVersion,
                entry: ENTRY,
                electronVersion: original.devDependencies?.electron || '',
                nativeNetworkVersion,
                files,
            };
            const signature = sign(payload, key);
            if (!verify(payload, signature, trust.updatePublicKey)) {
                throw new Error('更新签名私钥与内置公钥不匹配');
            }
            fs.writeFileSync(path.join(staging, 'release.json'), JSON.stringify({ payload, signature }));
        }
        await asar.createPackage(staging, filename);
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
        const metadata = {
            version,
            buildVersion,
            signed: !!env.PROCTOR_UPDATE_PRIVATE_KEY,
            size: fs.statSync(filename).size,
            sha256: hash.digest('hex'),
        };
        fs.writeFileSync(path.join(output, `app-${version}-${buildVersion}.json`), JSON.stringify(metadata, null, 2));
        return { filename, ...metadata };
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}
async function run(
    args = process.argv.slice(2),
    dependencies: { root?: string, env?: NodeJS.ProcessEnv, log?: (message: string) => void } = {},
) {
    let config;
    let signKey;
    let showHelp = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--help') showHelp = true;
        else if (args[i] === '--config') {
            if (config || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--config 必须指定且只能指定一个配置文件');
            config = args[++i];
        } else if (args[i] === '--sign-key') {
            if (signKey || !args[i + 1] || args[i + 1].startsWith('--')) {
                throw new Error('--sign-key 必须指定且只能指定一个私钥文件');
            }
            signKey = args[++i];
        } else throw new Error(`不支持的 ASAR 构建选项：${args[i]}`);
    }
    const log = dependencies.log || console.log;
    if (showHelp) {
        log(help);
        return undefined;
    }
    const env = buildEnvironment(config, dependencies.env || process.env);
    if (signKey && !env.PROCTOR_UPDATE_PRIVATE_KEY) {
        env.PROCTOR_UPDATE_PRIVATE_KEY = fs.readFileSync(path.resolve(signKey), 'utf8');
    }
    const result = await buildArchive(env, dependencies.root);
    log(JSON.stringify(result));
    return result;
}
if (require.main === module) {
    run().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
export { buildArchive, run };
