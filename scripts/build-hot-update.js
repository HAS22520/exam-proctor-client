const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { prepare } = require('./prepare-build');
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
if (require.main === module) buildArchive().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildArchive };
