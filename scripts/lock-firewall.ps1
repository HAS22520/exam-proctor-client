param([Parameter(Mandatory=$true)][string]$StatePath,
      [Parameter(Mandatory=$true)][string]$PolicyPath,
      [Parameter(Mandatory=$true)][int]$ClientProcessId)
$ErrorActionPreference = 'Stop'
function Report-Stage([string]$Stage) {
    [IO.File]::WriteAllText("$StatePath.progress.json", (@{ stage = $Stage } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
$mutex = [Threading.Mutex]::new($false, 'Global\HydroProctorNetworkRecovery')
$acquired = $false
$saved = $false
try {
    try { $acquired = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'Network policy is busy.' }
    if (Test-Path -LiteralPath $StatePath) { throw 'Restore the previous exam policy first.' }
    $policy = Get-Content -LiteralPath $PolicyPath -Raw | ConvertFrom-Json
    if (Test-Path -LiteralPath "$PolicyPath.cancel") { throw 'Network policy application was cancelled.' }
    if (Test-Path -LiteralPath "$StatePath.restore-request.json") {
        $cancel = Get-Content -LiteralPath "$StatePath.restore-request.json" -Raw | ConvertFrom-Json
        if ($cancel.group -eq $policy.group) { throw 'Network policy application was cancelled.' }
    }
    Report-Stage 'resolve-destinations'
    $targets = @{}
    foreach ($origin in $policy.origins) {
        $uri = [Uri]$origin
        foreach ($ip in [System.Net.Dns]::GetHostAddresses($uri.Host)) {
            $targets["$($ip.IPAddressToString):$($uri.Port)"] = @{ ip = $ip.IPAddressToString; port = $uri.Port }
        }
    }
    if ($targets.Count -eq 0) { throw 'No exam destinations resolved.' }
    Report-Stage 'snapshot-policy'
    $profiles = @(Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultOutboundAction)
    if (@($profiles | Where-Object { -not $_.Enabled }).Count -gt 0) { throw 'Windows Firewall must be enabled before the exam.' }
    $rules = @(Get-NetFirewallRule -PolicyStore PersistentStore -Direction Outbound -Enabled True -Action Allow | Select-Object -ExpandProperty Name)
    if (Test-Path -LiteralPath "$PolicyPath.cancel") { throw 'Network policy application was cancelled.' }
    $state = @{ group = $policy.group; profiles = $profiles; rules = $rules; watchdogProtocol = 1 }
    [IO.File]::WriteAllText("$StatePath.tmp", ($state | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath "$StatePath.tmp" -Destination $StatePath -Force
    $saved = $true
    # The elevated watchdog accepts a restore request without another UAC dialog.
    $watch = Join-Path $PSScriptRoot 'watch-network.ps1'
    $watchArgs = @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',"`"$watch`"",
        '-StatePath',"`"$StatePath`"",'-ClientProcessId',$ClientProcessId,'-PolicyProcessId',$PID)
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList $watchArgs | Out-Null
    Report-Stage 'disable-original-rules'
    if ($rules.Count -gt 0) { Disable-NetFirewallRule -PolicyStore PersistentStore -Name $rules | Out-Null }
    Report-Stage 'allow-exam-network'
    New-NetFirewallRule -DisplayName "$($policy.group)-DNS-UDP" -Group $policy.group -Direction Outbound -Action Allow -Protocol UDP -RemotePort 53 | Out-Null
    New-NetFirewallRule -DisplayName "$($policy.group)-DNS-TCP" -Group $policy.group -Direction Outbound -Action Allow -Protocol TCP -RemotePort 53 | Out-Null
    New-NetFirewallRule -DisplayName "$($policy.group)-DHCP" -Group $policy.group -Direction Outbound -Action Allow -Protocol UDP -LocalPort 68 -RemotePort 67 | Out-Null
    New-NetFirewallRule -DisplayName "$($policy.group)-Loopback" -Group $policy.group -Direction Outbound -Action Allow -RemoteAddress @('127.0.0.1','::1') | Out-Null
    $index = 0
    foreach ($target in $targets.Values) {
        New-NetFirewallRule -DisplayName "$($policy.group)-OJ-$index" -Group $policy.group -Direction Outbound -Action Allow -Protocol TCP -RemoteAddress $target.ip -RemotePort $target.port | Out-Null
        $index++
    }
    Report-Stage 'apply-outbound-policy'
    Set-NetFirewallProfile -Profile Domain,Public,Private -DefaultOutboundAction Block
    Report-Stage 'locked'
} catch {
    if ($saved -and (Test-Path -LiteralPath $StatePath)) { & (Join-Path $PSScriptRoot 'unlock-firewall.ps1') -StatePath $StatePath }
    throw
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
