const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { canonical, digest } = require('./proctor-crypto');

function atomicWrite(filename, data) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, filename);
}

class ProtectedStore {
  constructor(directory, safeStorage) { this.directory = directory; this.safeStorage = safeStorage; }

  check() {
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('OS protected key storage is unavailable; plaintext fallback is forbidden');
    }
  }

  read(name) {
    this.check();
    const filename = path.join(this.directory, name);
    return fs.existsSync(filename) ? JSON.parse(this.safeStorage.decryptString(fs.readFileSync(filename))) : null;
  }

  write(name, value) {
    this.check();
    atomicWrite(path.join(this.directory, name), this.safeStorage.encryptString(JSON.stringify(value)));
  }

  device() {
    let device = this.read('device.bin');
    if (!device) {
      const pair = crypto.generateKeyPairSync('ed25519');
      device = { privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), installationId: crypto.randomBytes(32).toString('hex') };
      // Deliberately excludes IP, hostname, boot time and OS update version.
      device.fingerprint = digest(canonical({ installationId: device.installationId, publicKey: device.publicKey,
        platform: process.platform, arch: process.arch }));
      this.write('device.bin', device);
    }
    if (crypto.createPublicKey(device.privateKey).export({ type: 'spki', format: 'pem' }).toString() !== device.publicKey
      || !/^[a-f0-9]{64}$/.test(device.fingerprint || '')) throw new Error('Damaged device identity; do not regenerate during an exam');
    return device;
  }
}

const deviceInfo = () => ({ platform: process.platform, osVersion: os.release().slice(0, 128), arch: process.arch });
// Read OS boot identity rather than subtracting wall time and uptime: clock
// correction must not manufacture a SYSTEM_RESTART event.
let cachedBootId = null;
let bootPending;
function bootIdentity() { return cachedBootId; }
function prepareBootIdentity({ platform = process.platform, exec = execFile, read = fs.promises.readFile } = {}) {
  if (bootPending) return bootPending;
  bootPending = (async () => {
    try {
      const options = { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4096 };
      const command = platform === 'darwin' ? ['/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']]
        : ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "(Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o')"]];
      const raw = ['darwin', 'win32'].includes(platform)
        ? await new Promise((resolve, reject) => exec(...command, options, (error, stdout) => error ? reject(error) : resolve(stdout)))
        : await read('/proc/sys/kernel/random/boot_id', 'utf8');
      const value = raw.trim();
      if (!value || value.length > 128 || /[\r\n]/.test(value)) throw new Error('Invalid boot identity');
      cachedBootId = digest(`${platform}:${value}`);
    } catch { cachedBootId = null; }
    return cachedBootId;
  })();
  return bootPending;
}

module.exports = { ProtectedStore, atomicWrite, deviceInfo, bootIdentity, prepareBootIdentity };
