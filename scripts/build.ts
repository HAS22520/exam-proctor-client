import * as fs from 'node:fs';
import * as path from 'node:path';
import { prepare } from './prepare-build';
import { projectRoot } from './project-layout';

type BuildInvocation = Omit<import('electron-builder').CliOptions, 'config'> & {
    config: import('electron-builder').Configuration & {
        beforePack: (context: import('app-builder-lib').PackContext) => Promise<void>;
    };
};
interface BuildDependencies {
    root?: string;
    env?: NodeJS.ProcessEnv;
    build?: (options: BuildInvocation) => Promise<string[]>;
}
interface BuildOptions {
    config?: string;
    dir?: boolean;
    portable?: boolean;
    check?: boolean;
    win?: boolean;
    mac?: boolean;
    x64?: boolean;
    arm64?: boolean;
    help?: boolean;
    'publish=never'?: boolean;
}

const root = projectRoot;
const retiredFields = new Set(['macTeamId', 'macHostProfileFile', 'macExtensionProfileFile']);
const help = `用法：npm run build -- [--config FILE] [--win | --mac] [--x64 | --arm64] [--dir | --portable | --check]

--config FILE  读取构建 JSON，公钥路径相对于配置文件。
--check        仅校验并生成内置配置，不打包。
--dir          生成解包应用目录。
--portable     仅构建 Windows 便携 EXE，需同时指定 --win。
--help         显示帮助，无需密钥或下载工具。

PROCTOR_* 环境变量优先于 JSON 配置，产物写入 dist/。
Windows 支持 x64；macOS 支持 x64 和 arm64。构建不会自动发布。`;

function parseArgs(args: string[]) {
    const options: BuildOptions = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--config') {
            if (options.config || !args[i + 1] || args[i + 1].startsWith('--')) {
                throw new Error('--config 必须指定且只能指定一个配置文件');
            }
            options.config = args[++i];
        } else if (
            ['--dir', '--portable', '--check', '--win', '--mac', '--x64', '--arm64', '--help', '--publish=never'].includes(
                arg,
            )
        ) {
            options[arg.slice(2) as Exclude<keyof BuildOptions, 'config'>] = true;
        } else throw new Error(`不支持的构建选项：${arg}`);
    }
    if (options.win && options.mac) throw new Error('每次构建只能选择一个平台：--win 或 --mac');
    if (options.x64 && options.arm64) throw new Error('每次构建只能选择一种架构：--x64 或 --arm64');
    if (options.portable && !options.win) throw new Error('--portable 必须与 --win 一起使用');
    if (options.portable && options.dir) throw new Error('--portable 和 --dir 不能同时使用');
    return options;
}

function buildEnvironment(filename: string | undefined, env: NodeJS.ProcessEnv) {
    if (!filename) return { ...env };
    const configFile = path.resolve(filename);
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('构建配置必须是 JSON 对象');
    }
    const fields: Record<string, [string, 'string' | 'file' | 'origins' | 'boolean']> = {
        keyId: ['PROCTOR_KEY_ID', 'string'],
        productName: ['PROCTOR_PRODUCT_NAME', 'string'],
        version: ['PROCTOR_CLIENT_VERSION', 'string'],
        buildVersion: ['PROCTOR_CLIENT_BUILD_VERSION', 'string'],
        updatePublicKeyFile: ['PROCTOR_UPDATE_PUBLIC_KEY', 'file'],
        authPublicKeyFile: ['PROCTOR_AUTH_PUBLIC_KEY', 'file'],
        logPublicKeyFile: ['PROCTOR_LOG_PUBLIC_KEY', 'file'],
        targetUrl: ['PROCTOR_TARGET_URL', 'string'],
        versionUrl: ['PROCTOR_VERSION_URL', 'string'],
        allowedOrigins: ['PROCTOR_ALLOWED_ORIGINS', 'origins'],
        updateOrigins: ['PROCTOR_UPDATE_ORIGINS', 'origins'],
        allowRootDebug: ['PROCTOR_ALLOW_ROOT_DEBUG', 'boolean'],
    };
    if (Object.hasOwn(config, '_comments')) {
        const comments = config._comments;
        if (
            !comments
            || typeof comments !== 'object'
            || Array.isArray(comments)
            || Object.entries(comments).some(
                ([field, value]) => (!Object.hasOwn(fields, field) && !retiredFields.has(field)) || typeof value !== 'string',
            )
        ) {
            throw new Error('构建配置 _comments 必须将支持的字段名映射为说明字符串');
        }
    }
    const result = { ...env };
    // 兼容旧配置字段，但不读取或打包已停用的签名配置文件。
    for (const [field, value] of Object.entries(config)) {
        if (field === '_comments' || retiredFields.has(field)) continue;
        if (!Object.hasOwn(fields, field)) throw new Error(`未知的构建配置字段：${field}`);
        const [variable, type] = fields[field];
        if (
            type === 'boolean'
                ? typeof value !== 'boolean'
                : type === 'origins'
                    ? !Array.isArray(value) || value.some((origin) => typeof origin !== 'string')
                    : typeof value !== 'string' || !value.trim()
        ) { throw new Error(`构建配置字段无效：${field}`); }
        // CI 环境变量优先；被覆盖的本地公钥文件可以不存在。
        if (env[variable] !== undefined) continue;
        result[variable] =
            type === 'file'
                ? fs.readFileSync(path.resolve(path.dirname(configFile), value as string), 'utf8')
                : type === 'origins'
                    ? JSON.stringify(value)
                    : String(value);
    }
    return result;
}

function clearEmptySigningEnvironment(env: NodeJS.ProcessEnv) {
    // 未配置的 Actions Secret 会展开为空字符串；
    // electron-builder 会把 CSC_LINK='' 误当成指向工程目录的证书路径。
    for (const name of [
        'CSC_LINK',
        'CSC_NAME',
        'CSC_KEY_PASSWORD',
        'CSC_INSTALLER_LINK',
        'CSC_INSTALLER_KEY_PASSWORD',
        'WIN_CSC_LINK',
        'WIN_CSC_KEY_PASSWORD',
        'APPLE_ID',
        'APPLE_APP_SPECIFIC_PASSWORD',
        'APPLE_TEAM_ID',
    ]) {
        if (typeof env[name] === 'string' && !env[name].trim()) delete env[name];
    }
}

async function run(args = process.argv.slice(2), dependencies: BuildDependencies = {}) {
    const options = parseArgs(args);
    if (options.help) {
        console.log(help);
        return undefined;
    }
    const env = buildEnvironment(options.config, dependencies.env || process.env);
    const projectDir = dependencies.root || root;
    const nativePlatform = options.win ? 'win32' : options.mac ? 'darwin' : process.platform;
    if (nativePlatform === 'win32' && options.arm64) throw new Error('Windows 安装包当前仅支持 x64');
    const { version, buildVersion, productName } = prepare(env, projectDir);
    if (options.check) {
        console.log(`监考客户端构建配置已通过校验：${version}`);
        return undefined;
    }
    clearEmptySigningEnvironment(env);
    // electron-builder 直接从 process.env 读取签名变量。
    clearEmptySigningEnvironment(process.env);
    const { build, Platform, Arch } = require('electron-builder');
    const platform = options.win ? Platform.WINDOWS : options.mac ? Platform.MAC : Platform.current();
    const arch = options.arm64 ? Arch.arm64 : Arch.x64;
    const target = options.dir ? 'dir' : options.portable ? 'portable' : undefined;
    const { buildNative } = require('./build-native');
    // Intel 和 Apple Silicon 均可使用无需 Apple 账号的临时签名。
    // 传入发行证书时，改用 electron-builder 的常规签名流程。
    const mac = !env.CSC_LINK && !env.CSC_NAME ? { identity: '-', notarize: false } : {};
    const artifacts = await (dependencies.build || build)({
        projectDir,
        targets: platform.createTarget(target, arch),
        publish: 'never',
        config: {
            productName,
            extraMetadata: { version, buildVersion, productName },
            mac,
            beforePack: async (context: import('app-builder-lib').PackContext) => {
                const prepared = prepare(env, projectDir);
                if (context.packager.appInfo.version !== prepared.version) {
                    throw new Error('构建元数据与配置的客户端版本不一致');
                }
                if (context.electronPlatformName) {
                    await buildNative(
                        context.electronPlatformName,
                        context.arch === Arch.arm64 ? 'arm64' : 'x64',
                        env,
                        projectDir,
                    );
                }
            },
        },
    });
    if (!options.dir && (!Array.isArray(artifacts) || !artifacts.length)) {
        throw new Error('electron-builder 未生成安装包，请检查前面的打包和签名日志。');
    }
    return artifacts;
}
function runCli(args = process.argv.slice(2), execute = run) {
    // 依赖可能留下未完成的 Promise，却无法保持 Node 进程运行；
    // 此时必须将打包判为失败，不能在没有产物时报告成功。
    const unfinished = () => {
        console.error('构建未完成便提前退出，请检查前面的打包和签名日志。');
        process.exitCode = 1;
    };
    process.once('beforeExit', unfinished);
    return Promise.resolve()
        .then(() => execute(args))
        .catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        })
        .finally(() => {
            process.removeListener('beforeExit', unfinished);
        });
}
if (require.main === module) runCli();
export { buildEnvironment, clearEmptySigningEnvironment, parseArgs, run, runCli };
