import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { globalShortcut, screen } from 'electron';
import type { AuditSink, ClientConfig } from '../contracts';
import { NativeProcessScanner, type ProcessInfo } from './process-scanner';

class AntiCheatGuard {
    declare window: Electron.BrowserWindow;
    declare config: ClientConfig['antiCheat'] & { preventMinimize?: boolean };
    declare logger: AuditSink | null;
    declare shortcuts: string[];
    declare listeners: (() => void)[];
    declare running: boolean;
    declare scanning: boolean;
    declare detected: Map<string, string>;
    declare platform: NodeJS.Platform;
    declare auditOnly: boolean;
    declare scanner: Pick<NativeProcessScanner, 'snapshot' | 'terminate' | 'close'>;
    declare generation: number;
    declare knownHashes: Set<string>;
    declare focusTimer: ReturnType<typeof setTimeout>;
    declare focusWatch: ReturnType<typeof setInterval>;
    declare timer: ReturnType<typeof setInterval>;

    constructor(
        mainWindow: Electron.BrowserWindow,
        config: ClientConfig,
        auditLogger: AuditSink | null = null,
        runtime: { platform?: NodeJS.Platform, scanner?: AntiCheatGuard['scanner'] } = {},
    ) {
        this.window = mainWindow;
        this.config = { ...config.antiCheat, preventMinimize: config.window?.preventMinimize };
        this.logger = auditLogger;
        this.shortcuts = [];
        this.listeners = [];
        this.running = false;
        this.scanning = false;
        this.detected = new Map();
        this.platform = runtime.platform || process.platform;
        this.auditOnly = this.platform === 'darwin';
        this.scanner = runtime.scanner || new NativeProcessScanner();
        this.generation = 0;
        this.knownHashes = new Set(config.antiCheat.processBlacklistHashes || []);
    }

    record(type: string, target = '') {
        this.logger?.logViolation({ source: 'ANTI_CHEAT', type, target, detail: '' });
    }

    listen(emitter: import('node:events').EventEmitter, event: string, callback: (...args: unknown[]) => void) {
        emitter.on(event, callback);
        this.listeners.push(() => emitter.removeListener(event, callback));
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.generation++;
        for (const shortcut of this.auditOnly ? [] : this.config.blockShortcuts || []) {
            try {
                if (globalShortcut.register(shortcut, () => this.record('BLOCKED_SHORTCUT', shortcut))) {
                    this.shortcuts.push(shortcut);
                } else this.record('SHORTCUT_UNAVAILABLE', shortcut);
            } catch {
                this.record('SHORTCUT_UNAVAILABLE', shortcut);
            }
        }
        this.listen(this.window, 'blur', () => {
            this.record('WINDOW_BLUR');
            this.restoreFocus();
        });
        this.listen(this.window, 'minimize', () => {
            this.record('WINDOW_MINIMIZED');
            if (!this.auditOnly && this.config.preventMinimize && !this.window.isDestroyed()) this.window.restore();
        });
        const displays = () => {
            const count = screen.getAllDisplays().length;
            if (this.config.singleScreenOnly && count > 1) this.record('MULTI_SCREEN_DETECTED', String(count));
        };
        for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
            this.listen(screen, event, displays);
        }
        displays();
        if (!this.auditOnly && this.config.preventMinimize) {
            this.focusWatch = setInterval(() => {
                if (this.window.isDestroyed()) return;
                if (this.window.isFocused?.() === false) this.restoreFocus();
            }, 750);
            this.focusWatch.unref?.();
        }
        this.scan();
        this.timer = setInterval(() => this.scan(), Math.max(1000, this.config.checkProcessIntervalMs || 3000));
        this.timer.unref();
    }

    restoreFocus() {
        if (this.auditOnly || !this.config.preventMinimize || this.focusTimer) return;
        // Windows 在 blur 返回后才完成前台切换，必须延后恢复；弹窗打开时 stop 会取消任务。
        const generation = this.generation;
        this.focusTimer = setTimeout(() => {
            this.focusTimer = null;
            if (!this.running || generation !== this.generation || this.window.isDestroyed()) return;
            if (this.window.isMinimized?.()) this.window.restore();
            this.window.moveTop?.();
            if (this.running && generation === this.generation && !this.window.isDestroyed()) this.window.focus();
        }, 80);
        this.focusTimer.unref?.();
    }

    scan() {
        if (!this.running || this.scanning) return;
        this.scanning = true;
        const windows = this.platform === 'win32';
        if (!windows && this.platform !== 'darwin') {
            this.scanning = false;
            return;
        }
        const generation = this.generation;
        const accept = (entries: ProcessInfo[]) => {
            if (this.running && generation === this.generation) this.inspectProcesses(entries);
        };
        const failed = () => {
            if (this.running && generation === this.generation) this.record('PROCESS_SCAN_UNAVAILABLE');
        };
        if (windows) {
            this.scanner.snapshot().then(accept, failed).finally(() => { this.scanning = false; });
            return;
        }
        execFile('/bin/ps', ['-axo', 'pid=,comm='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, output) => {
            this.scanning = false;
            if (error) {
                failed();
                return;
            }
            const entries = output.split(/\r?\n/).flatMap((line) => {
                const match = line.trim().match(/^(\d+)\s+(\S.*)$/);
                return match ? [{
                    pid: Number(match[1]), name: path.basename(match[2]), path: match[2],
                    created: '0', originalName: '', sha256: '', signed: false,
                }] : [];
            });
            accept(entries);
        });
    }

    inspectProcesses(entries: ProcessInfo[]) {
        const blacklist = this.config.processBlacklistByPlatform?.[this.platform]
            || (this.platform === 'win32' ? this.config.processBlacklist || [] : []);
        const forbidden = new Set(blacklist.map((name) => name.toLowerCase()));
        const detected = new Map<string, string>();
        for (const entry of entries) {
            if (entry.pid === process.pid || entry.pid < 2) continue;
            const named = forbidden.has(entry.name.toLowerCase());
            const renamed = entry.signed && forbidden.has(entry.originalName.toLowerCase());
            const hashed = /^[a-f0-9]{64}$/.test(entry.sha256) && this.knownHashes.has(entry.sha256);
            if (!named && !renamed && !hashed) continue;
            if ((named || renamed) && /^[a-f0-9]{64}$/.test(entry.sha256)) this.knownHashes.add(entry.sha256);
            const processKey = `${entry.pid}:${entry.created}:${entry.name}`;
            detected.set(processKey, entry.name);
            if (this.detected.has(processKey)) continue;
            this.logger?.logViolation({ source: 'ANTI_CHEAT', type: 'FORBIDDEN_PROCESS', target: entry.name,
                detail: JSON.stringify({
                    pid: entry.pid, path: entry.path, originalName: entry.originalName, sha256: entry.sha256, signed: entry.signed,
                }) });
            // 未识别进程不会自动判定作弊；macOS 始终只记录。终止时校验 PID 的创建时间。
            if (!this.auditOnly && this.config.terminateBlacklisted === true) {
                this.scanner.terminate(entry).then(
                    () => this.record('PROCESS_TERMINATED', entry.name),
                    () => this.record('PROCESS_TERMINATION_FAILED', entry.name),
                );
            }
        }
        for (const [key, name] of this.detected) if (!detected.has(key)) this.record('FORBIDDEN_PROCESS_EXITED', name);
        this.detected = detected;
    }

    close() {
        this.stop();
        this.scanner.close();
    }

    stop() {
        this.running = false;
        this.generation++;
        if (!this.auditOnly && this.scanning) this.scanner.close();
        this.detected.clear();
        clearInterval(this.timer);
        clearInterval(this.focusWatch);
        clearTimeout(this.focusTimer);
        this.focusTimer = null;
        for (const dispose of this.listeners.splice(0)) dispose();
        for (const shortcut of this.shortcuts.splice(0)) globalShortcut.unregister(shortcut);
    }
}

export = AntiCheatGuard;
