# 在线考试专用监考客户端 (Exam Proctor Client)

专为在线判题/评测系统（OJ）定制的安全考试客户端，提供全屏防切屏、**Windows 底层全局硬断网保护（仅保留考试网站访问权限）**、全维度违规访问实时审计日志。

---

## 🎯 核心功能与架构

1. **底层物理级全局断网 (Global Network Hard Cutoff)**
   - **Windows 高级安全防火墙策略**：客户端启动后，自动将整机出站规则设为全局阻断（`DefaultOutboundAction Block`），**瞬间掐断当前电脑所有外部 Web 与应用流量**；
   - **白名单精准放行**：唯一放行考试服务器真实目标 IP（`115.159.24.121`）及基础 DNS 解析端口；
   - **穿透免疫**：无论电脑后台是否开着 Clash、VPN、第三方浏览器或代理软件，由于在 Windows 过滤平台底层直接生效，均无法绕过断网限制。

2. **零录屏负担 (Zero Overhead)**
   - 已彻底移除录屏模块与 80MB 的 FFmpeg 依赖，软件启动轻量飞快，不占用任何 CPU、显卡与磁盘存储空间。

3. **违规访问审计日志与存证 (Audit Logger)**
   - 任何试图访问外部网站、新标签页弹窗、切屏失焦行为均实时毫秒级写入 `records/exam_audit_*.log` 与 `.json` 文件。

4. **安全闭环与一键恢复**
   - 界面右上角配备常驻悬浮栏与 **【交卷退出】** 按钮；
   - 正常交卷退出时，自动撤销防火墙规则，整机秒级恢复正常网络；
   - 配备有 [restore-network.bat](file:///d:/监考/scripts/restore-network.bat) 应急脚本，任何异常断电情况下右键管理员运行即可 1 秒复原整机网络。

---

## 📁 目录结构

```
d:\监考\
├── app/                  # 客户端主程序源码
│   ├── main/             # 主进程
│   │   ├── index.js             # 应用主入口与窗口生命周期
│   │   ├── firewall-guard.js    # Windows 底层全局防火墙硬断网守护模块
│   │   ├── system-proxy-guard.js# 本地白名单代理网关 (第二层防御)
│   │   ├── network-guard.js     # 客户端内部白名单拦截器
│   │   ├── audit-logger.js      # 违规访问实时审计落盘日志
│   │   └── anti-cheat.js        # 防作弊看门狗 (切屏失焦/黑名单进程扫描)
│   ├── preload/          # 预加载脚本 (安全 IPC 桥接与右上角悬浮工具栏)
│   │   └── preload.js
├── config/               # 配置文件
│   └── exam-config.json  # 考试配置 (白名单域名、OJ网址等)
├── records/              # 违规审计日志输出目录
├── scripts/              # 运维与防作弊辅助脚本
│   ├── lock-firewall.ps1    # 底层全局硬断网 PowerShell 脚本
│   ├── unlock-firewall.ps1  # 恢复全局网络 PowerShell 脚本
│   ├── notify-wininet.ps1   # 强刷网络缓存脚本
│   └── restore-network.bat  # 应急一键恢复脚本 (备用)
├── package.json          # Node 依赖与打包配置
└── README.md             # 本项目文档
```

---

## 🚀 启动与使用

### 方式一：开发调试运行
```bash
npm start
```

### 方式二：生成独立免安装 EXE
```bash
npm run dist
```
会在 `dist/` 目录下生成带有管理员提权清单的独立免安装可执行程序 `在线监考客户端 1.0.0.exe`，直接双击即可运行。
