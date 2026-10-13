import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { configureStorage, migrateStorage } from './storage';
import { DialogService } from './windows/dialog-service';
import { ENTRY } from './updates/signed-archive';
import { UpdateCache } from './updates/update-cache';

// This loader always runs from the original installation, never the cached ASAR.

app.setName('HydroProctorClient');
// 在实例锁和 Chromium session 初始化前设置目录，避免写回默认 AppData。
(async () => {
  const { directory, previous } = configureStorage(app);
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
  await migrateStorage(previous, directory);
  app.setPath('userData', directory);
  const browser = path.join(directory, 'browser');
  fs.mkdirSync(browser, { recursive: true, mode: 0o700 });
  app.setPath('sessionData', browser);
  const root = path.resolve(__dirname, '../..');
  const json = (name: string) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  const anchor = {
    trust: json('app/generated/trust.json'),
    config: json('app/generated/config.json'),
    identity: json('app/generated/build.json'),
    electronVersion: process.versions.electron,
  };
  const cache = new UpdateCache(directory, anchor);
  const selected = await cache.select();
  globalThis.__hydroProctorRuntime = {
    identity: selected
      ? { ...anchor.identity, version: selected.version, buildVersion: selected.buildVersion }
      : anchor.identity,
    markReady: () => cache.ready(),
    singleInstanceLocked: true,
    source: selected ? 'asar' : 'installed',
    failure: cache.read('failure'),
    cache,
  };
  try {
    require(selected ? path.join(cache.filename(selected), ENTRY) : './index');
  } catch (error) {
    // Re-executing native main in the same process would duplicate IPC/listeners.
    if (selected && cache.read('launch')) {
      cache.rollback(error.message);
      app.relaunch();
      app.exit(1);
    } else throw error;
  }
})().catch(async (error) => {
  await app.whenReady();
  ipcMain.removeHandler('exam:dialog-model');
  ipcMain.removeHandler('exam:dialog-response');
  const prompts = new DialogService({ BrowserWindow, dialog, ipcMain });
  try {
    await prompts.show({ type: 'error', title: '客户端启动失败', message: '客户端启动失败', detail: error.message, buttons: ['关闭软件'] });
  } catch (promptError) {
    // 页面损坏时也必须结束进程，Windows 不回退到系统提示框。
    console.error('客户端启动失败：', error.message, '提示页面不可用：', promptError.message);
  } finally { app.exit(1); }
});
