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

test('Windows 保留快捷键限制、焦点恢复和明确配置的进程终止', () => {
    const f = fixture('win32');
    f.guard.start();
    f.window.emit('blur');
    f.window.emit('minimize');
    assert.deepEqual(f.shortcuts, ['Alt+Tab']);
    assert.deepEqual(
        f.commands.map((command) => command.file),
        ['tasklist.exe', 'taskkill.exe'],
    );
    assert.ok(f.events.some((event) => event.type === 'FOCUS'));
    assert.ok(f.events.some((event) => event.type === 'RESTORE'));
    f.guard.stop();
});

export {};
