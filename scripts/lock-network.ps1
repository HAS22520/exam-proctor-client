<#
.SYNOPSIS
  考试模式 - Windows 系统级防火墙强力网络白名单锁定脚本 (需要管理员权限运行)
.DESCRIPTION
  此脚本用于考场极端防作弊场景：
  1. 阻断系统所有出站 80/443 端口流量
  2. 动态解析 oj.hntou.fmcf.cc 的 IP，并仅对该 IP 放行
  3. 考完后务必运行 unlock-network.ps1 恢复网络！
#>

# 检查管理员权限
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Warning "请以管理员身份运行 PowerShell 执行此脚本！"
    exit 1
}

$targetDomain = "oj.hntou.fmcf.cc"
Write-Host "正在解析考试系统 IP: $targetDomain ..." -ForegroundColor Cyan

try {
    $ipAddresses = [System.Net.Dns]::GetHostAddresses($targetDomain) | ForEach-Object { $_.IPAddressToString }
} catch {
    Write-Error "解析域名失败，请确认当前网络正常！"
    exit 1
}

Write-Host "解析到考试系统 IP 列表: $($ipAddresses -join ', ')" -ForegroundColor Green

# 规则名称前缀
$rulePrefix = "EXAM_LOCKDOWN_"

# 1. 清理已有考试规则
Get-NetFirewallRule -DisplayName "$rulePrefix*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

# 2. 阻断全局出站 80/443 Web 访问
Write-Host "正在添加防火墙策略：阻断所有外网 Web 请求..." -ForegroundColor Yellow
New-NetFirewallRule -DisplayName "${rulePrefix}BLOCK_HTTP_HTTPS" `
    -Direction Outbound `
    -Action Block `
    -Protocol TCP `
    -RemotePort 80, 443 `
    -Description "监考客户端临时阻止全局 Web 访问" | Out-Null

# 3. 仅放行考试系统 IP
foreach ($ip in $ipAddresses) {
    Write-Host "正在添加白名单放行: $ip" -ForegroundColor Green
    New-NetFirewallRule -DisplayName "${rulePrefix}ALLOW_OJ_$ip" `
        -Direction Outbound `
        -Action Allow `
        -Protocol TCP `
        -RemoteAddress $ip `
        -RemotePort 80, 443 `
        -Description "监考客户端放行考试系统 IP" | Out-Null
}

Write-Host "✅ 系统级网络白名单已锁定！除 $targetDomain 外，本机其他网页均无法访问。" -ForegroundColor Green
Write-Host "如需解除限制，请运行 ./scripts/unlock-network.ps1" -ForegroundColor Yellow
