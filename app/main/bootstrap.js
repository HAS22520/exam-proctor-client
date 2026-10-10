// This loader always runs from the original installation, never the cached ASAR.
const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { UpdateCache } = require('./update-cache');
const { ENTRY } = require('./signed-archive');
app.setName('HydroProctorClient');
if (!app.requestSingleInstanceLock()) app.exit(0);
else (async () => {
  const root = path.resolve(__dirname, '../..');
  const json = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  const anchor = { trust: json('app/generated/trust.json'), config: json('app/generated/config.json'),
    identity: json('app/generated/build.json'), electronVersion: process.versions.electron };
  const cache = new UpdateCache(app.getPath('userData'), anchor);
  const selected = await cache.select();
  globalThis.__hydroProctorRuntime = { identity: selected ? { version: selected.version, buildVersion: selected.buildVersion } : anchor.identity,
    markReady: () => cache.ready(), singleInstanceLocked: true, source: selected ? 'asar' : 'installed', failure: cache.read('failure'), cache };
  try { require(selected ? path.join(cache.filename(selected), ENTRY) : './index'); }
  catch (error) {
    // Re-executing native main in the same process would duplicate IPC/listeners.
    if (selected && cache.read('launch')) { cache.rollback(error.message); app.relaunch(); app.exit(1); }
    else throw error;
  }
})().catch(async (error) => {
  await app.whenReady(); dialog.showErrorBox('客户端启动失败', error.message); app.exit(1);
});
