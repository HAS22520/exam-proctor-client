const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function run(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--out-dir' || !args[1].trim()) throw new Error('Usage: npm run keys:update -- --out-dir <private directory outside repository>');
  const directory = path.resolve(args[1]), privateFile = path.join(directory, 'update-private.pem'), publicFile = path.join(directory, 'update-public.pem');
  const relative = path.relative(path.resolve(__dirname, '..'), directory);
  if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) throw new Error('Keep update signing keys outside the client repository');
  if (fs.existsSync(privateFile) || fs.existsSync(publicFile)) throw new Error('Update key files already exist; reuse them, do not overwrite existing release trust');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keys = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(privateFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(publicFile, keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644, flag: 'wx' });
  return { privateFile, publicFile };
}
if (require.main === module) {
  try { console.log(JSON.stringify(run())); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { run };
