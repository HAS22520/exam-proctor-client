import type { ActivityRunner, AuditSink, ClientConfig, Trace } from '../contracts';
import { endpoints, failure, NativeNetwork } from './native-network';

interface FirewallRuntime {
    platform?: NodeJS.Platform;
    trace?: Trace;
    activity?: ActivityRunner;
    lookup?: Parameters<typeof endpoints>[1];
    verifyConnectivity?: () => Promise<unknown>;
    onFailure?: (error: import('../contracts').ClientError) => void;
    native?: FirewallGuard['native'];
}

class FirewallGuard {
    declare config: { exam?: Pick<ClientConfig['exam'], 'allowedOrigins'> };
    declare logger: AuditSink | null;
    declare isLocked: boolean;
    declare platform: NodeJS.Platform;
    declare trace: Trace;
    declare activity: ActivityRunner;
    declare lookup: Parameters<typeof endpoints>[1];
    declare verifyConnectivity: () => Promise<unknown>;
    declare pending: Promise<unknown>;
    declare native:
        | (Pick<NativeNetwork, 'active' | 'check' | 'lock' | 'unlock' | 'close'> & Partial<Pick<NativeNetwork, 'healthy'>>)
        | null;

    declare auditRecorded: boolean;
    declare cancelled: boolean;
    declare lockPending: Promise<boolean> | null;
    declare restorePending: Promise<void> | null;

    constructor(
        config: FirewallGuard['config'],
        logger: AuditSink | null,
        runtime: FirewallRuntime = {},
    ) {
        Object.assign(this, { config, logger, isLocked: false });
        this.platform = runtime.platform || process.platform;
        this.trace = runtime.trace || (() => {});
        this.activity = runtime.activity || ((_kind, _stage, action) => action());
        this.lookup = runtime.lookup;
        this.verifyConnectivity = runtime.verifyConnectivity || (async () => {});
        this.pending = Promise.resolve();
        this.native =
            this.platform === 'darwin'
                ? null
                : runtime.native
                    || new NativeNetwork({
                        platform: this.platform,
                        trace: this.trace,
                        onFailure: (error: Error) => {
                            this.isLocked = false;
                            runtime.onFailure?.(error);
                        },
                    });
    }

    get mode() {
        return this.platform === 'win32' ? 'windows-wfp' : this.platform === 'darwin' ? 'macos-audit-only' : 'unavailable';
    }

    checkPrivileges() {
        return this.platform === 'win32' ? this.native.check() : Promise.resolve();
    }

    enqueue<T>(stage: string, action: () => T | Promise<T>): Promise<T> {
        const result = this.pending.then(() => this.activity('network', stage, action));
        this.pending = result.catch(() => {});
        return result;
    }

    lock() {
        if (this.platform === 'darwin') {
            if (!this.auditRecorded) {
                this.logger?.logViolation({
                    source: 'CLIENT',
                    type: 'NETWORK_AUDIT_ONLY',
                    target: this.mode,
                    detail: 'macOS 不限制系统网络',
                });
                this.auditRecorded = true;
            }
            return Promise.resolve(false);
        }
        if (this.lockPending) return this.lockPending;
        if (this.isLocked && (this.native.healthy?.() ?? this.native.active) && !this.restorePending) {
            return Promise.resolve(true);
        }
        this.cancelled = false;
        const pending = this.enqueue('lock', async () => {
            this.trace('info', 'firewall.stage', { phase: 'resolve-destinations' });
            const policy = await endpoints(this.config.exam.allowedOrigins, this.lookup);
            this.trace('info', 'firewall.policy', { message: policy });
            if (this.cancelled) throw failure('NETWORK_CANCELLED', '用户已退出监考');
            const started = Date.now();
            try {
                await this.native.lock(policy);
                this.trace('info', 'firewall.stage', { phase: 'verify-oj-connectivity' });
                try {
                    await this.verifyConnectivity();
                } catch (cause) {
                    this.trace('error', 'firewall.connectivity-failed', {
                        name: cause.name,
                        code: cause.code,
                        message: cause.message,
                    });
                    throw Object.assign(failure('NETWORK_OJ_UNREACHABLE'), { cause });
                }
            } catch (error) {
                this.isLocked = false;
                try {
                    await this.native.unlock();
                } catch (restoreError) {
                    this.trace('error', 'firewall.rollback-failed', { code: restoreError.code, message: restoreError.message });
                } finally {
                    this.native.close();
                }
                throw error;
            }
            if (this.cancelled) {
                this.native.close();
                throw failure('NETWORK_CANCELLED', '用户已退出监考');
            }
            this.isLocked = true;
            this.trace('info', 'firewall.complete', {
                operation: 'native-lock',
                backend: this.mode,
                durationMs: Date.now() - started,
            });
            this.logger?.logViolation({ source: 'FIREWALL', type: 'NETWORK_POLICY_APPLIED', target: this.mode, detail: '' });
            return true;
        });
        this.lockPending = pending;
        pending
            .finally(() => {
                if (this.lockPending === pending) this.lockPending = null;
            })
            .catch(() => {});
        return pending;
    }

    recover() {
        if (this.platform === 'darwin') {
            this.auditRecorded = false;
            return Promise.resolve();
        }
        if (this.restorePending) return this.restorePending;
        if (!this.lockPending && !this.isLocked && !this.native.active) return Promise.resolve();
        const pending = this.enqueue('restore', async () => {
            const started = Date.now();
            try {
                await this.native.unlock();
            } catch (error) {
                this.isLocked = false;
                throw error;
            }
            this.isLocked = false;
            this.trace('info', 'firewall.complete', {
                operation: 'native-unlock',
                backend: this.mode,
                durationMs: Date.now() - started,
            });
        });
        this.restorePending = pending;
        pending
            .finally(() => {
                if (this.restorePending === pending) this.restorePending = null;
            })
            .catch(() => {});
        return pending;
    }

    unlock() {
        return this.recover();
    }

    cancelPendingLock() {
        if (this.lockPending) {
            this.cancelled = true;
            this.native.close();
        }
    }

    close() {
        this.native?.close();
    }
}
export = FirewallGuard;
