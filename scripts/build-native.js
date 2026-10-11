const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function execute(command, args, cwd) {
  const child = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (child.error || child.status !== 0) throw new Error(`Native build failed: ${command}. Windows needs MSVC developer tools or MinGW.`);
}
async function buildNative(platform, arch, env = process.env, project = root) {
  // macOS uses passive logging and has no native network component.
  if (platform === 'darwin') return null;
  if (platform !== 'win32') throw new Error('Native network builds support Windows only');
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
}
if (require.main === module) {
  const { parseArgs, buildEnvironment } = require('./build');
  const options = parseArgs(process.argv.slice(2));
  const env = buildEnvironment(options.config, process.env);
  buildNative(options.win ? 'win32' : options.mac ? 'darwin' : process.platform, options.arm64 ? 'arm64' : 'x64', env)
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { buildNative };
