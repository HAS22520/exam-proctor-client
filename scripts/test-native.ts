import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectRoot } from './project-layout';

const root = projectRoot;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hydro-policy-test-'));
try {
  const output = path.join(directory, process.platform === 'win32' ? 'policy-test.exe' : 'policy-test');
  const sources = ['policy.cpp', 'policy-test.cpp'].map((file) => path.join(root, 'native/common', file));
  const compiler = process.platform === 'win32' ? 'cl.exe' : process.env.CXX || 'c++';
  const args =
    process.platform === 'win32'
      ? ['/nologo', '/EHsc', '/std:c++17', `/Fe:${output}`, ...sources, '/link', 'ws2_32.lib']
      : ['-std=c++17', '-Wall', '-Wextra', '-Werror', ...sources, '-o', output];
  for (const [command, commandArgs] of [
    [compiler, args],
    [output, []],
  ] as [string, string[]][]) {
    const result = spawnSync(command, commandArgs, { cwd: directory, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`${command} failed; install a C++17 compiler`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
