import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { uploadFile } from '../app/main/proctor/upload-transport';
import { forEachSerial, workspace } from './helpers';

function fixture(t, mode = 'ok') {
    const directory = workspace(t);
    const filename = path.join(directory, 'final.hplog');
    const bytes = Buffer.from('encrypted evidence');
    fs.writeFileSync(filename, bytes);
    const headers: any = {};
    const chunks = [];
    const statuses = [];
    const request: any = new EventEmitter();
    let uploaded = 0;
    let target;
    request.setHeader = (name, value) => {
        headers[name] = value;
    };
    request.getUploadProgress = () => ({ active: true, started: true, current: uploaded });
    request.write = (chunk, encoding, callback) => {
        if (mode === 'write-error') {
            callback(new Error('请求体写入失败'));
            return;
        }
        chunks.push(Buffer.from(chunk));
        callback();
    };
    request.abort = () => {
        request.aborted = true;
        request.emit('abort');
    };
    request.end = (chunk) => {
        chunks.push(chunk);
        if (mode === 'electron44') {
            request.writableFinished = true;
            request.emit('close');
        }
        if (mode === 'redirect') {
            request.emit('redirect');
            return;
        }
        if (mode === 'lost') {
            request.emit('close');
            return;
        }
        if (mode === 'timeout') return;
        // 写入回调已完成，但上传进度只统计网络层实际报告的字节数。
        uploaded = Math.floor(Buffer.concat(chunks).length / 2);
        setTimeout(() => {
            const response: any = new EventEmitter();
            response.statusCode = 200;
            response.headers = { 'content-type': mode === 'electron44' ? 'application/json' : ['application/json'] };
            request.emit('response', response);
            response.emit(
                'data',
                Buffer.from(mode === 'large' ? 'x'.repeat(1024 * 1024 + 1) : JSON.stringify({ ok: true, receipt: 'd'.repeat(24) })),
            );
            response.emit('end');
            request.emit('close');
        }, 230);
    };
    return {
        bytes,
        chunks,
        headers,
        request,
        statuses,
        get target() {
            return target;
        },
        options: {
            session: { id: 'exam-session' } as any,
            origin: 'https://oj.example.com',
            path: `/contest/${'a'.repeat(24)}/proctor`,
            filename,
            uploadName: `proctor-${'b'.repeat(24)}.hplog`,
            headers: { 'x-proctor-token': 'token', 'x-proctor-proof': 'proof' },
            onProgress: (status) => statuses.push(status),
            createRequest: (options) => {
                target = options;
                return request;
            },
        },
    };
}

test('流式上传携带考试 Cookie，以原生网络进度计数，再等待 JSON 回执', async (t) => {
    const f = fixture(t);
    const response = await uploadFile(f.options);
    assert.equal(response.receipt, 'd'.repeat(24));
    assert.equal(f.target.session.id, 'exam-session');
    assert.equal(f.target.useSessionCookies, true);
    assert.equal(f.target.redirect, 'manual');
    assert.equal(f.request.chunkedEncoding, true);
    assert.equal(f.headers['x-proctor-proof'], 'proof');
    assert.equal(f.headers['Content-Length'], undefined);
    const multipart = Buffer.concat(f.chunks).toString();
    assert.match(multipart, /name="operation"\r\n\r\nupload/);
    assert.ok(multipart.includes(f.options.uploadName));
    assert.ok(multipart.includes(f.bytes.toString()));
    assert.ok(f.statuses.some((value) => value.phase === 'uploading' && value.percent >= 49 && value.percent <= 50));
    assert.equal(f.statuses.at(-1).phase, 'verifying');
    assert.ok(f.statuses.every((value) => value.sent < value.total));
});

test('上传不跟随重定向，也不将响应丢失、超时或超限报告为成功', async (t) => {
    await forEachSerial(['redirect', 'lost', 'timeout', 'large', 'write-error'], async (mode) => {
        const f = fixture(t, mode);
        await assert.rejects(uploadFile({ ...f.options, timeoutMs: mode === 'timeout' ? 10 : 2000 }));
        assert.ok(!f.statuses.some((value) => value.phase === 'complete'));
        if (mode !== 'lost') assert.equal(f.request.aborted, true);
    });
});

test('Electron 44 请求体提前关闭及字符串响应头仍可正确确认回执', async (t) => {
    const f = fixture(t, 'electron44');
    assert.equal((await uploadFile(f.options)).receipt, 'd'.repeat(24));
    assert.equal(f.request.aborted, undefined);
});

test('上传目标拒绝外站、协议相对路径及不安全文件名', async (t) => {
    const f = fixture(t);
    await forEachSerial(
        [{ path: 'https://other.example/upload' }, { path: '//other.example/upload' }, { uploadName: 'file\r\nheader.hplog' }],
        async (extra) => {
            await assert.rejects(uploadFile({ ...f.options, ...extra }));
        },
    );
    assert.equal(f.target, undefined);
});

export {};
