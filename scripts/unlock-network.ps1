<#
.SYNOPSIS
  解除考试模式 - 恢复 Windows 系统级防火墙 (需要管理员权限运行)
#>

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Warning "请以管理员身份运行 PowerShell 执行此脚本！"
    exit 1
}

$rulePrefix = "EXAM_LOCKDOWN_"
Write-Host "正在清除监考网络锁定规则..." -ForegroundColor Yellow

$rules = Get-NetFirewallRule -DisplayName "$rulePrefix*" -ErrorAction SilentlyContinue
if ($rules) {
    $rules | Remove-NetFirewallRule
    Write-Host "✅ 已成功清除所有监考防火墙规则，网络已恢复正常！" -ForegroundColor Green
} else {
    Write-Host "未发现处于生效状态的监考防火墙规则。" -ForegroundColor Cyan
}
