import * as dns from 'node:dns';
import * as http from 'node:http';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';

interface Address { address: string, ttl?: number }
interface ProxyOptions {
    resolve?: (host: string) => Promise<Address[]>;
    beforeConnect?: () => Promise<unknown>;
}

/** 仅转发编译白名单中的来源；HTTPS/WSS 原样隧道转发，保留浏览器证书校验。 */
export class ControlledProxy {
    private server: http.Server;
    private sockets = new Set<Duplex>();
    private leases = new Map<string, Map<string, number>>();
    private cache = new Map<string, { addresses: Address[], expires: number }>();
    private resolver = new dns.promises.Resolver({ timeout: 2500, tries: 2 });
    private allowed: Set<string>;
    private options: ProxyOptions;
    private starting: Promise<void> | null = null;
    private port = 0;
    private closed = false;
    readonly servers: string[];

    constructor(origins: string[], options: ProxyOptions = {}) {
        this.allowed = new Set(origins);
        this.options = options;
        // 固定启动时的 DNS 上游；只发起白名单域名的 A/AAAA 查询，不提供通用 DNS 接口。
        this.servers = this.resolver.getServers();
        this.resolver.setServers(this.servers);
        this.server = http.createServer((request, response) => {
            this.forward(request, response).catch(() => {
                if (!response.headersSent) response.writeHead(502);
                response.end('监考网络无法连接目标，请检查网络连接。');
            });
        });
        this.server.on('connect', (request, socket, head) => {
            this.tunnel(request, socket, head).catch(() => socket.destroy());
        });
        this.server.on('upgrade', (request, socket, head) => {
            this.upgrade(request, socket, head).catch(() => socket.destroy());
        });
        this.server.on('connection', (socket) => {
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
        });
        this.server.on('clientError', (_error, socket) => socket.destroy());
        this.server.maxConnections = 128;
        this.server.requestTimeout = 15000;
        this.server.headersTimeout = 10000;
    }

    get proxyRules() { return `http://127.0.0.1:${this.port}`; }

    get localEndpoint() {
        if (!this.port) throw new Error('受控网络转发器尚未启动');
        return `127.0.0.1|${this.port}`;
    }

    get dnsEndpoints() {
        return this.servers.map((server) => {
            const match = server.match(/^\[([^\]]+)\](?::(\d+))?$/);
            const host = match ? match[1] : net.isIP(server) ? server : server.split(':')[0];
            const port = match?.[2] || (!net.isIP(server) && server.split(':')[1]) || '53';
            if (!net.isIP(host)) throw new Error('系统 DNS 上游地址无效');
            return `${host}|${port}|dns`;
        });
    }

    start() {
        if (this.closed) return Promise.reject(new Error('受控转发器已关闭'));
        if (this.port) return Promise.resolve();
        this.starting ||= new Promise<void>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => {
                this.server.removeListener('error', reject);
                this.port = (this.server.address() as net.AddressInfo).port;
                resolve();
            });
        });
        return this.starting;
    }

    private target(value: string, tunnel = false) {
        const url = new URL(value);
        const plain = new URL(`http://${url.hostname}:${url.port || '443'}`);
        const allowed = this.allowed.has(url.origin) || (tunnel && this.allowed.has(plain.origin));
        if (url.username || url.password || !allowed) throw new Error('目标不在编译白名单内');
        return url;
    }

    async lookup(host: string): Promise<Address[]> {
        if (![...this.allowed].some((origin) => new URL(origin).hostname.replace(/^\[|\]$/g, '') === host)) {
            throw new Error('解析域名不在编译白名单内');
        }
        if (net.isIP(host)) return [{ address: host, ttl: 60 }];
        if (host === 'localhost') return [{ address: '127.0.0.1', ttl: 60 }, { address: '::1', ttl: 60 }];
        const saved = this.cache.get(host);
        if (saved && saved.expires > Date.now()) return saved.addresses;
        let addresses = this.options.resolve
            ? await this.options.resolve(host)
            : (await Promise.allSettled([
                this.resolver.resolve4(host, { ttl: true }),
                this.resolver.resolve6(host, { ttl: true }),
            ])).flatMap((result) => result.status === 'fulfilled' ? result.value : []);
        if (!addresses.length || addresses.some((entry) => !net.isIP(entry.address))) throw new Error('白名单域名解析失败');
        const ipv4 = addresses.filter((entry) => net.isIP(entry.address) === 4);
        const ipv6 = addresses.filter((entry) => net.isIP(entry.address) === 6);
        addresses = [];
        for (let index = 0; addresses.length < 32 && index < Math.max(ipv4.length, ipv6.length); index++) {
            if (ipv4[index]) addresses.push(ipv4[index]);
            if (ipv6[index] && addresses.length < 32) addresses.push(ipv6[index]);
        }
        this.cache.set(host, {
            addresses,
            expires: Date.now() + Math.max(1000, Math.min(60000, ...addresses.map((entry) => (entry.ttl ?? 30) * 1000))),
        });
        return addresses;
    }

    async policyLookup(host: string) {
        const current = await this.lookup(host);
        return [...new Set([...current.map((entry) => entry.address), ...(this.leases.get(host)?.keys() || [])])]
            .map((address) => ({ address }));
    }

    private hold(host: string, addresses: Address[]) {
        const counts = this.leases.get(host) || new Map<string, number>();
        this.leases.set(host, counts);
        for (const entry of addresses) counts.set(entry.address, (counts.get(entry.address) || 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            for (const entry of addresses) {
                const count = counts.get(entry.address) - 1;
                if (count) counts.set(entry.address, count);
                else counts.delete(entry.address);
            }
            if (!counts.size) this.leases.delete(host);
        };
    }

    private async connect(url: URL): Promise<net.Socket> {
        if (this.closed) throw new Error('受控转发器已关闭');
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const addresses = await this.lookup(host);
        const release = this.hold(host, addresses);
        // 新解析地址必须先进入 WFP 策略，才能建立上游连接；不能临时解除整机限制。
        try { await this.options.beforeConnect?.(); } catch (error) {
            release();
            throw error;
        }
        try {
            const socket = await this.dial(addresses, Number(url.port || (url.protocol === 'https:' ? 443 : 80)));
            socket.once('close', release);
            return socket;
        } catch (error) {
            release();
            throw error;
        }
    }

    private dial(addresses: Address[], port: number): Promise<net.Socket> {
        // 交错尝试地址，避免坏的 IPv4 路由拖住可用 IPv6；连接建立后取消所有竞争连接。
        return new Promise((resolve, reject) => {
            const candidates = new Set<net.Socket>();
            let next = 0;
            let settled = false;
            let interval: ReturnType<typeof setInterval>;
            let deadline: ReturnType<typeof setTimeout>;
            const finish = (error?: Error, winner?: net.Socket) => {
                if (settled) return;
                settled = true;
                clearInterval(interval);
                clearTimeout(deadline);
                for (const socket of candidates) if (socket !== winner) socket.destroy();
                if (winner) resolve(winner);
                else reject(error || new Error('目标连接失败'));
            };
            const launch = () => {
                if (settled) return;
                if (this.closed) {
                    finish(new Error('受控转发器已关闭'));
                    return;
                }
                if (next >= addresses.length) {
                    if (!candidates.size) finish();
                    return;
                }
                const socket = net.connect(port, addresses[next++].address);
                candidates.add(socket);
                this.sockets.add(socket);
                socket.once('close', () => {
                    this.sockets.delete(socket);
                    candidates.delete(socket);
                });
                socket.on('error', () => {
                    candidates.delete(socket);
                    if (!settled && !candidates.size) launch();
                });
                socket.once('connect', () => finish(undefined, socket));
            };
            interval = setInterval(launch, 250);
            deadline = setTimeout(() => finish(new Error('目标连接超时')), 7500);
            launch();
        });
    }

    private async tunnel(request: http.IncomingMessage, socket: Duplex, head: Buffer) {
        const url = this.target(`https://${request.url}/`, true);
        const upstream = await this.connect(url);
        if (socket.destroyed) {
            upstream.destroy();
            return;
        }
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
        socket.on('close', () => upstream.destroy());
        upstream.on('close', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
    }

    private async forward(request: http.IncomingMessage, response: http.ServerResponse) {
        const url = this.target(request.url || '');
        if (url.protocol !== 'http:') throw new Error('HTTPS 必须使用 CONNECT 隧道');
        const socket = await this.connect(url);
        const headers: http.OutgoingHttpHeaders = { ...request.headers, host: url.host };
        delete headers['proxy-authorization'];
        delete headers['proxy-connection'];
        const upstream = http.request({
            method: request.method, host: url.hostname, port: Number(url.port || 80),
            path: url.pathname + url.search, headers, createConnection: () => socket,
        }, (reply) => {
            response.writeHead(reply.statusCode || 502, reply.headers);
            reply.pipe(response);
        });
        upstream.on('error', () => response.destroy());
        response.on('close', () => upstream.destroy());
        request.pipe(upstream);
    }

    private async upgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer) {
        const target = new URL(request.url || '', `http://${request.headers.host}`);
        if (target.protocol === 'ws:') target.protocol = 'http:';
        const url = this.target(target.href);
        if (url.protocol !== 'http:') throw new Error('安全 WebSocket 必须使用 CONNECT 隧道');
        const upstream = await this.connect(url);
        const headers = Object.entries({ ...request.headers, host: url.host })
            .filter(([name]) => !['proxy-authorization', 'proxy-connection'].includes(name))
            .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\r\n');
        upstream.write(`${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers}\r\n\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
        socket.on('error', () => upstream.destroy());
        socket.on('close', () => upstream.destroy());
        upstream.on('close', () => socket.destroy());
    }

    close() {
        this.closed = true;
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        this.server.close();
        this.resolver.cancel();
        this.port = 0;
    }
}
