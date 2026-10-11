# HydroNext 监考客户端

Electron 客户端，使用 `HydroNext-proctor/1` 协议连接 OJ。支持 Windows x64 和 macOS 13+（Intel x64 / Apple Silicon arm64）。

| 平台 | 监考行为 | 运行权限 |
| --- | --- | --- |
| Windows | WFP 临时限制整机网络，记录加密日志 | 必须以管理员身份启动 |
| macOS | 只记录监考事件，不限制系统网络、不强制窗口置顶或终止进程 | 普通用户即可，无须网络扩展授权 |

两种平台均保留设备认证、版本校验、读取和提交证明、日志续写、上传及补传。macOS 客户端内部仍限制考试页面的导航与资源来源，保护认证桥的信任边界；其他应用的联网不受影响。

## 部署准备

1. 在 OJ「监考设置」生成密钥，导出同一次生成的认证公钥（Ed25519）、日志加密公钥（RSA-3072）及 keyId。服务端私钥不进入客户端。
2. 将公钥、OJ 地址及允许访问的 origin 注入构建配置，构建并分发客户端。公钥可从安装包提取，隐藏公钥不能证明程序未被修改。
3. 在 OJ 设置与客户端完全一致的 `version`，启用系统及比赛监考。用户登录、报名后自动握手，无须注册码。

服务端须提供签名身份接口 `/proctor/identity`（域内为 `/d/<domainId>/proctor/identity`）及比赛监考接口。客户端为受保护的题目、题单、附件和提交请求提供设备签名证明，由 OJ 校验版本、令牌、环境与比赛状态。

## GitHub Actions 一键构建

将本客户端作为独立仓库推送 GitHub，使用 `.github/workflows/build.yml`。若放在 Hydro 父仓库内，该目录被父仓库忽略，应推送客户端自己的仓库。

先在仓库 **Settings → Secrets and variables → Actions** 配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Secret | `PROCTOR_AUTH_PUBLIC_KEY` | 完整认证公钥 PEM，保留换行 |
| Secret | `PROCTOR_LOG_PUBLIC_KEY` | 完整日志加密公钥 PEM，保留换行 |
| Variable | `PROCTOR_KEY_ID` | 与上述公钥对应的 32 位小写十六进制 keyId |
| Secret，可选 | `PROCTOR_UPDATE_PUBLIC_KEY` | 独立的 Ed25519 更新签名公钥；启用 ASAR 更新时需要 |
| Secret，可选 | `PROCTOR_UPDATE_PRIVATE_KEY` | 对应的更新签名私钥；生成可安装的 ASAR 时需要 |

在 **Actions → Build Hydro proctor client → Run workflow** 填写 `version`、递增的 `build_version`、OJ 起始地址、考试及更新 origin JSON 数组、更新清单 URL 和 root 调试开关。选择构建类型：

- `installers`：生成 Windows x64 的安装版／便携 EXE，以及 macOS x64、arm64 的 DMG／ZIP，无须更新签名私钥。
- `asar`：只生成签名应用更新归档，必须配置两项更新密钥。
- `all`：同时生成安装包与 ASAR，密钥要求同 `asar`。

构建成功后，从运行页面的 **Artifacts** 下载对应平台、架构的 ZIP，解压取得安装包。Windows 使用原生 Windows runner；Mac 两种架构分别使用 Intel 和 Apple Silicon runner。本工作流只上传产物，不自动发布 Release 或上传 OJ。

### macOS 安装与可选签名

没有 `MAC_CSC_LINK` 证书时，构建使用免费的 ad-hoc 签名并关闭公证，生成 DMG 不需要 Apple Developer 账号、Team ID 或 provisioning profile。

用户根据 Mac 芯片选择 `mac-x64` 或 `mac-arm64` 产物，打开 DMG，将应用拖入“应用程序”再启动。未公证的下载包可能被 Gatekeeper 阻止；确认来源可信后，在 **系统设置 → 隐私与安全性 → 仍要打开** 中允许启动，参见 [Apple 操作说明](https://support.apple.com/102445)。ad-hoc 签名不提供 Developer ID 身份认证。

若已有发行证书，可设置 `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`；公证再配置 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。Windows 签名使用 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`。这些均为可选项。

## 本地构建

需要 Node.js 22.12+。在本客户端目录复制 `config/build.example.json` 为 `config/build.local.json`，按照 `_comments` 填写各项；注释字段不会进入安装包。公钥路径相对于配置文件，文件应放在仓库外。本地配置已被 Git 忽略，`.env` 不会自动加载。

`allowedOrigins` 和 `updateOrigins` 使用完整 origin，例如 `https://oj.example.com`；不同子域、协议和端口需分别填写，不支持路径或通配符。HTTPS 必需，仅本机回环地址允许 HTTP 调试。`versionUrl` 填 OJ「更新设置」提供的远端清单地址。

```bash
npm ci
npm run build -- --config config/build.local.json --check

# Windows：安装版和便携版
npm run build -- --config config/build.local.json --win --x64
# 只生成便携版
npm run build -- --config config/build.local.json --win --x64 --portable

# Mac：在 macOS 上构建，无需付费开发者账号
npm ci && npm run build -- --config config/build.local.json --mac --arm64
# Intel Mac 将 --arm64 改为 --x64
```

Windows 原生构建需 Visual Studio Build Tools 的 C++ 桌面开发组件，并在 x64 Developer Command Prompt／PowerShell 中运行。Mac 需安装 Command Line Tools，以提供打包、签名工具。

输出位于 `dist/`。`--check` 只验证并生成配置；`--dir` 生成解包目录；`--help` 查看参数。`npm run dist` 与 `build` 等价，`npm run pack` 生成解包目录，`npm start` 用于开发。`package.json` 的 npm 声明和空 `workspaces` 用于隔离 Hydro 父仓库的依赖扫描，应保留。

环境变量优先于 JSON 配置，可用于 CI：

| 环境变量 | 对应内容 |
| --- | --- |
| `PROCTOR_AUTH_PUBLIC_KEY` / `PROCTOR_LOG_PUBLIC_KEY` | 完整公钥 PEM 正文，不是文件路径 |
| `PROCTOR_KEY_ID` | 两组公钥对应的 keyId |
| `PROCTOR_CLIENT_VERSION` / `PROCTOR_CLIENT_BUILD_VERSION` | 客户端版本／递增构建编号 |
| `PROCTOR_TARGET_URL` / `PROCTOR_VERSION_URL` | OJ 起始地址／更新清单 URL |
| `PROCTOR_ALLOWED_ORIGINS` / `PROCTOR_UPDATE_ORIGINS` | JSON 格式的 origin 数组 |
| `PROCTOR_ALLOW_ROOT_DEBUG` | `true` 或 `false`，默认关闭 |
| `PROCTOR_UPDATE_PUBLIC_KEY` | 独立更新公钥 PEM |
| `PROCTOR_UPDATE_PRIVATE_KEY` | 仅生成签名 ASAR 使用，不进入客户端 |

生成的 `app/generated/` 不提交源码仓库。旧本地配置中的 `macTeamId`、`macHostProfileFile`、`macExtensionProfileFile` 会被忽略，可以删除。

### WSL／Linux 使用 Docker 构建 Windows

需要 Docker daemon 访问权限，无需宿主机 Wine 或 MinGW：

```bash
npm run build:docker -- --config config/build.local.json --win --x64 --check
npm run build:docker -- --config config/build.local.json --win --x64
# 可追加 --portable 或 --dir
```

以 `electronuserland/builder:22-wine` 为基础添加 MinGW-w64，首次运行构建本机镜像 `hydro-proctor-builder:22-wine-wfp`。依赖、Electron、Wine 等缓存保存在 `.docker-cache/`，产物写入 `dist/`。只挂载临时源码副本、缓存及输出目录；公钥验证后通过环境变量传入，本地配置、PEM 文件和 `.env` 不复制到容器。

`PROCTOR_BUILDER_IMAGE` 可指定已包含 MinGW-w64 的自定义镜像，跳过镜像构建。Docker 入口仅支持 Windows x64，不转发宿主机代码签名凭据；macOS 使用 Mac 或 GitHub Actions 构建。

## 认证、退出与日志

每次启动先清空客户端登录 Cookie、HTTP 登录缓存、Service Worker 和 Cache Storage，要求重新登录；保留草稿、设备密钥及加密日志。登录变化立即撤销旧身份。同一上下文的并发认证合并处理，签名身份短暂缓存；每次读取与提交仍生成新的请求证明。

“退出 / 结束监考”提供两种操作：

- **保留日志退出**：保留开放的监考记录，不生成最终文件、不上传；原账号再次登录后继续续写和做题。
- **上传日志并结束监考**：关闭本次监考，生成最终加密文件并上传。窗口显示加密、上传百分比／字节数及服务端确认进度；收到有效回执才报告完成。断网时保留文件，联网后原账号登录补传，成绩待确认。

Windows 在上传前解除网络限制，恢复失败时仍尝试上传并显示警告；macOS 直接准备日志。两种退出操作均不会代交代码。成功结束后，原账号能否再次参加同场比赛由服务端决定；另一账号独立认证，不复用原账号令牌或日志。

用户数据目录为 Windows 的 `%APPDATA%\HydroProctorClient`、macOS 的 `~/Library/Application Support/HydroProctorClient`。实时日志以 AES-GCM 存入 `journals/`，密钥由 Windows DPAPI／macOS Keychain 保护；最终 `.hplog` 使用 OJ 日志公钥封装。不能保护密钥时拒绝启动，不回退明文。

异常退出后自动续写，记录客户端重启与异常事件；检测到系统启动标识变化时记录系统重启。损坏尾部保留备份，中段损坏拒绝续写。上传回执丢失时查询文件 SHA-256 确认。日志不包含代码正文、会话令牌或私钥，禁止通过删除本机数据解决认证、补传或更新问题。

### Windows 网络限制与恢复

普通监考使用 WFP 动态会话，临时放行允许的 IP／端口及必要的 DNS、DHCP、IPv6 邻居发现和本机通信，限制整机其他流量。不会枚举或停用用户原有防火墙规则，其他安全软件仍可能阻止 OJ 连接。

Windows 客户端会话直接连接 OJ，不继承系统 HTTP／SOCKS 代理，也不修改 Windows 的代理设置。WFP 地址来自客户端浏览器的 DNS 缓存及实际连接 IP，避免 CDN 地址与独立 DNS 查询不一致。启用过滤后会再次验证 OJ 的签名身份响应；连接失败则撤销本次策略，保留日志并提示重试。TUN／Fake-IP 代理属于系统路由或 DNS 设置，客户端直连不能替代关闭它们；考前应确认关闭这些模式后仍能访问 OJ。

OJ 页面加载失败时，原生提示框提供重试、返回首页和退出入口。连接或认证失败后浮窗不再显示“已认证”；重新验证成功后清除错误提示。头像源等外部资源需列入 `allowedOrigins` 才能加载。WebSocket 成功升级（HTTP 101）只记录信息日志。

正常退出撤销临时策略；原生辅助进程监测客户端退出和心跳，失联时退出，由系统清理动态规则。网络组件异常会撤销客户端认证，不能以未启用限制的状态继续考试。进度提示显示阶段、实际等待时间和参考耗时。

`unlock-firewall.ps1`、`restore-network.bat` 和旧策略恢复代码保留用于迁移旧版 `network-state.json`，不再用于启用监考限制。恢复失败时，以管理员身份运行随包 `scripts/restore-network.bat`，保留用户数据。

此前安装过 macOS 网络扩展版本时，安装新版完整包并在系统设置关闭／移除旧扩展；当前客户端不会激活它。

## ASAR 热更新

更新只比较递增的 `buildVersion`，格式为实际日期加两位序号 `YYYYMMDDNN`。`version` 仍用于 OJ 精确版本认证和 `minClientVersion` 校验；两者不能互相替代。

清单中的安装包地址不在 `updateOrigins` 时，客户端显示警告并禁用安装包下载，不影响同源清单和 ASAR 更新。清单、远端配置、ASAR 及其重定向仍必须通过白名单校验；修复安装包链接时应使用允许的下载域名。

先生成一组独立更新签名密钥，将公钥填入构建配置的 `updatePublicKeyFile`，并安装包含该公钥的完整客户端：

```bash
npm run keys:update -- --out-dir /path/outside-repo/update-keys
```

后续修改应用代码并增加 `buildVersion`，执行：

```bash
npm run release:hot -- --config config/build.local.json --sign-key /path/outside-repo/update-keys/update-private.pem
```

`--sign-key` 必须是对应的更新**私钥**，不能使用更新公钥或 OJ 的认证／日志私钥。产物为 `updates/app-<version>-<buildVersion>.asar` 及构建信息 JSON。将 ASAR 上传 OJ「更新设置」，填写一致的版本与构建编号；构建信息 JSON 不是完整的远端更新清单。未签名归档会被客户端拒绝。

同一份 JS／HTML ASAR 适用于 Windows 和 Mac；不包含 Electron 或 Windows WFP 辅助程序。更换 Electron、原生组件、密钥、白名单或调试权限时重新分发完整包。加载器验证签名、文件哈希、版本、构建编号及运行时兼容性，不覆盖原安装目录；新版本启动失败会回退。

存在未结束或待上传日志时，可查看更新状态，但需先上传并结束所有监考才能安装 ASAR 和重启。此检查包含其他账号的日志。浮窗显示阻止原因、当前版本、更新进度，并允许拖动和收起。

源码仓库的 `updates/` 是可重建产物，可以清理；安装包中的 `resources/app.asar` 和用户数据目录中的日志、更新缓存属于运行数据。完整包地址支持 `fullUpdate.platforms.<win32|darwin>.<x64|arm64>`；旧 `installerUrl` / `portableUrl` 只用于 Windows x64。

## root 调试与诊断

构建配置 `allowRootDebug=true` 且 OJ 签名确认具有 `PRIV_ALL` 权限时，才启用管理员调试：停止防作弊限制、解除 Windows 网络策略，并自动打开独立调试控制台。普通用户名 root、系统 root 或 Windows 管理员身份不能单独开启调试。Windows 启动权限要求及服务端认证、版本和日志规则仍适用。

控制台可筛选、复制诊断记录并打开开发工具。登录失效或换账号时关闭控制台并撤销调试权限。启用该构建选项后，每次启动在用户数据目录 `diagnostics/` 保存脱敏日志，时间使用本地时区偏移并保留 UTC 对照。诊断文件不作为考试证据上传，不记录 Cookie、令牌、私钥或请求体。

排查问题时检查 `startup.*`、`identity.verified`、`auth.session-accepted`、`auth.attempt-complete`、`request.authentication-failed`、`firewall.*` 和 `logs.upload-progress`。HTTP 200 不代表一定取得会话令牌；服务端可能返回“本场监考已结束”。

## 管理员解密日志

需要 Python 3.9+ 和 `cryptography`，使用 OJ 的 RSA 日志解密私钥：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r tools/requirements.txt
.venv/bin/python tools/decrypt-log.py downloaded.hplog --private-key /path/to/log-private.pem -o decrypted.log
```

Windows 使用 `py -m venv .venv`，后续以 `.venv/Scripts/python.exe` 执行。工具也接受后台导出的私钥 JSON；`--key-id` 可额外核对 keyId，`--password` 交互读取加密 PEM 的密码。输出为 UTF-8 JSON Lines `.log`，通过 RSA-OAEP／AES-GCM 完整性校验后生成；默认不覆盖已有文件。实时 `journal.enc` 不能作为输入。

## 验证

```bash
npm test
npm run test:native
python3 -m unittest discover -s tools/tests -v
```

原生测试需要 C++17 编译器，只检查 Windows endpoint 策略解析，不修改系统网络。`npm run build:native -- --win --x64` 可单独编译 WFP 辅助程序。Windows 实际网络限制与恢复、Mac 安装启动及 Keychain 行为仍需在对应系统验证；Node 测试不代替真机检查。
