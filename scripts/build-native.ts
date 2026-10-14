import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectRoot } from './project-layout';

const root = projectRoot;

function execute(command: string, args: string[], cwd: string) {
    const child = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (child.error || child.status !== 0) {
        throw new Error(`原生构建失败：${command}。Windows 需要 MSVC 开发工具或 MinGW。`);
    }
}
async function buildNative(platform: string, arch: string, env = process.env, project = root) {
    // macOS 只记录日志，不构建原生网络限制组件。
    if (platform === 'darwin') return null;
    if (platform !== 'win32') throw new Error('原生网络组件构建仅支持 Windows');
    const output = path.join(project, 'build/native');
    fs.mkdirSync(output, { recursive: true });
    const common = path.join(project, 'native/common/policy.cpp');
    if (arch !== 'x64') throw new Error('WFP 当前仅支持 Windows x64');
    const filename = path.join(output, 'hydro-network.exe');
    const source = path.join(project, 'native/windows/main.cpp');
    if (process.platform === 'win32') {
        execute(
            'cl.exe',
            [
                '/nologo',
                '/EHsc',
                '/std:c++17',
                '/utf-8',
                '/O2',
                '/MT',
                '/D_WIN32_WINNT=0x0A00',
                `/Fe:${filename}`,
                source,
                common,
                '/link',
                'fwpuclnt.lib',
                'rpcrt4.lib',
                'ws2_32.lib',
                'advapi32.lib',
            ],
            output,
        );
    } else {
        execute(
            env.PROCTOR_MINGW_CXX || 'x86_64-w64-mingw32-g++',
            [
                '-std=c++17',
                '-O2',
                '-static',
                '-D_WIN32_WINNT=0x0A00',
                source,
                common,
                '-o',
                filename,
                '-lfwpuclnt',
                '-lrpcrt4',
                '-lws2_32',
                '-ladvapi32',
            ],
            output,
        );
    }
    const auditSource = path.join(project, 'native/windows/process-audit.cpp');
    const auditFilename = path.join(output, 'hydro-audit.exe');
    if (process.platform === 'win32') {
        execute('cl.exe', ['/nologo', '/EHsc', '/std:c++17', '/utf-8', '/O2', '/MT', '/D_WIN32_WINNT=0x0A00',
            `/Fe:${auditFilename}`, auditSource, '/link', 'version.lib', 'wintrust.lib', 'crypt32.lib', 'bcrypt.lib', 'advapi32.lib'], output);
    } else {
        execute(env.PROCTOR_MINGW_CXX || 'x86_64-w64-mingw32-g++', ['-std=c++17', '-O2', '-static', '-D_WIN32_WINNT=0x0A00',
            auditSource, '-o', auditFilename, '-lversion', '-lwintrust', '-lcrypt32', '-lbcrypt', '-ladvapi32'], output);
    }
    return output;
}
if (require.main === module) {
    const { parseArgs, buildEnvironment } = require('./build');
    const options = parseArgs(process.argv.slice(2));
    const env = buildEnvironment(options.config, process.env);
    buildNative(
        options.win ? 'win32' : options.mac ? 'darwin' : process.platform,
        options.arm64 ? 'arm64' : 'x64',
        env,
    ).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
export { buildNative };
