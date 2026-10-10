const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { once } = require('node:events');
const { setImmediate: yieldToLoop } = require('node:timers/promises');
const { atomicWrite, bootIdentity } = require('./device-store');
const { canonical, digest, LOG_MAGIC } = require('./proctor-crypto');

function decodeRecord(line, key, binding, seq, previousHash) {
  const sealed = JSON.parse(line);
  const iv = Buffer.from(sealed.iv, 'base64url');
  const tag = Buffer.from(sealed.tag, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid journal encryption');
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`HYDRO-JOURNAL/1:${binding.attemptId}`));
  cipher.setAuthTag(tag);
  const record = JSON.parse(Buffer.concat([cipher.update(Buffer.from(sealed.data, 'base64url')), cipher.final()]).toString('utf8'));
  if (record.seq !== seq || record.previousHash !== previousHash) throw new Error('Invalid journal sequence');
  return { record, iv: sealed.iv, hash: digest(canonical(sealed)) };
}

class AuditLogger {
  constructor({ directory, binding, protectedStore, logPublicKey, keyId, nowBoot }) {
    Object.assign(this, { directory, binding, store: protectedStore, logPublicKey, keyId });
    const bootId = nowBoot === undefined ? bootIdentity() : `test:${nowBoot}`;
    this.statePath = path.join(directory, 'state.json');
    this.journalPath = path.join(directory, 'journal.enc');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const existed = fs.existsSync(this.statePath);
    this.state = existed ? JSON.parse(fs.readFileSync(this.statePath, 'utf8')) : {
      binding, keyId, phase: 'open', clean: false, createdAt: new Date().toISOString(), bootId,
    };
    if (canonical(this.state.binding) !== canonical(binding)) throw new Error('Journal identity mismatch');
    const secretName = `journal-${binding.attemptId}.bin`;
    let secret = this.store.read(secretName);
    if (!secret) {
      if (existed || fs.existsSync(this.journalPath)) throw new Error('Journal key is missing; recovery required');
      secret = { key: crypto.randomBytes(32).toString('base64url') };
      this.store.write(secretName, secret);
    }
    this.key = Buffer.from(secret.key, 'base64url');
    if (this.key.length !== 32) throw new Error('Invalid protected journal key');
    this.seq = 0;
    this.previousHash = '';
    this.usedIvs = new Set();
    const recovered = this.recover();
    if (this.state.phase === 'closing' && fs.existsSync(path.join(directory, 'final.hplog'))) {
      this.state.phase = 'pending-upload';
      this.state.finalFile = 'final.hplog';
      this.saveState();
    }
    if (['open', 'closing'].includes(this.state.phase)) {
      if (existed && !this.state.clean) this.append('ABNORMAL_EXIT_DETECTED');
      if (existed && bootId && this.state.bootId && bootId !== this.state.bootId) this.append('SYSTEM_RESTART');
      if (!bootId) this.append('BOOT_ID_UNAVAILABLE');
      this.append(existed ? 'CLIENT_RESTART' : 'CLIENT_START');
      if (recovered) this.append('JOURNAL_TAIL_RECOVERED', { bytes: recovered });
      this.state.bootId = bootId;
      this.state.clean = false;
      this.saveState();
    }
  }

  saveState() { atomicWrite(this.statePath, JSON.stringify(this.state)); }

  recover() {
    if (!fs.existsSync(this.journalPath)) return 0;
    const bytes = fs.readFileSync(this.journalPath);
    let offset = 0;
    let validEnd = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      if (end < 0) break;
      try {
        const decoded = decodeRecord(bytes.subarray(offset, end).toString('utf8'), this.key, this.binding, this.seq + 1, this.previousHash);
        if (this.usedIvs.has(decoded.iv)) throw new Error('Repeated journal nonce');
        this.usedIvs.add(decoded.iv);
        this.seq++;
        this.previousHash = decoded.hash;
        validEnd = end + 1;
      } catch (error) {
        if (end + 1 < bytes.length || !['open', 'closing'].includes(this.state.phase)) throw error;
        break;
      }
      offset = end + 1;
    }
    if (validEnd === bytes.length) return 0;
    if (!['open', 'closing'].includes(this.state.phase)) throw new Error('Finalized journal is damaged');
    const tail = bytes.subarray(validEnd);
    atomicWrite(path.join(this.directory, `corrupt-tail-${crypto.randomBytes(8).toString('hex')}.enc`), tail);
    fs.truncateSync(this.journalPath, validEnd);
    return tail.length;
  }

  append(type, details = {}) {
    if (this.sealing || !['open', 'closing'].includes(this.state.phase)) return;
    const record = { seq: this.seq + 1, utc: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString(),
      type, details, previousHash: this.previousHash };
    let iv;
    do { iv = crypto.randomBytes(12); } while (this.usedIvs.has(iv.toString('base64url')));
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`HYDRO-JOURNAL/1:${this.binding.attemptId}`));
    const data = Buffer.concat([cipher.update(canonical(record)), cipher.final()]);
    const sealed = { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') };
    const fd = fs.openSync(this.journalPath, 'a', 0o600);
    try { fs.writeFileSync(fd, `${canonical(sealed)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.seq++;
    this.previousHash = digest(canonical(sealed));
    this.usedIvs.add(sealed.iv);
  }

  logViolation({ source, type, target, detail }) {
    let safeTarget = String(target || '').slice(0, 512);
    try { const url = new URL(safeTarget); safeTarget = `${url.origin}${url.pathname}`; } catch { /* Process/shortcut. */ }
    this.append(type || 'SECURITY_EVENT', { source: source || 'CLIENT', target: safeTarget, detail: String(detail || '').slice(0, 512) });
  }

  close() {
    if (this.state.phase !== 'open') return;
    this.append('FINISH_REQUESTED');
    this.state.phase = 'closing';
    this.saveState();
  }

  cleanShutdown() {
    if (['open', 'closing'].includes(this.state.phase)) this.append('CLIENT_SHUTDOWN');
    this.state.clean = true;
    this.saveState();
  }

  async finalize() {
    this.close();
    const filename = path.join(this.directory, 'final.hplog');
    if (['uploaded', 'pending-upload'].includes(this.state.phase)) return filename;
    this.sealing = true;
    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const wrappedKey = crypto.publicEncrypt({ key: this.logPublicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256' }, aesKey);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    cipher.setAAD(Buffer.from(`${LOG_MAGIC}:${this.keyId}`));
    const header = { keyId: this.keyId, iv: iv.toString('base64url'), tag: Buffer.alloc(16).toString('base64url'),
      wrappedKey: wrappedKey.toString('base64url') };
    const prefix = `${LOG_MAGIC}\n${JSON.stringify(header)}\n`;
    const temp = `${filename}.tmp`;
    const output = fs.createWriteStream(temp, { flags: 'w', mode: 0o600 });
    const outputDone = once(output, 'finish');
    outputDone.catch(() => {});
    const write = async (bytes) => { if (!output.write(bytes)) await once(output, 'drain'); };
    const lines = readline.createInterface({ input: fs.createReadStream(this.journalPath), crlfDelay: Infinity });
    try {
      await write(Buffer.from(prefix));
      await write(cipher.update(`${canonical({ protocol: 'hydro-journal/1', binding: this.binding })}\n`));
      let seq = 0;
      let previousHash = '';
      for await (const line of lines) {
        const decoded = decodeRecord(line, this.key, this.binding, ++seq, previousHash);
        previousHash = decoded.hash;
        await write(cipher.update(`${canonical(decoded.record)}\n`));
        if (seq % 128 === 0) await yieldToLoop();
      }
      if (seq !== this.seq || previousHash !== this.previousHash) throw new Error('Journal changed while finalizing');
      await write(cipher.final());
      output.end();
      await outputDone;
      header.tag = cipher.getAuthTag().toString('base64url');
      const fd = fs.openSync(temp, 'r+');
      try { fs.writeSync(fd, Buffer.from(`${LOG_MAGIC}\n${JSON.stringify(header)}\n`), 0, Buffer.byteLength(prefix), 0); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, filename);
      Object.assign(this.state, { phase: 'pending-upload', finalFile: 'final.hplog', keyId: this.keyId, clean: true });
      this.saveState();
      return filename;
    } catch (error) { output.destroy(); throw error; }
    finally { lines.close(); aesKey.fill(0); this.sealing = false; }
  }

  uploaded(receipt) {
    if (!/^[a-f0-9]{24}$/.test(receipt || '')) throw new Error('Invalid upload receipt');
    Object.assign(this.state, { phase: 'uploaded', receipt, clean: true });
    delete this.state.uploadError;
    this.saveState();
    // Retain encrypted evidence to recover qualification after an admin deletion.
  }
}

module.exports = AuditLogger;
