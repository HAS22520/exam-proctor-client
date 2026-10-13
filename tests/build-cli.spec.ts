import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { validateProductName } from '../app/shared/branding';
import { buildEnvironment, clearEmptySigningEnvironment, parseArgs, run } from '../scripts/build';
import { projectRoot, runtimePackage } from '../scripts/project-layout';
import { auth, forEachSerial, trust, workspace } from './helpers';

function fixture(t) {
    const root = workspace(t);
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0', buildVersion: '2026101001' }));
    fs.writeFileSync(
        path.join(root, 'config/exam-config.json'),
        JSON.stringify({
            exam: { targetUrl: 'https://oj.example.com', allowedOrigins: ['https://oj.example.com'] },
            updater: {
                enabled: true,
                versionUrl: 'https://oj.example.com/version.json',
                allowedOrigins: ['https://oj.example.com'],
            },
            debug: { allowRoot: false },
        }),
    );
    fs.writeFileSync(path.join(root, 'auth.pem'), trust.authPublicKey);
    fs.writeFileSync(path.join(root, 'log.pem'), trust.logPublicKey);
    const file = path.join(root, 'config/build.local.json');
    const config: any = {
        keyId: trust.keyId,
        version: '1.2.3',
        authPublicKeyFile: '../auth.pem',
        logPublicKeyFile: '../log.pem',
        targetUrl: 'https://oj.example.com/contest/123',
        allowedOrigins: ['https://oj.example.com'],
        updateOrigins: ['https://oj.example.com'],
        versionUrl: 'https://oj.example.com/version.json',
        allowRootDebug: true,
    };
    fs.writeFileSync(file, JSON.stringify(config));
    return { root, file, config };
}

test('构建 JSON 按配置文件解析 PEM 路径，支持环境覆盖并严格校验类型', (t) => {
    const { file, config } = fixture(t);
    const env = buildEnvironment(file, { PROCTOR_CLIENT_VERSION: '2.0.0', PROCTOR_ALLOW_ROOT_DEBUG: 'false' });
    assert.equal(env.PROCTOR_AUTH_PUBLIC_KEY, trust.authPublicKey);
    assert.equal(env.PROCTOR_LOG_PUBLIC_KEY, trust.logPublicKey);
    assert.equal(env.PROCTOR_CLIENT_VERSION, '2.0.0');
    assert.equal(env.PROCTOR_ALLOW_ROOT_DEBUG, 'false');
    assert.deepEqual(JSON.parse(env.PROCTOR_ALLOWED_ORIGINS.toString()), ['https://oj.example.com']);
    fs.writeFileSync(file, JSON.stringify({ ...config, authPublicKeyFile: 'missing.pem' }));
    assert.equal(buildEnvironment(file, { PROCTOR_AUTH_PUBLIC_KEY: trust.authPublicKey }).PROCTOR_AUTH_PUBLIC_KEY, trust.authPublicKey);
    for (const extra of [{ allowRootDebug: 'false' }, { allowedOrigins: 'https://oj.example.com' }, { unexpected: true }]) {
        fs.writeFileSync(file, JSON.stringify({ ...config, ...extra }));
        assert.throws(() => buildEnvironment(file, {}), /构建配置字段/);
    }
});

test('软件名称从构建配置传入打包器、身份元数据、窗口标题和 React 页面', async (t) => {
    const f = fixture(t);
    fs.writeFileSync(f.file, JSON.stringify({ ...f.config, productName: '计算机学院监考客户端' }));
    assert.equal(buildEnvironment(f.file, {}).PROCTOR_PRODUCT_NAME, '计算机学院监考客户端');
    await run(['--config', f.file, '--win'], {
        root: f.root,
        env: { PROCTOR_PRODUCT_NAME: '学院测试监考客户端' },
        build: async ({ config }) => {
            assert.equal(config.productName, '学院测试监考客户端');
            assert.equal(config.extraMetadata.productName, '学院测试监考客户端');
            return ['fixture.exe'];
        },
    });
    const json = (file) => JSON.parse(fs.readFileSync(path.join(f.root, file), 'utf8'));
    assert.equal(json('app/generated/build.json').productName, '学院测试监考客户端');
    assert.equal(json('app/generated/config.json').exam.title, '学院测试监考客户端');
    assert.match(fs.readFileSync(path.join(f.root, 'app/renderer/assets/brand.js'), 'utf8'), /学院测试监考客户端/);
    for (const name of ['', '学院', 'A/B监考客户端', 'A\n监考客户端', `${'A'.repeat(61)}监考客户端`]) {
        assert.throws(() => validateProductName(name), /productName/);
    }
});

test('JSON 注释可读取但不进入安装包，也不能隐藏未知构建字段', async (t) => {
    const { root, file, config } = fixture(t);
    const example = require('../config/build.example.json');
    const fields = Object.keys(example).filter((field) => field !== '_comments');
    assert.deepEqual(Object.keys(example._comments).sort(), fields.sort());
    fs.writeFileSync(file, JSON.stringify({ ...config, _comments: example._comments }));
    const env = buildEnvironment(file, {});
    assert.ok(Object.keys(env).every((field) => field.startsWith('PROCTOR_')));
    await run(['--config', file, '--check'], { root, env: {}, build: async () => assert.fail('检查模式不能打包') });
    for (const name of ['config.json', 'trust.json']) {
        const generated = JSON.parse(fs.readFileSync(path.join(root, 'app/generated', name)).toString());
        assert.ok(!Object.hasOwn(generated, '_comments'));
    }
    for (const comments of [null, [], 'comment', { unknownOption: 'explanation' }, { version: true }]) {
        fs.writeFileSync(file, JSON.stringify({ ...config, _comments: comments }));
        assert.throws(() => buildEnvironment(file, {}), /_comments/);
    }
    fs.writeFileSync(file, JSON.stringify({ ...config, _comments: example._comments, typoVersion: '2.0.0' }));
    assert.throws(() => buildEnvironment(file, {}), /未知的构建配置字段/);
});

test('检查模式先校验密钥和来源，拒绝冲突目标及不支持的选项', async (t) => {
    const { root, file, config } = fixture(t);
    let builds = 0;
    const dependencies: any = {
        root,
        env: {},
        build: async () => {
            builds++;
        },
    };
    await run(['--config', file, '--mac', '--arm64', '--check'], dependencies);
    assert.equal(builds, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'app/generated/config.json')).toString()).debug.allowRoot, true);
    fs.writeFileSync(path.join(root, 'auth.pem'), auth.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await assert.rejects(run(['--config', file, '--check'], dependencies));
    fs.writeFileSync(path.join(root, 'auth.pem'), trust.authPublicKey);
    fs.writeFileSync(file, JSON.stringify({ ...config, targetUrl: 'https://evil.example' }));
    await assert.rejects(run(['--config', file, '--win'], dependencies));
    assert.equal(builds, 0);
    for (const args of [
        ['--win', '--mac'],
        ['--x64', '--arm64'],
        ['--config'],
        ['--config', '--win'],
        ['--unknown'],
        ['--portable'],
        ['--mac', '--portable'],
        ['--win', '--portable', '--dir'],
    ]) {
        assert.throws(() => parseArgs(args));
    }
    await assert.rejects(run(['--win', '--arm64'], dependencies), /仅支持 x64/);
});
test('macOS 打包无需开发者账号、配置描述文件或原生组件构建', async (t) => {
    const { root, file, config } = fixture(t);
    const pkg = runtimePackage(require(path.join(projectRoot, 'package.json')));
    assert.equal(pkg.build.extraResources, undefined);
    assert.equal(pkg.build.mac.sign, undefined);
    assert.equal(pkg.build.afterSign, undefined);
    const resources = pkg.build.win.extraResources;
    assert.ok(Array.isArray(resources));
    assert.ok(resources.some((resource) => typeof resource !== 'string' && resource.to === 'native'));
    fs.writeFileSync(
        file,
        JSON.stringify({
            ...config,
            macTeamId: 'old-team',
            macHostProfileFile: 'deleted.profile',
            macExtensionProfileFile: 'missing.profile',
            _comments: { macTeamId: 'Retired option' },
        }),
    );
    const env = buildEnvironment(file, {});
    assert.equal(env.PROCTOR_MAC_TEAM_ID, undefined);
    assert.equal(env.PROCTOR_MAC_HOST_PROFILE, undefined);
    const optional = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
    const previous = Object.fromEntries(optional.map((name) => [name, process.env[name]]));
    t.after(() => {
        for (const name of optional) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    });
    for (const name of optional) process.env[name] = '';
    await run(['--config', file, '--mac', '--arm64'], {
        root,
        env: { CSC_LINK: '', CSC_KEY_PASSWORD: '', APPLE_ID: '', APPLE_APP_SPECIFIC_PASSWORD: '', APPLE_TEAM_ID: '' },
        build: async ({ config: settings }: any) => {
            for (const name of optional) assert.equal(process.env[name], undefined);
            assert.equal(settings.mac.identity, '-');
            assert.equal(settings.mac.notarize, false);
            assert.equal(settings.afterPack, undefined);
            await settings.beforePack({
                electronPlatformName: 'darwin',
                arch: 3,
                packager: { appInfo: { version: '1.2.3' } },
            });
            assert.equal(fs.existsSync(path.join(root, 'build/native')), false);
            return ['fixture.dmg', 'fixture.zip'];
        },
    });
    await run(['--config', file, '--mac', '--x64'], {
        root,
        env: { CSC_LINK: 'certificate.p12' },
        build: async ({ config: settings }: any) => {
            assert.equal(settings.mac.identity, undefined);
            assert.equal(settings.mac.notarize, undefined);
            return ['fixture.dmg', 'fixture.zip'];
        },
    });
});

test('空的 Actions 签名凭据不会误解析为证书目录，已配置凭据保留', () => {
    const env: any = {
        CSC_LINK: '',
        CSC_NAME: '  ',
        CSC_KEY_PASSWORD: '',
        CSC_INSTALLER_LINK: '',
        CSC_INSTALLER_KEY_PASSWORD: '',
        WIN_CSC_LINK: '',
        WIN_CSC_KEY_PASSWORD: '',
        APPLE_ID: '',
        APPLE_APP_SPECIFIC_PASSWORD: '',
        APPLE_TEAM_ID: '',
        PROCTOR_ALLOW_ROOT_DEBUG: 'false',
    };
    clearEmptySigningEnvironment(env);
    assert.deepEqual(env, { PROCTOR_ALLOW_ROOT_DEBUG: 'false' });
    const configured: any = {
        CSC_LINK: 'certificate.p12',
        CSC_KEY_PASSWORD: ' password ',
        APPLE_ID: 'test@example.com',
        APPLE_TEAM_ID: 'TEAM123',
        APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
    };
    const copy: any = { ...configured };
    clearEmptySigningEnvironment(copy);
    assert.deepEqual(copy, configured);
});

test('原生构建使用工程根目录和动态版本，打包钩子保留配置中的信任信息', async (t) => {
    const { root, file } = fixture(t);
    await forEachSerial(
        [
            ['--win', '--x64'],
            ['--mac', '--arm64', '--dir'],
            ['--win', '--x64', '--portable'],
        ],
        async (args) => {
            let called = false;
            await run(['--config', file, ...args], {
                root,
                env: { PROCTOR_CLIENT_VERSION: '2.3.4' },
                build: async (options: any) => {
                    called = true;
                    assert.equal(options.projectDir, root);
                    assert.equal(options.publish, 'never');
                    assert.equal(options.config.extraMetadata.version, '2.3.4');
                    const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
                    const { DebugLogger } = require('builder-util');
                    await validateConfiguration(
                        { ...runtimePackage(require(path.join(projectRoot, 'package.json'))).build, ...options.config },
                        new DebugLogger(),
                    );
                    const targets = [...options.targets.entries()];
                    assert.equal(targets[0][0].name, args[0] === '--win' ? 'windows' : 'mac');
                    const architectures = [...targets[0][1].entries()];
                    assert.equal(architectures[0][0], args[0] === '--win' ? 1 : 3);
                    if (args.includes('--dir')) assert.deepEqual(architectures[0][1], ['dir']);
                    if (args.includes('--portable')) assert.deepEqual(architectures[0][1], ['portable']);
                    await options.config.beforePack({ packager: { appInfo: { version: '2.3.4' } } });
                    assert.equal(
                        JSON.parse(fs.readFileSync(path.join(root, 'app/generated/trust.json')).toString()).authPublicKey,
                        trust.authPublicKey,
                    );
                    await assert.rejects(options.config.beforePack({ packager: { appInfo: { version: '1.0.0' } } }), /构建元数据/);
                    return args.includes('--dir') ? [] : ['fixture.exe'];
                },
            });
            assert.ok(called);
        },
    );
});

test('未生成产物时安装包构建不能报告成功，解包构建无需安装包', async (t) => {
    const { root, file } = fixture(t);
    const dependencies: any = { root, env: {}, build: async () => [] };
    await assert.rejects(run(['--config', file, '--mac'], dependencies), /未生成安装包/);
    await assert.rejects(run(['--config', file, '--win'], dependencies), /未生成安装包/);
    await run(['--config', file, '--mac', '--dir'], dependencies);
});

test('打包 Promise 未完成即退出时命令行报告失败，并保留成功和失败退出码', () => {
    const { spawnSync } = require('node:child_process');
    const script = JSON.stringify(path.resolve(__dirname, '../scripts/build.js'));
    for (const [execute, status, message] of [
        ['() => new Promise(() => {})', 1, /构建未完成便提前退出/],
        ['async () => {}', 0, /^$/],
        ['async () => { throw new Error("打包失败"); }', 1, /打包失败/],
    ]) {
        const child = spawnSync(process.execPath, ['-e', `require(${script}).runCli([], ${execute});`], {
            encoding: 'utf8',
            timeout: 10000,
        });
        assert.equal(child.error, undefined);
        assert.equal(child.status, status);
        assert.match(child.stderr, message as RegExp);
    }
});

test('即使存在 Bun 锁文件，npm 客户端仍与父级 Yarn 工作区隔离', async (t) => {
    const parent = workspace(t);
    const root = path.join(parent, 'client');
    fs.mkdirSync(root);
    fs.writeFileSync(
        path.join(parent, 'package.json'),
        JSON.stringify({
            name: 'unrelated-yarn-parent',
            version: '1.0.0',
            workspaces: ['packages/*'],
            packageManager: 'yarn@4.17.0',
            dependencies: { 'parent-only-module': '1.0.0' },
        }),
    );
    fs.writeFileSync(path.join(parent, 'yarn.lock'), '__metadata:\n  version: 8\n');
    const pkg = runtimePackage(require(path.join(projectRoot, 'package.json')));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    fs.writeFileSync(
        path.join(root, 'package-lock.json'),
        JSON.stringify({
            name: pkg.name,
            version: pkg.version,
            lockfileVersion: 3,
            packages: { '': pkg },
        }),
    );
    fs.writeFileSync(path.join(root, 'bun.lock'), '{}');
    const { Packager } = require('app-builder-lib/out/packager');
    const { getCollectorByPackageManager } = require('app-builder-lib/out/node-module-collector');
    const packager = new Packager({ projectDir: root });
    t.after(() => packager.tempDirManager.cleanup());
    assert.equal(await packager.getWorkspaceRoot(), root);
    assert.equal(await packager.getPackageManager(), 'npm');
    const collector = getCollectorByPackageManager(await packager.getPackageManager(), root, packager.tempDirManager);
    const dependencies = await collector.getNodeModules({ packageName: pkg.name });
    assert.deepEqual(dependencies.nodeModules, []);
});

export {};
