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
std::vector<UINT64> filterIds;
FWP_BYTE_BLOB* applicationId = nullptr;
void checked(DWORD code) { if (code != ERROR_SUCCESS) throw code; }
bool elevated() {
    HANDLE token = nullptr; TOKEN_ELEVATION value{}; DWORD size = 0;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    const bool result = GetTokenInformation(token, TokenElevation, &value, sizeof(value), &size) && value.TokenIsElevated;
    CloseHandle(token); return result;
}
void closePolicy() { if (engine) { checked(FwpmEngineClose0(engine)); engine = nullptr; filterIds.clear(); } }
FWPM_FILTER_CONDITION0 number(const GUID& key, FWP_DATA_TYPE type, unsigned value) {
    FWPM_FILTER_CONDITION0 c{}; c.fieldKey = key; c.matchType = FWP_MATCH_EQUAL; c.conditionValue.type = type;
    if (type == FWP_UINT8) c.conditionValue.uint8 = static_cast<UINT8>(value);
    else if (type == FWP_UINT16) c.conditionValue.uint16 = static_cast<UINT16>(value);
    else c.conditionValue.uint32 = value;
    return c;
}
void filter(const GUID& layer, std::vector<FWPM_FILTER_CONDITION0> conditions, bool permit) {
    FWPM_FILTER0 f{}; checked(UuidCreate(&f.filterKey)); f.layerKey = layer; f.subLayerKey = sublayer;
    f.displayData.name = const_cast<wchar_t*>(L"Hydro 临时监考策略");
    f.action.type = permit ? FWP_ACTION_PERMIT : FWP_ACTION_BLOCK;
    UINT64 weight = permit ? 100 : 1; f.weight.type = FWP_UINT64; f.weight.uint64 = &weight;
    // 软放行仍遵守其他安全软件的阻断规则；
    // 兜底阻断为终结规则，普通放行规则不能覆盖它。
    f.numFilterConditions = static_cast<UINT32>(conditions.size()); f.filterCondition = conditions.data();
    UINT64 id = 0; checked(FwpmFilterAdd0(engine, &f, nullptr, &id)); filterIds.push_back(id);
}
void install(const std::vector<hydro::Endpoint>& endpoints) {
    const bool first = !engine;
    if (first) {
        FWPM_SESSION0 session{}; session.flags = FWPM_SESSION_FLAG_DYNAMIC; session.txnWaitTimeoutInMSec = 5000;
        checked(FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, &session, &engine));
    }
    const auto previousFilters = filterIds;
    const auto previousSublayer = sublayer;
    try {
        checked(FwpmTransactionBegin0(engine, 0));
        // 在同一事务里替换旧策略；DNS 刷新期间始终保留已提交的网络限制。
        for (const auto id : previousFilters) checked(FwpmFilterDeleteById0(engine, id));
        if (!first) checked(FwpmSubLayerDeleteByKey0(engine, &sublayer));
        filterIds.clear();
        checked(UuidCreate(&sublayer)); FWPM_SUBLAYER0 s{}; s.subLayerKey = sublayer; s.weight = 0x8000;
        s.displayData.name = const_cast<wchar_t*>(L"Hydro 监考动态会话"); checked(FwpmSubLayerAdd0(engine, &s, nullptr));
        const GUID* layers[] = { &FWPM_LAYER_ALE_AUTH_CONNECT_V4, &FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4, &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
            &FWPM_LAYER_OUTBOUND_TRANSPORT_V4, &FWPM_LAYER_OUTBOUND_TRANSPORT_V6,
            &FWPM_LAYER_INBOUND_TRANSPORT_V4, &FWPM_LAYER_INBOUND_TRANSPORT_V6 };
        for (int index = 0; index < 8; ++index) {
            const bool ipv6 = index % 2; const auto& layer = *layers[index];
            FWPM_FILTER_CONDITION0 app{}; app.fieldKey = FWPM_CONDITION_ALE_APP_ID;
            app.matchType = FWP_MATCH_EQUAL; app.conditionValue.type = FWP_BYTE_BLOB_TYPE; app.conditionValue.byteBlob = applicationId;
            const bool ale = index < 4;
            const bool inbound = index == 2 || index == 3 || index == 6 || index == 7;
            for (const auto& endpoint : endpoints) {
                if ((endpoint.family == AF_INET6) != ipv6) continue;
                FWPM_FILTER_CONDITION0 address{}; address.fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS; address.matchType = FWP_MATCH_EQUAL;
                FWP_BYTE_ARRAY16 ipv6Address{}; UINT32 ipv4Address{};
                if (ipv6) { memcpy(ipv6Address.byteArray16, endpoint.address.data(), 16); address.conditionValue.type = FWP_BYTE_ARRAY16_TYPE; address.conditionValue.byteArray16 = &ipv6Address; }
                else { memcpy(&ipv4Address, endpoint.address.data(), 4); address.conditionValue.type = FWP_UINT32; address.conditionValue.uint32 = ntohl(ipv4Address); }
                // DNS 仅允许到启动时确定的上游，且 ALE 发起方必须是客户端自身。
                // 普通白名单端点只允许 TCP，不向其他程序开放 DNS、QUIC 或整个回环。
                for (const unsigned protocol : { 6u, 17u }) {
                    if (protocol == 17 && !endpoint.dns) continue;
                    std::vector<FWPM_FILTER_CONDITION0> conditions{ address,
                        number(FWPM_CONDITION_IP_PROTOCOL, FWP_UINT8, protocol),
                        number(FWPM_CONDITION_IP_REMOTE_PORT, FWP_UINT16, endpoint.port) };
                    if (ale) conditions.push_back(app);
                    filter(layer, conditions, true);
                    // 回环服务的接收侧及传输层响应使用本地端口；新连接发起侧仍须通过应用身份校验。
                    const bool loopback = ipv6 ? endpoint.address == std::array<uint8_t, 16>{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1} : endpoint.address[0] == 127;
                    if (loopback && (inbound || !ale)) {
                        filter(layer, { address, number(FWPM_CONDITION_IP_PROTOCOL, FWP_UINT8, protocol),
                            number(FWPM_CONDITION_IP_LOCAL_PORT, FWP_UINT16, endpoint.port) }, true);
                    }
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
    } catch (...) {
        FwpmTransactionAbort0(engine);
        filterIds = previousFilters; sublayer = previousSublayer;
        if (first) closePolicy();
        throw;
    }
}
void reply(unsigned id, const char* code = nullptr, DWORD detail = 0) {
    std::cout << "{\"id\":" << id << ",\"protocol\":2,\"ok\":" << (code ? "false" : "true");
    if (code) std::cout << ",\"code\":\"" << code << "\",\"message\":\"Windows 错误 " << detail << "\"";
    std::cout << "}" << std::endl;
}
}
int main(int argc, char** argv) {
    if (argc == 2 && std::string(argv[1]) == "--check") { reply(1, elevated() ? nullptr : "ADMIN_REQUIRED"); return elevated() ? 0 : 5; }
    if (argc != 3 || std::string(argv[1]) != "--parent") return 2;
    HANDLE parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(strtoul(argv[2], nullptr, 10)));
    if (!parent) return 2;
    wchar_t executable[32768]; DWORD length = 32768;
    if (!QueryFullProcessImageNameW(parent, 0, executable, &length)
        || FwpmGetAppIdFromFileName0(executable, &applicationId) != ERROR_SUCCESS) { CloseHandle(parent); return 2; }
    WSADATA data{}; if (WSAStartup(MAKEWORD(2, 2), &data)) return 2;
    std::mutex mutex; std::condition_variable ready; std::queue<std::string> lines; bool eof = false;
    std::atomic<ULONGLONG> lastHeartbeat{GetTickCount64()};
    std::thread watchdog([&] {
        for (;;) {
            if (WaitForSingleObject(parent, 200) != WAIT_TIMEOUT || GetTickCount64() - lastHeartbeat.load() > 10000) {
                // 不依赖可能卡住的 WFP RPC；进程结束后，BFE 会
                // 删除动态会话并放弃未提交的修改。
                ExitProcess(0);
            }
        }
    });
    watchdog.detach();
    // 读取标准输入不能阻塞父进程和租约监测；
    // 进程结束会终止输入线程，崩溃时 BFE 也会清理动态对象。
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
    closePolicy(); FwpmFreeMemory0(reinterpret_cast<void**>(&applicationId)); CloseHandle(parent); WSACleanup(); reader.detach();
    // 不能销毁阻塞输入线程仍在引用的栈对象。
    ExitProcess(0);
}
