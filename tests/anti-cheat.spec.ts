import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

function fixture(platform) {
    const events = [];
    const commands = [];
    const shortcuts = [];
    const screen: any = new EventEmitter();
    const window: any = new EventEmitter();
    screen.getAllDisplays = () => [{}, {}];
    window.isDestroyed = () => false;
    window.focus = () => events.push({ type: 'FOCUS' });
    window.restore = () => events.push({ type: 'RESTORE' });
    const mocks: any = {
        electron: {
            screen,
            globalShortcut: {
                register: (value) => {
                    shortcuts.push(value);
                    return true;
                },
                unregister: () => {},
            },
        },
        './process-scanner': require('../app/main/security/process-scanner'),
        'node:child_process': {
            execFile: (file, args, options, callback) => {
                commands.push({ file, args });
                if (file === '/bin/ps') callback(null, '123 ForbiddenApp\n');
                else if (file === 'tasklist.exe') callback(null, '"ForbiddenApp","123"\n');
                else callback(null, '');
            },
        },
    };
    const module: any = { exports: {} };
    runInNewContext(fs.readFileSync(path.resolve(__dirname, '../app/main/security/anti-cheat.js'), 'utf8'), {
        module,
        require: (name) => mocks[name] || require(name),
        process: { platform, pid: 999 },
        setInterval: () => ({ unref() {} }),
        clearInterval: () => {},
        setTimeout, clearTimeout,
    });
    const AntiCheatGuard = module.exports;
    const guard = new AntiCheatGuard(
        window,
        {
            window: { preventMinimize: true },
            antiCheat: {
                blockShortcuts: ['Alt+Tab'],
                singleScreenOnly: true,
                terminateBlacklisted: true,
                processBlacklistByPlatform: { darwin: ['ForbiddenApp'], win32: ['ForbiddenApp'] },
            },
        },
        { logViolation: (event) => events.push(event) },
        { scanner: {
            snapshot: async () => {
                commands.push({ file: 'native-snapshot' }); return [{
                    pid: 123, name: 'ForbiddenApp', path: 'C:/ForbiddenApp', originalName: '', sha256: '', signed: false, created: '1',
                }];
            },
            terminate: async () => { commands.push({ file: 'native-terminate' }); },
            close() {},
        } },
    );
    return { guard, events, commands, shortcuts, window };
}

test('macOS 记录焦点、屏幕和进程，不拦截快捷键或终止应用', () => {
    const f = fixture('darwin');
    f.guard.start();
    f.window.emit('blur');
    f.window.emit('minimize');
    assert.deepEqual(f.shortcuts, []);
    assert.deepEqual(
        f.commands.map((command) => command.file),
        ['/bin/ps'],
    );
    for (const type of ['WINDOW_BLUR', 'WINDOW_MINIMIZED', 'MULTI_SCREEN_DETECTED', 'FORBIDDEN_PROCESS']) {
        assert.ok(f.events.some((event) => event.type === type));
    }
    assert.ok(f.events.every((event) => !['FOCUS', 'RESTORE', 'PROCESS_TERMINATED'].includes(event.type)));
    f.guard.stop();
    const count = f.events.length;
    f.window.emit('blur');
    assert.equal(f.events.length, count);
});

test('Windows 使用常驻扫描，延迟恢复焦点并保留明确配置的进程终止', async () => {
    const f = fixture('win32');
    f.guard.start();
    f.window.emit('blur');
    f.window.emit('minimize');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(f.shortcuts, ['Alt+Tab']);
    assert.deepEqual(
        f.commands.map((command) => command.file),
        ['native-snapshot', 'native-terminate'],
    );
    assert.ok(f.events.some((event) => event.type === 'FOCUS'));
    assert.ok(f.events.some((event) => event.type === 'RESTORE'));
    f.guard.stop();
});

export {};

test('弹窗打开后取消尚未执行的焦点恢复，不与弹窗争抢前台', async () => {
    const f = fixture('win32');
    f.guard.start();
    f.window.emit('blur');
    assert.equal(f.events.some((event) => event.type === 'FOCUS'), false);
    f.guard.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.events.some((event) => event.type === 'FOCUS'), false);
});

test('检测重命名的已签名工具及已知哈希，不把未知软件或伪造产品名当作作弊', () => {
    const f = fixture('win32');
    const hash = 'a'.repeat(64);
    const entry = {
        pid: 321, created: '123', path: 'C:/renamed.exe', name: 'calculator.exe',
        originalName: 'ForbiddenApp', sha256: hash, signed: true,
    };
    f.guard.inspectProcesses([entry]);
    assert.equal(f.events.filter((event) => event.type === 'FORBIDDEN_PROCESS').length, 1);
    f.guard.inspectProcesses([{ ...entry, pid: 322, originalName: '', signed: false }]);
    assert.equal(f.events.filter((event) => event.type === 'FORBIDDEN_PROCESS').length, 2);
    f.guard.inspectProcesses([{ ...entry, pid: 323, sha256: 'b'.repeat(64), signed: false }]);
    assert.equal(f.events.filter((event) => event.type === 'FORBIDDEN_PROCESS').length, 2);
});
