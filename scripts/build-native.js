const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function execute(command, args, cwd) {
  const child = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (child.error || child.status !== 0) throw new Error(`Native build failed: ${command}. Windows needs MSVC developer tools or MinGW; macOS needs Xcode command-line tools.`);
}
function plist(file, value) {
  // plist is an existing electron-builder dependency. Never interpolate paths or
  // identifiers into XML or a shell command.
  fs.writeFileSync(file, require('plist').build(value));
}
async function buildNative(platform, arch, env = process.env, project = root) {
  const output = path.join(project, 'build/native');
  fs.mkdirSync(output, { recursive: true });
  const common = path.join(project, 'native/common/policy.cpp');
  if (platform === 'win32') {
    if (arch !== 'x64') throw new Error('WFP currently supports Windows x64');
    const filename = path.join(output, 'hydro-network.exe');
    const source = path.join(project, 'native/windows/main.cpp');
    if (process.platform === 'win32') {
      execute('cl.exe', ['/nologo', '/EHsc', '/std:c++17', '/O2', '/MT', '/D_WIN32_WINNT=0x0A00', `/Fe:${filename}`, source, common,
        '/link', 'fwpuclnt.lib', 'rpcrt4.lib', 'ws2_32.lib', 'advapi32.lib'], output);
    } else {
      execute(env.PROCTOR_MINGW_CXX || 'x86_64-w64-mingw32-g++', ['-std=c++17', '-O2', '-static', '-D_WIN32_WINNT=0x0A00',
        source, common, '-o', filename, '-lfwpuclnt', '-lrpcrt4', '-lws2_32', '-ladvapi32'], output);
    }
    return output;
  }
  if (platform !== 'darwin' || process.platform !== 'darwin') throw new Error('Network Extension must be built on macOS');
  const team = env.PROCTOR_MAC_TEAM_ID || env.APPLE_TEAM_ID;
  if (!/^[A-Z0-9]{10}$/.test(team || '')) throw new Error('Set macTeamId / PROCTOR_MAC_TEAM_ID to your 10-character Apple Developer Team ID');
  const version = env.PROCTOR_CLIENT_VERSION || require(path.join(project, 'package.json')).version;
  const build = env.PROCTOR_CLIENT_BUILD_VERSION || require(path.join(project, 'package.json')).buildVersion;
  const bundleVersion = `${Number(build.slice(2, 6))}.${Number(build.slice(6, 8))}.${Number(build.slice(8))}`;
  const target = `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`;
  const sdk = spawnSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' });
  if (sdk.status !== 0) throw new Error('macOS SDK is unavailable');
  const extensionID = 'com.exam.proctor.network-filter';
  const bundle = path.join(output, `${extensionID}.systemextension`), contents = path.join(bundle, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  const hostEntitlements = {
    'com.apple.security.cs.allow-jit': true,
    'com.apple.developer.system-extension.install': true,
    'com.apple.developer.networking.networkextension': ['content-filter-provider-systemextension'],
    'com.apple.security.application-groups': [`${team}.com.exam.proctor`],
    'com.apple.developer.team-identifier': team,
    'com.apple.application-identifier': `${team}.com.exam.proctor`,
  };
  plist(path.join(output, 'host-entitlements.plist'), hostEntitlements);
  plist(path.join(output, 'extension-entitlements.plist'), {
    'com.apple.security.app-sandbox': true,
    'com.apple.developer.networking.networkextension': ['content-filter-provider-systemextension'],
    'com.apple.security.application-groups': [`${team}.com.exam.proctor`],
    'com.apple.developer.team-identifier': team,
    'com.apple.application-identifier': `${team}.${extensionID}`,
  });
  plist(path.join(contents, 'Info.plist'), {
    CFBundleIdentifier: extensionID, CFBundleExecutable: 'HydroNetworkFilter', CFBundleName: 'Hydro Exam Network Filter',
    CFBundlePackageType: 'SYSX', CFBundleShortVersionString: version, CFBundleVersion: bundleVersion,
    LSMinimumSystemVersion: '13.0', HydroTeamID: team,
    NSSystemExtensionUsageDescription: '考试期间仅允许访问考试服务器，退出监考后自动恢复网络。',
    NetworkExtension: { NEMachServiceName: `${team}.${extensionID}.${build}`,
      NEProviderClasses: { 'com.apple.networkextension.filter-packet': 'HydroNetworkFilter.PacketProvider' } },
  });
  const source = path.join(project, 'native/macos');
  const object = path.join(output, 'policy.o');
  execute('xcrun', ['clang++', '-std=c++17', '-O2', '-target', target, '-isysroot', sdk.stdout.trim(), '-c', common, '-o', object], output);
  execute('xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', target, '-sdk', sdk.stdout.trim(), '-module-name', 'HydroNetworkFilter',
    '-import-objc-header', path.join(project, 'native/common/policy.h'), path.join(source, 'ControlProtocol.swift'), path.join(source, 'PacketProvider.swift'),
    path.join(source, 'main.swift'), object, '-lc++', '-o', path.join(contents, 'MacOS/HydroNetworkFilter')], output);
  execute('xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', target, '-sdk', sdk.stdout.trim(),
    path.join(source, 'ControlProtocol.swift'), path.join(source, 'Host.swift'), path.join(source, 'host/main.swift'), '-o', path.join(output, 'HydroNetworkHost')], output);
  return output;
}
async function afterPack(context, env = process.env, project = root) {
  if (context.electronPlatformName !== 'darwin') return;
  for (const name of ['PROCTOR_MAC_HOST_PROFILE', 'PROCTOR_MAC_EXTENSION_PROFILE']) {
    if (!env[name] || !fs.existsSync(env[name])) throw new Error(`macOS network filtering requires ${name} (Developer ID provisioning profile)`);
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`), contents = path.join(app, 'Contents');
  const native = path.join(project, 'build/native'), extension = 'com.exam.proctor.network-filter.systemextension';
  fs.copyFileSync(path.join(native, 'HydroNetworkHost'), path.join(contents, 'MacOS/HydroNetworkHost'));
  fs.cpSync(path.join(native, extension), path.join(contents, 'Library/SystemExtensions', extension), { recursive: true });
  fs.copyFileSync(env.PROCTOR_MAC_HOST_PROFILE, path.join(contents, 'embedded.provisionprofile'));
  fs.copyFileSync(env.PROCTOR_MAC_EXTENSION_PROFILE, path.join(contents, 'Library/SystemExtensions', extension, 'Contents/embedded.provisionprofile'));
}
if (require.main === module) {
  const { parseArgs, buildEnvironment } = require('./build');
  const options = parseArgs(process.argv.slice(2));
  const env = buildEnvironment(options.config, process.env);
  buildNative(options.win ? 'win32' : options.mac ? 'darwin' : process.platform, options.arm64 ? 'arm64' : 'x64', env)
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { buildNative, afterPack };
