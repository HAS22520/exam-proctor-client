# Exam Lockdown - Outbound Firewall Enforcement
# Target exam server IP and domain
$targetIps = @("115.159.24.121")
$targetDomain = "oj.hntou.fmcf.cc"

try {
    $resolved = [System.Net.Dns]::GetHostAddresses($targetDomain) | ForEach-Object { $_.IPAddressToString }
    if ($resolved) {
        # Filter out Clash/Mihomo fake-ip range (198.18.0.0/15)
        $realIps = $resolved | Where-Object { $_ -notmatch '^198\.(18|19)\.' }
        if ($realIps) {
            $targetIps = ($targetIps + $realIps) | Select-Object -Unique
        }
    }
} catch {}

Write-Host "[Firewall] Locking network, allowed target: $($targetIps -join ', ')..."

# 1. Clean existing exam rules
Get-NetFirewallRule -DisplayName "EXAM_*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

# 2. Stop VPN, Proxy, and TUN background services (e.g. clash_verge_service)
Get-Service | Where-Object {
    $_.Name -match 'clash|verge|mihomo|v2ray|sing|xray' -or
    $_.DisplayName -match 'clash|verge|mihomo|v2ray|sing|xray'
} | ForEach-Object {
    Write-Host "[Firewall] Stopping proxy service: $($_.Name)"
    Stop-Service -Name $_.Name -Force -ErrorAction SilentlyContinue
}

# 3. Disable virtual TUN/TAP network adapters (such as Mihomo, Meta Tunnel, TAP)
Get-NetAdapter | Where-Object {
    ($_.InterfaceDescription -match 'Tunnel|TAP|Wintun|VPN|Virtual') -or
    ($_.Name -match 'Mihomo|Clash|v2ray|sing-box')
} | ForEach-Object {
    Write-Host "[Firewall] Disabling virtual adapter: $($_.Name)"
    Disable-NetAdapter -Name $_.Name -Confirm:$false -ErrorAction SilentlyContinue
}

# 4. Disable IPv6 stack binding on all network adapters
Disable-NetAdapterBinding -Name * -ComponentId ms_tcpip6 -ErrorAction SilentlyContinue

# 5. Reset system proxy settings in registry
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -Name ProxyEnable -Value 0 -ErrorAction SilentlyContinue
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -Name ProxyServer -Value "" -ErrorAction SilentlyContinue
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -Name AutoConfigURL -Value "" -ErrorAction SilentlyContinue

# 6. Terminate communication apps (Weixin/WeChat/QQ), AI assistants, and proxy tools
$killList = @(
    "Weixin", "WeChat", "WeChatAppEx", "WeChatPlayer", "WXWork",
    "QQ", "QQEX", "QQProtect", "TIM",
    "DeepSeek", "DeepSeek Harness", "chatbox", "Kimi", "ChatGPT", "Claude",
    "DingTalk", "Feishu", "Telegram",
    "clash-verge", "clash_verge", "verge-mihomo", "clash", "v2rayN", "v2ray", "sing-box", "xray", "nekoray"
)
foreach ($proc in $killList) {
    Stop-Process -Name $proc -Force -ErrorAction SilentlyContinue
}

# 7. Add explicit ALLOW rules for essential exam traffic
# 7.1 Allow local loopback
New-NetFirewallRule -DisplayName "EXAM_ALLOW_LOOPBACK" -Direction Outbound -Action Allow -Protocol Any -RemoteAddress "127.0.0.1" -Description "Exam Lockdown: Allow IPC Loopback" | Out-Null

# 7.2 Allow DNS queries (UDP 53)
New-NetFirewallRule -DisplayName "EXAM_ALLOW_DNS" -Direction Outbound -Action Allow -Protocol UDP -RemotePort 53 -Description "Exam Lockdown: Allow DNS resolution" | Out-Null

# 7.3 Allow DHCP (UDP 67/68) to maintain local IP lease
New-NetFirewallRule -DisplayName "EXAM_ALLOW_DHCP" -Direction Outbound -Action Allow -Protocol UDP -RemotePort 67,68 -Description "Exam Lockdown: Allow DHCP" | Out-Null

# 7.4 Allow TCP traffic to the exam server
New-NetFirewallRule -DisplayName "EXAM_ALLOW_OJ_TCP" -Direction Outbound -Action Allow -Protocol TCP -RemoteAddress $targetIps -RemotePort 80,443 -Description "Exam Lockdown: Allow OJ Server" | Out-Null

# 8. Add explicit BLOCK rules (Explicit BLOCK takes priority over any third-party ALLOW rules)
# 8.1 Block all IPv6 traffic using valid CIDR ranges
New-NetFirewallRule -DisplayName "EXAM_BLOCK_IPV6" -Direction Outbound -Action Block -RemoteAddress @("0000::/1", "8000::/1") -Description "Exam Lockdown: Block all IPv6" | Out-Null

# 8.2 Block all IPv4 TCP ranges except the exam server IP (115.159.24.121)
New-NetFirewallRule -DisplayName "EXAM_BLOCK_TCP_BEFORE_OJ" -Direction Outbound -Action Block -Protocol TCP -RemoteAddress "0.0.0.0-115.159.24.120" -Description "Exam Lockdown: Block IPv4 before OJ IP" | Out-Null
New-NetFirewallRule -DisplayName "EXAM_BLOCK_TCP_AFTER_OJ" -Direction Outbound -Action Block -Protocol TCP -RemoteAddress "115.159.24.122-255.255.255.255" -Description "Exam Lockdown: Block IPv4 after OJ IP" | Out-Null

# 8.3 Block all other UDP ports (prevent UDP bypass such as QUIC, WeChat voice/video, game protocols)
New-NetFirewallRule -DisplayName "EXAM_BLOCK_UDP_1" -Direction Outbound -Action Block -Protocol UDP -RemotePort "1-52" -Description "Exam Lockdown: Block UDP 1-52" | Out-Null
New-NetFirewallRule -DisplayName "EXAM_BLOCK_UDP_2" -Direction Outbound -Action Block -Protocol UDP -RemotePort "54-66" -Description "Exam Lockdown: Block UDP 54-66" | Out-Null
New-NetFirewallRule -DisplayName "EXAM_BLOCK_UDP_3" -Direction Outbound -Action Block -Protocol UDP -RemotePort "69-65535" -Description "Exam Lockdown: Block UDP 69-65535" | Out-Null

# 9. Set Default Outbound Action to Block across all network profiles as baseline
Set-NetFirewallProfile -Profile Domain,Public,Private -DefaultOutboundAction Block

# 10. Flush local DNS cache so fake-ip entries and cached records are wiped
Clear-DnsClientCache -ErrorAction SilentlyContinue

Write-Host "[Firewall] Global network lockdown active successfully!"
