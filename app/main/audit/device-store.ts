import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DeviceIdentity } from '../contracts';
import { canonical, digest } from '../proctor/proctor-crypto';

interface BootOptions {
    platform?: NodeJS.Platform;
    exec?: (
        command: string,
        args: string[],
        options: import('node:child_process').ExecFileOptions,
        callback: (error: Error | null, stdout: string) => void,
    ) => unknown;
    read?: (filename: string, encoding: 'utf8') => Promise<string>;
}

function atomicWrite(filename: string, data: string | NodeJS.ArrayBufferView) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temp = `${filename}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(temp, filename);
}

class ProtectedStore {
    declare directory: string;
    declare safeStorage: Pick<Electron.SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>
        & Partial<Pick<Electron.SafeStorage, 'getSelectedStorageBackend'>>;

    constructor(directory: string, safeStorage: ProtectedStore['safeStorage']) {
        this.directory = directory;
        this.safeStorage = safeStorage;
    }

    check() {
        if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
            throw new Error('系统安全密钥存储不可用，禁止回退为明文存储');
        }
    }

    read(name: string) {
        this.check();
        const filename = path.join(this.directory, name);
        return fs.existsSync(filename) ? JSON.parse(this.safeStorage.decryptString(fs.readFileSync(filename))) : null;
    }

    write(name: string, value: unknown) {
        this.check();
        atomicWrite(path.join(this.directory, name), this.safeStorage.encryptString(JSON.stringify(value)));
    }

    device(): DeviceIdentity {
        let device = this.read('device.bin');
        if (!device) {
            const pair = crypto.generateKeyPairSync('ed25519');
            device = {
                privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
                publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
                installationId: crypto.randomBytes(32).toString('hex'),
            };
            // 环境指纹不包含 IP、主机名、开机时间和系统更新版本。
            device.fingerprint = digest(
                canonical({
                    installationId: device.installationId,
                    publicKey: device.publicKey,
                    platform: process.platform,
                    arch: process.arch,
                }),
            );
            this.write('device.bin', device);
        }
        if (
            crypto.createPublicKey(device.privateKey).export({ type: 'spki', format: 'pem' }).toString() !== device.publicKey
            || !/^[a-f0-9]{64}$/.test(device.fingerprint || '')
        ) {
            throw new Error('设备身份损坏，考试期间不能重新生成');
        }
        return device;
    }
}

const deviceInfo = () => ({ platform: process.platform, osVersion: os.release().slice(0, 128), arch: process.arch });
// 读取系统启动标识，不通过当前时间减运行时长计算开机时间，
// 避免校时被误记为 SYSTEM_RESTART 事件。
let cachedBootId: string | null = null;
let bootPending: Promise<string | null>;
function bootIdentity() {
    return cachedBootId;
}
function prepareBootIdentity({ platform = process.platform, exec = execFile, read = fs.promises.readFile }: BootOptions = {}) {
    if (bootPending) return bootPending;
    bootPending = (async () => {
        try {
            const options = { encoding: 'utf8' as const, windowsHide: true, timeout: 10000, maxBuffer: 4096 };
            const command: [string, string[]] =
                platform === 'darwin'
                    ? ['/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']]
                    : [
                        'powershell.exe',
                        [
                            '-NoProfile',
                            '-NonInteractive',
                            '-Command',
                            "(Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o')",
                        ],
                    ];
            const raw = ['darwin', 'win32'].includes(platform)
                ? await new Promise<string>((resolve, reject) =>
                    exec(...command, options, (error: Error | null, stdout: string) => (error ? reject(error) : resolve(stdout))),
                )
                : await read('/proc/sys/kernel/random/boot_id', 'utf8');
            const value = raw.trim();
            if (!value || value.length > 128 || /[\r\n]/.test(value)) throw new Error('系统启动标识无效');
            cachedBootId = digest(`${platform}:${value}`);
        } catch {
            cachedBootId = null;
        }
        return cachedBootId;
    })();
    return bootPending;
}

export { atomicWrite, bootIdentity, deviceInfo, prepareBootIdentity, ProtectedStore };
