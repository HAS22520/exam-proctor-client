import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type { UploadProgress, UploadReply } from '../contracts';
import { parseReply, ProctorError } from './protocol-errors';

interface UploadOptions {
    session: Electron.Session;
    origin: string;
    path: string;
    filename: string;
    uploadName: string;
    headers: Record<string, string>;
    onProgress?: (progress: UploadProgress) => void;
    timeoutMs?: number;
    createRequest?: (options: Electron.ClientRequestConstructorOptions) => Electron.ClientRequest;
}

async function uploadFile({
    session,
    origin,
    path,
    filename,
    uploadName,
    headers,
    onProgress,
    timeoutMs = 120000,
    createRequest = (options) => (require('electron') as typeof import('electron')).net.request(options),
}: UploadOptions) {
    const url = new URL(path, origin);
    if (url.origin !== origin || !path.startsWith('/') || path.startsWith('//') || !/^proctor-[a-f0-9]{24}\.hplog$/.test(uploadName)) {
        throw new Error('日志上传目标无效');
    }
    const boundary = `HydroProctor${crypto.randomBytes(24).toString('hex')}`;
    const prefix = Buffer.from(
        [
            `--${boundary}\r\nContent-Disposition: form-data; name="operation"\r\n\r\nupload\r\n`,
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${uploadName}"\r\n`,
            'Content-Type: application/octet-stream\r\n\r\n',
        ].join(''),
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const total = prefix.length + fs.statSync(filename).size + suffix.length;
    const request = createRequest({
        url: url.href,
        method: 'POST',
        session,
        useSessionCookies: true,
        redirect: 'manual',
    }) as Electron.ClientRequest & { readonly writableFinished?: boolean };
    request.chunkedEncoding = true;
    for (const [key, value] of Object.entries({
        Accept: 'application/json',
        Origin: origin,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        ...headers,
    })) {
        request.setHeader(key, value);
    }
    let ended = false;
    let responseStarted = false;
    let sent = 0;
    let input: fs.ReadStream;
    return new Promise<UploadReply>((resolve, reject) => {
        let poll: ReturnType<typeof setInterval>;
        let timeout: ReturnType<typeof setTimeout>;
        const finish = (error: Error | null, result?: UploadReply) => {
            if (ended) return;
            ended = true;
            clearInterval(poll);
            clearTimeout(timeout);
            input?.destroy();
            if (error) reject(error);
            else resolve(result);
        };
        const fail = (error: Error) => {
            if (ended) return;
            finish(error);
            request.abort();
        };
        const progress = () => {
            if (ended) return;
            let value;
            try {
                value = request.getUploadProgress();
            } catch {
                fail(new ProctorError('无法读取日志上传进度'));
                return;
            }
            if (!value.active || !value.started) return;
            sent = Math.max(sent, Math.min(total, value.current));
            onProgress?.({
                sent,
                total,
                percent: Math.floor((sent / total) * 100),
                phase: responseStarted || sent === total ? 'verifying' : 'uploading',
            });
        };
        poll = setInterval(progress, 200);
        timeout = setTimeout(() => fail(new ProctorError('日志上传超时')), timeoutMs);
        request.on('error', (error) => fail(new ProctorError(error.message)));
        request.on('abort', () => finish(new ProctorError('日志上传已中断')));
        // Electron 44 使用 Writable，请求体流可能先于 HTTP 响应关闭。
        // 只有请求体尚未写完就关闭，才表示上传中断。
        request.on('close', () => {
            if (!ended && !request.writableFinished) finish(new ProctorError('日志上传响应丢失'));
        });
        request.on('redirect', () => fail(new ProctorError('日志上传不允许重定向', 403)));
        request.on('response', (response) => {
            if (ended) return;
            responseStarted = true;
            progress();
            onProgress?.({ phase: 'verifying', sent, total, percent: Math.floor((sent / total) * 100) });
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('error', (error) => fail(new ProctorError(error.message)));
            response.on('aborted', () => fail(new ProctorError('日志上传响应丢失')));
            response.on('data', (chunk) => {
                if (ended) return;
                size += chunk.length;
                if (size > 1024 * 1024) {
                    fail(new ProctorError('协议响应超过大小限制', 400));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                if (ended) return;
                const type = response.headers['content-type'];
                try {
                    finish(
                        null,
                        parseReply(
                            Buffer.concat(chunks).toString('utf8'),
                            response.statusCode,
                            Array.isArray(type) ? type.join(';') : String(type || ''),
                        ),
                    );
                } catch (error) {
                    finish(error);
                }
            });
        });
        (async () => {
            const write = (chunk: Buffer) =>
                new Promise<void>((done, rejectWrite) =>
                    request.write(chunk, 'utf8', (error?: Error | null) => (error ? rejectWrite(error) : done())),
                );
            await write(prefix);
            if (ended) return;
            input = fs.createReadStream(filename);
            for await (const chunk of input) {
                if (ended) return;
                await write(chunk);
            }
            if (!ended) request.end(suffix);
        })().catch(fail);
    });
}

export { uploadFile };
