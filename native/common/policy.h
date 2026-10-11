#pragma once
#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace hydro {
struct Endpoint { int family; std::array<uint8_t, 16> address{}; uint16_t port; };
std::vector<Endpoint> parsePolicy(const std::string& policy);
}
