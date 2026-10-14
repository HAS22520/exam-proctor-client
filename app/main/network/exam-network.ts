import type { Trace } from '../contracts';
import { ControlledProxy } from './controlled-proxy';

type SessionNetwork = Pick<Electron.Session, 'setProxy' | 'closeAllConnections'>;

class ExamNetwork {
    private sessions: SessionNetwork[];
    private debug = false;
    readonly proxy: ControlledProxy;

    constructor(
        private session: SessionNetwork,
        private origins: string[],
        private trace: Trace = () => {},
        beforeConnect: () => Promise<unknown> = async () => {},
        updates?: SessionNetwork,
    ) {
        this.sessions = [session, updates].filter(Boolean);
        this.proxy = new ControlledProxy(origins, { beforeConnect });
        this.lookup = this.lookup.bind(this);
    }

    async prepare() {
        await this.proxy.start();
        for await (const session of this.sessions) {
            await session.setProxy({
                mode: 'fixed_servers', proxyRules: this.proxy.proxyRules, proxyBypassRules: '<-loopback>',
            });
            await session.closeAllConnections();
        }
        this.trace('info', 'network.connection-mode', { source: 'controlled-proxy' });
    }

    async setDebug(enabled: boolean) {
        if (this.debug === enabled) return;
        this.debug = enabled;
        if (enabled) await this.session.setProxy({ mode: 'direct' });
        else await this.prepare();
        await this.session.closeAllConnections();
    }

    get auxiliaryEndpoints() { return [this.proxy.localEndpoint, ...this.proxy.dnsEndpoints]; }

    close() { this.proxy.close(); }

    observe(details: { url: string, fromCache?: boolean, ip?: string }) {
        const url = new URL(details.url);
        if (!details.fromCache && this.origins.includes(url.origin)) {
            this.trace('info', 'network.response', { url: details.url });
        }
    }

    async lookup(host: string) {
        // 新连接候选和正在使用的地址均保留，DNS 刷新不能打断既有提交或 WebSocket。
        const addresses = await this.proxy.policyLookup(host);
        this.trace('info', 'network.resolved', { url: host, message: addresses.map((entry) => entry.address).join(', ') });
        return addresses;
    }
}

export = ExamNetwork;
