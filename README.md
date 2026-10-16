# HydroNext 监考客户端

Electron 客户端，使用 `HydroNext-proctor/1` 协议连接 OJ。支持 Windows x64 和 macOS 13+（Intel x64 / Apple Silicon arm64）。

| 平台 | 监考行为 | 运行权限 |
| --- | --- | --- |
| Windows | WFP 临时限制整机网络，记录加密日志 | 必须以管理员身份启动 |
| macOS | 只记录监考事件，不限制系统网络、不强制窗口置顶或终止进程 | 普通用户即可，无须网络扩展授权 |

两种平台均保留设备认证、版本校验、读取和提交证明、日志续写、上传及补传。macOS 客户端内部仍限制考试页面的导航与资源来源，保护认证桥的信任边界；其他应用的联网不受影响。

团队比赛采用全员独立监考：每位成员必须使用本人账号认证，并分别上传本人的最终日志。赛后全员日志齐全，全队成绩才有效。网页中的“结束全队比赛”仅队长可操作，会停止全员提交；它不会代替客户端的“结束个人监考”和日志上传。

进行中的监考比赛通过 `record_view` 读取证明保护本人及队友的记录详情、代码下载、代码回放和实时记录连接。客户端向 OJ 查询并验签记录实际所属比赛，按记录编号和完整请求路径生成独立证明；令牌不会放入 WebSocket URL。服务端与客户端需同步升级，旧客户端不能读取这些受保护资源。

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

在 **Actions → 构建 Hydro 监考客户端 → Run workflow** 填写软件名称 `product_name`、`version`、递增的 `build_version`、OJ 起始地址、考试及更新 origin JSON 数组、更新清单 URL 和 root 调试开关。软件名称填写完整名称，例如“计算机学院监考客户端”。选择构建类型：

- `installers`：生成 Windows x64 的安装版／便携 EXE，以及 macOS x64、arm64 的 DMG／ZIP，无须更新签名私钥。
- `asar`：只生成签名应用更新归档，必须配置两项更新密钥。
- `all`：同时生成安装包与 ASAR，密钥要求同 `asar`。

构建成功后，从运行页面的 **Artifacts** 下载对应平台、架构的 ZIP，解压取得安装包。Windows 使用原生 Windows runner；Mac 两种架构分别使用 Intel 和 Apple Silicon runner。本工作流只上传产物，不自动发布 Release 或上传 OJ。

工作流也运行 `npm run test:updates:electron`，在 Electron 的 Node 模式中验证 ASAR 下载、签名校验、缓存、清理与代码加载，不创建窗口。普通 Node 测试无法覆盖 Electron 把 ASAR 映射成虚拟目录的行为；更新包的文件操作使用 `original-fs`。

### macOS 安装与可选签名

没有 `MAC_CSC_LINK` 证书时，构建使用免费的 ad-hoc 签名并关闭公证，生成 DMG 不需要 Apple Developer 账号、Team ID 或 provisioning profile。

用户根据 Mac 芯片选择 `mac-x64` 或 `mac-arm64` 产物，打开 DMG，将应用拖入“应用程序”再启动。未公证的下载包可能被 Gatekeeper 阻止；确认来源可信后，在 **系统设置 → 隐私与安全性 → 仍要打开** 中允许启动，参见 [Apple 操作说明](https://support.apple.com/102445)。ad-hoc 签名不提供 Developer ID 身份认证。

若已有发行证书，可设置 `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`；公证再配置 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。Windows 签名使用 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`。这些均为可选项。

未设置的可选签名 Secret 会被 Actions 展开为空字符串，构建脚本会清除这些空值，避免把仓库目录误当成证书文件。打包提前退出或未生成安装包时，构建步骤会直接报告失败；`--dir` 不要求生成安装包。

## TypeScript 开发与编译

`app/`、`scripts/` 和 `tests/` 的源码均为 TypeScript。React 页面和 preload 使用 TypeScript `strict` 模式；应用和构建脚本禁止隐式 `any`；测试保留对部分 Electron API 的模拟，同时仍参与类型检查。源码目录仅保留 `.ts` / `.tsx` / `.mts`，不再生成旁边的 `.js`。编译产物统一写入被 Git 忽略的 `out/`，不要手动编辑或提交。

```bash
npm ci
npm run typecheck  # 检查应用、构建脚本和测试的类型，不生成文件
npm run compile    # 编译主进程，打包 React/preload，并生成各平台图标
npm test           # 自动先编译，再运行现有回归测试
npm run test:updates:electron  # 在 Electron Node 模式中测试 ASAR，不创建窗口
```

`npm start`、安装包构建、Docker 构建和 ASAR 发布命令都自动先编译，原有参数保持不变。直接使用 `node out/scripts/…js` 或 `electron .` 时，须先执行 `npm run compile`。GitHub Actions 也会检查类型，并通过相同 npm 命令编译。

每次编译先清空 `out/`，避免已经删除或移动的模块残留；只复制明确列出的公开资源，不复制本地配置、PEM 或旧的生成密钥。开发入口为 `out/app/main/bootstrap.js`，打包时以 `out/` 为应用根目录，保留安装包和 ASAR 内稳定的 `app/main/bootstrap.js` 与 `app/main/index.js` 入口。安装包和签名 ASAR 只包含编译后的应用代码与资源，不包含 TypeScript 源码、构建脚本或测试。Docker 暂存目录使用已编译代码，继续隔离父仓库依赖和本地密钥。原生 WFP 组件仍使用 C++，日志解密工具仍使用 Python。

源码结构：

- `app/main/`：仅保留生命周期入口、运行身份及数据目录策略；业务按 `proctor/`（认证及请求证明）、`audit/`（加密日志与设备身份）、`network/`（网络策略）、`updates/`（签名 ASAR）、`security/`、`diagnostics/` 和 `windows/` 分组。
- `app/renderer/`：React 内置界面，`pages/` 放页面，`components/` 放共享组件，`hooks/` 放订阅与拖动逻辑，`lib/` 放纯状态格式化函数，`entries/` 为打包入口，`styles/`、`assets/` 放样式和图标。远程 OJ 网页保持服务端原实现。
- `app/preload/`：按考试浮窗、上传、等待、调试和弹窗拆分的隔离 IPC 桥；远程 OJ 不会获得私有调试／更新桥。
- `app/types/`：配置、协议、日志、界面状态与弹窗类型；`app/main/contracts.ts` 仅重导出类型。
- `scripts/compile.mts`：Node.js 类型擦除入口，先用 TypeScript 检查并编译，再用 esbuild 将 React 和 preload 依赖打入 bundle；`scripts/project-layout.ts` 统一工程、Docker 与发布文件规则。
- `scripts/generate-icons.mts`：从 `app/renderer/assets/icon.svg` 生成 PNG、多尺寸 ICO 和 ICNS；无需额外图标制作工具。图案沿用 Hydro 的蓝色与水流意象，加入 H 与监考盾形。
- `config/installer.nsh`：Windows 安装完成页及保留监考数据的卸载规则。
- `tests/`：TypeScript 回归测试。React 静态渲染、IPC 模拟和状态测试均不启动浏览器，不进行 Playwright 等 UI 验收。

Windows 提示框统一使用无系统标题栏的本地 React 窗口，操作通过页面按钮完成，包括管理员权限提示、退出选择、认证／页面错误和更新重启确认。打开弹窗前解除主窗口抢焦点行为，关闭或取消后按考试状态恢复；macOS 仍可使用系统提示框。所有本地页面限制导航、网络访问和 IPC 来源，React 不包含 Node 权限。

结束监考弹窗在两个平台均使用 React；按 Esc 或通过系统快捷键关闭时等同于“继续监考”，不上传日志、不结束考试：“继续监考”和“上传日志并结束监考”并排显示为同级主要按钮；“保留日志退出”在下方显示为次要操作，并说明下次可以继续监考。

## 本地构建

需要 Node.js 22.12+。在本客户端目录复制 `config/build.example.json` 为 `config/build.local.json`，按照 `_comments` 填写各项；注释字段不会进入安装包。公钥路径相对于配置文件，文件应放在仓库外。本地配置已被 Git 忽略，`.env` 不会自动加载。

通过 `productName` 设置完整软件名称，例如：

```json
{
  "productName": "计算机学院监考客户端"
}
```

将这一项加入包含公钥等配置的本地构建文件。名称须以“监考客户端”结尾、长度不超过 60 个字符，且不包含文件名特殊字符或换行；未设置时默认“在线监考客户端”。名称用于窗口、内置页面、Windows 程序及安装向导、快捷方式和 macOS 应用。更名需要重新分发完整安装包；内部应用标识和数据目录保持稳定，保留设备身份及未上传日志。

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

Windows 安装向导允许选择安装目录。如果本机已经安装客户端，会先提示卸载，并打开新安装包内置的可见卸载向导，针对原安装目录完成卸载后再安装。此时安装器暂时隐藏，卸载向导关闭后恢复；取消卸载、卸载失败或原安装目录无效时会停止安装。即使原卸载器默认静默或已经丢失，也可以通过此向导卸载。检测到已有全用户安装时，需要以管理员身份运行安装包。已有安装不支持 `/S` 静默重装，以免绕过卸载引导。

安装完成后需点击“完成”，不会自动运行软件。随后到桌面右键监考客户端，选择“以管理员身份运行”；普通权限启动会显示 React 提示并要求关闭重开。安装包更新和卸载保留 `data/`，以免丢失尚未上传的证据；移动安装位置时应同时搬迁整个 `data/`，不要删除它来修复认证问题。

输出位于 `dist/`。`--check` 只验证并生成配置；`--dir` 生成解包目录；`--help` 查看参数。`npm run dist` 与 `build` 等价，`npm run pack` 生成解包目录，`npm start` 用于开发。`package.json` 的 npm 声明和空 `workspaces` 用于隔离 Hydro 父仓库的依赖扫描，应保留。

环境变量优先于 JSON 配置，可用于 CI：

| 环境变量 | 对应内容 |
| --- | --- |
| `PROCTOR_PRODUCT_NAME` | 完整软件名称，如“计算机学院监考客户端” |
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

需要 Docker daemon 访问权限，并先在宿主机安装本客户端的 TypeScript 构建依赖；无需宿主机 Wine 或 MinGW：

```bash
npm ci
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

运行数据统一放在用户选择的安装位置：

- Windows 安装版：`<安装目录>\data`；便携版：原始便携 EXE 所在目录的 `data`，不放在临时解包目录。
- macOS：`.app` 同级的 `在线监考客户端.data`，展示名称更改后仍使用这一固定目录。数据不写进 `.app`，以保留签名完整性；推荐将应用复制到 `~/Applications` 或其他可写安装位置后启动，不能直接在只读 DMG 内运行。
- 开发环境：客户端工程内被忽略的 `.proctor-data/`。

设备身份、监考日志、更新缓存和诊断记录位于上述目录的 `state/` 内；Chromium 会话／缓存位于 `browser/`，临时文件和崩溃记录位于同级的 `temp/`、`crashes/` 等子目录。目录不可写时明确提示并停止，不回退到 AppData。首次启动新版完整安装包时，从旧 Windows `%APPDATA%\HydroProctorClient` 或 macOS `~/Library/Application Support/HydroProctorClient` 复制设备密钥、日志、配置与更新缓存，并迁移考试页面 Local Storage／IndexedDB 中的草稿（不迁移登录 Cookie）；所有 Electron 路径都在进入 `ready` 前设置，迁移在创建考试 session 前完成。迁移先在同磁盘暂存整个持久状态，再通过单次原子重命名发布；原数据保留，迁移失败或异常退出不会混用半份身份。已有独立设备数据的安装位置不会合并旧身份。

实时日志以 AES-GCM 存入 `journals/`，密钥由 Windows DPAPI／macOS Keychain 保护；最终 `.hplog` 使用 OJ 日志公钥封装。不能保护密钥时拒绝启动，不回退明文。

异常退出后自动续写，记录客户端重启与异常事件；检测到系统启动标识变化时记录系统重启。损坏尾部保留备份，中段损坏拒绝续写。上传回执丢失时查询文件 SHA-256 确认。日志不包含代码正文、会话令牌或私钥，禁止通过删除本机数据解决认证、补传或更新问题。

### Windows 网络限制与恢复

普通监考使用 WFP 动态会话，临时放行允许的 IP／端口及必要的 DNS、DHCP、IPv6 邻居发现和本机通信，限制整机其他流量。不会枚举或停用用户原有防火墙规则，其他安全软件仍可能阻止 OJ 连接。

Windows 客户端会话直接连接 OJ，不继承系统 HTTP／SOCKS 代理，也不修改 Windows 的代理设置。WFP 地址来自客户端浏览器的 DNS 缓存及实际连接 IP，避免 CDN 地址与独立 DNS 查询不一致。启用过滤后会再次验证 OJ 的签名身份响应；连接失败则撤销本次策略，保留日志并提示重试。TUN／Fake-IP 代理属于系统路由或 DNS 设置，客户端直连不能替代关闭它们；考前应确认关闭这些模式后仍能访问 OJ。

OJ 页面加载失败时，提示框提供重试、返回首页和退出入口。连接或认证失败后浮窗不再显示“已认证”；重新验证成功后清除错误提示。头像源等外部资源需列入 `allowedOrigins` 才能加载。WebSocket 成功升级（HTTP 101）只记录信息日志。

正常退出撤销临时策略；原生辅助进程监测客户端退出和心跳，失联时退出，由系统清理动态规则。网络组件异常会撤销客户端认证，不能以未启用限制的状态继续考试。进度提示显示阶段、实际等待时间和参考耗时。

客户端不包含 PowerShell 防火墙脚本或旧版快照恢复逻辑；Windows 网络限制与恢复均由原生 WFP 辅助进程完成。

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

同一份 JS／HTML ASAR 适用于 Windows 和 Mac；不包含 Electron 或 Windows WFP 辅助程序。更换 Electron、原生组件、软件名称、密钥、白名单、调试权限、安装器、系统图标或启动加载器／数据目录策略时重新分发完整包。本次 React 迁移后的首次部署应使用完整安装包，后续页面与业务代码仍可通过签名 ASAR 更新。加载器验证签名、文件哈希、版本、构建编号及运行时兼容性，不覆盖原安装目录；新版本启动失败会回退。

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


## Windows 监考保护与原生组件更新

正式考试窗口固定禁用开发者工具，并在主进程阻断相关快捷键；正常复制、粘贴和编辑器右键不受影响。有效的签名 root 身份可以在独立管理员窗口中打开页面开发工具，退出登录或权限失效后窗口立即销毁。考试窗口失焦时延迟恢复前台，客户端弹窗、上传窗口和退出流程会暂停焦点保护。

Windows 考试分区使用客户端内部的受控 HTTP/CONNECT 转发器，只转发编译白名单中的完整来源。HTTPS 和 WSS 原样传输，仍由浏览器检查服务端证书。解析器只查询白名单域名的 A/AAAA 记录，固定启动时的系统 DNS 上游，按 TTL 缓存；`localhost` 直接解析为回环地址。此机制不更改系统 DNS、代理或证书配置；管理员 root 调试时考试分区恢复直连，身份失效后重新启用受控转发。

WFP 默认阻断其他程序的连接。DNS 只允许客户端到明确的上游地址、端口；回环只允许白名单本地服务及内部转发端口。CDN 地址变化时，通过同一动态会话的事务替换规则，没有临时解除限制的空隙。DNS 或新地址连接失败不会扩大白名单，请检查网络后重试；监考日志继续保留。网络组件退出后动态策略自动释放，并撤销客户端当前认证。

进程扫描由独立常驻 `hydro-audit.exe` 执行，不再反复启动 `tasklist.exe`。扫描结果包含路径、创建时间、SHA-256、经过验证的签名及原始文件名；哈希与签名按文件修改时间和大小缓存。已签名工具的原始文件名，以及配置或本次运行中已识别的文件哈希，可以识别部分重命名工具。无签名、未知进程和无法读取的系统进程不会自动判定作弊。`antiCheat.processBlacklistHashes` 可配置已确认禁止工具的 SHA-256 数组；`terminateBlacklisted` 默认仍为 `false`，显式开启后终止操作会校验 PID 创建时间，避免误杀复用该 PID 的进程。

这次修改将原生组件兼容编号升级为 **2**，必须先安装新版完整 Windows 安装包，不能通过 ASAR 安装新的原生组件。之后同为编号 2 的签名 ASAR 更新继续使用原有流程。Windows 构建会同时输出并打包 `hydro-network.exe` 和 `hydro-audit.exe`，本地 Docker 与 GitHub Actions 共用构建脚本。macOS 继续只记录日志，不执行 WFP 网络限制、焦点恢复或进程终止。
