# 在线考试专用监考客户端 (Exam Proctor Client)

专为在线判题/评测系统（OJ）定制的安全考试客户端，提供全屏防切屏、全电脑网络严格白名单锁定、屏幕录制存证功能。

---

## 🎯 核心功能设计

1. **自动屏幕录制 (Screen Recording Engine)**
   - 客户端启动时自动在后台启动录制，静默录制当前屏幕。
   - 考试交卷退出时安全收尾，输出 MP4 文件至 `records/` 目录。
   - 基于 FFmpeg 桌面采集，保障超低 CPU 占用与流畅度。

2. **严格网络白名单模式 (Network Whitelist Shield)**
   - **整机全局白名单锁定**：客户端启动后，自动开启 Windows 系统级网络代理网关（127.0.0.1:18899），对当前电脑发起的所有 HTTP/HTTPS 连接进行域名过滤。**除考试网站（`https://oj.hntou.fmcf.cc/`）外，整台电脑所有其他网站均被直接阻断（返回 403 / 阻断连接）**。
   - **客户端内部防御**：深度拦截 `will-navigate`、`will-redirect`、`webRequest` 和外部弹窗，任何试图跳转或嵌入外部非白名单域名的行为均被拦截。
   - **自动安全还原**：交卷退出客户端时，系统自动切回正常网络；即使意外崩溃或强退，也可随时双击运行 `scripts/restore-network.bat` 一键复原网络。

3. **防作弊全屏锁屏与看门狗 (Anti-Cheat & Kiosk Guard)**
   - **Kiosk 独占模式**：全屏置顶，隐藏菜单栏与原生窗口控制按钮。
   - **切屏监测**：窗口失焦（Blur）行为监控与计数存证。
   - **多显示器排查**：检测到双屏/多屏时发出警告。
   - **后台黑名单扫描**：定期排查微信、QQ、浏览器、远程控制软件等进程。

---

## 📁 目录结构

```
d:\监考\
├── app/                  # 客户端主程序源码
│   ├── main/             # 主进程
│   │   ├── index.js             # 应用主入口与窗口生命周期
│   │   ├── system-proxy-guard.js# 整机系统级白名单代理看门狗
│   │   ├── network-guard.js     # 客户端内部白名单拦截器
│   │   ├── screen-recorder.js   # 屏幕录制管理器 (FFmpeg 驱动)
│   │   └── anti-cheat.js        # 防作弊看门狗 (切屏/黑名单进程/多屏)
│   ├── preload/          # 预加载脚本 (安全 IPC 桥接)
│   │   └── preload.js
│   └── renderer/         # 渲染层 (UI组件、监考浮层提示)
├── bin/                  # 第三方二进制工具 (ffmpeg.exe)
├── config/               # 配置文件
│   └── exam-config.json  # 考试配置 (白名单、OJ网址、防作弊参数等)
├── records/              # 录屏存证输出目录
├── scripts/              # 运维与防作弊辅助脚本
│   ├── restore-network.bat # 网络紧急一键复原脚本 (备用)
│   ├── lock-network.ps1    # (可选) 系统级防火墙强力阻断脚本
│   └── unlock-network.ps1  # (可选) 恢复系统防火墙规则
├── package.json          # Node 依赖描述
└── README.md             # 本项目文档
```

---

## 🚀 启动与使用

在根目录下打开命令行终端执行：
```bash
npm start
```

- **启动时**：
  1. 自动启动整机白名单网络锁定，阻断当前电脑访问任何外部网站；
  2. 自动启动静默录屏；
  3. 全屏 Kiosk 独占加载 `https://oj.hntou.fmcf.cc/`。
- **退出时**：
  点击退出并确认交卷后，自动保存录屏 MP4，并**自动恢复电脑正常上网功能**。
