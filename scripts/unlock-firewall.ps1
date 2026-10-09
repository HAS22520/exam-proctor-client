<#
.SYNOPSIS
  考试结束 - 恢复 Windows 系统级防火墙与全局网络
#>

Write-Host "正在解除考试网络锁定，恢复全局出站网络..." -ForegroundColor Yellow

# 1. 恢复防火墙出站默认规则为 Allow
Set-NetFirewallProfile -Profile Domain,Public,Private -DefaultOutboundAction Allow

# 2. 清理所有考试临时规则
Get-NetFirewallRule -DisplayName "EXAM_ALLOW_*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName "EXAM_LOCKDOWN_*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

# 3. 刷新 WinINet 网络缓存
$notifyScript = Join-Path $PSScriptRoot "notify-wininet.ps1"
if (Test-Path $notifyScript) {
    & $notifyScript
}

Write-Host "✅ 全局网络已完全恢复正常！" -ForegroundColor Green
