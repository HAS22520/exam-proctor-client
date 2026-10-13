import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { validateConfig } from '../app/main/security/config-policy';
import { projectRoot, runtimePackage } from '../scripts/project-layout';
import Updater = require('../app/main/updates/updater');
import { buildArchive, run as buildHotUpdate } from '../scripts/build-hot-update';
import { prepare } from '../scripts/prepare-build';
import { forEachSerial, trust, workspace } from './helpers';

const base: any = {
    exam: { targetUrl: 'https://oj.example.com' },
    updater: { versionUrl: 'https://oj.example.com/version.json', enabled: true },
    debug: { allowRoot: false },
};
const environment: any = {
    PROCTOR_AUTH_PUBLIC_KEY: trust.authPublicKey,
    PROCTOR_LOG_PUBLIC_KEY: trust.logPublicKey,
    PROCTOR_KEY_ID: trust.keyId,
    PROCTOR_ALLOWED_ORIGINS: '["https://oj.example.com"]',
    PROCTOR_UPDATE_ORIGINS: '["https://oj.example.com"]',
    PROCTOR_CLIENT_VERSION: '1.2.3',
    PROCTOR_CLIENT_BUILD_VERSION: '2026101001',
};
test('缺少公钥时构建失败，支持动态版本和来源，归档保留根元数据和入口', async (t) => {
    const root = workspace(t);
    fs.mkdirSync(path.join(root, 'config'));
    fs.mkdirSync(path.join(root, 'app/main'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config/exam-config.json'), JSON.stringify(base));
    fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '1.0.0', buildVersion: '2026101001', main: 'app/main/index.js' }),
    );
    fs.writeFileSync(path.join(root, 'app/main/index.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(root, '.env'), 'PRIVATE_BUILD_SECRET');
    assert.throws(() => prepare({}, root));
    for (const field of ['PROCTOR_AUTH_PUBLIC_KEY', 'PROCTOR_LOG_PUBLIC_KEY', 'PROCTOR_KEY_ID']) {
        assert.throws(() => prepare({ ...environment, [field]: '' }, root));
    }
    const { version, config } = prepare({ ...environment, PROCTOR_ALLOW_ROOT_DEBUG: 'true' }, root);
    assert.equal(version, '1.2.3');
    assert.ok(config.debug.allowRoot);
    assert.throws(() => prepare({ ...environment, PROCTOR_TARGET_URL: 'https://evil.example' }, root));
    const result = await buildArchive(environment, root);
    const asar = require('@electron/asar');
    const pkg = JSON.parse(asar.extractFile(result.filename, 'package.json').toString());
    assert.equal(pkg.version, '1.2.3');
    assert.equal(pkg.main, 'app/main/index.js');
    assert.equal(asar.extractFile(result.filename, path.normalize(pkg.main)).toString(), 'module.exports = 1;');
    assert.ok(!asar.listPackage(result.filename).includes(path.join(path.sep, '.env')));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(result.filename)).digest('hex'), result.sha256);
});
test('更新器实际回退，下载发布前校验字节数及哈希', async (t) => {
    const config = validateConfig(base, trust);
    const directory = workspace(t);
    const bytes = Buffer.from('archive-bytes');
    const calls = [];
    const fetch = async (url) => {
        calls.push(String(url));
        return String(url).endsWith('/bad') ? new Response('failed', { status: 503 }) : new Response(bytes);
    };
    const updater = new Updater(config, { directory, trust, version: '1.0.0', fetch });
    const info: any = {
        asarUrl: 'https://oj.example.com/bad',
        fallbackUrl: 'https://oj.example.com/good',
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
    const filename = path.join(directory, 'archive');
    await updater.downloadPackage(info, filename);
    assert.deepEqual(fs.readFileSync(filename), bytes);
    assert.equal(calls.length, 2);
    fs.rmSync(filename);
    await assert.rejects(updater.downloadPackage({ ...info, sha256: '0'.repeat(64) }, filename));
    assert.ok(!fs.existsSync(filename));
    await assert.rejects(updater.downloadPackage({ ...info, size: bytes.length - 1 }, filename));
    assert.ok(!fs.existsSync(filename));
});
test('ASAR 命令从 JSON 解析相对公钥路径，环境变量覆盖归档元数据', async (t) => {
    const root = workspace(t);
    const configDirectory = path.join(root, 'config');
    fs.mkdirSync(configDirectory);
    fs.mkdirSync(path.join(root, 'app/main'), { recursive: true });
    fs.writeFileSync(path.join(configDirectory, 'exam-config.json'), JSON.stringify(base));
    fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '1.0.0', buildVersion: '2026101001', main: 'app/main/index.js' }),
    );
    fs.writeFileSync(path.join(root, 'app/main/index.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(configDirectory, 'auth.pem'), trust.authPublicKey);
    fs.writeFileSync(path.join(configDirectory, 'log.pem'), trust.logPublicKey);
    const configFile = path.join(configDirectory, 'build.local.json');
    fs.writeFileSync(
        configFile,
        JSON.stringify({
            keyId: trust.keyId,
            version: '1.2.3',
            authPublicKeyFile: 'auth.pem',
            logPublicKeyFile: 'log.pem',
            allowedOrigins: ['https://oj.example.com'],
            updateOrigins: ['https://oj.example.com'],
            allowRootDebug: true,
        }),
    );
    const result = await buildHotUpdate(['--config', configFile], {
        env: { PROCTOR_CLIENT_VERSION: '1.2.4' },
        root,
        log: () => {},
    });
    assert.equal(result.version, '1.2.4');
    const asar = require('@electron/asar');
    assert.equal(JSON.parse(asar.extractFile(result.filename, 'package.json').toString()).version, '1.2.4');
    assert.equal(
        JSON.parse(asar.extractFile(result.filename, path.join('app', 'generated', 'config.json')).toString()).debug.allowRoot,
        true,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'updates/app-1.2.4-2026101001.json')).toString()), {
        version: result.version,
        buildVersion: '2026101001',
        signed: false,
        size: result.size,
        sha256: result.sha256,
    });
    assert.ok(!asar.listPackage(result.filename).some((file) => /build\.local\.json|\.pem$/.test(file)));
    await assert.rejects(buildHotUpdate(['--win'], { env: {}, root }), /不支持的 ASAR 构建选项/);
    await assert.rejects(buildHotUpdate(['--config'], { env: {}, root }), /必须指定且只能指定一个/);
    const help = [];
    await buildHotUpdate(['--help'], { env: {}, log: (value) => help.push(value) });
    assert.match(help[0], /release:hot/);
});
test('更新重定向不能逃出白名单或降级 HTTPS，无长度头时仍限制大小', async (t) => {
    const config = validateConfig(base, trust);
    const directory = workspace(t);
    await forEachSerial(['https://evil.example/file', 'http://oj.example.com/file'], async (redirect) => {
        const updater = new Updater(config, {
            directory,
            trust,
            version: '1.0.0',
            fetch: async () => new Response('', { status: 302, headers: { location: redirect } }),
        });
        await assert.rejects(updater.json('https://oj.example.com/version.json'));
    });
    const updater = new Updater(config, {
        directory,
        trust,
        version: '1.0.0',
        fetch: async () => new Response('a'.repeat(256 * 1024 + 1)),
    });
    await assert.rejects(updater.json('https://oj.example.com/version.json'));
});
test('未签名 ASAR 不执行，最低版本限制证明，远端配置不能开启 root 调试', async (t) => {
    const directory = workspace(t);
    const config = validateConfig(base, trust);
    const manifest: any = {
        version: '1.2.3',
        minClientVersion: '1.2.0',
        hotUpdate: { version: '1.2.3', asarUrl: 'https://evil.example/payload' },
        config: { url: 'https://oj.example.com/config.json' },
    };
    const updater = new Updater(config, {
        directory,
        trust,
        version: '1.0.0',
        fetch: async (url) =>
            new Response(JSON.stringify(String(url).endsWith('config.json') ? { ...base, debug: { allowRoot: true } } : manifest)),
    });
    await updater.check();
    assert.ok(updater.minimumBlocked);
    assert.equal(updater.snapshot().canHotUpdate, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'config/exam-config.json')).toString()).debug.allowRoot, false);
    assert.ok(!fs.existsSync(path.join(directory, 'app.asar')));
});
test('原生构建配置有效，安装版与便携版产物名称独立', async () => {
    const pkg = runtimePackage(require(path.join(projectRoot, 'package.json')));
    const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
    const { expandMacro } = require('app-builder-lib/out/util/macroExpander');
    const { DebugLogger } = require('builder-util');
    await validateConfiguration(pkg.build, new DebugLogger());
    const expand = (pattern, os, ext) => expandMacro(pattern, 'x64', { version: '1.2.3' }, { os, ext });
    const installer = expand(pkg.build.nsis.artifactName, 'win', 'exe');
    const portable = expand(pkg.build.portable.artifactName, 'win', 'exe');
    assert.notEqual(installer, portable);
    assert.equal(installer, 'HydroProctor-1.2.3-win-x64-setup.exe');
    assert.equal(expand(pkg.build.artifactName, 'mac', 'dmg'), 'HydroProctor-1.2.3-mac-x64.dmg');
});

export {};
