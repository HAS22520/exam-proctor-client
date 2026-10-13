import * as net from 'node:net';
import type { Trace } from '../contracts';

class ExamNetwork {
  declare session: Pick<Electron.Session, 'setProxy' | 'closeAllConnections' | 'resolveHost'>;
  declare origins: string[];
  declare trace: Trace;
  declare connected: Map<string, Set<string>>;

  constructor(session: ExamNetwork['session'], origins: string[], trace: Trace = () => {}) {
    Object.assign(this, { session, origins, trace });
    this.connected = new Map();
    this.lookup = this.lookup.bind(this);
  }

  async prepare() {
    // 整机 WFP 策略启用后，本地或系统代理可能失去上游连接。
    // 只修改考试分区的连接方式，不改写 Windows 系统代理设置。
    await this.session.setProxy({ mode: 'direct' });
    await this.session.closeAllConnections();
    this.trace('info', 'network.connection-mode', { source: 'direct' });
  }

  observe(details: { url: string; fromCache?: boolean; ip?: string }) {
    if (details.fromCache || !net.isIP(details.ip || '')) return;
    const url = new URL(details.url);
    if (!this.origins.includes(url.origin)) return;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = this.connected.get(host) || new Set();
    addresses.add(details.ip);
    if (addresses.size > 32) addresses.delete(addresses.values().next().value);
    this.connected.set(host, addresses);
  }

  async lookup(host: string) {
    // 与实际 HTTPS 请求共用解析器和缓存；
    // 独立的 Node DNS 查询可能获得不同的 CDN 或代理地址。
    const result = await this.session.resolveHost(host, { cacheUsage: 'allowed' });
    const addresses = result.endpoints?.map((entry) => entry.address) || (result as { addresses?: string[] }).addresses;
    if (!Array.isArray(addresses) || !addresses.length || addresses.some((address) => !net.isIP(address))) {
      throw Object.assign(new Error('浏览器未能解析 OJ 地址，请检查 DNS 或代理软件。'), { code: 'DNS_INVALID_RESULT' });
    }
    const combined = [...new Set([...addresses, ...(this.connected.get(host) || [])])];
    this.trace('info', 'network.resolved', { url: host, message: combined.join(', ') });
    return combined.map((address) => ({ address }));
  }
}

export = ExamNetwork;
