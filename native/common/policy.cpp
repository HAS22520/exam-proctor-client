#include "policy.h"
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
}
