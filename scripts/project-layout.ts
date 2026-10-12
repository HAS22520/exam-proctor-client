import * as fs from 'node:fs';
import * as path from 'node:path';

interface RuntimeMetadata {
  main?: string;
  build?: import('electron-builder').Configuration;
  [field: string]: unknown;
}

const compiledRoot = path.resolve(__dirname, '..');
// 脚本既会在工程 out/ 内运行，也会在 Docker 的独立暂存工程中运行。
const projectRoot =
  path.basename(compiledRoot) === 'out' && fs.existsSync(path.join(compiledRoot, '..', 'tsconfig.json'))
    ? path.resolve(compiledRoot, '..')
    : compiledRoot;

function applicationRoot(project = projectRoot): string {
  return fs.existsSync(path.join(project, 'tsconfig.json')) ? path.join(project, 'out') : project;
}

function runtimePackage(pkg: RuntimeMetadata): RuntimeMetadata {
  const result: RuntimeMetadata = { ...pkg, main: pkg.main?.replace(/^out\//, '') };
  if (pkg.build) {
    const directories = { ...pkg.build.directories };
    delete directories.app;
    result.build = { ...pkg.build, directories, beforePack: './scripts/before-pack.js' };
  }
  return result;
}

export { applicationRoot, projectRoot, runtimePackage };
