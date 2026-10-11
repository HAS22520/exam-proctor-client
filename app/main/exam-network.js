const net = require('node:net');

class ExamNetwork {
  constructor(session, origins, trace = () => {}) {
    Object.assign(this, { session, origins, trace });
    this.connected = new Map();
    this.lookup = this.lookup.bind(this);
  }

  async prepare() {
    // A local/system proxy may lose its upstream when the whole-machine WFP
    // policy starts. Set this partition only; do not edit Windows proxy settings.
    await this.session.setProxy({ mode: 'direct' });
    await this.session.closeAllConnections();
    this.trace('info', 'network.connection-mode', { source: 'direct' });
  }

  observe(details) {
    if (details.fromCache || !net.isIP(details.ip || '')) return;
    const url = new URL(details.url);
    if (!this.origins.includes(url.origin)) return;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = this.connected.get(host) || new Set();
    addresses.add(details.ip);
    if (addresses.size > 32) addresses.delete(addresses.values().next().value);
    this.connected.set(host, addresses);
  }

  async lookup(host) {
    // Use the same resolver/cache as the actual HTTPS requests. A separate
    // Node DNS lookup can select different CDN or proxy DNS answers.
    const result = await this.session.resolveHost(host, { cacheUsage: 'allowed' });
    const addresses = result.endpoints?.map((entry) => entry.address) || result.addresses;
    if (!Array.isArray(addresses) || !addresses.length || addresses.some((address) => !net.isIP(address))) {
      throw Object.assign(new Error('浏览器未能解析 OJ 地址，请检查 DNS 或代理软件。'), { code: 'DNS_INVALID_RESULT' });
    }
    const combined = [...new Set([...addresses, ...(this.connected.get(host) || [])])];
    this.trace('info', 'network.resolved', { url: host, message: combined.join(', ') });
    return combined.map((address) => ({ address }));
  }
}

module.exports = ExamNetwork;
