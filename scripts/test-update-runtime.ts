import { spawnSync } from 'node:child_process';
import { applicationRoot } from './project-layout';

// 只在 Electron 的 Node 模式运行文件系统和更新测试，不创建窗口或进行 UI 验收。
const electron = require('electron');
const child = spawnSync(electron, ['--test', 'tests/asar-filesystem.spec.js'], {
    cwd: applicationRoot(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PROCTOR_TEST_NODE_EXE: process.execPath },
    stdio: 'inherit',
});
if (child.error) {
    console.error(child.error.message);
    process.exitCode = 1;
} else process.exitCode = child.status ?? 1;
