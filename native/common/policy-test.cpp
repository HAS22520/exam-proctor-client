#include "policy.h"
#include <cassert>
#include <iostream>
#include <stdexcept>
#ifdef _WIN32
#include <winsock2.h>
#else
#include <sys/socket.h>
#endif

bool rejects(const std::string& text) {
    try { hydro::parsePolicy(text); } catch (const std::runtime_error&) { return true; }
    return false;
}
int main() {
    const auto policy = hydro::parsePolicy("203.0.113.7|443;2001:db8::7|8282");
    assert(policy.size() == 2);
    assert(policy[0].family == AF_INET && policy[0].port == 443);
    assert(policy[0].address[0] == 203 && policy[0].address[1] == 0
        && policy[0].address[2] == 113 && policy[0].address[3] == 7);
    assert(policy[1].family == AF_INET6 && policy[1].port == 8282);
    assert(policy[1].address[0] == 0x20 && policy[1].address[1] == 0x01
        && policy[1].address[2] == 0x0d && policy[1].address[3] == 0xb8 && policy[1].address[15] == 7);
    const auto limits = hydro::parsePolicy("127.0.0.1|1;::1|65535");
    assert(limits[0].port == 1 && limits[1].port == 65535);
    for (const char* invalid : { "", "example.com|443", "::1|0", "127.0.0.1|65536", "::1|443\n",
        "127.0.0.1|443;bad", "127.0.0.1", "127.0.0.1|", "::1|-1", "::1|443|80", "::1%en0|443",
        "127.0.0.1|443;;::1|443", "999.0.0.1|443" }) assert(rejects(invalid));
    std::string tooMany;
    for (int i = 0; i < 1025; ++i) tooMany += "127.0.0.1|443;";
    assert(rejects(tooMany));
    assert(rejects(std::string(65537, 'a')));
    std::cout << "Windows endpoint policy tests passed" << std::endl;
}
