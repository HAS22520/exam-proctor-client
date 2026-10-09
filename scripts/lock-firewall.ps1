<#
.SYNOPSIS
  考试专用 - 底层物理级全局硬断网 (显式 BLOCK 规则覆盖所有已有白名单，仅放行考试系统)
#>

$targetIps = @("115.159.24.121")
$targetDomain = "oj.hntou.fmcf.cc"

try {
    $resolved = [System.Net.Dns]::GetHostAddresses($targetDomain) | ForEach-Object { $_.IPAddressToString }
    if ($resolved) {
        $targetIps = ($targetIps + $resolved) | Select-Object -Unique
    }
} catch {}

Write-Host "正在切断整机网络，仅保留考试系统白名单 IP: $($targetIps -join ', ')..." -ForegroundColor Yellow

# 1. 强制清理已有的考试规则
Get-NetFirewallRule -DisplayName "EXAM_*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

# 2. 强制关闭可能接管整机流量的代理服务与客户端
$killList = @(
    "clash-verge", "verge-mihomo", "clash", "v2rayN", "v2ray", "xray", "sing-box",
    "DeepSeek Harness", "DeepSeek", "QQ", "QQEX", "WeChat", "WeChatAppEx"
)
foreach ($proc in $killList) {
    Stop-Process -Name $proc -Force -ErrorAction SilentlyContinue
}

# 停止可能存在的后台 Windows 代理服务
Stop-Service -Name "clash-verge-service" -Force -ErrorAction SilentlyContinue

# 重置系统代理为关闭
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -Name ProxyEnable -Value 0 -ErrorAction SilentlyContinue

# 3. 添加显式 BLOCK 规则 (在 Windows 防火墙中，显式 BLOCK 规则的优先级绝对高于任何已有的 ALLOW 规则)

# 3.1 阻断 IPv6 全部外部流量
New-NetFirewallRule -DisplayName "EXAM_BLOCK_IPV6" `
    -Direction Outbound -Action Block -RemoteAddress "::/0" `
    -Description "考试模式：阻断全部 IPv6 出站" | Out-Null

# 3.2 阻断除考试 IP 之外的所有 TCP 流量 (涵盖 80/443 及所有应用 TCP 连接)
# 针对 115.159.24.121 进行前后 IP 段全闭环阻断
New-NetFirewallRule -DisplayName "EXAM_BLOCK_TCP_BEFORE_OJ" `
    -Direction Outbound -Action Block -Protocol TCP -RemoteAddress "0.0.0.0-115.159.24.120" `
    -Description "考试模式：阻断考试服务器 IP 之前的所有 IPv4" | Out-Null

New-NetFirewallRule -DisplayName "EXAM_BLOCK_TCP_AFTER_OJ" `
    -Direction Outbound -Action Block -Protocol TCP -RemoteAddress "115.159.24.122-255.255.255.255" `
    -Description "考试模式：阻断考试服务器 IP 之后的所有 IPv4" | Out-Null

# 3.3 阻断除 DNS (53) 和 DHCP (67/68) 之外的所有 UDP 流量 (阻断 QQ/微信/游戏底层的 UDP 协议通信)
New-NetFirewallRule -DisplayName "EXAM_BLOCK_UDP_RANGE1" `
    -Direction Outbound -Action Block -Protocol UDP -RemotePort "1-52" `
    -Description "考试模式：阻断 UDP 端口 1-52" | Out-Null

New-NetFirewallRule -DisplayName "EXAM_BLOCK_UDP_RANGE2" `
    -Direction Outbound -Action Block -Protocol UDP -RemotePort "54-66" `
    -Description "考试模式：阻断 UDP 端口 54-66" | Out-Null

New-NetFirewallRule -DisplayName "EXAM_BLOCK_UDP_RANGE3" `
    -Direction Outbound -Action Block -Protocol UDP -RemotePort "69-65535" `
    -Description "考试模式：阻断 UDP 端口 69-65535" | Out-Null

# 4. 放行本地回环
New-NetFirewallRule -DisplayName "EXAM_ALLOW_LOOPBACK" `
    -Direction Outbound -Action Allow -Protocol Any -RemoteAddress "127.0.0.1" `
    -Description "考试模式：放行本地进程通信" | Out-Null

# 5. 调整出站默认行为为 Block 作为保底
Set-NetFirewallProfile -Profile Domain,Public,Private -DefaultOutboundAction Block

Write-Host "✅ 显式防火墙硬断网已生效！整机除 115.159.24.121 以外所有 IP 与端口全部阻断。" -ForegroundColor Green
