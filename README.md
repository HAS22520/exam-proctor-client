# HydroNext 监考客户端

Electron 客户端，连接 HydroNext 的 `HydroNext-proctor/1` 协议。支持 Windows x64，以及 macOS Intel x64 / Apple Silicon arm64。源码修改可直接在本仓库查看；HydroNext 父仓库把本目录作为独立 Git 仓库忽略。

## 功能与部署顺序

1. 在 OJ「监考设置」生成认证密钥，取得同一次生成的认证公钥（Ed25519）、日志加密公钥（RSA-3072）和 keyId。两组服务端私钥只保存在 OJ，不能用于客户端构建。
2. 通过环境变量注入公钥和地址，构建、签名、安装客户端。公钥不写进公开源码，但可从安装包提取；隐藏公钥不能证明客户端程序未被修改。
3. 在 OJ 设置与安装包完全一致的指定客户端版本，开启系统监考，再开启比赛监考。用户登录原 OJ 账号并报名，客户端自动握手，无须注册码或手工设备登记。
4. ui-next 现有的 `window.examAPI.proctorHeaders` 桥会自动为代码提交、文件提交和自测生成设备签名证明；服务端决定是否接受。普通浏览器没有此桥，不能提交监考比赛。
5. 退出时可选“保留日志退出”：停止本次客户端监控、恢复网络并保留开放的 attempt 和可续写日志，重新登录原账号后继续做题。只有“上传日志并结束监考”才关闭 attempt、生成最终加密日志并上传；上传前成绩待确认，断网可保留文件并用原账号补传。两种操作都不会代交代码，禁止删除本机数据。

必须部署 HydroNext 的 `/proctor/identity` 接口（域内为 `/d/<domainId>/proctor/identity`）。它使用已有认证私钥签署当前登录 UID、root 权限和比赛/题目上下文。接口是本次唯一新增的服务端协议入口，不读取前端显示的用户名来判断 root。

每次启动，在加载 OJ 页面前清空客户端会话的 Cookie、HTTP 登录缓存、Service Worker 和 Cache Storage，要求重新登录。保留本地草稿、设备密钥和加密日志，原账号登录后仍可恢复未结束的监考或补传日志。登录 Cookie 变化会立即撤销旧身份与调试权限，并触发重新认证。

设备密钥和日志 AES 密钥使用 Electron safeStorage 加密：Windows 的 DPAPI / macOS 的 Keychain。密钥不能加密时客户端拒绝启动，不回退明文。跨系统用户、迁移用户数据或删除密钥可能使原考试无法恢复。当前固定 Electron 44；升级到 46 前需迁移其异步 safeStorage API。参见 [Electron 官方说明](https://github.com/electron/electron/blob/main/docs/api/safe-storage.md)。

## 本地构建

需要 Node.js 22.12 或更新版本。先 `npm ci`，运行 `npm test`。本地配置位于 `config/exam-config.json`，远端地址使用完整 origin（协议、主机、端口），不能只填写域名。

推荐使用跨平台构建脚本 `scripts/build.js`：复制 `config/build.example.json` 为 `config/build.local.json`，填写后台的 keyId、版本、buildVersion 构建编号、两组公钥文件路径（启用 ASAR 更新时再填独立更新公钥）、考试地址、允许访问的 origin 和更新地址。公钥文件路径相对于这份 JSON 文件解析，支持绝对路径；Windows 路径可写成 `C:/proctor-keys/auth-public.pem`。本地配置文件已被 Git 忽略。

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

客户端的 `package.json` 显式声明 npm 和空的 `workspaces`，用于建立独立的依赖扫描边界。即使放在 Hydro 的 Yarn 仓库内、同时存在其它包管理器的锁文件，electron-builder 也应只扫描客户端。请保留这两项；无需删除或重装 Hydro 的 `node_modules`。

在 WSL/Linux x64 上，可用以下命令只生成便携版 EXE；本客户端固定的 electron-builder 26.15.3 已在 WSL 验证此目标不需要 Wine：

```bash
npm run build -- --config config/build.local.json --win --x64 --portable
```

默认的 `--win --x64` 同时生成便携版与 NSIS 安装版。WSL/Linux 上生成 NSIS 安装版需要可正常执行 Windows 程序的系统 Wine，并能下载 Electron、NSIS 等工具；NSIS 不需要 Mono。未安装或 Wine 无法运行时，可先使用便携版，或使用已有 GitHub Actions 的 Windows 构建任务。macOS 签名与公证在 macOS 构建机完成。参见 [electron-builder v26 跨平台构建说明](https://www.electron.build/v26/docs/features/multi-platform-build/)。

以下 Bash 示例引用管理员导出的**公钥**文件；文件应位于仓库外：

```bash
export PROCTOR_AUTH_PUBLIC_KEY="$(cat /secure/auth-public.pem)"
export PROCTOR_LOG_PUBLIC_KEY="$(cat /secure/log-public.pem)"
export PROCTOR_KEY_ID='后台显示的32位小写十六进制keyId'
export PROCTOR_CLIENT_VERSION='1.2.3'
export PROCTOR_CLIENT_BUILD_VERSION='2026101001'
# 启用 ASAR 更新时预置独立更新公钥：
export PROCTOR_UPDATE_PUBLIC_KEY="$(cat /secure/update-public.pem)"
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
| `PROCTOR_CLIENT_BUILD_VERSION` | YYYYMMDDNN 字符串，如 2026101001；覆盖构建编号，每次新发布递增，须与 OJ 清单一致 |
| `PROCTOR_UPDATE_PUBLIC_KEY` | 启用 ASAR 时必填，独立 Ed25519 SPKI PEM 更新签名公钥；完整包与 ASAR 保持一致 |
| `PROCTOR_UPDATE_PRIVATE_KEY` | 仅 `release:hot` 使用的独立更新签名私钥，也可用 `--sign-key FILE`；不写入客户端 |
| `PROCTOR_ALLOWED_ORIGINS` | JSON 数组；覆盖本地 exam.allowedOrigins |
| `PROCTOR_UPDATE_ORIGINS` | JSON 数组；覆盖本地 updater.allowedOrigins，包含清单、包、重定向的源站 |
| `PROCTOR_TARGET_URL` | 覆盖考试起始 URL，必须位于考试白名单 |
| `PROCTOR_VERSION_URL` | 覆盖 OJ 更新清单 URL，同时替换备用清单地址 |
| `PROCTOR_ALLOW_ROOT_DEBUG` | true/false；覆盖 debug.allowRoot，默认关闭 |

HTTPS 必需，只有 localhost 可使用 HTTP。`start`、`build`、`pack`、`dist`、`release:hot` 和 electron-builder 的 beforePack 都验证公钥，缺失或类型错误会失败。生成的 `app/generated/` 已被忽略；正式包内有公钥和配置，没有服务端私钥。客户端报告实际启动的应用版本和构建编号；下载清单或 ASAR 不会提前改变本机版本。

`npm start` 用于开发；`npm run pack` 生成解包目录。支持 ASAR 更新需要先生成一组**独立更新签名密钥**，该私钥不是 OJ 的认证私钥或日志解密私钥。密钥目录放在仓库外，例如：

```bash
npm run keys:update -- --out-dir "$HOME/proctor-update-keys"
```

生成 `update-public.pem` 和 `update-private.pem`，不会覆盖已有密钥，也不会显示私钥内容。Windows 请将这个目录的访问权限限制给构建管理员；POSIX 系统会使用私钥 0600、目录 0700 权限。在 `config/build.local.json` 的 `updatePublicKeyFile` 填该公钥的路径。先用这个配置构建并安装一次完整客户端，使更新加载器和公钥进入安装包。旧 EXE 不含加载器，不能仅靠发布 ASAR 获得新更新能力。

后续只改应用代码时，增加 `buildVersion`（例如从 `2026101001` 增至 `2026101002`，显示 `version` 可保持 `1.0.0`），执行：

```bash
npm run release:hot -- --config config/build.local.json --sign-key "$HOME/proctor-update-keys/update-private.pem"
```

`--sign-key` 指定的是与 `updatePublicKeyFile` 配对的 **update-private.pem 私钥**；不能传 update-public.pem 公钥，也不能使用 OJ 的认证或日志解密私钥。

生成 `updates/app-<version>-<buildVersion>.asar` 和同名 `.json`（包含 `version`、`buildVersion`、`signed`、`size` 字节数、`sha256`）。把 **ASAR 本身**上传至 OJ「更新设置」的热更新包，填写与产物完全一致的 `version` 和 `buildVersion`，发布清单。元数据 JSON 是构建信息，不是完整 OJ 清单；签名位于 ASAR 内的 `release.json`，OJ 不需要增加签名接口或保留外部签名字段。不传签名私钥时仍可生成归档供检查，但 `signed=false`，客户端会拒绝安装。

公钥与地址配置随包生成，`PROCTOR_*` 环境变量优先于 JSON。ASAR 不需要 Docker、Wine、`--win` 或 `--mac`，同一份纯 JS/HTML 归档用于 Windows x64 和 macOS x64/arm64。它不包含 Electron 运行时，也不包含安装包独立的防火墙脚本。升级 Electron、更改外部脚本、密钥、白名单或 root 调试权限时，需要完整安装包。根目录保留 package.json、启动入口和生成配置，私钥、本地构建 JSON、仓库 `.env` 不会进入归档。

`updates/` 是上述可选热更新命令的产物目录，不是运行所需源码，也不参与正常安装包构建。历史遗留的 `updates/app.asar` 已清理；整目录可删除，需要时 `release:hot` 会重新创建。ASAR 是 Electron 的应用文件归档，并不是考试日志；正式安装包自身也可能含有 `resources/app.asar`，那份属于安装包运行文件，应保留。

## GitHub Actions

独立客户端仓库的 `.github/workflows/build.yml` 提供手动 workflow_dispatch 构建。将客户端仓库推送 GitHub 后，添加 Secrets：`PROCTOR_AUTH_PUBLIC_KEY`、`PROCTOR_LOG_PUBLIC_KEY`；使用 ASAR 时另加 `PROCTOR_UPDATE_PUBLIC_KEY`（上面生成的更新公钥）和 `PROCTOR_UPDATE_PRIVATE_KEY`（对应私钥，仅 ASAR job 使用）；添加 Variable：`PROCTOR_KEY_ID`。Actions 页面填写版本、递增的 `build_version`、考试地址、两个 origin JSON 数组、更新清单 URL，以及是否允许 root 调试。

Actions 的 `build_type` 可以选 `installers`（完整安装包）、`asar`（应用归档）或 `all`（默认，两者都构建）。完整安装包使用 Windows/macOS 原生 runner，输出 Windows x64（NSIS/便携 EXE）、macOS x64（DMG/ZIP）、macOS arm64（DMG/ZIP）三个 Artifact；ASAR 在独立 Ubuntu job 中执行 `release:hot`，输出 `HydroProctor-<version>-<buildVersion>-asar` Artifact，内含签名 ASAR 与构建信息 JSON，沿用同一组公钥、版本、构建编号与地址参数；缺少签名私钥时 ASAR job 会明确失败。工作流只上传构建结果，不自动发布 Release 或上传 OJ。Mac runner 使用明确的 Intel/Arm 标签，参见 [GitHub 官方 runner 列表](https://github.com/actions/runner-images)。

正式分发需要代码签名。Windows 可设置 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`；Mac 设置 `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`，以及 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 进行公证。未配置证书时可生成测试包；不能把未签名测试包当成已完成正式签名/公证的发行包。

## 本地 Docker 构建 Windows

在 WSL/Linux 的客户端目录执行，沿用填写好的 `config/build.local.json`：

```bash
npm run build:docker -- --config config/build.local.json --win --x64 --check
npm run build:docker -- --config config/build.local.json --win --x64
# 只生成便携 EXE
npm run build:docker -- --config config/build.local.json --win --x64 --portable
```

采用 [electron-builder v26 官方跨平台构建流程](https://www.electron.build/v26/docs/features/multi-platform-build/) 的 Wine 容器，默认 `electronuserland/builder:22-wine`，使用 Node 22。当前终端用户须有 Docker daemon 访问权限；构建脚本不会自动修改系统用户组或调用 sudo。`--check` 只验证配置，不启动容器。macOS 打包仍需 macOS；此容器入口仅支持 Windows x64，GitHub Actions 继续使用原有 Windows/macOS 原生 runner。

首次运行自动拉取镜像并在容器内执行 `npm ci`，后续复用客户端 `.docker-cache/` 内的 npm、Electron、electron-builder 和 Wine 缓存；产物写入 `dist/`。容器只挂载独立的临时源码副本、缓存和输出目录，依赖安装在临时副本中，不使用 Hydro 或本机 `node_modules`。宿主机上的公钥文件先读取、验证，再通过环境变量传入；`build.local.json`、PEM 文件、`.env` 和服务端私钥不复制到容器。

需要固定镜像版本或摘要时：

```bash
PROCTOR_BUILDER_IMAGE=electronuserland/builder:22-wine-03.25 npm run build:docker -- --config config/build.local.json --win --x64
```

`PROCTOR_*` 公钥、版本和地址环境变量与普通 `build` 一样可以覆盖 JSON 配置。这个本地容器入口用于生成测试包，没有转发宿主机签名证书变量；正式签名发行使用原生构建或 GitHub Actions 中的证书配置。

## 比赛读取认证与结束监考

兼容 HydroNext 提交 `b74f64ed` 的读取保护：开启监考的比赛在读取题目、提交页面、题目文件、题单、打印页面和比赛私有文件前，需要带有 `problem_view` 或 `contest_view` 的 GET 签名证明。客户端通过签名身份响应确认账号、域和比赛，完成版本与设备认证后，按原始路径和读取参数生成证明。深链接、刷新和附件请求也会自动补充证明；每次读取生成新的 nonce，已有前端桥接证明保持原样。身份、握手和状态接口不走读取签名，跨源跳转剥离监考令牌和证明。

版本或认证密钥不匹配时不能获得有效证明，由 OJ 拒绝读取和提交；客户端不会用调试身份绕过服务端检查。普通比赛及赛后浏览仍由 OJ 的既有规则决定。客户端进入比赛前应先报名并登录，且构建版本必须与后台指定版本完全一致。

同一 origin、域、比赛和题目上下文的签名身份最多缓存 20 秒，并在签名即将到期前重新获取；导航认证串行合并，比赛页与题目列表共用一次握手。每次读取和提交仍生成新的请求证明，由 OJ 校验实际请求的版本、令牌、环境和比赛状态。客户端不再对每个受保护资源额外查询比赛状态；后台定期检查及登录变化会重新获取签名身份。

结束监考并上传成功后，服务端会把该账号在这场比赛中的 attempt 设为 `complete`。之后握手可能返回 HTTP 200 和 `completed: true`，而不是新的会话令牌；这代表该场监考已结束，不代表版本不匹配。客户端显示“本场监考已结束且日志已上传”，不再对此记录反复握手或恢复监考限制。按“完成并退出”退出客户端后，另一账号可以重新登录、独立认证和建立自己的日志；原账号继续同场比赛受服务端规则限制，客户端不会清除原日志或重开已结束的 attempt。

点击“退出 / 结束监考”先选择操作。“保留日志退出”不关闭服务端 attempt、不生成最终文件也不上传；正常退出会在加密日志中记录 CLIENT_PAUSED 和 CLIENT_SHUTDOWN，下次原账号登录仍可续写与做题。“上传日志并结束监考”先明确提示必须上传日志才能确认成绩，随后打开本地独立上传窗口，显示整理/加密、实际网络上传百分比和字节数、等待服务端确认、成功或待补传状态。上传到 100% 仍需等待有效回执，才允许“完成并退出”。网络中断时提示日志已加密保存在本机、成绩待确认，可选择保留待补传文件退出，联网后重新启动并登录原账号补传。此时不能继续做题。多个待上传比赛依次显示，各自成功才报告全部完成。

上传窗口先显示网络恢复阶段。恢复失败时显示单独的网络警告，仍整理日志并尝试向白名单内的 OJ 上传；失败则保留加密文件供补传，不重新开始考试。加密整理定期让出主进程事件循环，上传使用文件流和实际网络进度，最长等待 120 秒；兼容 Electron 44 的字符串响应头及请求体流先关闭、服务端回执后到达的行为。

考试页面的监考面板显示认证状态、已监考时长、待补传数量、实际运行的版本/buildVersion 和更新状态，提供检查更新、签名 ASAR 安装及完整包下载入口。拖动面板标题可改变位置，位置在当前 OJ origin 的本地存储中保留，窗口缩放时限制在视口内；仍可收起以减少遮挡。管理员调试和补传按钮按当前可信状态显示。

## 管理员解密日志

`tools/decrypt-log.py` 是离线命令行工具，需要 Python 3.9+ 和 `cryptography`。Windows 可用 `py` 代替下面的 `python3`：

```bash
python3 -m venv .venv
# Linux/macOS；Windows 使用 .venv/Scripts/python.exe 执行后续命令
.venv/bin/python -m pip install -r tools/requirements.txt
.venv/bin/python tools/decrypt-log.py downloaded.hplog --private-key /path/to/log-private.pem -o decrypted.log
```

使用 OJ 后台“日志解密私钥”（RSA-3072），不是 Ed25519 认证私钥，也不是客户端构建用公钥。工具也接受 JSON：`{"keyId":"…","encryptionPrivateKey":"-----BEGIN PRIVATE KEY-----\n…"}`，或后台响应的 `privateKeys` / `keys` 包装结构；可用 `--key-id` 额外核对密钥 ID。加密 PEM 使用 `--password` 交互输入密码。私钥只供管理员本地解密，不放入客户端配置、安装包或 Actions 公钥变量。

输出 `.log` 保留原始 UTF-8 JSON Lines：首行是账号/域/比赛绑定元数据，后续每行一个监考事件。文件完整性经过 RSA-OAEP/SHA-256 解包和 AES-256-GCM 校验；错误密钥、截断或篡改不会生成输出文件，已有文件也不会被破坏。默认拒绝覆盖，确需替换时加 `--force`。实时的 `journal.enc` 需要本机 OS 保护的密钥，不能作为 `.hplog` 输入。

验证客户端和解密工具：

```bash
npm test
python3 -m unittest discover -s tools/tests -v
```

## root 调试与系统保护

只有构建配置 `debug.allowRoot=true` 且 OJ **签名响应**确认 具有 `PRIV_ALL` 超级管理员权限时，才自动进入 root 调试：恢复 Windows 防火墙、停止防作弊快捷键/进程扫描、退出 kiosk、允许网络访问所有 HTTP(S) 地址，并可打开开发工具。用户名为 root 的普通账号不能开启。切换账号或验签失败立即取消调试；前端无法请求任意签名或自行声明 root。调试不豁免服务端版本、令牌、提交证明及日志要求。

在 `config/build.local.json` 设置 `"allowRootDebug": true`（或构建时传入 `PROCTOR_ALLOW_ROOT_DEBUG=true`），重新打包后用 OJ 超级管理员账号登录。签名身份验证成功时会自动打开独立“调试控制台”，关闭后可通过监考面板的“调试控制台”按钮重新打开。控制台显示启动步骤、防火墙操作、身份请求、challenge/handshake/refresh 阶段、HTTP 错误、网络拦截、日志上传进度与耗时、页面无响应/崩溃及主进程事件循环延迟；可筛选、复制日志，也可打开考试页面开发工具查看页面问题。控制台使用独立会话，不提供执行命令或任意签名功能。退出登录、验签失败或签名身份到期时关闭控制台并撤销调试权限。

启用 root 调试的构建在每次启动时保存脱敏诊断记录，Windows 路径为 `%APPDATA%\HydroProctorClient\diagnostics\debug-<时间戳>.log`，macOS 路径为 `~/Library/Application Support/HydroProctorClient/diagnostics/debug-<时间戳>.log`。即使尚未登录或启动失败，也可查看文件最后的 `*.start` / `*.failed` 定位停在哪一步。控制台保留最近 1,000 条；文件每次启动最多 4 MiB、保留最近 3 次。诊断文件与考试用的加密 `.hplog` 分开，不作为监考证据上传；不记录请求体、代码、Cookie、令牌、密钥或完整证明，URL 移除查询参数与片段。普通构建不创建诊断文件。修改配置后必须重新构建，旧 EXE 不会自动获得控制台。

诊断记录的 `time` 使用系统本地时区并带偏移，例如 `2026-10-10T18:50:45.841+08:00`，另保留 `utc` 和 `timeZone`。旧记录以 `Z` 结尾，表示 UTC，在香港本地需要加 8 小时；它本身不表示系统时钟错误。HTTP 200 的 `net::OK` 不会再记为错误，HTTP 403 等拒绝响应保留为警告。`firewall.stage` 会标明域名解析、策略快照、规则批量禁用、恢复出站策略及恢复原规则等阶段。

`identity.verified` 记录签名验证后的 UID、域和比赛；`auth.session-accepted` 表示已收到并验证会话令牌，`auth.attempt-complete` 表示服务端返回已完成状态。`request.authentication-failed` 会记录读取认证失败的实际原因和错误码，不记录令牌或证明。排查换账号的问题时，可以用 UID 区分客户端是否已识别新账号，不能仅凭握手的 HTTP 200 判断仍有有效做题会话。

Windows：普通考试用户握手后按配置应用系统防火墙规则，保存原出站策略和本地允许规则，退出/异常重启恢复。独立提升权限的看守进程会在客户端被强杀后恢复策略。恢复失败会保留状态；可用管理员终端运行随包 `scripts/restore-network.bat`，默认读取 `%APPDATA%\HydroProctorClient\network-state.json`。不会重置整机防火墙、清空代理或禁用所有网卡。网络权限提升仅在需要修改防火墙时请求，不强制客户端全程以管理员身份运行。

提权只显示 Windows UAC 授权提示，PowerShell 执行窗口隐藏且禁止交互输入。通过当前 Windows 访问令牌判断管理员权限，不依赖 `net session` 或 Server 服务。执行器仅等待防火墙命令进程退出，保留看守进程独立运行；不能改回 `Start-Process -Wait`，它会等待包括看守进程在内的整个进程树，导致看守进程等待客户端退出、客户端又等待看守进程的死锁。已提升权限的看守进程接受恢复请求，正常退出和 root 调试不再重复申请 UAC；检测到客户端退出或取消请求时，先停止仍在修改策略的进程，再恢复。通过策略组和互斥锁防止旧看守进程操作新一场考试的策略。

防火墙操作与 OS 启动标识查询均采用异步子进程，等待 UAC/系统服务期间不阻塞 Electron 主进程。规则批量启用/禁用，恢复时先恢复出站默认策略。应用操作最多等待 45 秒、前台恢复最多等待 30 秒；失败保留快照，看守进程每隔 5 秒继续尝试，前台 30 秒内不会反复提权。未恢复的旧策略会阻止应用新策略。正常退出先尝试恢复，然后处理日志；强制退出由独立看守进程恢复。Docker 构建会跳过旧的 `app/generated`，在临时项目内按本次配置重新生成，避免沿用旧公钥或读取容器遗留的不可读文件。

macOS：支持应用内精确 origin 白名单、全屏、失焦、多屏、进程检测和加密日志。**本版本没有系统级 macOS 网络过滤器**，其它应用的网络不能因此被阻断；需要另行实现有相应签名与授权的原生 Network Extension。Windows 的 IP/端口规则也不能证明其它应用绝对无法通过共享 CDN、DNS、代理、GPO 或管理员操作访问外网；日志与服务端认证都不能视为不可绕过的设备证明。

进程黑名单按平台配置；默认记录事件，只有明确设置 `antiCheat.terminateBlacklisted=true` 才终止命中的进程。Windows 为原有黑名单，Mac 可在 `processBlacklistByPlatform.darwin` 中配置可执行文件名。

## 日志恢复与更新

用户数据目录名固定为 `HydroProctorClient`。`journals/<上下文摘要>/journal.enc` 为逐条 AES-GCM 加密记录，附带序号、单调时间和摘要链。`state.json` 仅保留归属、阶段和重试元数据，`secrets/*.bin` 是 OS 保护的密钥，`final.hplog` 使用独立 RSA/AES 封装供 OJ 验证和管理员离线解密。日志不包含代码正文、令牌、私钥或完整请求证明。断电时损坏尾部另行保留并记录恢复事件；中段损坏拒绝续写，不重建空日志冒充完整。

尚未结束的日志重启后自动续写，记录异常退出及客户端重启，只有 OS boot 标识改变才另记系统重启。已结束文件保持不变；上传响应丢失时通过服务端 SHA-256 回执确认。版本/密钥错误暂停该版本的补传，升级客户端后允许重新尝试；管理员修复策略后可点击“补传日志”手动重试。成功上传的加密证据目前保留在本机，便于管理员删除服务端日志后恢复；管理员应按考试留存期限安排本机数据清理。

更新器兼容 OJ 的 version/minClientVersion/buildVersion/config/hotUpdate/fullUpdate 清单。**是否有更新只比较合法的 buildVersion 字符串**，格式为实际日期 YYYYMMDD 加两位序号。同版本也能更新；较高显示版本配较低构建编号不会提示新构建。最低版本仍按 x.y.z 独立校验，低于最低版本不能取得做题/提交证明。每次检查都刷新最低版本和远端配置，降低最低版本限制也会生效。旧清单或旧本机身份缺少合法 buildVersion 时提示安装完整客户端，不回退用 version 判断更新。

窗口和认证 IPC 先启动，清单后台检查，不等待慢速更新服务器。存在开放、关闭中或待上传日志时仍可查看更新状态，但禁止下载应用 ASAR 和重启应用新代码；先上传并结束所有监考。下载期间开始监考也会取消暂存，下一次启动加载新包前再次检查所有本地日志（包括其他账号）。已经运行的 ASAR 可继续用于续写，不因日志未结束而切换回旧代码。

签名 ASAR 更新依次经过：受白名单约束的下载/重定向、大小与 SHA-256 校验、预置更新公钥的 Ed25519 验签、所有应用文件的 SHA-256 校验、版本/buildVersion/Electron 身份及信任边界核对，之后暂存到用户数据目录 `updates/`。发布签名绑定构建编号、显示版本、Electron 版本及每个文件的路径、大小、哈希。拒绝链接、unpacked 和原生模块；不会因为清单提供了同一个包的哈希就信任它。考试面板显示下载进度和验证状态，用户确认后重启；选择稍后重启时，下次启动且没有未结束日志时生效。

原安装包中的启动加载器负责验证并加载缓存 ASAR 的 main 入口，以及其中的 preload/页面文件，不覆盖安装目录的 `resources/app.asar`。更新启动完成才确认新版本；首次启动未完成或 main 加载失败，会回退到上一份已确认的签名归档或原安装包。Mac 原始签名 bundle 保持完整。Linux Node 测试验证真实 ASAR 文件、加载选择与失败回退，Windows/macOS 的实际 Electron 启动仍需真机验证。

完整包下载按系统/架构选择。OJ 现有 fullUpdate 的 installerUrl/portableUrl 用于 Windows x64，本客户端不会在 Mac 展示 EXE；Mac 完整包先人工分发。客户端也识别 `fullUpdate.platforms.<win32|darwin>.<x64|arm64>`，但不能把 Windows 与 Mac 包混进一个 installerUrl。认证握手始终执行 OJ 的精确版本策略，buildVersion 不替代考试认证版本。

自动化测试覆盖协议验签/刷新、IPC 请求范围、加密格式、异常恢复、原账号断网补传、丢失回执、更新重定向/哈希和 ASAR 目录结构。Windows 防火墙恢复、macOS 权限和签名/公证仍需在相应系统真机验收；Linux 的单元测试不能证明这些行为。
