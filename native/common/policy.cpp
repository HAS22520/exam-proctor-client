#include "policy.h"
#include <algorithm>
#include <cstring>
#include <stdexcept>
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#endif
namespace hydro {
std::vector<Endpoint> parsePolicy(const std::string& text) {
    if (text.empty() || text.size() > 65536) throw std::runtime_error("INVALID_POLICY");
    std::vector<Endpoint> result;
    size_t start = 0;
    while (start < text.size()) {
        const auto end = text.find(';', start), stop = end == std::string::npos ? text.size() : end;
        const auto separator = text.find('|', start);
        if (separator == std::string::npos || separator >= stop) throw std::runtime_error("INVALID_POLICY");
        const auto host = text.substr(start, separator - start), portText = text.substr(separator + 1, stop - separator - 1);
        if (portText.empty() || portText.size() > 5 || portText.find_first_not_of("0123456789") != std::string::npos) throw std::runtime_error("INVALID_POLICY");
        const auto port = std::stoul(portText);
        if (port == 0 || port > 65535) throw std::runtime_error("INVALID_POLICY");
        Endpoint value{}; value.port = static_cast<uint16_t>(port);
        value.family = host.find(':') == std::string::npos ? AF_INET : AF_INET6;
        if (inet_pton(value.family, host.c_str(), value.address.data()) != 1) throw std::runtime_error("INVALID_POLICY");
        result.push_back(value);
        if (result.size() > 1024) throw std::runtime_error("INVALID_POLICY");
        start = stop + 1;
    }
    return result;
}
static unsigned word(const uint8_t* p) { return (unsigned(p[0]) << 8) | p[1]; }
bool allowPacket(const std::vector<Endpoint>& policy, const uint8_t* p, size_t size, bool outbound) {
    if (!p || size < 1) return false;
    // The packet provider receives link-layer frames. Also handle raw IP from
    // virtual/loopback interfaces. VLAN tags are peeled before inspecting IP.
    size_t offset = 0;
    unsigned ether = size >= 14 ? word(p + 12) : 0;
    if (ether == 0x0800 || ether == 0x86dd || ether == 0x0806 || ether == 0x888e || ether == 0x8100 || ether == 0x88a8) {
        offset = 14;
        for (int tag = 0; (ether == 0x8100 || ether == 0x88a8) && tag < 2; ++tag) {
            if (size < offset + 4) return false;
            ether = word(p + offset + 2); offset += 4;
        }
        if (ether == 0x0806) return size >= offset + 28; // ARP is needed to reach the gateway.
        if (ether == 0x888e) return size >= offset + 4; // Preserve 802.1X/Wi-Fi link authentication.
        if (ether != 0x0800 && ether != 0x86dd) return false;
    }
    if (size <= offset) return false;
    p += offset; size -= offset;
    int family; const uint8_t* source; const uint8_t* destination; size_t transport; unsigned protocol;
    if ((p[0] >> 4) == 4) {
        if (size < 20 || (p[0] & 15) < 5) return false;
        const auto length = word(p + 2); transport = (p[0] & 15) * 4;
        if (length < transport || length > size || (word(p + 6) & 0x3fff)) return false; // No fragments may bypass the port policy.
        size = length; family = AF_INET; source = p + 12; destination = p + 16; protocol = p[9];
    } else if ((p[0] >> 4) == 6) {
        if (size < 40 || word(p + 4) + 40 > size) return false;
        size = word(p + 4) + 40; family = AF_INET6; source = p + 8; destination = p + 24; protocol = p[6]; transport = 40;
        // Skip hop-by-hop, routing and destination option headers. Fragmented,
        // encrypted and unknown extension chains are rejected during monitoring.
        for (int count = 0; protocol == 0 || protocol == 43 || protocol == 60; ++count) {
            if (count >= 8 || size < transport + 2) return false;
            const auto next = p[transport];
            const auto length = (size_t(p[transport + 1]) + 1) * 8;
            if (size < transport + length) return false;
            transport += length; protocol = next;
        }
    } else return false;
    const auto remote = outbound ? destination : source;
    if (family == AF_INET && remote[0] == 127) return true;
    if (family == AF_INET6 && std::all_of(remote, remote + 15, [](uint8_t b) { return b == 0; }) && remote[15] == 1) return true;
    if (protocol == 1 && family == AF_INET && size >= transport + 8) {
        return p[transport] == 3 || p[transport] == 11 || p[transport] == 12; // Routing/MTU errors, not echo traffic.
    }
    if (protocol == 58 && family == AF_INET6 && size >= transport + 8) {
        const auto type = p[transport];
        return (type >= 1 && type <= 4) || (type >= 133 && type <= 136 && p[7] == 255); // Routing/MTU errors and neighbour discovery.
    }
    if ((protocol != 6 && protocol != 17) || size < transport + (protocol == 6 ? 20 : 8)) return false;
    const auto sourcePort = word(p + transport), destinationPort = word(p + transport + 2);
    const auto remotePort = outbound ? destinationPort : sourcePort;
    if (remotePort == 53) return true; // TCP/UDP DNS; app-origin restrictions remain separate.
    if (protocol == 17 && ((sourcePort == 68 && destinationPort == 67) || (sourcePort == 67 && destinationPort == 68)
        || (sourcePort == 546 && destinationPort == 547) || (sourcePort == 547 && destinationPort == 546))) return true;
    const auto length = family == AF_INET ? 4u : 16u;
    return std::any_of(policy.begin(), policy.end(), [&](const Endpoint& e) {
        return e.family == family && e.port == remotePort && std::memcmp(e.address.data(), remote, length) == 0;
    });
}
}
extern "C" void* hydro_policy_create(const char* text) {
    try { return new std::vector<hydro::Endpoint>(hydro::parsePolicy(text ? text : "")); } catch (...) { return nullptr; }
}
extern "C" void hydro_policy_destroy(void* p) { delete static_cast<std::vector<hydro::Endpoint>*>(p); }
extern "C" int hydro_policy_allows(void* p, const void* data, size_t size, int outbound) {
    if (!p) return 1; // No lease = normal network access.
    return hydro::allowPacket(*static_cast<std::vector<hydro::Endpoint>*>(p), static_cast<const uint8_t*>(data), size, outbound != 0);
}
