<#
.SYNOPSIS
  考试专用 - 全局硬切断网络 (仅放行考试系统)
#>

$targetDomain = "oj.hntou.fmcf.cc"
$targetIps = @("115.159.24.121")

# 尝试解析当前域名真实 IP
try {
    $resolved = [System.Net.Dns]::GetHostAddresses($targetDomain) | ForEach-Object { $_.IPAddressToString }
    if ($resolved) {
        $targetIps = ($targetIps + $resolved) | Select-Object -Unique
    }
} catch {}

Write-Host "正在切断整机网络，仅保留考试系统白名单 IP: $($targetIps -join ', ')..." -ForegroundColor Yellow

# 1. 尝试结束可能存在的代理劫持进程 (如 Clash / TUN)
$proxyProcesses = @("clash-verge", "verge-mihomo", "clash", "v2ray", "xray", "sing-box")
foreach ($proc in $proxyProcesses) {
    Stop-Process -Name $proc -Force -ErrorAction SilentlyContinue
}

# 2. 重置系统代理设置
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -Name ProxyEnable -Value 0 -ErrorAction SilentlyContinue

# 3. 清理已有的考试放行规则
Get-NetFirewallRule -DisplayName "EXAM_ALLOW_*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

# 4. 创建白名单放行规则
# 4.1 放行 DNS (53 端口，用于域名解析)
New-NetFirewallRule -DisplayName "EXAM_ALLOW_DNS" `
    -Direction Outbound -Action Allow -Protocol UDP -RemotePort 53 `
    -Description "考试模式：放行 DNS 解析" | Out-Null
New-NetFirewallRule -DisplayName "EXAM_ALLOW_DNS_TCP" `
    -Direction Outbound -Action Allow -Protocol TCP -RemotePort 53 `
    -Description "考试模式：放行 DNS 解析 (TCP)" | Out-Null

# 4.2 放行 DHCP 与本地回环 (67/68 端口，维持本地网卡正常连接)
New-NetFirewallRule -DisplayName "EXAM_ALLOW_DHCP" `
    -Direction Outbound -Action Allow -Protocol UDP -LocalPort 68 -RemotePort 67 `
    -Description "考试模式：维持本地网关地址" | Out-Null
New-NetFirewallRule -DisplayName "EXAM_ALLOW_LOOPBACK" `
    -Direction Outbound -Action Allow -Protocol Any -RemoteAddress "127.0.0.1" `
    -Description "考试模式：放行本地 IPC 通信" | Out-Null

# 4.3 仅放行考试系统 IP (80, 443 端口)
foreach ($ip in $targetIps) {
    New-NetFirewallRule -DisplayName "EXAM_ALLOW_OJ_$ip" `
        -Direction Outbound -Action Allow -Protocol TCP -RemoteAddress $ip -RemotePort 80, 443 `
        -Description "考试模式：仅放行考试平台服务器" | Out-Null
}

# 5. 将 Windows 防火墙出站默认规则设为 Block (强力切断整台电脑其他所有出站连接)
Set-NetFirewallProfile -Profile Domain,Public,Private -DefaultOutboundAction Block

Write-Host "✅ 全局网络阻断已生效！整台电脑其他所有软件与网站均已断网，仅考试平台可访问。" -ForegroundColor Green
