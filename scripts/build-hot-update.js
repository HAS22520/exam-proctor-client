const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { prepare } = require('./prepare-build');
const { buildEnvironment } = require('./build');
const help = `Usage: npm run release:hot -- [--config FILE] [--help]

--config FILE  Read build JSON; public key paths are relative to this file.
--help         Show this help without requiring keys.

PROCTOR_* environment variables override JSON settings.
Outputs: updates/app-<version>.asar and updates/app-<version>.json.
This packages application code only; it does not publish or enable automatic ASAR updates.`;
async function buildArchive(env = process.env, root = path.resolve(__dirname, '..')) {
  const { version } = prepare(env, root);
  const asar = require('@electron/asar');
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hydro-proctor-asar-'));
  const output = path.join(root, 'updates');
  fs.mkdirSync(output, { recursive: true });
  try {
    fs.cpSync(path.join(root, 'app'), path.join(staging, 'app'), { recursive: true });
    const original = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: original.name, version, main: original.main }));
    const filename = path.join(output, `app-${version}.asar`);
    await asar.createPackage(staging, filename);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    const metadata = { version, size: fs.statSync(filename).size, sha256: hash.digest('hex') };
    fs.writeFileSync(path.join(output, `app-${version}.json`), JSON.stringify(metadata, null, 2));
    return { filename, ...metadata };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
async function run(args = process.argv.slice(2), dependencies = {}) {
  let config, showHelp = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') showHelp = true;
    else if (args[i] === '--config') {
      if (config || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--config requires exactly one file');
      config = args[++i];
    } else throw new Error(`Unsupported ASAR build option: ${args[i]}`);
  }
  const log = dependencies.log || console.log;
  if (showHelp) { log(help); return; }
  const env = buildEnvironment(config, dependencies.env || process.env);
  const result = await buildArchive(env, dependencies.root);
  log(JSON.stringify(result));
  return result;
}
if (require.main === module) run().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildArchive, run };
