const fs = require('node:fs');
const path = require('node:path');

const fields = new Set(['operation', 'method', 'url', 'status', 'code', 'name', 'message', 'durationMs',
  'phase', 'percent', 'sent', 'total', 'reason', 'exitCode', 'version', 'platform', 'arch', 'debug', 'root', 'source', 'type']);

function redact(value) {
  return String(value).replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, '[KEY REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => {
      try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch { return '[URL]'; }
    })
    .replace(/\b(?:Bearer\s+\S+|(?:token|password|cookie|authorization|signature|proof)\s*[:=]\s*[^\s,;]+)/gi, '[REDACTED]')
    .replace(/[A-Za-z0-9_+-]{40,}={0,2}/g, '[REDACTED]')
    .replace(/[\r\n\u0000-\u001f]+/g, ' ').slice(0, 800);
}

function localTimestamp(date) {
  const offset = -date.getTimezoneOffset();
  const wall = new Date(date.getTime() + offset * 60000).toISOString().slice(0, -1);
  const pad = (value) => String(value).padStart(2, '0');
  return `${wall}${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

class Diagnostics {
  constructor() { this.entries = []; this.sequence = 0; this.pending = Promise.resolve(); this.bytes = 0; }

  async enable(directory) {
    try {
      const destination = path.join(directory, 'diagnostics');
      await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
      const previous = (await fs.promises.readdir(destination)).filter((name) => /^debug-\d+\.log$/.test(name)).sort();
      for (const name of previous.slice(0, Math.max(0, previous.length - 2))) await fs.promises.unlink(path.join(destination, name));
      this.file = path.join(destination, `debug-${Date.now()}.log`);
      await fs.promises.writeFile(this.file, '', { mode: 0o600 });
      for (const entry of this.entries) this.persist(entry);
    } catch { this.file = null; }
  }

  log(level, event, details = {}) {
    const data = {};
    for (const [key, value] of Object.entries(details)) {
      if (!fields.has(key) || value == null) continue;
      data[key] = typeof value === 'number' || typeof value === 'boolean' ? value : redact(value);
    }
    const now = new Date();
    const entry = { id: ++this.sequence, time: localTimestamp(now), utc: now.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, level, event: redact(event), data };
    this.entries.push(entry);
    if (this.entries.length > 1000) this.entries.shift();
    this.persist(entry);
    return entry;
  }

  error(event, error, details = {}) {
    this.log('error', event, { ...details, name: error?.name, code: error?.code, status: error?.status, message: error?.message });
  }

  persist(entry) {
    if (!this.file) return;
    const line = `${JSON.stringify(entry)}\n`;
    // Bounded plain diagnostics are separate from encrypted examination logs.
    if (this.bytes + Buffer.byteLength(line) > 4 * 1024 * 1024) return;
    this.bytes += Buffer.byteLength(line);
    this.pending = this.pending.then(() => fs.promises.appendFile(this.file, line)).catch(() => {});
  }

  snapshot(after = 0) {
    return { entries: this.entries.filter((entry) => entry.id > after), latest: this.sequence, file: this.file || null };
  }

  async span(event, action) {
    const start = Date.now();
    this.log('info', `${event}.start`);
    try {
      const result = await action();
      this.log('info', `${event}.complete`, { durationMs: Date.now() - start });
      return result;
    } catch (error) { this.error(`${event}.failed`, error, { durationMs: Date.now() - start }); throw error; }
  }
}

module.exports = { Diagnostics, redact, localTimestamp };
