import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { executable } from '../network/native-network';

export interface ProcessInfo {
    pid: number;
    created: string;
    name: string;
    path: string;
    originalName: string;
    sha256: string;
    signed: boolean;
}

/** 独立常驻进程扫描器；与网络守护分离，进程扫描耗时不会阻塞网络恢复。 */
export class NativeProcessScanner {
    private child: ReturnType<typeof spawn> | null = null;
    private id = 0;
    private pending = new Map<number, { resolve: (reply: any) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }>();

    constructor(private spawnProcess: typeof spawn = spawn) {}

    private start() {
        if (this.child) return;
        const filename = path.join(path.dirname(executable()), 'hydro-audit.exe');
        const child = this.spawnProcess(filename, ['--parent', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = child;
        const stopped = () => {
            if (this.child !== child) return;
            this.child = null;
            for (const request of this.pending.values()) {
                clearTimeout(request.timer);
                request.reject(new Error('原生进程扫描组件已停止'));
            }
            this.pending.clear();
        };
        child.once('error', stopped);
        child.once('exit', stopped);
        child.stdin.on('error', stopped);
        child.stderr.resume();
        child.stdout.setEncoding('utf8');
        let buffer = '';
        child.stdout.on('data', (chunk) => {
            buffer += chunk;
            if (buffer.length > 2 * 1024 * 1024) {
                child.kill();
                stopped();
                return;
            }
            for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
                const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
                try {
                    const reply = JSON.parse(line);
                    const request = this.pending.get(reply.id);
                    if (!request) continue;
                    clearTimeout(request.timer);
                    this.pending.delete(reply.id);
                    if (reply.ok) request.resolve(reply);
                    else request.reject(new Error('原生进程扫描操作失败'));
                } catch { /* 非协议输出不能改变扫描结果。 */ }
            }
        });
    }

    private command(operation: string) {
        this.start();
        const id = ++this.id;
        return new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                this.close();
                reject(new Error('原生进程扫描超时'));
            }, 30000);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(`${id}\t${operation}\n`);
        });
    }

    async snapshot(): Promise<ProcessInfo[]> {
        const reply = await this.command('scan');
        if (!Array.isArray(reply.processes) || reply.processes.length > 10000
            || reply.processes.some((entry: ProcessInfo) => !Number.isSafeInteger(entry.pid) || entry.pid < 2
                || !(['name', 'path', 'originalName', 'sha256', 'created'] as const).every((field) => typeof entry[field] === 'string')
                || typeof entry.signed !== 'boolean' || !/^\d+$/.test(entry.created))) {
            throw new Error('原生进程扫描响应无效');
        }
        return reply.processes;
    }

    terminate(process: ProcessInfo) {
        if (!Number.isSafeInteger(process.pid) || process.pid < 2 || !/^\d+$/.test(process.created) || process.created === '0') {
            return Promise.reject(new Error('不能终止身份不完整的进程'));
        }
        return this.command(`terminate\t${process.pid}\t${process.created}`);
    }

    close() {
        const child = this.child;
        this.child = null;
        child?.stdin.end();
        child?.kill();
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error('原生进程扫描已取消'));
        }
        this.pending.clear();
    }
}
