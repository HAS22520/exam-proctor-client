param([Parameter(Mandatory=$true)][string]$StatePath,
      [string]$ExpectedGroup = '')
$ErrorActionPreference = 'Stop'
function Report-Stage([string]$Stage) {
    [IO.File]::WriteAllText("$StatePath.progress.json", (@{ stage = $Stage } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
$mutex = [Threading.Mutex]::new($false, 'Global\HydroProctorNetworkRecovery')
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'Network recovery is busy.' }
    if (-not (Test-Path -LiteralPath $StatePath)) { return }
    $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    if ($ExpectedGroup -and $state.group -ne $ExpectedGroup) { return }
    if ($state.group -notmatch '^HydroProctor-[a-f0-9-]+$') { throw 'Invalid saved firewall group.' }
    # Restore outbound defaults first, so connectivity returns promptly even on a
    # machine with many disabled rules. Keep the snapshot until every step succeeds.
    Report-Stage 'restore-outbound-policy'
    foreach ($profile in $state.profiles) {
        Set-NetFirewallProfile -Name $profile.Name -DefaultOutboundAction $profile.DefaultOutboundAction
    }
    Report-Stage 'restore-original-rules'
    $names = @{}
    foreach ($name in $state.rules) { $names[$name] = $true }
    $existing = @(Get-NetFirewallRule -PolicyStore PersistentStore -Direction Outbound | Where-Object { $names.ContainsKey($_.Name) } | Select-Object -ExpandProperty Name)
    if ($existing.Count -gt 0) { Enable-NetFirewallRule -PolicyStore PersistentStore -Name $existing | Out-Null }
    Report-Stage 'remove-exam-rules'
    Get-NetFirewallRule -PolicyStore PersistentStore -Group $state.group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Remove-Item -LiteralPath $StatePath -Force
    Report-Stage 'restored'
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
