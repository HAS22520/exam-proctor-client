import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ClientError, DiagnosticEntry, DiagnosticSnapshot, TraceLevel } from '../contracts';

const fields = new Set([
  'operation',
  'method',
  'url',
  'status',
  'code',
  'name',
  'message',
  'durationMs',
  'phase',
  'percent',
  'sent',
  'total',
  'reason',
  'exitCode',
  'version',
  'buildVersion',
  'platform',
  'arch',
  'debug',
  'root',
  'source',
  'type',
  'uid',
  'domainId',
  'tid',
  'state',
  'completed',
]);

function redact(value: unknown) {
  return String(value)
    .replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, '[KEY REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return '[URL]';
      }
    })
    .replace(
      /\b(?:Bearer\s+\S+|(?:token|password|cookie|authorization|signature|proof)\s*[:=]\s*[^\s,;]+)/gi,
      '[REDACTED]',
    )
    .replace(/[A-Za-z0-9_+-]{40,}={0,2}/g, '[REDACTED]')
    .replace(/[\r\n\u0000-\u001f]+/g, ' ')
    .slice(0, 800);
}

function localTimestamp(date: Date) {
  const offset = -date.getTimezoneOffset();
  const wall = new Date(date.getTime() + offset * 60000).toISOString().slice(0, -1);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${wall}${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

class Diagnostics {
  declare entries: DiagnosticEntry[];
  declare sequence: number;
  declare pending: Promise<void>;
  declare bytes: number;
  declare file: string;

  constructor() {
    this.entries = [];
    this.sequence = 0;
    this.pending = Promise.resolve();
    this.bytes = 0;
  }

  async enable(directory: string) {
    try {
      const destination = path.join(directory, 'diagnostics');
      await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
      const previous = (await fs.promises.readdir(destination)).filter((name) => /^debug-\d+\.log$/.test(name)).sort();
      for (const name of previous.slice(0, Math.max(0, previous.length - 2)))
        await fs.promises.unlink(path.join(destination, name));
      this.file = path.join(destination, `debug-${Date.now()}.log`);
      await fs.promises.writeFile(this.file, '', { mode: 0o600 });
      for (const entry of this.entries) this.persist(entry);
    } catch {
      this.file = null;
    }
  }

  log(level: TraceLevel, event: string, details: Record<string, unknown> = {}) {
    const data: DiagnosticEntry['data'] = {};
    for (const [key, value] of Object.entries(details)) {
      if (!fields.has(key) || value == null) continue;
      data[key] = typeof value === 'number' || typeof value === 'boolean' ? value : redact(value);
    }
    const now = new Date();
    const entry = {
      id: ++this.sequence,
      time: localTimestamp(now),
      utc: now.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      level,
      event: redact(event),
      data,
    };
    this.entries.push(entry);
    if (this.entries.length > 1000) this.entries.shift();
    this.persist(entry);
    return entry;
  }

  error(event: string, error: ClientError, details: Record<string, unknown> = {}) {
    this.log('error', event, {
      ...details,
      name: error?.name,
      code: error?.code,
      status: error?.status,
      message: error?.message,
    });
  }

  persist(entry: DiagnosticEntry) {
    if (!this.file) return;
    const line = `${JSON.stringify(entry)}\n`;
    // 限制明文诊断文件大小，并与加密监考日志分开存储。
    if (this.bytes + Buffer.byteLength(line) > 4 * 1024 * 1024) return;
    this.bytes += Buffer.byteLength(line);
    this.pending = this.pending.then(() => fs.promises.appendFile(this.file, line)).catch(() => {});
  }

  snapshot(after = 0): DiagnosticSnapshot {
    return {
      entries: this.entries.filter((entry) => entry.id > after),
      latest: this.sequence,
      file: this.file || null,
    };
  }

  async span<T>(event: string, action: () => T | Promise<T>): Promise<T> {
    const start = Date.now();
    this.log('info', `${event}.start`);
    try {
      const result = await action();
      this.log('info', `${event}.complete`, { durationMs: Date.now() - start });
      return result;
    } catch (error) {
      this.error(`${event}.failed`, error, { durationMs: Date.now() - start });
      throw error;
    }
  }
}

export { Diagnostics, redact, localTimestamp };
