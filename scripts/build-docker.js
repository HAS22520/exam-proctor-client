const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs, buildEnvironment } = require('./build');
const { prepare } = require('./prepare-build');
const root = path.resolve(__dirname, '..');

function stageProject(projectDir, destination) {
  const generated = path.join(projectDir, 'app/generated');
  // Recreate build outputs from this invocation's public configuration. Old
  // container-owned files may be unreadable and must not carry stale trust.
  fs.cpSync(path.join(projectDir, 'app'), path.join(destination, 'app'), {
    recursive: true, filter: (source) => source !== generated,
  });
  fs.mkdirSync(path.join(destination, 'scripts'));
  for (const name of ['build.js', 'prepare-build.js', 'before-pack.js', 'docker-build-entry.js',
    'lock-firewall.ps1', 'unlock-firewall.ps1', 'watch-network.ps1', 'restore-network.bat']) {
    fs.copyFileSync(path.join(projectDir, 'scripts', name), path.join(destination, 'scripts', name));
  }
  fs.mkdirSync(path.join(destination, 'config'));
  for (const name of ['exam-config.json', 'entitlements.mac.plist']) fs.copyFileSync(path.join(projectDir, 'config', name), path.join(destination, 'config', name));
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(projectDir, name), path.join(destination, name));
}

function dockerArguments(stage, projectDir, env, options) {
  const cache = path.join(projectDir, '.docker-cache'), output = path.join(projectDir, 'dist');
  if ([stage, cache, output].some((value) => value.includes(','))) throw new Error('Docker bind mount paths cannot contain commas');
  const args = ['run', '--rm', '--platform', 'linux/amd64', '--workdir', '/project'];
  if (process.getuid) args.push('--user', `${process.getuid()}:${process.getgid()}`);
  for (const [source, target] of [[stage, '/project'], [cache, '/cache'], [output, '/output']]) {
    args.push('--mount', `type=bind,source=${source},target=${target}`);
  }
  // The container entrypoint owns dependencies; no host node_modules or private PEM files are mounted.
  const variables = { ELECTRON_CACHE: '/cache/electron', ELECTRON_BUILDER_CACHE: '/cache/builder',
    npm_config_cache: '/cache/npm', WINEPREFIX: '/cache/wine', USE_SYSTEM_WINE: 'true', XDG_CACHE_HOME: '/cache' };
  for (const [name, value] of Object.entries(variables)) args.push('--env', `${name}=${value}`);
  for (const name of Object.keys(env).filter((name) => name.startsWith('PROCTOR_') && name !== 'PROCTOR_BUILDER_IMAGE')) args.push('--env', name);
  args.push('--entrypoint', 'node', env.PROCTOR_BUILDER_IMAGE || 'electronuserland/builder:22-wine', 'scripts/docker-build-entry.js', '--win', '--x64');
  if (options.portable) args.push('--portable');
  if (options.dir) args.push('--dir');
  return args;
}

function run(args = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('npm run build:docker -- --config config/build.local.json [--portable | --dir]\nLocal Windows x64 build using electronuserland/builder:22-wine. GitHub Actions use native runners.');
    return;
  }
  if (options.mac || options.arm64) throw new Error('Docker builds support Windows x64 only');
  const projectDir = dependencies.root || root;
  const env = buildEnvironment(options.config, dependencies.env || process.env);
  const result = prepare(env, projectDir);
  if (options.check) { console.log(`Validated Docker proctor build ${result.version}`); return; }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'hydro-proctor-docker-'));
  try {
    stageProject(projectDir, stage);
    for (const name of ['.docker-cache', 'dist']) fs.mkdirSync(path.join(projectDir, name), { recursive: true });
    const publicEnv = { PROCTOR_KEY_ID: result.trust.keyId, PROCTOR_AUTH_PUBLIC_KEY: result.trust.authPublicKey,
      PROCTOR_LOG_PUBLIC_KEY: result.trust.logPublicKey, PROCTOR_UPDATE_PUBLIC_KEY: result.trust.updatePublicKey || '',
      PROCTOR_CLIENT_VERSION: result.version, PROCTOR_CLIENT_BUILD_VERSION: result.buildVersion, PROCTOR_ALLOWED_ORIGINS: JSON.stringify(result.trust.allowedOrigins),
      PROCTOR_UPDATE_ORIGINS: JSON.stringify(result.trust.updateOrigins), PROCTOR_TARGET_URL: result.config.exam.targetUrl,
      PROCTOR_VERSION_URL: result.config.updater.versionUrl || '', PROCTOR_ALLOW_ROOT_DEBUG: String(result.config.debug.allowRoot),
      ...(env.PROCTOR_BUILDER_IMAGE ? { PROCTOR_BUILDER_IMAGE: env.PROCTOR_BUILDER_IMAGE } : {}) };
    const child = (dependencies.spawn || spawnSync)('docker', dockerArguments(stage, projectDir, publicEnv, options),
      { stdio: 'inherit', env: { ...process.env, ...publicEnv } });
    if (child.error) throw new Error(`Cannot run Docker: ${child.error.message}`);
    if (child.status !== 0) throw new Error('Docker build failed. Check Docker daemon access and the container output above.');
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
if (require.main === module) {
  try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { run, stageProject, dockerArguments };
