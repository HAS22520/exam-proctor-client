import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { workspace } from './helpers';

// 模拟 Electron 的 ready、窗口和 IPC，不启动原生界面。
test('加载器先配置路径，ready 后展示窗口，再迁移数据并把窗口交给主入口', async (t) => {
    const root = workspace(t);
    const directory = path.join(root, 'state');
    const calls = [];
    let ready = false;
    let shown = false;
    let status;
    let splash;
    let loaded;
    let failed;
    const done = new Promise<void>((resolve, reject) => {
        loaded = resolve;
        failed = reject;
    });
    const setPath = (name, filename) => {
        assert.equal(ready, false, `${name} 必须在 ready 之前设置`);
        calls.push([name, filename]);
    };
    const app: any = {
        setName: () => {},
        requestSingleInstanceLock: () => true,
        setPath,
        on: () => {},
        removeListener: () => {},
        whenReady: async () => { ready = true; },
        exit: () => failed(new Error('启动过程应当成功')),
    };
    const source = path.resolve(__dirname, '../app/main/bootstrap.js');
    const context: any = {
        exports: {},
        console,
        __dirname: path.dirname(source),
        process: { versions: { electron: '44.7.0' } },
        require(name) {
            if (name === '../shared/branding') return require('../app/shared/branding');
            if (name === './diagnostics/activity-progress') return require('../app/main/diagnostics/activity-progress');
            if (name === 'electron') return { app, ipcMain: { removeHandler: () => { status = undefined; } } };
            if (name === './storage') {
                return {
                    configureStorage: () => {
                        setPath('sessionData', path.join(root, 'browser'));
                        return { root, directory, previous: '/old' };
                    },
                    migrateStorage: async () => {
                        assert.equal(shown, true);
                        assert.equal(status().stage, 'prepare-data');
                        await new Promise((resolve) => setImmediate(resolve));
                    },
                    restoreBrowserProfile: async (state, browser) => {
                        assert.equal(state, directory);
                        assert.equal(browser, path.join(root, 'browser'));
                    },
                };
            }
            if (name === 'node:fs') return { ...fs, readFileSync: () => '{}' };
            if (name === './updates/update-cache') {
                return {
                    UpdateCache: class {
                        async select() {
                            assert.equal(shown, true);
                            assert.equal(status().stage, 'verify-app');
                            return null;
                        }

                        read() {
                            return null;
                        }
                    },
                };
            }
            if (name === './windows/waiting-window') {
                return class {
                    constructor() { splash = this; }
                    publish() {}
                    bindStatus(_ipc, snapshot) { status = snapshot; }
                    async show() { assert.equal(ready, true); shown = true; }
                };
            }
            if (name === './updates/signed-archive') return { ENTRY: 'app/main/index.js' };
            if (name === './windows/dialog-service') {
                return {
                    DialogService: class {
                        async show() {
                            /* 成功启动的模拟过程不显示弹窗。 */
                        }
                    },
                };
            }
            if (name === './index') {
                assert.equal(status, undefined);
                assert.equal(context.__hydroProctorRuntime.takeWaitingWindow(), splash);
                loaded();
                return {};
            }
            return require(name);
        },
    };
    runInNewContext(fs.readFileSync(source, 'utf8'), context);
    await done;
    assert.deepEqual(
        calls.map(([name]) => name),
        ['sessionData', 'userData'],
    );
    assert.equal(calls[1][1], directory);
});
