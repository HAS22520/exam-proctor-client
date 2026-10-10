const fs = require('node:fs');
const path = require('node:path');
const { prepare } = require('./prepare-build');
const root = path.resolve(__dirname, '..');
const help = `Usage: npm run build -- [--config FILE] [--win | --mac] [--x64 | --arm64] [--dir | --portable | --check]

--config FILE  Read build JSON; public key paths are relative to this file.
--check        Validate and generate embedded configuration without packaging.
--dir          Produce an unpacked application instead of installers.
--portable     Build only the Windows portable EXE (requires --win).
--help         Show this help without requiring keys or downloading tools.

PROCTOR_* environment variables override JSON settings. Outputs go to dist/.
Windows supports x64; macOS supports x64 and arm64. Builds never publish.`;

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config') {
      if (options.config || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--config requires exactly one file');
      options.config = args[++i];
    } else if (['--dir', '--portable', '--check', '--win', '--mac', '--x64', '--arm64', '--help', '--publish=never'].includes(arg)) {
      options[arg.slice(2)] = true;
    } else throw new Error(`Unsupported build option: ${arg}`);
  }
  if (options.win && options.mac) throw new Error('Choose one platform per build: --win or --mac');
  if (options.x64 && options.arm64) throw new Error('Choose one architecture per build: --x64 or --arm64');
  if (options.portable && !options.win) throw new Error('--portable requires --win');
  if (options.portable && options.dir) throw new Error('Choose --portable or --dir');
  return options;
}

function buildEnvironment(filename, env) {
  if (!filename) return { ...env };
  const configFile = path.resolve(filename);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Build config must be a JSON object');
  const fields = {
    keyId: ['PROCTOR_KEY_ID', 'string'], version: ['PROCTOR_CLIENT_VERSION', 'string'],
    authPublicKeyFile: ['PROCTOR_AUTH_PUBLIC_KEY', 'file'], logPublicKeyFile: ['PROCTOR_LOG_PUBLIC_KEY', 'file'],
    targetUrl: ['PROCTOR_TARGET_URL', 'string'], versionUrl: ['PROCTOR_VERSION_URL', 'string'],
    allowedOrigins: ['PROCTOR_ALLOWED_ORIGINS', 'origins'], updateOrigins: ['PROCTOR_UPDATE_ORIGINS', 'origins'],
    allowRootDebug: ['PROCTOR_ALLOW_ROOT_DEBUG', 'boolean'],
  };
  if (Object.hasOwn(config, '_comments')) {
    const comments = config._comments;
    if (!comments || typeof comments !== 'object' || Array.isArray(comments)
      || Object.entries(comments).some(([field, value]) => !Object.hasOwn(fields, field) || typeof value !== 'string')) {
      throw new Error('Build config _comments must map supported field names to explanation strings');
    }
  }
  const result = { ...env };
  for (const [field, value] of Object.entries(config)) {
    if (field === '_comments') continue;
    if (!Object.hasOwn(fields, field)) throw new Error(`Unknown build config field: ${field}`);
    const [variable, type] = fields[field];
    if (type === 'boolean' ? typeof value !== 'boolean' : type === 'origins'
      ? !Array.isArray(value) || value.some((origin) => typeof origin !== 'string')
      : typeof value !== 'string' || !value.trim()) throw new Error(`Invalid build config field: ${field}`);
    // CI environment takes precedence; unused local key files need not exist there.
    if (env[variable] !== undefined) continue;
    result[variable] = type === 'file' ? fs.readFileSync(path.resolve(path.dirname(configFile), value), 'utf8')
      : type === 'origins' ? JSON.stringify(value) : String(value);
  }
  return result;
}

async function run(args = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(args);
  if (options.help) { console.log(help); return; }
  const env = buildEnvironment(options.config, dependencies.env || process.env);
  const projectDir = dependencies.root || root;
  const nativePlatform = options.win ? 'win32' : options.mac ? 'darwin' : process.platform;
  if (nativePlatform === 'win32' && options.arm64) throw new Error('Windows packages currently support x64 only');
  const { version } = prepare(env, projectDir);
  if (options.check) { console.log(`Validated proctor build ${version}`); return; }
  const { build, Platform, Arch } = require('electron-builder');
  const platform = options.win ? Platform.WINDOWS : options.mac ? Platform.MAC : Platform.current();
  const arch = options.arm64 ? Arch.arm64 : Arch.x64;
  const target = options.dir ? 'dir' : options.portable ? 'portable' : undefined;
  await (dependencies.build || build)({ projectDir, targets: platform.createTarget(target, arch), publish: 'never',
    config: { extraMetadata: { version }, beforePack: async (context) => {
      const prepared = prepare(env, projectDir);
      if (context.packager.appInfo.version !== prepared.version) throw new Error('Build metadata does not match configured client version');
    } } });
}
if (require.main === module) {
  run().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { run, parseArgs, buildEnvironment };
