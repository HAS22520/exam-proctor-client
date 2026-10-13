import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { archiveFs as fs } from './updates/archive-filesystem';
import { MAC_DATA_FOLDER } from '../shared/branding';

interface StorageLocation {
  packaged: boolean;
  executable: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  developmentRoot?: string;
}
export function dataDirectory({ packaged, executable, platform, env, developmentRoot = path.resolve(__dirname, '../../..') }: StorageLocation) {
  if (!packaged) return path.join(developmentRoot, '.proctor-data');
  // NSIS portable 的 exe 在临时目录解包，持久数据必须跟原始便携 EXE 放在一起。
  if (platform === 'win32') {
    const portable = env.PORTABLE_EXECUTABLE_DIR || (env.PORTABLE_EXECUTABLE_FILE ? path.dirname(env.PORTABLE_EXECUTABLE_FILE) : '');
    return path.join(portable || path.dirname(executable), 'data');
  }
  if (platform === 'darwin') {
    const bundle = path.resolve(executable, '../../..');
    if (!bundle.endsWith('.app')) throw new Error('无法确定 macOS 应用安装目录，请将应用复制到可写目录后启动。');
    // 不改写签名的 .app 包；数据目录与 .app 同处于用户选择的安装位置。
    return path.join(path.dirname(bundle), MAC_DATA_FOLDER);
  }
  return path.join(path.dirname(executable), 'data');
}

export function configureStorage(app: Pick<Electron.App, 'isPackaged' | 'getPath' | 'setPath'>, env = process.env, platform = process.platform) {
  const previous = app.getPath('userData');
  const directory = dataDirectory({ packaged: app.isPackaged, executable: app.getPath('exe'), platform, env });
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const probe = path.join(directory, `.write-check-${crypto.randomBytes(8).toString('hex')}`);
    fs.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
    fs.unlinkSync(probe);
    app.setPath('userData', directory);
    // Chromium 登录缓存、临时文件、崩溃记录也使用安装位置，而非默认 AppData。
    // sessionData 必须在 ready 之前确定，不能等待异步迁移完成后才 setPath。
    for (const [name, folder] of [['sessionData', 'browser'], ['temp', 'temp'], ['logs', 'logs'], ['crashDumps', 'crashes']] as const) {
      const target = path.join(directory, folder);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      app.setPath(name, target);
    }
  } catch (error) {
    throw new Error(`无法写入客户端数据目录：${directory}。Windows 请以管理员身份运行；macOS 请将 .app 移到有写入权限的目录（例如 ~/Applications）。${error.message}`);
  }
  // 实例锁和 Chromium 文件留在根目录；监考持久状态单独整体发布。
  return { root: directory, directory: path.join(directory, 'state'), previous };
}

/** 路径早已配置，只在创建考试 session 前原子搬迁分区，不再修改 Electron 路径。 */
export async function restoreBrowserProfile(directory: string, browser: string) {
  const source = path.join(directory, 'browser', 'Partitions');
  const destination = path.join(browser, 'Partitions');
  if (!fs.existsSync(source) || fs.existsSync(destination)) return;
  await fs.promises.rename(source, destination);
}

/** 先完整复制到同目录暂存区，再原子发布。中途失败不留下半份身份/日志，也不删除旧数据。 */
export async function migrateStorage(previous: string, directory: string) {
  const marker = path.join(directory, 'migration.json');
  if (path.resolve(previous) === path.resolve(directory) || fs.existsSync(marker)) return;
  const names = ['secrets', 'journals', 'updates', 'config', 'diagnostics', 'network-state.json'];
  const existing = names.filter((name) => fs.existsSync(path.join(directory, name)));
  // 禁止把两组设备身份/日志混合。已有新目录数据说明此安装已开始独立运行。
  if (existing.length) return;
  // 不移动 Electron 实例锁所在目录。单次 rename 发布整个 state，崩溃也不会留下半份设备身份。
  const parent = path.dirname(directory);
  await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
  if (fs.existsSync(directory) && (await fs.promises.readdir(directory)).length) return;
  const stage = path.join(parent, `.${path.basename(directory)}.migration-${crypto.randomBytes(8).toString('hex')}`);
  await fs.promises.mkdir(stage, { mode: 0o700 });
  try {
    for (const name of names) {
      const source = path.join(previous, name);
      if (!fs.existsSync(source)) continue;
      // 必须用 original-fs，旧更新缓存中的 .asar 是文件，不是虚拟目录。
      await fs.promises.cp(source, path.join(stage, name), { recursive: true, dereference: false });
    }
    const browser = path.join(stage, 'browser');
    await fs.promises.mkdir(browser, { mode: 0o700 });
    // 保留旧编辑器草稿/IndexedDB。Cookie、认证缓存和 Service Worker 不迁移，启动仍要求重新登录。
    for (const name of ['Local Storage', 'IndexedDB']) {
      const source = path.join(previous, 'Partitions', 'hydro-exam', name);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(browser, 'Partitions', 'hydro-exam', name);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.promises.cp(source, destination, { recursive: true, dereference: false });
    }
    await fs.promises.writeFile(path.join(stage, 'migration.json'), JSON.stringify({ version: 1, from: previous, time: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    if (fs.existsSync(directory)) await fs.promises.rmdir(directory); // 只移除确认过的空目录。
    await fs.promises.rename(stage, directory);
  } catch (error) {
    // 发布前的失败仅影响暂存区，原目录从未被修改，可安全重试。
    throw new Error(`旧客户端数据迁移失败，请保留原数据并重试：${error.message}`);
  } finally { await fs.promises.rm(stage, { recursive: true, force: true }); }
}
