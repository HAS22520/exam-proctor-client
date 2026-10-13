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
const help = `Usage: npm run build -- [--config FILE] [--win | --mac] [--x64 | --arm64] [--dir | --portable | --check]

--config FILE  Read build JSON; public key paths are relative to this file.
--check        Validate and generate embedded configuration without packaging.
--dir          Produce an unpacked application instead of installers.
--portable     Build only the Windows portable EXE (requires --win).
--help         Show this help without requiring keys or downloading tools.

PROCTOR_* environment variables override JSON settings. Outputs go to dist/.
Windows supports x64; macOS supports x64 and arm64. Builds never publish.`;

function parseArgs(args: string[]) {
  const options: BuildOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config') {
      if (options.config || !args[i + 1] || args[i + 1].startsWith('--'))
        throw new Error('--config requires exactly one file');
      options.config = args[++i];
    } else if (
      ['--dir', '--portable', '--check', '--win', '--mac', '--x64', '--arm64', '--help', '--publish=never'].includes(
        arg,
      )
    ) {
      options[arg.slice(2) as Exclude<keyof BuildOptions, 'config'>] = true;
    } else throw new Error(`Unsupported build option: ${arg}`);
  }
  if (options.win && options.mac) throw new Error('Choose one platform per build: --win or --mac');
  if (options.x64 && options.arm64) throw new Error('Choose one architecture per build: --x64 or --arm64');
  if (options.portable && !options.win) throw new Error('--portable requires --win');
  if (options.portable && options.dir) throw new Error('Choose --portable or --dir');
  return options;
}

function buildEnvironment(filename: string | undefined, env: NodeJS.ProcessEnv) {
  if (!filename) return { ...env };
  const configFile = path.resolve(filename);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Build config must be a JSON object');
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
      !comments ||
      typeof comments !== 'object' ||
      Array.isArray(comments) ||
      Object.entries(comments).some(
        ([field, value]) => (!Object.hasOwn(fields, field) && !retiredFields.has(field)) || typeof value !== 'string',
      )
    ) {
      throw new Error('Build config _comments must map supported field names to explanation strings');
    }
  }
  const result = { ...env };
  // Accept older local files without reading or embedding retired signing profiles.
  for (const [field, value] of Object.entries(config)) {
    if (field === '_comments' || retiredFields.has(field)) continue;
    if (!Object.hasOwn(fields, field)) throw new Error(`Unknown build config field: ${field}`);
    const [variable, type] = fields[field];
    if (
      type === 'boolean'
        ? typeof value !== 'boolean'
        : type === 'origins'
          ? !Array.isArray(value) || value.some((origin) => typeof origin !== 'string')
          : typeof value !== 'string' || !value.trim()
    )
      throw new Error(`Invalid build config field: ${field}`);
    // CI environment takes precedence; unused local key files need not exist there.
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
  // Unconfigured Actions secrets become empty strings. electron-builder treats
  // CSC_LINK='' as a certificate path pointing to the project directory.
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
    return;
  }
  const env = buildEnvironment(options.config, dependencies.env || process.env);
  const projectDir = dependencies.root || root;
  const nativePlatform = options.win ? 'win32' : options.mac ? 'darwin' : process.platform;
  if (nativePlatform === 'win32' && options.arm64) throw new Error('Windows packages currently support x64 only');
  const { version, buildVersion, productName } = prepare(env, projectDir);
  if (options.check) {
    console.log(`Validated proctor build ${version}`);
    return;
  }
  clearEmptySigningEnvironment(env);
  // electron-builder reads signing variables from process.env directly.
  clearEmptySigningEnvironment(process.env);
  const { build, Platform, Arch } = require('electron-builder');
  const platform = options.win ? Platform.WINDOWS : options.mac ? Platform.MAC : Platform.current();
  const arch = options.arm64 ? Arch.arm64 : Arch.x64;
  const target = options.dir ? 'dir' : options.portable ? 'portable' : undefined;
  const { buildNative } = require('./build-native');
  // Ad-hoc signing works without an Apple account on Intel and Apple Silicon.
  // Imported certificates opt into normal electron-builder signing instead.
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
        if (context.packager.appInfo.version !== prepared.version)
          throw new Error('Build metadata does not match configured client version');
        if (context.electronPlatformName)
          await buildNative(
            context.electronPlatformName,
            context.arch === Arch.arm64 ? 'arm64' : 'x64',
            env,
            projectDir,
          );
      },
    },
  });
  if (!options.dir && (!Array.isArray(artifacts) || !artifacts.length)) {
    throw new Error('electron-builder 未生成安装包，请检查前面的打包和签名日志。');
  }
  return artifacts;
}
function runCli(args = process.argv.slice(2), execute = run) {
  // A dependency can leave an unresolved promise without keeping Node alive.
  // That must fail the packaging step rather than report success with no files.
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
export { run, runCli, parseArgs, buildEnvironment, clearEmptySigningEnvironment };
