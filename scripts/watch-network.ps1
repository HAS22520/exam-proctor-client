param([Parameter(Mandatory=$true)][string]$StatePath,
      [Parameter(Mandatory=$true)][int]$ClientProcessId,
      [int]$PolicyProcessId = 0)
$ErrorActionPreference = 'Stop'
# Cache recovery code before a portable package removes its extracted resources.
$restore = [ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'unlock-firewall.ps1')))
$client = Get-Process -Id $ClientProcessId -ErrorAction SilentlyContinue
$policyProcess = Get-Process -Id $PolicyProcessId -ErrorAction SilentlyContinue
$state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
$watchPath = "$StatePath.watch.json"
$requestPath = "$StatePath.restore-request.json"
$resultPath = "$StatePath.restore-result.json"
function Write-Json([string]$Path, $Value) {
    [IO.File]::WriteAllText("$Path.tmp", ($Value | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath "$Path.tmp" -Destination $Path -Force
}
$lastAttempt = [DateTime]::MinValue
try {
    while (Test-Path -LiteralPath $StatePath) {
        # A subsequent exam may reuse the path before this watchdog exits.
        $current = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
        if ($current.group -ne $state.group) { break }
        Write-Json $watchPath @{ group = $state.group; pid = $PID }
        $request = $null
        if (Test-Path -LiteralPath $requestPath) {
            try {
                $candidate = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
                if ($candidate.group -eq $state.group -and $candidate.id -match '^[a-f0-9]{32}$') { $request = $candidate }
            } catch { }
        }
        $clientExited = -not $client -or $client.HasExited
        if (($request -or $clientExited) -and ([DateTime]::UtcNow - $lastAttempt).TotalSeconds -ge 5) {
            $lastAttempt = [DateTime]::UtcNow
            # Stop a stalled elevated policy process before rolling back. Killing
            # only its unelevated launcher would leave firewall mutations running.
            try {
                if ($policyProcess -and -not $policyProcess.HasExited) {
                    try { Stop-Process -InputObject $policyProcess -Force -ErrorAction Stop }
                    catch { if (-not $policyProcess.HasExited) { throw } }
                    $policyProcess.WaitForExit()
                }
                & $restore -StatePath $StatePath -ExpectedGroup $state.group
                if ($request) { Write-Json $resultPath @{ id = $request.id; ok = $true } }
            } catch {
                if ($request) { Write-Json $resultPath @{ id = $request.id; ok = $false; message = $_.Exception.Message } }
            }
        }
        Start-Sleep -Milliseconds 500
    }
} finally {
    if (Test-Path -LiteralPath $watchPath) {
        try {
            $owner = Get-Content -LiteralPath $watchPath -Raw | ConvertFrom-Json
            if ($owner.pid -eq $PID) { Remove-Item -LiteralPath $watchPath -Force }
        } catch { }
    }
}
