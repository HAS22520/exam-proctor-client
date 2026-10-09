<#
.SYNOPSIS
  考试结束 - 恢复 Windows 系统级防火墙与全局网络
#>

Write-Host "正在解除考试网络锁定，恢复全局出站网络..." -ForegroundColor Yellow

# 1. 恢复防火墙出站默认规则为 Allow
Set-NetFirewallProfile -Profile Domain,Public,Private -DefaultOutboundAction Allow

# 2. 清理所有考试显式阻断与放行规则
Get-NetFirewallRule -DisplayName "EXAM_*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

# 3. 恢复可能被停止的代理后台服务
Start-Service -Name "clash-verge-service" -ErrorAction SilentlyContinue

# 4. 刷新 WinINet 网络缓存
$notifyScript = Join-Path $PSScriptRoot "notify-wininet.ps1"
if (Test-Path $notifyScript) {
    & $notifyScript
}

Write-Host "✅ 全局网络与防火墙已完全恢复正常！" -ForegroundColor Green
