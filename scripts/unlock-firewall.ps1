# Exam Recovery - Restore Windows Firewall and Global Network
Write-Host "[Firewall] Restoring global network and firewall..." -ForegroundColor Yellow

# 1. Restore firewall default outbound action to Allow
Set-NetFirewallProfile -Profile Domain,Public,Private -DefaultOutboundAction Allow

# 2. Remove all exam explicit block and allow rules
Get-NetFirewallRule -DisplayName "EXAM_*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

# 3. Re-enable IPv6 stack binding
Enable-NetAdapterBinding -Name * -ComponentId ms_tcpip6 -ErrorAction SilentlyContinue

# 4. Re-enable any disabled virtual network adapters
Get-NetAdapter | Where-Object {
    ($_.InterfaceDescription -match 'Tunnel|TAP|Wintun|VPN|Virtual') -or
    ($_.Name -match 'Mihomo|Clash|v2ray|sing-box')
} | ForEach-Object {
    Write-Host "[Firewall] Re-enabling adapter: $($_.Name)"
    Enable-NetAdapter -Name $_.Name -Confirm:$false -ErrorAction SilentlyContinue
}

# 5. Restart proxy background services if installed
Get-Service | Where-Object { $_.Name -match 'clash|verge' } | ForEach-Object {
    Write-Host "[Firewall] Restarting service: $($_.Name)"
    Start-Service -Name $_.Name -ErrorAction SilentlyContinue
}

# 6. Flush DNS cache
Clear-DnsClientCache -ErrorAction SilentlyContinue

# 7. Refresh WinINet settings if helper script exists
$notifyScript = Join-Path $PSScriptRoot "notify-wininet.ps1"
if (Test-Path $notifyScript) {
    & $notifyScript
}

Write-Host "[Firewall] Global network and firewall fully restored!" -ForegroundColor Green
