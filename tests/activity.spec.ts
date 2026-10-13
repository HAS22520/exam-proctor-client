import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import ActivityProgress = require('../app/main/diagnostics/activity-progress');
import FirewallGuard = require('../app/main/network/firewall-guard');

test('网络阶段说明认证等待原因，跨阶段保留耗时并返回认证进度', async () => {
    let now = 100;
    let releaseAuth;
    let releaseNetwork;
    const statuses = [];
    const progress = new ActivityProgress({ now: () => now, onChange: (value) => statuses.push(value) });
    const auth = progress.run(
        'auth',
        'identity',
        () =>
            new Promise((resolve) => {
                releaseAuth = resolve;
            }),
    );
    now += 500;
    progress.stage('auth', 'challenge');
    assert.equal(progress.snapshot().stage, 'challenge');
    assert.equal(progress.snapshot().elapsedMs, 500);
    const network = progress.run(
        'network',
        'lock',
        () =>
            new Promise((resolve) => {
                releaseNetwork = resolve;
            }),
    );
    now += 5000;
    progress.stage('network', 'apply-native-policy');
    assert.equal(progress.snapshot().kind, 'network');
    assert.equal(progress.snapshot().elapsedMs, 5000);
    assert.equal(progress.snapshot().estimatedMaxMs, 10000);
    now += 30000;
    assert.equal(progress.snapshot().delayed, true);
    releaseNetwork();
    await network;
    assert.equal(progress.snapshot().kind, 'auth');
    assert.equal(progress.snapshot().elapsedMs, 35500);
    releaseAuth();
    await auth;
    assert.equal(progress.snapshot(), null);
    assert.ok(statuses.some((value) => value?.stage === 'apply-native-policy'));
});
test('失败后显示简短说明，不泄露错误内容或留下无限加载状态', async () => {
    let now = 0;
    const progress = new ActivityProgress({ now: () => now });
    await assert.rejects(
        progress.run('network', 'restore', async () => {
            throw new Error('PRIVATE_TOKEN');
        }),
    );
    assert.equal(progress.snapshot().busy, false);
    assert.equal(JSON.stringify(progress.snapshot()).includes('PRIVATE_TOKEN'), false);
    now = 8001;
    assert.equal(progress.snapshot(), null);
    await progress.run('auth', 'identity', async () => 1);
    assert.equal(progress.snapshot(), null);
});
test('排队的网络恢复开始前，不覆盖正在启用限制的进度', async () => {
    const progress = new ActivityProgress();
    const statuses = [];
    progress.onChange = (value) => statuses.push(value);
    const guard = new FirewallGuard({}, null, { platform: 'win32', activity: progress.run.bind(progress) });
    let release;
    guard.native = {
        active: false,
        lock: () =>
            new Promise((resolve) => {
                release = resolve;
            }),
        unlock: async () => {},
        close: () => {},
    } as any;
    guard.config = { exam: { allowedOrigins: ['https://127.0.0.1'] } };
    const lock = guard.lock();
    const restore = guard.unlock();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(progress.snapshot().stage, 'lock');
    release();
    await lock;
    await restore;
    assert.equal(progress.snapshot(), null);
    assert.ok(statuses.some((value) => value?.stage === 'restore'));
});
test('已启用的网络保护和无活动策略的恢复不重复显示进度或发送命令', async () => {
    const progress = new ActivityProgress();
    const statuses = [];
    progress.onChange = (value) => statuses.push(value);
    let commands = 0;
    const guard = new FirewallGuard({ exam: { allowedOrigins: ['https://oj.example.com'] } }, null, {
        platform: 'win32',
        activity: progress.run.bind(progress),
        native: {
            active: false,
            async lock() {
                commands++;
                this.active = true;
            },
            async unlock() {
                this.active = false;
            },
            close: () => {},
        } as any,
        lookup: async () => [{ address: '127.0.0.1' }],
    });
    await guard.recover();
    await guard.unlock();
    assert.equal(statuses.length, 0);
    await guard.lock();
    assert.equal(commands, 1);
    const count = statuses.length;
    await guard.lock();
    assert.equal(commands, 1);
    assert.equal(statuses.length, count);
});
test('准备完成后，不留下迟到的进度窗口', async () => {
    const { EventEmitter } = require('node:events');
    const WaitingWindow = require('../app/main/windows/waiting-window');
    let release;
    class Window extends EventEmitter {
        declare webContents: any;
        declare destroyed: boolean;

        constructor() {
            super();
            this.webContents = new EventEmitter();
            this.webContents.setWindowOpenHandler = () => {};
            this.webContents.session = { webRequest: { onBeforeRequest: () => {} } };
        }

        loadFile() {
            return new Promise((resolve) => {
                release = resolve;
            });
        }

        isDestroyed() {
            return !!this.destroyed;
        }

        destroy() {
            this.destroyed = true;
        }

        show() {
            assert.fail('准备阶段已经完成');
        }
    }
    const progress = new WaitingWindow(Window);
    const showing = progress.show();
    const window = progress.window;
    progress.close();
    release();
    await showing;
    assert.equal(window.destroyed, true);
    assert.equal(progress.window, null);
});

export {};
