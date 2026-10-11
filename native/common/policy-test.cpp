#include "policy.h"
#include <cassert>
#include <iostream>
#include <vector>
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#endif
using Bytes = std::vector<uint8_t>;
Bytes packet(bool ipv6, const char* remote, unsigned port, bool outbound = true, unsigned protocol = 6) {
    const size_t ip = ipv6 ? 40 : 20, payload = protocol == 6 ? 20 : 8;
    Bytes p(ip + payload, 0);
    p[0] = ipv6 ? 0x60 : 0x45;
    if (ipv6) { p[4] = payload >> 8; p[5] = payload & 255; p[6] = protocol; p[7] = 64; }
    else { p[2] = p.size() >> 8; p[3] = p.size() & 255; p[9] = protocol; }
    const size_t source = ipv6 ? 8 : 12, destination = ipv6 ? 24 : 16;
    inet_pton(ipv6 ? AF_INET6 : AF_INET, remote, p.data() + (outbound ? destination : source));
    const auto remotePort = ip + (outbound ? 2 : 0), localPort = ip + (outbound ? 0 : 2);
    p[remotePort] = port >> 8; p[remotePort + 1] = port & 255;
    p[localPort] = 0xc0; p[localPort + 1] = 0x01;
    return p;
}
int main() {
    const auto policy = hydro::parsePolicy("203.0.113.7|443;2001:db8::7|8282");
    auto allows = [&](const Bytes& p, bool outbound = true) { return hydro::allowPacket(policy, p.data(), p.size(), outbound); };
    assert(allows(packet(false, "203.0.113.7", 443)));
    assert(!allows(packet(false, "203.0.113.8", 443)));
    assert(!allows(packet(false, "203.0.113.7", 80)));
    assert(allows(packet(false, "203.0.113.7", 443, false), false));
    assert(allows(packet(true, "2001:db8::7", 8282)));
    assert(!allows(packet(true, "2001:db8::8", 8282)));
    assert(allows(packet(true, "2001:db8::7", 8282, true, 17))); // QUIC/UDP to the same approved endpoint.
    assert(allows(packet(false, "8.8.8.8", 53, true, 17)));
    assert(allows(packet(true, "::1", 1234)));
    assert(allows(packet(false, "127.0.0.1", 1234)));
    auto vlan = packet(false, "203.0.113.7", 443);
    vlan.insert(vlan.begin(), 18, 0); vlan[12] = 0x81; vlan[16] = 0x08;
    assert(allows(vlan));
    auto fragment = packet(false, "203.0.113.7", 443); fragment[6] = 0x20;
    assert(!allows(fragment));
    auto nd = packet(true, "ff02::1", 0, true, 58); nd[40] = 135; nd[7] = 255;
    assert(allows(nd)); nd[40] = 128; assert(!allows(nd));
    for (size_t n = 0; n < 60; ++n) { Bytes truncated(n, 0); assert(!allows(truncated)); }
    for (const char* invalid : { "", "example.com|443", "::1|0", "127.0.0.1|65536", "::1|443\n", "127.0.0.1|443;bad" }) {
        assert(hydro_policy_create(invalid) == nullptr);
    }
    void* p = hydro_policy_create("127.0.0.1|443"); assert(p); hydro_policy_destroy(p);
    std::cout << "Native policy tests passed" << std::endl;
}
