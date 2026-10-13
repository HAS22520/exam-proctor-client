import * as fs from 'node:fs';
import * as path from 'node:path';

function runtime(app: Pick<Electron.App, 'getVersion'>): NonNullable<typeof globalThis.__hydroProctorRuntime> {
    if (globalThis.__hydroProctorRuntime) return globalThis.__hydroProctorRuntime;
    // 开发入口或缺少更新加载器身份的安装包从内置元数据读取版本。
    let identity;
    try {
        identity = JSON.parse(fs.readFileSync(path.join(__dirname, '../generated/build.json'), 'utf8'));
    } catch {
        identity = { version: app.getVersion(), buildVersion: '' };
    }
    return { identity, markReady: () => {}, source: 'installed', failure: null };
}
export { runtime };
