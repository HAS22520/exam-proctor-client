import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { validateConfig } from '../app/main/security/config-policy';
import { buildVersion } from '../app/main/updates/build-version';
import { readArchive, verifyArchive } from '../app/main/updates/signed-archive';
import { hasUnfinishedJournals, journalUpdateState, UpdateCache } from '../app/main/updates/update-cache';
import Updater = require('../app/main/updates/updater');
import { buildArchive } from '../scripts/build-hot-update';
import { prepare } from '../scripts/prepare-build';
import { forEachSerial, trust, workspace } from './helpers';

const updatesKey = crypto.generateKeyPairSync('ed25519');
const updatePublicKey = updatesKey.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const updatePrivateKey = updatesKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const base: any = {
    exam: { targetUrl: 'https://oj.example.com' },
    updater: { enabled: true, versionUrl: 'https://oj.example.com/version.json' },
    debug: { allowRoot: false },
};
const environment: any = {
    PROCTOR_AUTH_PUBLIC_KEY: trust.authPublicKey,
    PROCTOR_LOG_PUBLIC_KEY: trust.logPublicKey,
    PROCTOR_KEY_ID: trust.keyId,
    PROCTOR_UPDATE_PUBLIC_KEY: updatePublicKey,
    PROCTOR_UPDATE_PRIVATE_KEY: updatePrivateKey,
    PROCTOR_ALLOWED_ORIGINS: '["https://oj.example.com"]',
    PROCTOR_UPDATE_ORIGINS: '["https://oj.example.com"]',
    PROCTOR_CLIENT_VERSION: '1.0.0',
    PROCTOR_CLIENT_BUILD_VERSION: '2026101001',
};
function fixture(t) {
    const root = workspace(t);
    const directory = workspace(t);
    fs.mkdirSync(path.join(root, 'config'));
    fs.mkdirSync(path.join(root, 'app/main'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config/exam-config.json'), JSON.stringify(base));
    fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({
            name: 'test-update',
            version: '1.0.0',
            buildVersion: '2026101001',
            main: 'app/main/bootstrap.js',
            devDependencies: { electron: '44.7.0' },
        }),
    );
    fs.writeFileSync(path.join(root, 'app/main/index.js'), 'module.exports = "signed application entry";');
    fs.writeFileSync(path.join(root, 'app/main/bootstrap.js'), 'require("./index");');
    const prepared = prepare(environment, root);
    const config: any = { ...prepared.config };
    delete config.trust;
    return {
        root,
        directory,
        anchor: {
            trust: prepared.trust,
            config,
            identity: { version: prepared.version, buildVersion: prepared.buildVersion, nativeNetworkVersion: 2 },
            electronVersion: '44.7.0',
        },
    };
}
async function release(f, extra: any = {}) {
    return buildArchive({ ...environment, PROCTOR_CLIENT_BUILD_VERSION: '2026101002', ...extra }, f.root);
}
function unfinished(f, phase = 'open') {
    const journal = path.join(f.directory, 'journals', 'a'.repeat(64));
    fs.mkdirSync(journal, { recursive: true });
    fs.writeFileSync(path.join(journal, 'state.json'), JSON.stringify({ phase }));
    return journal;
}

test('构建编号校验真实日期，拒绝数字类型及语义版本', () => {
    for (const value of ['2026101001', '2024022900', '2026123199']) assert.equal(buildVersion(value), value);
    for (const value of [2026101001, '1.0.0', '', '202610100', '2026131001', '2026022901', '2026100001']) {
        assert.throws(() => buildVersion(value));
    }
});
test('仅构建编号决定是否更新，同版或旧版清单仍刷新策略和远端配置', async (t) => {
    const directory = workspace(t);
    const config = validateConfig(base, trust);
    let manifest: any = {
        version: '0.9.0',
        buildVersion: '2026101002',
        minClientVersion: '1.1.0',
        config: { url: 'https://oj.example.com/config.json' },
    };
    const updater = new Updater(config, {
        directory,
        trust,
        version: '1.0.0',
        buildVersion: '2026101001',
        fetch: async (url) =>
            new Response(JSON.stringify(String(url).endsWith('/config.json') ? { ...base, window: { width: 1300 } } : manifest)),
    });
    await updater.check();
    assert.equal(updater.snapshot().available, true);
    assert.equal(updater.minimumBlocked, true);
    assert.equal(updater.snapshot().version, '1.0.0');
    assert.equal(updater.snapshot().buildVersion, '2026101001');
    manifest = { ...manifest, version: '9.0.0', buildVersion: '2026101001', minClientVersion: '0.9.0' };
    await updater.check();
    assert.equal(updater.snapshot().available, false);
    assert.equal(updater.minimumBlocked, false);
    assert.equal(JSON.parse(fs.readFileSync(updater.policyPath).toString()).buildVersion, '2026101001');
    assert.ok(fs.existsSync(path.join(directory, 'config/exam-config.json')));
    manifest = { ...manifest, buildVersion: '2026100901' };
    await updater.check();
    assert.equal(updater.snapshot().phase, 'current');
    await forEachSerial([undefined, 2026101003, 'bad'], async (value) => {
        manifest = { ...manifest, buildVersion: value };
        await updater.check();
        assert.equal(updater.snapshot().phase, 'incompatible');
        assert.equal(updater.snapshot().available, false);
    });
    const legacy = new Updater(config, {
        directory: workspace(t),
        trust,
        version: '0.1.0',
        fetch: async () => new Response(JSON.stringify({ version: '1.0.0', buildVersion: '2026101002' })),
    });
    await legacy.check();
    assert.equal(legacy.snapshot().phase, 'incompatible');
});
test('外站安装包被禁用，不影响有效清单，也不允许外站 ASAR 下载', async (t) => {
    const directory = workspace(t);
    const config = validateConfig(base, trust);
    const requested = [];
    const manifest: any = {
        version: '1.0.0',
        buildVersion: '2026101002',
        fullUpdate: {
            platforms: { [process.platform]: { [process.arch]: { installerUrl: 'https://qfile.qq.com/package' } } },
        },
        hotUpdate: { version: '1.0.0', asarUrl: 'https://oj.example.com/app.asar', size: 1, sha256: 'a'.repeat(64) },
    };
    const updater = new Updater(config, {
        directory,
        trust,
        version: '1.0.0',
        buildVersion: '2026101001',
        cache: {} as any,
        fetch: async (url) => {
            requested.push(String(url));
            return new Response(JSON.stringify(manifest));
        },
    });
    await updater.check();
    assert.equal(updater.snapshot().phase, 'available');
    assert.equal(updater.snapshot().canHotUpdate, true);
    assert.equal(updater.snapshot().installerUrl, '');
    assert.match(updater.snapshot().installerWarning, /https:\/\/qfile.qq.com/);
    assert.equal(requested.length, 1);
    await assert.rejects(updater.response('https://qfile.qq.com/app.asar', 10), (error: any) => error.code === 'UPDATE_ORIGIN_DENIED');
    assert.equal(requested.length, 1);
    manifest.fullUpdate.platforms[process.platform][process.arch].installerUrl = 'https://oj.example.com/setup.exe';
    await updater.check();
    assert.equal(updater.snapshot().installerWarning, '');
    assert.equal(updater.snapshot().installerUrl, 'https://oj.example.com/setup.exe');
});
test('真实 ASAR 包含发布签名且不含私钥，篡改字节即使外部哈希一致也被拒绝', async (t) => {
    const f = fixture(t);
    const result = await release(f);
    await verifyArchive(result.filename, result, f.anchor);
    const archive = readArchive(result.filename);
    assert.equal(archive.pkg.main, 'app/main/bootstrap.js');
    assert.equal(archive.release.payload.buildVersion, '2026101002');
    assert.equal(fs.readFileSync(result.filename).includes(Buffer.from('BEGIN PRIVATE KEY')), false);
    const entry = archive.files.get('app/main/index.js');
    const bytes = fs.readFileSync(result.filename);
    bytes[entry.start] ^= 1;
    fs.writeFileSync(result.filename, bytes);
    await assert.rejects(
        verifyArchive(result.filename, { ...result, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, f.anchor),
        /文件签名校验失败/,
    );
});
test('签名归档不能更改信任密钥、白名单、调试权限、身份或 Electron 运行时', async (t) => {
    const f = fixture(t);
    const result = await release(f);
    await forEachSerial(
        [
            { ...f.anchor, electronVersion: '45.0.0' },
            { ...f.anchor, trust: { ...f.anchor.trust, updatePublicKey: trust.authPublicKey } },
            { ...f.anchor, trust: { ...f.anchor.trust, updatePublicKey: '' } },
        ],
        async (anchor) => {
            await assert.rejects(verifyArchive(result.filename, result, anchor));
        },
    );
    await assert.rejects(verifyArchive(result.filename, { ...result, buildVersion: '2026101003' }, f.anchor), /不匹配/);
    const debug = await release(f, { PROCTOR_ALLOW_ROOT_DEBUG: 'true' });
    await assert.rejects(verifyArchive(debug.filename, debug, f.anchor), /调试权限/);
    const origins = await release(f, {
        PROCTOR_ALLOWED_ORIGINS: '["https://oj.example.com","https://other.example.com"]',
    });
    await assert.rejects(verifyArchive(origins.filename, origins, f.anchor), /白名单/);
    const unsigned = await release(f, { PROCTOR_UPDATE_PRIVATE_KEY: '' });
    await assert.rejects(verifyArchive(unsigned.filename, unsigned, f.anchor), /发布签名/);
    await assert.rejects(release(f, { PROCTOR_UPDATE_PRIVATE_KEY: '', PROCTOR_REQUIRE_SIGNED_UPDATE: 'true' }), /需要设置/);
    await assert.rejects(
        release(f, {
            PROCTOR_UPDATE_PRIVATE_KEY: crypto
                .generateKeyPairSync('ed25519')
                .privateKey.export({ type: 'pkcs8', format: 'pem' })
                .toString(),
        }),
        /私钥与内置公钥不匹配/,
    );
});

test('原生网络组件需先安装完整包，再应用兼容的 ASAR 更新', async (t) => {
    const f = fixture(t);
    const result = await release(f);
    const old: any = { ...f.anchor, identity: { version: '1.0.0', buildVersion: '2026101001' } };
    await assert.rejects(verifyArchive(result.filename, result, old), /系统网络组件不兼容.*完整安装包/);
    await verifyArchive(result.filename, result, f.anchor);
});
test('签名更新保留自定义软件名称，更名必须使用完整安装包', async (t) => {
    const f = fixture(t);
    const productName = '计算机学院监考客户端';
    const result = await release(f, { PROCTOR_PRODUCT_NAME: productName });
    const anchor = { ...f.anchor, identity: { ...f.anchor.identity, productName } };
    await verifyArchive(result.filename, result, anchor);
    assert.equal(readArchive(result.filename).identity.productName, productName);
    const cache = new UpdateCache(f.directory, anchor);
    await cache.stage(result, result.filename);
    assert.equal((await cache.select()).buildVersion, result.buildVersion);
    await assert.rejects(verifyArchive(cache.filename(result), result, f.anchor), /软件名称.*完整安装包/);
});
test('校验后的下载等待下次启动，首次启动失败回退，成功后确认实际身份', async (t) => {
    const f = fixture(t);
    const result = await release(f);
    const cache = new UpdateCache(f.directory, f.anchor);
    await cache.stage(result, result.filename);
    assert.equal(cache.read('active'), null);
    assert.equal(cache.anchor.identity.buildVersion, '2026101001');
    assert.equal((await cache.select()).buildVersion, '2026101002');
    assert.ok(cache.read('launch'));
    assert.equal(await cache.select(), null);
    assert.match(cache.read('failure').message, /回退/);
    cache.write('pending', result);
    assert.equal((await cache.select()).buildVersion, '2026101002');
    cache.ready();
    assert.equal(cache.read('launch'), null);
    assert.equal((await cache.select()).buildVersion, '2026101002');
    const next = await release(f, { PROCTOR_CLIENT_BUILD_VERSION: '2026101003' });
    await cache.stage(next, next.filename);
    assert.equal((await cache.select()).buildVersion, '2026101003');
    cache.rollback('test crash');
    assert.equal((await cache.select()).buildVersion, '2026101002');
});
test('未结束日志阻止暂存和激活，已激活归档仍可用于恢复考试', async (t) => {
    const f = fixture(t);
    const result = await release(f);
    const cache = new UpdateCache(f.directory, f.anchor);
    const journal = unfinished(f);
    assert.equal(hasUnfinishedJournals(f.directory), true);
    await forEachSerial(['open', 'closing', 'pending-upload', 'unknown', undefined], async (phase) => {
        fs.writeFileSync(path.join(journal, 'state.json'), JSON.stringify({ phase }));
        await assert.rejects(cache.stage(result, result.filename), /监考日志/);
    });
    fs.writeFileSync(path.join(journal, 'state.json'), JSON.stringify({ phase: 'uploaded' }));
    await cache.stage(result, result.filename);
    fs.writeFileSync(path.join(journal, 'state.json'), '{broken');
    assert.equal(await cache.select(), null);
    assert.ok(cache.read('pending'));
    fs.writeFileSync(path.join(journal, 'state.json'), JSON.stringify({ phase: 'uploaded' }));
    assert.equal((await cache.select()).buildVersion, '2026101002');
    cache.ready();
    fs.writeFileSync(path.join(journal, 'state.json'), JSON.stringify({ phase: 'open' }));
    assert.equal((await cache.select()).buildVersion, '2026101002');
});
test('更新阻止状态区分跨账号未完成日志、Finder 元数据和已上传证据', (t) => {
    const directory = workspace(t);
    const journals = path.join(directory, 'journals');
    assert.equal(journalUpdateState(directory).blocked, false);
    fs.mkdirSync(journals);
    fs.writeFileSync(path.join(journals, '.DS_Store'), 'Finder metadata');
    fs.writeFileSync(path.join(journals, 'notes.txt'), 'not an attempt');
    fs.mkdirSync(path.join(journals, 'metadata'));
    assert.equal(hasUnfinishedJournals(directory), false);
    const save = (id, state) => {
        const folder = path.join(journals, id.repeat(64));
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'state.json'), JSON.stringify(state));
    };
    save('a', { phase: 'open', binding: { uid: 7 } });
    save('b', { phase: 'closing', binding: { uid: 8 } });
    save('c', { phase: 'pending-upload', binding: { uid: 8 } });
    save('d', { phase: 'uploaded', binding: { uid: 9 } });
    fs.mkdirSync(path.join(journals, 'e'.repeat(64))); // 真实会话损坏并缺少状态。
    save('f', { phase: 'unknown' });
    const status = journalUpdateState(directory);
    assert.equal(status.open, 1);
    assert.equal(status.pending, 2);
    assert.equal(status.unreadable, 2);
    assert.equal(status.blocked, true);
    assert.match(status.message, /1 份未结束、2 份待上传、2 份需恢复/);
    assert.match(status.message, /本机所有账号/);
    assert.match(status.message, /补传日志/);
    assert.match(status.message, /退出但不上传/);
    fs.writeFileSync(path.join(journals, 'e'.repeat(64), 'state.json'), '{broken');
    assert.equal(journalUpdateState(directory).unreadable, 2);
});
test('更新可用状态与日志阻止状态独立，上传后立即解除阻止', (t) => {
    const directory = workspace(t);
    const config = validateConfig(base, trust);
    const updater = new Updater(config, {
        directory,
        trust,
        version: '1.0.0',
        buildVersion: '2026101001',
        cache: {} as any,
    });
    updater.manifest = { hotUpdate: { asarUrl: 'https://oj.example.com/update.asar' } } as any;
    updater.state = { phase: 'available', available: true, message: '发现新版本' };
    const journal = unfinished({ directory });
    const blocked = updater.snapshot();
    assert.equal(blocked.phase, 'available');
    assert.equal(blocked.canHotUpdate, true);
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.journalCounts.open, 1);
    assert.match(blocked.blockedReason, /上传并结束/);
    fs.writeFileSync(path.join(journal, 'state.json'), JSON.stringify({ phase: 'pending-upload' }));
    assert.equal(updater.snapshot().journalCounts.pending, 1);
    assert.match(updater.snapshot().blockedReason, /补传日志/);
    fs.writeFileSync(path.join(journal, 'state.json'), JSON.stringify({ phase: 'uploaded' }));
    const ready = updater.snapshot();
    assert.equal(ready.blocked, false);
    assert.equal(ready.blockedReason, '');
    assert.deepEqual(ready.journalCounts, { open: 0, pending: 0, unreadable: 0 });
    assert.equal(ready.phase, 'available');
    assert.equal(ready.canHotUpdate, true);
});
test('更新器下载并暂存签名 ASAR，报告进度、保留运行版本并重查日志状态', async (t) => {
    const f = fixture(t);
    const result = await release(f);
    const cache = new UpdateCache(f.directory, f.anchor);
    const states = [];
    const bytes = fs.readFileSync(result.filename);
    const manifest: any = {
        version: result.version,
        buildVersion: result.buildVersion,
        hotUpdate: { ...result, asarUrl: 'https://oj.example.com/update.asar' },
    };
    const updater = new Updater(validateConfig(base, f.anchor.trust), {
        directory: f.directory,
        trust: f.anchor.trust,
        ...f.anchor.identity,
        cache,
        onStatus: (state) => states.push(state),
        fetch: async (url) => new Response(String(url).endsWith('.asar') ? bytes : JSON.stringify(manifest)),
    });
    await updater.check();
    await updater.stage();
    assert.equal(updater.snapshot().phase, 'ready');
    assert.equal(updater.snapshot().buildVersion, '2026101001');
    assert.equal(cache.read('active'), null);
    assert.equal(cache.read('pending').buildVersion, '2026101002');
    assert.ok(states.some((state) => state.phase === 'downloading' && state.percent === 100));
    unfinished(f);
    await assert.rejects(updater.stage(), /监考日志/);
});

test('安装包加载器选择缓存 ASAR 并展示实际版本，加载失败后重启旧构建', async (t) => {
    const { runInNewContext } = require('node:vm');
    const f = fixture(t);
    const result = await release(f, { PROCTOR_CLIENT_VERSION: '0.9.0' });
    const cache = new UpdateCache(f.directory, f.anchor);
    await cache.stage(result, result.filename);
    // 原安装包加载器的生成文件属于固定的完整构建元数据。
    for (const [name, value] of [
        ['build', f.anchor.identity],
        ['trust', f.anchor.trust],
        ['config', f.anchor.config],
    ]) {
        fs.writeFileSync(path.join(f.root, `app/generated/${name}.json`), JSON.stringify(value));
    }
    const source = fs.readFileSync(path.resolve(__dirname, '../app/main/bootstrap.js'), 'utf8');
    async function boot(fail = false) {
        let resolve;
        const done = new Promise((r) => {
            resolve = r;
        });
        const loaded = [];
        const context: any = {
            exports: {},
            JSON,
            __dirname: path.join(f.root, 'app/main'),
            process: { versions: { electron: '44.7.0' } },
        };
        let relaunch = 0;
        const app: any = {
            setName: () => {},
            setPath: () => {},
            requestSingleInstanceLock: () => true,
            getPath: () => f.directory,
            whenReady: async () => {},
            relaunch: () => {
                relaunch++;
            },
            exit: () => resolve(),
        };
        context.require = (name) => {
            if (name === '../shared/branding') return require('../app/shared/branding');
            if (name === './storage') {
                return {
                    configureStorage: () => ({ root: f.directory, directory: f.directory, previous: f.directory }),
                    migrateStorage: async () => {},
                    restoreBrowserProfile: async () => {},
                };
            }
            if (name === './windows/dialog-service') return { DialogService: class {} };
            if (name === 'electron') return { app, dialog: { showErrorBox: (_title, message) => assert.fail(message) } };
            if (name === './updates/update-cache') return require('../app/main/updates/update-cache');
            if (name === './updates/signed-archive') return require('../app/main/updates/signed-archive');
            if (name === './index' || name.endsWith(path.join('.asar', 'app', 'main', 'index.js'))) {
                loaded.push(name);
                if (fail) throw new Error('更新后的主入口损坏');
                context.__hydroProctorRuntime.markReady();
                resolve();
                return {};
            }
            return require(name);
        };
        runInNewContext(source, context);
        await done;
        return { loaded, runtime: context.__hydroProctorRuntime, relaunch };
    }
    const updated = await boot();
    assert.ok(updated.loaded[0].endsWith(path.join('.asar', 'app', 'main', 'index.js')));
    assert.equal(updated.runtime.source, 'asar');
    assert.deepEqual({ ...updated.runtime.identity }, { version: '0.9.0', buildVersion: '2026101002', nativeNetworkVersion: 2 });
    const next = await release(f, { PROCTOR_CLIENT_BUILD_VERSION: '2026101003' });
    await cache.stage(next, next.filename);
    // release() 会重写构建文件，因此再次恢复原安装身份。
    fs.writeFileSync(path.join(f.root, 'app/generated/build.json'), JSON.stringify(f.anchor.identity));
    const failed = await boot(true);
    assert.equal(failed.relaunch, 1);
    assert.equal(cache.read('active').buildVersion, '2026101002');
    const restored = await boot();
    assert.equal(restored.runtime.identity.buildVersion, '2026101002');
});

test('完整客户端源码生成签名代码归档，并按原安装包信任信息校验', async (t) => {
    const { stageProject } = require('../scripts/build-docker');
    const root = workspace(t);
    stageProject(path.resolve(__dirname, '..'), root);
    const prepared = prepare(environment, root);
    const anchor: any = {
        trust: prepared.trust,
        config: prepared.config,
        identity: { version: prepared.version, buildVersion: prepared.buildVersion, nativeNetworkVersion: 2 },
        electronVersion: '44.7.0',
    };
    const result = await buildArchive({ ...environment, PROCTOR_CLIENT_BUILD_VERSION: '2026101002' }, root);
    await verifyArchive(result.filename, result, anchor);
    const archive = readArchive(result.filename);
    assert.ok(archive.files.has('app/main/bootstrap.js'));
    assert.ok(archive.files.has('app/preload/preload.js'));
    assert.equal(
        [...archive.files.keys()].some((file) => file.startsWith('scripts/')),
        false,
    );
    assert.equal(
        [...archive.files.keys()].some((file) => /\.(?:ts|map)$/.test(file)),
        false,
    );
    for (const entry of ['app/main/index.js', 'app/preload/debug.js', 'app/preload/upload.js', 'app/preload/waiting.js']) {
        assert.ok(archive.files.has(entry), `缺少编译入口：${entry}`);
    }
    for (const page of ['console', 'dialog', 'upload', 'waiting']) {
        assert.ok(archive.files.has(`app/renderer/${page}.html`));
        assert.ok(archive.files.has(`app/renderer/entries/${page}.js`));
    }
    const bytes = fs.readFileSync(result.filename);
    for (const [name, entry] of archive.files) {
        if (!name.endsWith('.js')) continue;
        const source = bytes.subarray(entry.start, entry.start + entry.size).toString();
        for (const [, specifier] of source.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
            assert.ok(
                [target, `${target}.js`, `${target}/index.js`].some((candidate) => archive.files.has(candidate)),
                `${name} 引用了发布包中缺失的模块：${specifier}`,
            );
        }
    }
});

test('更新密钥工具在仓库外生成独立密钥，并保留已有发布信任', (t) => {
    const { run } = require('../scripts/update-keys');
    const directory = path.join(workspace(t), 'keys');
    const result = run(['--out-dir', directory]);
    const privateKey = fs.readFileSync(result.privateFile, 'utf8');
    const publicKey = fs.readFileSync(result.publicFile, 'utf8');
    assert.equal(crypto.createPrivateKey(privateKey).asymmetricKeyType, 'ed25519');
    const bytes = Buffer.from('release proof');
    assert.ok(crypto.verify(null, bytes, publicKey, crypto.sign(null, bytes, privateKey)));
    assert.notEqual(publicKey, trust.authPublicKey);
    assert.throws(() => run(['--out-dir', directory]), /文件已存在/);
    assert.equal(fs.readFileSync(result.privateFile, 'utf8'), privateKey);
    assert.throws(() => run(['--out-dir', path.resolve(__dirname, '../app/generated')]), /仓库之外/);
});

test('ASAR 签名前拒绝公钥、无效 PEM 和 RSA，不提前创建发布文件', async (t) => {
    const f = fixture(t);
    await assert.rejects(release(f, { PROCTOR_UPDATE_PRIVATE_KEY: updatePublicKey }), /需要更新签名私钥.*传入了公钥/);
    await assert.rejects(release(f, { PROCTOR_UPDATE_PRIVATE_KEY: 'broken private PEM' }), /完整、未加密.*PKCS#8/);
    const { logs } = require('./helpers');
    await assert.rejects(
        release(f, { PROCTOR_UPDATE_PRIVATE_KEY: logs.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }),
        /Ed25519.*RSA/,
    );
    assert.equal(fs.existsSync(path.join(f.root, 'updates')), false);
});

export {};
