#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <initguid.h>
#include <fwpmu.h>
#include "wfp-compat.h"
#include <rpc.h>
#include <chrono>
#include <atomic>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <queue>
#include <sstream>
#include <thread>
#include "../common/policy.h"

namespace {
HANDLE engine = nullptr;
GUID sublayer{};
void checked(DWORD code) { if (code != ERROR_SUCCESS) throw code; }
bool elevated() {
    HANDLE token = nullptr; TOKEN_ELEVATION value{}; DWORD size = 0;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    const bool result = GetTokenInformation(token, TokenElevation, &value, sizeof(value), &size) && value.TokenIsElevated;
    CloseHandle(token); return result;
}
void closePolicy() { if (engine) { checked(FwpmEngineClose0(engine)); engine = nullptr; } }
FWPM_FILTER_CONDITION0 number(const GUID& key, FWP_DATA_TYPE type, unsigned value) {
    FWPM_FILTER_CONDITION0 c{}; c.fieldKey = key; c.matchType = FWP_MATCH_EQUAL; c.conditionValue.type = type;
    if (type == FWP_UINT8) c.conditionValue.uint8 = static_cast<UINT8>(value);
    else if (type == FWP_UINT16) c.conditionValue.uint16 = static_cast<UINT16>(value);
    else c.conditionValue.uint32 = value;
    return c;
}
void filter(const GUID& layer, std::vector<FWPM_FILTER_CONDITION0> conditions, bool permit) {
    FWPM_FILTER0 f{}; checked(UuidCreate(&f.filterKey)); f.layerKey = layer; f.subLayerKey = sublayer;
    f.displayData.name = const_cast<wchar_t*>(L"Hydro temporary exam policy");
    f.action.type = permit ? FWP_ACTION_PERMIT : FWP_ACTION_BLOCK;
    UINT64 weight = permit ? 100 : 1; f.weight.type = FWP_UINT64; f.weight.uint64 = &weight;
    // Soft permits respect blocks from other security products. Our fallback
    // block is terminating and cannot be overridden by ordinary allow rules.
    f.numFilterConditions = static_cast<UINT32>(conditions.size()); f.filterCondition = conditions.data();
    checked(FwpmFilterAdd0(engine, &f, nullptr, nullptr));
}
void install(const std::vector<hydro::Endpoint>& endpoints) {
    closePolicy();
    FWPM_SESSION0 session{}; session.flags = FWPM_SESSION_FLAG_DYNAMIC; session.txnWaitTimeoutInMSec = 5000;
    checked(FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, &session, &engine));
    try {
        checked(FwpmTransactionBegin0(engine, 0));
        checked(UuidCreate(&sublayer)); FWPM_SUBLAYER0 s{}; s.subLayerKey = sublayer; s.weight = 0x8000;
        s.displayData.name = const_cast<wchar_t*>(L"Hydro exam dynamic session"); checked(FwpmSubLayerAdd0(engine, &s, nullptr));
        const GUID* layers[] = { &FWPM_LAYER_ALE_AUTH_CONNECT_V4, &FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4, &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
            &FWPM_LAYER_OUTBOUND_TRANSPORT_V4, &FWPM_LAYER_OUTBOUND_TRANSPORT_V6,
            &FWPM_LAYER_INBOUND_TRANSPORT_V4, &FWPM_LAYER_INBOUND_TRANSPORT_V6 };
        for (int index = 0; index < 8; ++index) {
            const bool ipv6 = index % 2; const auto& layer = *layers[index];
            auto loop = number(FWPM_CONDITION_FLAGS, FWP_UINT32, FWP_CONDITION_FLAG_IS_LOOPBACK);
            loop.matchType = FWP_MATCH_FLAGS_ALL_SET; filter(layer, { loop }, true);
            for (const unsigned protocol : { 6u, 17u }) {
                filter(layer, { number(FWPM_CONDITION_IP_PROTOCOL, FWP_UINT8, protocol), number(FWPM_CONDITION_IP_REMOTE_PORT, FWP_UINT16, 53) }, true);
                for (const auto& endpoint : endpoints) {
                    if ((endpoint.family == AF_INET6) != ipv6) continue;
                    FWPM_FILTER_CONDITION0 address{}; address.fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS; address.matchType = FWP_MATCH_EQUAL;
                    FWP_BYTE_ARRAY16 ipv6Address{}; UINT32 ipv4Address{};
                    if (ipv6) { memcpy(ipv6Address.byteArray16, endpoint.address.data(), 16); address.conditionValue.type = FWP_BYTE_ARRAY16_TYPE; address.conditionValue.byteArray16 = &ipv6Address; }
                    else { memcpy(&ipv4Address, endpoint.address.data(), 4); address.conditionValue.type = FWP_UINT32; address.conditionValue.uint32 = ntohl(ipv4Address); }
                    filter(layer, { address, number(FWPM_CONDITION_IP_PROTOCOL, FWP_UINT8, protocol), number(FWPM_CONDITION_IP_REMOTE_PORT, FWP_UINT16, endpoint.port) }, true);
                }
            }
            filter(layer, { number(FWPM_CONDITION_IP_PROTOCOL, FWP_UINT8, 17), number(FWPM_CONDITION_IP_LOCAL_PORT, FWP_UINT16, ipv6 ? 546 : 68),
                number(FWPM_CONDITION_IP_REMOTE_PORT, FWP_UINT16, ipv6 ? 547 : 67) }, true);
            if (ipv6) for (unsigned type = 133; type <= 136; ++type) {
                filter(layer, { number(FWPM_CONDITION_IP_PROTOCOL, FWP_UINT8, 58), number(FWPM_CONDITION_ICMP_TYPE, FWP_UINT16, type) }, true);
            }
            filter(layer, {}, false);
        }
        checked(FwpmTransactionCommit0(engine));
    } catch (...) { closePolicy(); throw; }
}
void reply(unsigned id, const char* code = nullptr, DWORD detail = 0) {
    std::cout << "{\"id\":" << id << ",\"protocol\":1,\"ok\":" << (code ? "false" : "true");
    if (code) std::cout << ",\"code\":\"" << code << "\",\"message\":\"Windows error " << detail << "\"";
    std::cout << "}" << std::endl;
}
}
int main(int argc, char** argv) {
    if (argc == 2 && std::string(argv[1]) == "--check") { reply(1, elevated() ? nullptr : "ADMIN_REQUIRED"); return elevated() ? 0 : 5; }
    if (argc != 3 || std::string(argv[1]) != "--parent") return 2;
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(strtoul(argv[2], nullptr, 10)));
    if (!parent) return 2;
    WSADATA data{}; if (WSAStartup(MAKEWORD(2, 2), &data)) return 2;
    std::mutex mutex; std::condition_variable ready; std::queue<std::string> lines; bool eof = false;
    std::atomic<ULONGLONG> lastHeartbeat{GetTickCount64()};
    std::thread watchdog([&] {
        for (;;) {
            if (WaitForSingleObject(parent, 200) != WAIT_TIMEOUT || GetTickCount64() - lastHeartbeat.load() > 10000) {
                // Independent of a stalled WFP RPC: process death makes BFE
                // remove the dynamic session and abort uncommitted changes.
                ExitProcess(0);
            }
        }
    });
    watchdog.detach();
    // Read stdin without blocking parent/lease monitoring. Process exit tears
    // down this thread and BFE also removes its dynamic objects on a crash.
    std::thread reader([&] { std::string line; while (std::getline(std::cin, line)) {
        if (line.size() > 70000) break;
        if (line == "0\tping") { lastHeartbeat.store(GetTickCount64()); continue; }
        { std::lock_guard<std::mutex> lock(mutex); lines.push(line); } ready.notify_one();
    } { std::lock_guard<std::mutex> lock(mutex); eof = true; } ready.notify_one(); });
    for (;;) {
        std::unique_lock<std::mutex> lock(mutex); ready.wait_for(lock, std::chrono::milliseconds(200), [&] { return eof || !lines.empty(); });
        if (eof || WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) break;
        if (lines.empty()) continue;
        const auto line = lines.front(); lines.pop(); lock.unlock();
        std::istringstream input(line); std::string idText, op, policy;
        std::getline(input, idText, '\t'); std::getline(input, op, '\t'); std::getline(input, policy);
        const unsigned id = static_cast<unsigned>(strtoul(idText.c_str(), nullptr, 10));
        if (op == "ping") { lastHeartbeat.store(GetTickCount64()); continue; }
        if (!elevated()) { reply(id, "ADMIN_REQUIRED"); continue; }
        try {
            if (op == "lock") {
                const auto endpoints = hydro::parsePolicy(policy);
                std::cout << "{\"event\":\"stage\",\"phase\":\"apply-native-policy\"}" << std::endl;
                install(endpoints);
            } else if (op == "unlock") {
                std::cout << "{\"event\":\"stage\",\"phase\":\"remove-native-policy\"}" << std::endl; closePolicy();
            } else if (op != "check") { reply(id, "INVALID_COMMAND"); continue; }
            reply(id);
        } catch (DWORD code) { reply(id, "FILTER_FAILED", code); }
        catch (...) { reply(id, "INVALID_POLICY"); }
    }
    closePolicy(); CloseHandle(parent); WSACleanup(); reader.detach();
    // Do not destroy stack objects still referenced by the blocking input thread.
    ExitProcess(0);
}
