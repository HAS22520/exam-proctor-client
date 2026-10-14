#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <wintrust.h>
#include <softpub.h>
#include <bcrypt.h>
#include <iostream>
#include <sstream>
#include <map>
#include <vector>
#include <iomanip>
#include <string>
#include <thread>
#include <algorithm>
#include <cstdint>

namespace {
std::string utf8(const std::wstring& text) {
    if (text.empty()) return "";
    const int size = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    std::string value(size, '\0'); WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), value.data(), size, nullptr, nullptr);
    return value;
}
std::string quote(const std::wstring& text) {
    std::ostringstream out; out << '"';
    for (const unsigned char c : utf8(text)) {
        if (c == '"' || c == '\\') out << '\\' << c;
        else if (c < 32) out << "\\u00" << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned>(c) << std::dec;
        else out << c;
    }
    out << '"'; return out.str();
}
struct Identity { ULONGLONG modified = 0, size = 0; std::wstring original; std::string hash; bool signedFile = false; };
std::map<std::wstring, Identity> cache;
std::string hashFile(const wchar_t* path) {
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr);
    if (file == INVALID_HANDLE_VALUE) return "";
    BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
    std::string result;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0
        && BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) == 0) {
        BYTE bytes[65536], digest[32]; DWORD read = 0; bool success = true;
        for (;;) {
            if (!ReadFile(file, bytes, sizeof(bytes), &read, nullptr)) { success = false; break; }
            if (!read) break;
            if (BCryptHashData(hash, bytes, read, 0) != 0) { success = false; break; }
        }
        if (success && BCryptFinishHash(hash, digest, sizeof(digest), 0) == 0) {
            std::ostringstream out; for (const auto b : digest) out << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned>(b);
            result = out.str();
        }
    }
    if (hash) BCryptDestroyHash(hash);
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    CloseHandle(file); return result;
}
Identity inspect(const std::wstring& path) {
    WIN32_FILE_ATTRIBUTE_DATA attributes{};
    if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &attributes)) return {};
    const ULONGLONG modified = (static_cast<ULONGLONG>(attributes.ftLastWriteTime.dwHighDateTime) << 32) | attributes.ftLastWriteTime.dwLowDateTime;
    const ULONGLONG size = (static_cast<ULONGLONG>(attributes.nFileSizeHigh) << 32) | attributes.nFileSizeLow;
    const auto existing = cache.find(path);
    if (existing != cache.end() && existing->second.modified == modified && existing->second.size == size) return existing->second;
    Identity result{}; result.modified = modified; result.size = size;
    // 大文件不阻塞守护循环；无法取得身份的进程仍返回路径并记录状态。
    if (size <= 256ull * 1024 * 1024) result.hash = hashFile(path.c_str());
    DWORD unused = 0; const DWORD versionSize = GetFileVersionInfoSizeW(path.c_str(), &unused);
    if (versionSize && versionSize <= 1024 * 1024) {
        std::vector<BYTE> bytes(versionSize);
        if (GetFileVersionInfoW(path.c_str(), 0, versionSize, bytes.data())) {
            struct Translation { WORD language, codepage; }; Translation* translations = nullptr; UINT length = 0;
            if (VerQueryValueW(bytes.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void**>(&translations), &length) && length >= sizeof(Translation)) {
                wchar_t query[100]; swprintf(query, 100, L"\\StringFileInfo\\%04x%04x\\OriginalFilename", translations[0].language, translations[0].codepage);
                wchar_t* original = nullptr;
                if (VerQueryValueW(bytes.data(), query, reinterpret_cast<void**>(&original), &length) && original && length) {
                    const auto offset = reinterpret_cast<uintptr_t>(original) - reinterpret_cast<uintptr_t>(bytes.data());
                    const size_t count = std::min<size_t>(length, 1024);
                    if (offset <= bytes.size() && count <= (bytes.size() - offset) / sizeof(wchar_t)) {
                        result.original.assign(original, std::find(original, original + count, L'\0'));
                    }
                }
            }
        }
    }
    WINTRUST_FILE_INFO file{}; file.cbStruct = sizeof(file); file.pcwszFilePath = path.c_str();
    WINTRUST_DATA trust{}; trust.cbStruct = sizeof(trust); trust.dwUIChoice = WTD_UI_NONE;
    trust.fdwRevocationChecks = WTD_REVOKE_NONE; trust.dwUnionChoice = WTD_CHOICE_FILE; trust.pFile = &file;
    // 签名查询不访问网络，避免证书验证与整机网络封锁互相等待。
    trust.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL; trust.dwStateAction = WTD_STATEACTION_VERIFY;
    GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    result.signedFile = WinVerifyTrust(nullptr, &action, &trust) == ERROR_SUCCESS;
    trust.dwStateAction = WTD_STATEACTION_CLOSE; WinVerifyTrust(nullptr, &action, &trust);
    if (cache.size() >= 4096) cache.clear();
    cache[path] = result; return result;
}
void scan(unsigned id) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) { std::cout << "{\"id\":" << id << ",\"ok\":false}" << std::endl; return; }
    PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
    std::ostringstream out; out << "{\"id\":" << id << ",\"ok\":true,\"processes\":[";
    bool first = true;
    if (Process32FirstW(snapshot, &entry)) do {
        if (entry.th32ProcessID < 2 || entry.th32ProcessID == GetCurrentProcessId()) continue;
        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
        std::wstring path; ULONGLONG created = 0;
        if (process) {
            wchar_t image[32768]; DWORD length = 32768;
            if (QueryFullProcessImageNameW(process, 0, image, &length)) path.assign(image, length);
            FILETIME start{}, end{}, kernel{}, user{};
            if (GetProcessTimes(process, &start, &end, &kernel, &user)) created = (static_cast<ULONGLONG>(start.dwHighDateTime) << 32) | start.dwLowDateTime;
            CloseHandle(process);
        }
        const auto identity = path.empty() ? Identity{} : inspect(path);
        if (!first) out << ',';
        first = false;
        out << "{\"pid\":" << entry.th32ProcessID << ",\"created\":\"" << created << "\",\"name\":" << quote(entry.szExeFile)
            << ",\"path\":" << quote(path) << ",\"originalName\":" << quote(identity.original) << ",\"sha256\":\"" << identity.hash
            << "\",\"signed\":" << (identity.signedFile ? "true" : "false") << '}';
    } while (Process32NextW(snapshot, &entry));
    CloseHandle(snapshot); out << "]}"; std::cout << out.str() << std::endl;
}
}
int main(int argc, char** argv) {
    if (argc != 3 || std::string(argv[1]) != "--parent") return 2;
    const DWORD parentId = static_cast<DWORD>(strtoul(argv[2], nullptr, 10));
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parentId);
    if (!parent) return 2;
    SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
    std::thread([parent] { WaitForSingleObject(parent, INFINITE); ExitProcess(0); }).detach();
    std::string line;
    while (std::getline(std::cin, line) && WaitForSingleObject(parent, 0) == WAIT_TIMEOUT) {
        if (line.size() > 100) break;
        std::istringstream input(line); unsigned id; std::string op; input >> id >> op;
        if (op == "scan") scan(id);
        else if (op == "terminate") {
            DWORD pid; ULONGLONG expected; input >> pid >> expected;
            bool success = false;
            HANDLE process = pid > 1 && pid != parentId && pid != GetCurrentProcessId() ? OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) : nullptr;
            if (process) {
                FILETIME start{}, end{}, kernel{}, user{};
                if (GetProcessTimes(process, &start, &end, &kernel, &user)) {
                    const ULONGLONG actual = (static_cast<ULONGLONG>(start.dwHighDateTime) << 32) | start.dwLowDateTime;
                    success = actual == expected && actual && TerminateProcess(process, 1);
                }
                CloseHandle(process);
            }
            std::cout << "{\"id\":" << id << ",\"ok\":" << (success ? "true" : "false") << "}" << std::endl;
        }
    }
    // 父进程观察线程持有句柄直到退出，由系统统一释放。
    return 0;
}
