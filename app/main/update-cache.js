const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./device-store');
const { buildVersion } = require('./build-version');
const { verifyArchive } = require('./signed-archive');
function hasUnfinishedJournals(directory) {
  const journals = path.join(directory, 'journals');
  if (!fs.existsSync(journals)) return false;
  return fs.readdirSync(journals).some((name) => {
    try { return JSON.parse(fs.readFileSync(path.join(journals, name, 'state.json'), 'utf8')).phase !== 'uploaded'; }
    catch { return true; }
  });
}
class UpdateCache {
  constructor(directory, anchor) {
    this.directory = directory; this.anchor = anchor;
    this.root = path.join(directory, 'updates');
    fs.mkdirSync(this.root, { recursive: true });
  }
  read(name) {
    try { return JSON.parse(fs.readFileSync(path.join(this.root, `${name}.json`), 'utf8')); } catch { return null; }
  }
  write(name, value) {
    const filename = path.join(this.root, `${name}.json`);
    if (value) atomicWrite(filename, JSON.stringify(value)); else fs.rmSync(filename, { force: true });
  }
  filename(info) {
    buildVersion(info.buildVersion);
    if (!/^[a-f0-9]{64}$/.test(info.sha256 || '')) throw new Error('Invalid cached ASAR hash');
    return path.join(this.root, `${info.buildVersion}-${info.sha256}.asar`);
  }
  async validate(info) {
    await verifyArchive(this.filename(info), info, this.anchor);
    return info;
  }
  async stage(info, downloaded) {
    if (hasUnfinishedJournals(this.directory)) throw new Error('仍有未结束或待上传的监考日志，请上传完成后再更新');
    await verifyArchive(downloaded, info, this.anchor);
    if (hasUnfinishedJournals(this.directory)) throw new Error('监考已开始，暂停应用更新');
    const destination = this.filename(info);
    fs.renameSync(downloaded, destination);
    this.write('pending', info);
  }
  // A failed first launch is rolled back before trying any downloaded code again.
  rollback(message) {
    const trial = this.read('launch');
    if (trial) {
      this.write('active', trial.previous || null);
      this.write('failure', { buildVersion: trial.candidate.buildVersion, message });
      this.write('launch', null);
    }
  }
  async select() {
    this.rollback('上次更新未完成启动，已回退');
    let active = this.read('active');
    const pending = this.read('pending');
    const baseline = this.anchor.identity.buildVersion;
    if (active) {
      try {
        if (buildVersion(active.buildVersion) <= buildVersion(baseline)) active = null;
        else await this.validate(active);
      } catch (error) { this.write('failure', { message: error.message }); active = null; }
      this.write('active', active);
    }
    if (pending && !hasUnfinishedJournals(this.directory)) {
      this.write('pending', null);
      try {
        if (buildVersion(pending.buildVersion) > buildVersion(active?.buildVersion || baseline)) {
          await this.validate(pending);
          this.write('launch', { candidate: pending, previous: active });
          this.write('active', pending);
          active = pending;
        }
      } catch (error) { this.write('failure', { message: error.message }); }
    }
    return active;
  }
  ready() { if (this.read('launch')) this.write('failure', null); this.write('launch', null); }
}
module.exports = { UpdateCache, hasUnfinishedJournals };
