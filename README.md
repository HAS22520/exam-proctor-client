# Hydro 监考客户端

Electron 客户端，连接 Hydro 的 `hydro-proctor/1` 协议。支持 Windows x64，以及 macOS Intel x64 / Apple Silicon arm64。源码修改可直接在本仓库查看；Hydro 父仓库把本目录作为独立 Git 仓库忽略。

## 功能与部署顺序

1. 在 OJ「监考设置」生成认证密钥，取得同一次生成的认证公钥（Ed25519）、日志加密公钥（RSA-3072）和 keyId。两组服务端私钥只保存在 OJ，不能用于客户端构建。
2. 通过环境变量注入公钥和地址，构建、签名、安装客户端。公钥不写进公开源码，但可从安装包提取；隐藏公钥不能证明客户端程序未被修改。
3. 在 OJ 设置与安装包完全一致的指定客户端版本，开启系统监考，再开启比赛监考。用户登录原 OJ 账号并报名，客户端自动握手，无须注册码或手工设备登记。
4. ui-next 现有的 `window.examAPI.proctorHeaders` 桥会自动为代码提交、文件提交和自测生成设备签名证明；服务端决定是否接受。普通浏览器没有此桥，不能提交监考比赛。
5. 结束监考会先停止新提交、等待在途请求，关闭服务端 attempt，生成固定加密日志并上传。此操作不会代交代码。日志上传前成绩待确认。断网可安全退出；再次打开客户端、登录原账号后自动补传，禁止删除本机数据。

必须部署 Hydro 的 `/proctor/identity` 接口（域内为 `/d/<domainId>/proctor/identity`）。它使用已有认证私钥签署当前登录 UID、root 权限和比赛/题目上下文。接口是本次唯一新增的服务端协议入口，不读取前端显示的用户名来判断 root。

设备密钥和日志 AES 密钥使用 Electron safeStorage 加密：Windows 的 DPAPI / macOS 的 Keychain。密钥不能加密时客户端拒绝启动，不回退明文。跨系统用户、迁移用户数据或删除密钥可能使原考试无法恢复。当前固定 Electron 44；升级到 46 前需迁移其异步 safeStorage API。参见 [Electron 官方说明](https://github.com/electron/electron/blob/main/docs/api/safe-storage.md)。

## 本地构建

需要 Node.js 22.12 或更新版本。先 `npm ci`，运行 `npm test`。本地配置位于 `config/exam-config.json`，远端地址使用完整 origin（协议、主机、端口），不能只填写域名。

推荐使用跨平台构建脚本 `scripts/build.js`：复制 `config/build.example.json` 为 `config/build.local.json`，填写后台的 keyId、版本、两组公钥文件路径、考试地址、允许访问的 origin 和更新地址。公钥文件路径相对于这份 JSON 文件解析，支持绝对路径；Windows 路径可写成 `C:/proctor-keys/auth-public.pem`。本地配置文件已被 Git 忽略。

示例中的 `_comments` 是每项配置的中文填写说明，可以保留或删除，构建时不会写入安装包配置。文件保持标准 JSON，不支持 `//` 或 `/* */` 注释。修改 `_comments` 外的实际配置值；`oj.example.com`、keyId 和公钥路径均须替换。`versionUrl` 来自 OJ「更新设置」提供的远端清单地址，客户端仓库不再保留本地 `version.json` 示例。

在 `exam-proctor-client` 目录运行（Bash 和 PowerShell 均适用）：

```text
npm ci
npm run build -- --config config/build.local.json --check

# 在 Windows 构建机，生成安装版和便携版 EXE：
npm run build -- --config config/build.local.json --win --x64

# 在 macOS 构建机，分别生成 Intel / Apple Silicon 的 DMG 和 ZIP：
npm run build -- --config config/build.local.json --mac --x64
npm run build -- --config config/build.local.json --mac --arm64
```

输出位于 `dist/`。`--check` 只验证并生成包内配置，不下载打包工具或生成安装包；`--dir` 生成解包目录，`--help` 查看用法。也可从任意工作目录运行 `node /完整路径/exam-proctor-client/scripts/build.js --config /完整路径/build.local.json --win --x64`。`PROCTOR_*` 环境变量优先于 JSON 配置，原有 `npm run dist`、`npm run pack` 和 GitHub Actions 入口继续可用。构建不会自动发布。

以下 Bash 示例引用管理员导出的**公钥**文件；文件应位于仓库外：

```bash
export PROCTOR_AUTH_PUBLIC_KEY="$(cat /secure/auth-public.pem)"
export PROCTOR_LOG_PUBLIC_KEY="$(cat /secure/log-public.pem)"
export PROCTOR_KEY_ID='后台显示的32位小写十六进制keyId'
export PROCTOR_CLIENT_VERSION='1.2.3'
export PROCTOR_TARGET_URL='https://oj.example.com/'
export PROCTOR_ALLOWED_ORIGINS='["https://oj.example.com"]'
export PROCTOR_UPDATE_ORIGINS='["https://oj.example.com"]'
export PROCTOR_VERSION_URL='https://oj.example.com/client-updates/version.json'
export PROCTOR_ALLOW_ROOT_DEBUG='false'
npm run dist -- --win --x64
# 在 Mac 构建机：
npm run dist -- --mac --arm64
npm run dist -- --mac --x64
```

PowerShell 设置公钥时使用 `$env:PROCTOR_AUTH_PUBLIC_KEY = Get-Content -Raw <公钥路径>`，保留真实 PEM 换行。`.env` 不会自动加载。

| 环境变量 | 含义 |
| --- | --- |
| `PROCTOR_AUTH_PUBLIC_KEY` | 必填，Ed25519 SPKI PEM 认证公钥 |
| `PROCTOR_LOG_PUBLIC_KEY` | 必填，RSA-3072 SPKI PEM 日志加密公钥 |
| `PROCTOR_KEY_ID` | 必填，对应两组密钥的 32 位 keyId |
| `PROCTOR_CLIENT_VERSION` | 可选，覆盖安装包版本，格式 x.y.z；须匹配 OJ 指定版本 |
| `PROCTOR_ALLOWED_ORIGINS` | JSON 数组；覆盖本地 exam.allowedOrigins |
| `PROCTOR_UPDATE_ORIGINS` | JSON 数组；覆盖本地 updater.allowedOrigins，包含清单、包、重定向的源站 |
| `PROCTOR_TARGET_URL` | 覆盖考试起始 URL，必须位于考试白名单 |
| `PROCTOR_VERSION_URL` | 覆盖 OJ 更新清单 URL，同时替换备用清单地址 |
| `PROCTOR_ALLOW_ROOT_DEBUG` | true/false；覆盖 debug.allowRoot，默认关闭 |

HTTPS 必需，只有 localhost 可使用 HTTP。`start`、`build`、`pack`、`dist`、`release:hot` 和 electron-builder 的 beforePack 都验证公钥，缺失或类型错误会失败。生成的 `app/generated/` 已被忽略；正式包内有公钥和配置，没有服务端私钥。正式版本从 Electron 安装包元数据读取，不从网页读取。

`npm start` 用于开发；`npm run pack` 生成解包目录。`npm run release:hot` 使用同样变量生成 `updates/app-<version>.asar` 和大小/哈希元数据，根目录包含正确的 package.json 和 app/main 入口，不自动递增版本、不上传文件、不打包仓库 .env。当前客户端不会自动执行 ASAR，见下方更新限制。

`updates/` 是上述可选热更新命令的产物目录，不是运行所需源码，也不参与正常安装包构建。历史遗留的 `updates/app.asar` 已清理；整目录可删除，需要时 `release:hot` 会重新创建。ASAR 是 Electron 的应用文件归档，并不是考试日志；正式安装包自身也可能含有 `resources/app.asar`，那份属于安装包运行文件，应保留。

## GitHub Actions

独立客户端仓库的 `.github/workflows/build.yml` 提供手动 workflow_dispatch 构建。将客户端仓库推送 GitHub 后，添加 Secrets：`PROCTOR_AUTH_PUBLIC_KEY`、`PROCTOR_LOG_PUBLIC_KEY`；添加 Variable：`PROCTOR_KEY_ID`。Actions 页面填写版本、考试地址、两个 origin JSON 数组、更新清单 URL，以及是否允许 root 调试。

输出三个独立 Artifact：Windows x64（NSIS 安装包和便携 EXE）、macOS x64（DMG/ZIP）、macOS arm64（DMG/ZIP）。工作流只上传构建结果，不自动发布 Release。Mac runner 使用明确的 Intel/Arm 标签，参见 [GitHub 官方 runner 列表](https://github.com/actions/runner-images)。

正式分发需要代码签名。Windows 可设置 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`；Mac 设置 `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`，以及 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 进行公证。未配置证书时可生成测试包；不能把未签名测试包当成已完成正式签名/公证的发行包。

## root 调试与系统保护

只有构建配置 `debug.allowRoot=true` 且 OJ **签名响应**确认 具有 `PRIV_ALL` 超级管理员权限时，才自动进入 root 调试：恢复 Windows 防火墙、停止防作弊快捷键/进程扫描、退出 kiosk、允许网络访问所有 HTTP(S) 地址，并可打开开发工具。用户名为 root 的普通账号不能开启。切换账号或验签失败立即取消调试；前端无法请求任意签名或自行声明 root。调试不豁免服务端版本、令牌、提交证明及日志要求。

Windows：普通考试用户握手后按配置应用系统防火墙规则，保存原出站策略和本地允许规则，退出/异常重启恢复。独立提升权限的看守进程会在客户端被强杀后恢复策略。恢复失败会保留状态；可用管理员终端运行随包 `scripts/restore-network.bat`，默认读取 `%APPDATA%\HydroProctorClient\network-state.json`。不会重置整机防火墙、清空代理或禁用所有网卡。网络权限提升仅在需要修改防火墙时请求，不强制客户端全程以管理员身份运行。

macOS：支持应用内精确 origin 白名单、全屏、失焦、多屏、进程检测和加密日志。**本版本没有系统级 macOS 网络过滤器**，其它应用的网络不能因此被阻断；需要另行实现有相应签名与授权的原生 Network Extension。Windows 的 IP/端口规则也不能证明其它应用绝对无法通过共享 CDN、DNS、代理、GPO 或管理员操作访问外网；日志与服务端认证都不能视为不可绕过的设备证明。

进程黑名单按平台配置；默认记录事件，只有明确设置 `antiCheat.terminateBlacklisted=true` 才终止命中的进程。Windows 为原有黑名单，Mac 可在 `processBlacklistByPlatform.darwin` 中配置可执行文件名。

## 日志恢复与更新

用户数据目录名固定为 `HydroProctorClient`。`journals/<上下文摘要>/journal.enc` 为逐条 AES-GCM 加密记录，附带序号、单调时间和摘要链。`state.json` 仅保留归属、阶段和重试元数据，`secrets/*.bin` 是 OS 保护的密钥，`final.hplog` 使用独立 RSA/AES 封装供 OJ 验证和管理员离线解密。日志不包含代码正文、令牌、私钥或完整请求证明。断电时损坏尾部另行保留并记录恢复事件；中段损坏拒绝续写，不重建空日志冒充完整。

尚未结束的日志重启后自动续写，记录异常退出及客户端重启，只有 OS boot 标识改变才另记系统重启。已结束文件保持不变；上传响应丢失时通过服务端 SHA-256 回执确认。版本/密钥错误暂停该版本的补传，升级客户端后允许重新尝试；管理员修复策略后可点击“补传日志”手动重试。成功上传的加密证据目前保留在本机，便于管理员删除服务端日志后恢复；管理员应按考试留存期限安排本机数据清理。

更新器兼容 OJ 的 version/minClientVersion/config/hotUpdate/fullUpdate 清单。它实际尝试备用下载地址，限制大小及重定向源站，校验下载包 SHA-256/字节数；缓存最低版本策略。存在未完成/待上传考试时跳过更新检查，避免破坏原 attempt。

**现有 OJ 清单缺少独立发布签名，因此不自动替换或执行 ASAR**。新版通过完整安装包下载提示更新；Mac signed bundle 也不应直接替换 app.asar。OJ 现有 fullUpdate 只提供 Windows x64 链接，本客户端不会在 Mac 上展示 EXE；Mac 包应先人工分发。客户端预留 `fullUpdate.platforms.<win32|darwin>.<x64|arm64>` 选择器，但当前 OJ 后台尚不生成它。不要把 Windows 与 Mac 包混进单个 installerUrl。认证握手始终执行 OJ 的精确版本策略。

自动化测试覆盖协议验签/刷新、IPC 请求范围、加密格式、异常恢复、原账号断网补传、丢失回执、更新重定向/哈希和 ASAR 目录结构。Windows 防火墙恢复、macOS 权限和签名/公证仍需在相应系统真机验收；Linux 的单元测试不能证明这些行为。
