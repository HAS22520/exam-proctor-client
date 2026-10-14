import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { NativeProcessScanner } from '../app/main/security/process-scanner';

function fixture(t) {
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.emit('exit', 0); };
    let starts = 0;
    const scanner = new NativeProcessScanner((() => {
        starts++;
        return child;
    }) as any);
    t.after(() => scanner.close());
    const entry = {
        pid: 100, created: '123', name: 'renamed.exe', path: 'C:/renamed.exe',
        originalName: 'chrome.exe', sha256: 'a'.repeat(64), signed: true,
    };
    return { child, scanner, entry, starts: () => starts };
}

test('多轮进程快照复用一个原生进程，接收分块响应，终止携带创建时间避免 PID 复用', async (t) => {
    const f = fixture(t);
    const first = f.scanner.snapshot();
    const reply = `${JSON.stringify({ id: 1, ok: true, processes: [f.entry] })}\n`;
    f.child.stdout.write(reply.slice(0, 20));
    f.child.stdout.write(reply.slice(20));
    assert.deepEqual(await first, [f.entry]);
    const next = f.scanner.snapshot();
    f.child.stdout.write(`${JSON.stringify({ id: 2, ok: true, processes: [] })}\n`);
    assert.deepEqual(await next, []);
    const ending = f.scanner.terminate(f.entry);
    const commands = f.child.stdin.read().toString();
    assert.match(commands, /3\tterminate\t100\t123/);
    f.child.stdout.write('{"id":3,"ok":true}\n');
    await ending;
    assert.equal(f.starts(), 1);
    await assert.rejects(f.scanner.terminate({ ...f.entry, created: '0' }), /身份不完整/);
});

test('扫描进程停止时拒绝未完成请求，无效身份响应不能触发进程处置', async (t) => {
    const f = fixture(t);
    const first = f.scanner.snapshot();
    f.child.stdout.write(`${JSON.stringify({ id: 1, ok: true, processes: [{ ...f.entry, created: '123\tterminate\t1' }] })}\n`);
    await assert.rejects(first, /响应无效/);
    const waiting = f.scanner.snapshot();
    f.child.emit('exit', 1);
    await assert.rejects(waiting, /组件已停止/);
});
