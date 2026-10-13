import * as fs from 'node:fs';

// Electron 会把 .asar 当成虚拟目录；下载、校验和清理必须操作真实文件。
// 普通 Node 构建/测试使用原生 fs，Electron 运行时统一使用 original-fs。
const archiveFs: typeof fs = process.versions.electron ? require('original-fs') : fs;

export { archiveFs };
