const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { prepare } = require('./prepare-build');
const { buildEnvironment } = require('./build');
const { sign, verify } = require('../app/main/proctor-crypto');
const { ENTRY } = require('../app/main/signed-archive');
const help = `Usage: npm run release:hot -- [--config FILE] [--sign-key FILE] [--help]

--config FILE  Read build JSON; public key paths are relative to this file.
--sign-key FILE Ed25519 update signing PRIVATE key, e.g. update-private.pem (never embedded).
--help         Show this help without requiring keys.

PROCTOR_* environment variables override JSON settings.
Outputs: updates/app-<version>-<buildVersion>.asar and matching JSON.
Signed archives can be applied by clients with the same embedded update public key.
Electron, native scripts and trust changes require full installers.`;
function readSigningKey(pem) {
  if (/-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(pem)) {
    throw new Error('--sign-key / PROCTOR_UPDATE_PRIVATE_KEY 需要更新签名私钥（update-private.pem），你传入了公钥。update-public.pem 应用于 build 配置的 updatePublicKeyFile。');
  }
  let key;
  try { key = crypto.createPrivateKey(pem); }
  catch { throw new Error('无法读取更新签名私钥：请提供完整、未加密的 Ed25519 PKCS#8 PEM（BEGIN PRIVATE KEY），不要传入公钥。'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('更新签名私钥必须是 Ed25519，不能使用日志解密的 RSA 私钥。');
  return key;
}
async function buildArchive(env = process.env, root = path.resolve(__dirname, '..')) {
  // Validate before generating config, staging source or creating output files.
  const key = env.PROCTOR_UPDATE_PRIVATE_KEY ? readSigningKey(env.PROCTOR_UPDATE_PRIVATE_KEY) : null;
  const { version, buildVersion, trust } = prepare(env, root);
  if (env.PROCTOR_REQUIRE_SIGNED_UPDATE === 'true' && !env.PROCTOR_UPDATE_PRIVATE_KEY) throw new Error('Signed ASAR requires PROCTOR_UPDATE_PRIVATE_KEY');
  if (env.PROCTOR_UPDATE_PRIVATE_KEY && !trust.updatePublicKey) throw new Error('Signed ASAR requires an independent PROCTOR_UPDATE_PUBLIC_KEY');
  const asar = require('@electron/asar');
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hydro-proctor-asar-'));
  const output = path.join(root, 'updates');
  fs.mkdirSync(output, { recursive: true });
  try {
    fs.cpSync(path.join(root, 'app'), path.join(staging, 'app'), { recursive: true });
    const original = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: original.name, version, buildVersion, main: original.main }));
    const filename = path.join(output, `app-${version}-${buildVersion}.asar`);
    if (env.PROCTOR_UPDATE_PRIVATE_KEY) {
      const files = [];
      function collect(directory, prefix = '') {
        for (const name of fs.readdirSync(directory).sort()) {
          const source = path.join(directory, name), relative = prefix + name, stat = fs.lstatSync(source);
          if (stat.isSymbolicLink()) throw new Error('ASAR does not support symlinks');
          if (stat.isDirectory()) collect(source, relative + '/');
          else files.push({ path: relative, size: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex') });
        }
      }
      collect(staging);
      const payload = { action: 'hydro-proctor-update/2', version, buildVersion, entry: ENTRY,
        electronVersion: original.devDependencies?.electron || '', files };
      const signature = sign(payload, key);
      if (!verify(payload, signature, trust.updatePublicKey)) throw new Error('Update signing key does not match embedded public key');
      fs.writeFileSync(path.join(staging, 'release.json'), JSON.stringify({ payload, signature }));
    }
    await asar.createPackage(staging, filename);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    const metadata = { version, buildVersion, signed: !!env.PROCTOR_UPDATE_PRIVATE_KEY, size: fs.statSync(filename).size, sha256: hash.digest('hex') };
    fs.writeFileSync(path.join(output, `app-${version}-${buildVersion}.json`), JSON.stringify(metadata, null, 2));
    return { filename, ...metadata };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
async function run(args = process.argv.slice(2), dependencies = {}) {
  let config, signKey, showHelp = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') showHelp = true;
    else if (args[i] === '--config') {
      if (config || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--config requires exactly one file');
      config = args[++i];
    } else if (args[i] === '--sign-key') {
      if (signKey || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--sign-key requires exactly one file');
      signKey = args[++i];
    } else throw new Error(`Unsupported ASAR build option: ${args[i]}`);
  }
  const log = dependencies.log || console.log;
  if (showHelp) { log(help); return; }
  const env = buildEnvironment(config, dependencies.env || process.env);
  if (signKey && !env.PROCTOR_UPDATE_PRIVATE_KEY) env.PROCTOR_UPDATE_PRIVATE_KEY = fs.readFileSync(path.resolve(signKey), 'utf8');
  const result = await buildArchive(env, dependencies.root);
  log(JSON.stringify(result));
  return result;
}
if (require.main === module) run().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildArchive, run };
