param([Parameter(Mandatory=$true)][string]$StatePath,
      [Parameter(Mandatory=$true)][string]$PolicyPath,
      [Parameter(Mandatory=$true)][int]$ClientProcessId)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $StatePath) { throw 'Restore the previous exam policy first.' }
$policy = Get-Content -LiteralPath $PolicyPath -Raw | ConvertFrom-Json
$targets = @()
foreach ($origin in $policy.origins) {
    $uri = [Uri]$origin
    $ips = [System.Net.Dns]::GetHostAddresses($uri.Host)
    foreach ($ip in $ips) { $targets += @{ ip = $ip.IPAddressToString; port = $uri.Port } }
}
if ($targets.Count -eq 0) { throw 'No exam destinations resolved.' }
$profiles = @(Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultOutboundAction)
if (@($profiles | Where-Object { -not $_.Enabled }).Count -gt 0) { throw 'Windows Firewall must be enabled before the exam.' }
$rules = @(Get-NetFirewallRule -Direction Outbound -Enabled True -Action Allow | Where-Object { $_.PolicyStoreSourceType -eq 'Local' } | Select-Object -ExpandProperty Name)
$state = @{ group = $policy.group; profiles = $profiles; rules = $rules }
[IO.File]::WriteAllText("$StatePath.tmp", ($state | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath "$StatePath.tmp" -Destination $StatePath -Force
# A separate elevated process restores policy even if Electron is force-killed.
$watch = Join-Path $PSScriptRoot 'watch-network.ps1'
$argsText = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watch`" -StatePath `"$StatePath`" -ClientProcessId $ClientProcessId -PolicyProcessId $PID"
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList $argsText | Out-Null
try {
    foreach ($name in $rules) { Disable-NetFirewallRule -Name $name }
    New-NetFirewallRule -DisplayName "$($policy.group)-DNS-UDP" -Group $policy.group -Direction Outbound -Action Allow -Protocol UDP -RemotePort 53 | Out-Null
    New-NetFirewallRule -DisplayName "$($policy.group)-DNS-TCP" -Group $policy.group -Direction Outbound -Action Allow -Protocol TCP -RemotePort 53 | Out-Null
    New-NetFirewallRule -DisplayName "$($policy.group)-DHCP" -Group $policy.group -Direction Outbound -Action Allow -Protocol UDP -LocalPort 68 -RemotePort 67 | Out-Null
    New-NetFirewallRule -DisplayName "$($policy.group)-Loopback" -Group $policy.group -Direction Outbound -Action Allow -RemoteAddress @('127.0.0.1','::1') | Out-Null
    $index = 0
    foreach ($target in $targets) {
        New-NetFirewallRule -DisplayName "$($policy.group)-OJ-$index" -Group $policy.group -Direction Outbound -Action Allow -Protocol TCP -RemoteAddress $target.ip -RemotePort $target.port | Out-Null
        $index++
    }
    Set-NetFirewallProfile -Profile Domain,Public,Private -DefaultOutboundAction Block
} catch {
    & (Join-Path $PSScriptRoot 'unlock-firewall.ps1') -StatePath $StatePath
    throw
}
