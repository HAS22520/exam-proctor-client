param([Parameter(Mandatory=$true)][string]$StatePath)
$ErrorActionPreference = 'Stop'
$mutex = [Threading.Mutex]::new($false, 'Global\HydroProctorNetworkRecovery')
try {
    try { if (-not $mutex.WaitOne(60000)) { throw 'Network recovery is busy.' } } catch [Threading.AbandonedMutexException] {}
if (-not (Test-Path -LiteralPath $StatePath)) { return }
$state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
Get-NetFirewallRule -Group $state.group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
foreach ($name in $state.rules) { Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue | Enable-NetFirewallRule }
foreach ($profile in $state.profiles) {
    Set-NetFirewallProfile -Name $profile.Name -DefaultOutboundAction $profile.DefaultOutboundAction
}
Remove-Item -LiteralPath $StatePath -Force

} finally { try { $mutex.ReleaseMutex() } catch {} ; $mutex.Dispose() }
