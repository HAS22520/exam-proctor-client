#pragma once
#include <stddef.h>
#ifdef __cplusplus
#include <array>
#include <cstdint>
#include <string>
#include <vector>
namespace hydro {
struct Endpoint { int family; std::array<uint8_t, 16> address{}; uint16_t port; };
std::vector<Endpoint> parsePolicy(const std::string& policy);
bool allowPacket(const std::vector<Endpoint>& policy, const uint8_t* bytes, size_t size, bool outbound);
}
extern "C" {
#endif
void* hydro_policy_create(const char* policy);
void hydro_policy_destroy(void* policy);
int hydro_policy_allows(void* policy, const void* bytes, size_t size, int outbound);
#ifdef __cplusplus
}
#endif
