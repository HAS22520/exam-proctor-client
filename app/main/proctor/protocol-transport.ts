import type { Trace, UploadProgress } from '../contracts';
import { ProctorError, parseReply } from './protocol-errors';
import { uploadFile } from './upload-transport';

// 所有协议请求共享考试 Session，保留登录 Cookie，并拒绝跨域和重定向。
class Transport {
  declare session: Electron.Session;
  declare origin: string;
  declare timeoutMs: number;
  declare trace: Trace;

  constructor(session: Transport['session'], origin: string, timeoutMs = 15000, trace: Trace = () => {}) {
    Object.assign(this, { session, origin, timeoutMs, trace });
  }

  async request(
    path: string,
    {
      method = 'POST',
      body,
      headers = {},
      timeoutMs = this.timeoutMs,
      operation,
    }: {
      method?: string;
      body?: BodyInit;
      headers?: Record<string, string>;
      timeoutMs?: number;
      operation?: string;
    } = {},
  ) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || !path.startsWith('/') || path.startsWith('//'))
      throw new Error('协议请求目标无效');
    const started = Date.now();
    const details = { url: url.href, method, operation };
    this.trace('info', 'protocol.request', details);
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await this.session.fetch(url.href, {
        method,
        redirect: 'manual',
        credentials: 'include',
        cache: 'no-store',
        signal,
        headers: { Accept: 'application/json', Origin: this.origin, ...headers },
        body,
      });
      const type = response.headers.get('content-type') || '';
      if (response.status >= 300 && response.status < 400)
        throw new ProctorError('登录或重定向状态异常，请重新登录', response.status);
      if (!type.includes('application/json'))
        throw new ProctorError('服务端未返回协议要求的 JSON', response.status);
      const raw = await response.text();
      const result = parseReply(raw, response.status, type);
      this.trace('info', 'protocol.response', {
        ...details,
        status: response.status,
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      this.trace('error', 'protocol.failed', {
        ...details,
        status: error.status,
        name: error.name,
        code: error.code,
        message: error.message,
        durationMs: Date.now() - started,
      });
      throw error;
    }
  }

  json(path: string, body: unknown, headers?: Record<string, string>) {
    const request = body as { operation?: string };
    const operation = ['challenge', 'handshake', 'refresh', 'finish'].includes(request?.operation)
      ? request.operation
      : undefined;
    return this.request(path, {
      operation,
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  async upload(
    path: string,
    options: {
      filename: string;
      uploadName: string;
      headers: Record<string, string>;
      onProgress?: (progress: UploadProgress) => void;
    },
  ) {
    const started = Date.now();
    this.trace('info', 'protocol.upload-start');
    try {
      const result = await uploadFile({
        session: this.session,
        origin: this.origin,
        path,
        ...options,
      });
      this.trace('info', 'protocol.upload-complete', { durationMs: Date.now() - started });
      return result;
    } catch (error) {
      this.trace('error', 'protocol.upload-failed', {
        name: error.name,
        status: error.status,
        message: error.message,
        durationMs: Date.now() - started,
      });
      throw error;
    }
  }
}

export { Transport };
