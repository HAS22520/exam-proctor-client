import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { stageProject } from '../scripts/build-docker';
import { applicationRoot, projectRoot } from '../scripts/project-layout';
import { workspace } from './helpers';

function files(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const filename = path.join(directory, entry.name);
        return entry.isDirectory() ? files(filename) : [filename];
    });
}

test('安装向导在写入新版前引导卸载，取消或登记未移除时停止安装', () => {
    const installer = fs.readFileSync(path.join(projectRoot, 'config/installer.nsh'), 'utf8');
    const templates = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis');
    const wizard = fs.readFileSync(path.join(templates, 'assistedInstaller.nsh'), 'utf8');
    // 验证真实 builder 的调用位置，避免把卸载提示接到程序文件已被覆盖之后。
    assert.ok(wizard.indexOf('!insertmacro customPageAfterChangeDir') < wizard.indexOf('!insertmacro MUI_PAGE_INSTFILES'));
    assert.match(installer, /Page custom proctorUninstallBeforeInstall/);
    assert.match(installer, /proctorUninstallRegistered HKLM allusers/);
    assert.match(installer, /proctorUninstallRegistered HKCU currentuser/);
    const commands = installer.split('\n').filter((line) => line.trim().startsWith('ExecWait '));
    assert.equal(commands.length, 1);
    assert.doesNotMatch(commands[0], /(?:\/S|--updated)\s/);
    assert.match(commands[0], /\/KEEP_APP_DATA \/\$\{MODE\} _\?=\$proctorOldDirectory'/);
    assert.match(installer, /MB_OKCANCEL[^\n]+\/SD IDCANCEL IDOK \+3\s+SetErrorLevel 1\s+Quit/);
    assert.match(installer, /\$proctorOldExitCode != 0[\s\S]*?SetErrorLevel 2\s+Quit/);
    const afterExit = installer.slice(installer.indexOf('Delete "$proctorOldTemporary"'));
    assert.match(afterExit, /ReadRegStr[^\n]+UninstallString/);
    assert.match(afterExit, /ReadRegStr[^\n]+InstallLocation/);
    assert.match(afterExit, /原客户端尚未完成卸载[\s\S]*?SetErrorLevel 2\s+Quit/);
    // 重装仍沿用已有的数据保留逻辑，不把未上传的监考证据当作程序文件删除。
    assert.match(installer, /\$R1 != "data"/);
});

test('重装使用新安装包的可见卸载器，并在卸载期间让出前台窗口', () => {
    const installer = fs.readFileSync(path.join(projectRoot, 'config/installer.nsh'), 'utf8');
    assert.match(installer, /SilentUnInstall normal/);
    assert.match(installer, /!macro customUnInit[\s\S]*?--proctor-interactive-uninstall[\s\S]*?SetSilent normal/);
    assert.match(installer, /File "\/oname=\$PLUGINSDIR[^\n]+" "\$\{UNINSTALLER_OUT_FILE\}"/);
    assert.doesNotMatch(installer, /CopyFiles[^\n]+proctorOldUninstaller/);
    assert.match(installer, /ExecWait[^\n]+--proctor-interactive-uninstall/);
    const launch = installer.indexOf('ExecWait ');
    const hide = installer.search(/ShowWindow \$HWNDPARENT \$\{SW_HIDE\}/);
    assert.ok(hide >= 0 && hide < launch);
    assert.ok(installer.search(/ShowWindow \$HWNDPARENT \$\{SW_SHOW\}/) > launch);
    assert.ok(installer.indexOf('BringToFront') > launch);
    assert.match(installer, /\$proctorOldLaunchFailed == "1"[\s\S]*?SetErrorLevel 2\s+Quit/);
});

test('已有安装禁止静默重装，全用户安装卸载前检查管理员权限', () => {
    const installer = fs.readFileSync(path.join(projectRoot, 'config/installer.nsh'), 'utf8');
    assert.match(installer, /!macro customInit\s+\$\{If\} \$\{Silent\}/);
    assert.match(installer, /proctorRequireInteractive HKLM/);
    assert.match(installer, /proctorRequireInteractive HKCU/);
    assert.match(installer, /\$\{IfNot\} \$\{UAC_IsAdmin\}[\s\S]*?SetErrorLevel 2\s+Quit/);
    assert.doesNotMatch(installer, /DeleteRegKey/);
});

test('TypeScript 源码不含 JS，编译资源及开发和安装入口使用独立根目录', () => {
    for (const directory of ['app', 'scripts', 'tests']) {
        assert.deepEqual(
            files(path.join(projectRoot, directory)).filter((file) => file.endsWith('.js')),
            [],
        );
    }
    const output = applicationRoot();
    assert.equal(output, path.join(projectRoot, 'out'));
    const sourcePackage = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const runtimePackage = JSON.parse(fs.readFileSync(path.join(output, 'package.json'), 'utf8'));
    assert.equal(sourcePackage.main, 'out/app/main/bootstrap.js');
    assert.equal(sourcePackage.build.directories.app, 'out');
    assert.deepEqual(sourcePackage.build.win.extraResources[0].filter, ['hydro-network.exe', 'hydro-audit.exe']);
    assert.equal(runtimePackage.main, 'app/main/bootstrap.js');
    assert.equal(runtimePackage.build, undefined);
    for (const entry of ['app/main/bootstrap.js', 'app/preload/preload.js', 'app/renderer/upload.html']) {
        assert.ok(fs.existsSync(path.join(output, entry)), `缺少编译资源：${entry}`);
    }
    assert.deepEqual(fs.readdirSync(path.join(output, 'config')).sort(), [
        'build.example.json',
        'entitlements.mac.plist',
        'exam-config.json',
        'installer.nsh',
    ]);
    assert.equal(fs.existsSync(path.join(output, '.env')), false);
    assert.equal(
        files(path.join(output, 'app')).some((file) => /\.pem$/.test(file)),
        false,
    );
    assert.equal(
        files(output).some((file) => /\.(?:ps1|bat)$/.test(file)),
        false,
    );
});

test('Docker 暂存编译后应用，不复制 TS、本地配置或旧信任信息', (t) => {
    const destination = path.join(workspace(t), 'stage');
    stageProject(projectRoot, destination);
    assert.equal(
        files(destination).some((file) => /\.(?:ts|mts|pem)$/.test(file)),
        false,
    );
    assert.ok(fs.existsSync(path.join(destination, 'scripts/project-layout.js')));
    assert.equal(fs.existsSync(path.join(destination, 'app/generated')), false);
    assert.equal(
        files(destination).some((file) => /\.(?:ps1|bat)$/.test(file)),
        false,
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
    assert.equal(pkg.main, 'app/main/bootstrap.js');
    assert.ok(fs.existsSync(path.join(destination, pkg.main)));
    assert.equal(pkg.build.directories.app, undefined);
});

// 校验真实 electron-builder 的双 package.json 规则，不触发下载、打包或 UI。
test('electron-builder 将 out 识别为应用根目录，并保持 npm 与父工作区隔离', async (t) => {
    const { Packager } = require('app-builder-lib/out/packager');
    const packager = new Packager({ projectDir: projectRoot });
    t.after(() => packager.tempDirManager.cleanup());
    await packager.validateConfig();
    assert.equal(packager.appDir, applicationRoot());
    assert.equal(packager.metadata.main, 'app/main/bootstrap.js');
    assert.equal(packager.metadata.build, undefined);
    assert.equal(await packager.getPackageManager(), 'npm');
    assert.equal(await packager.getWorkspaceRoot(), projectRoot);
});
