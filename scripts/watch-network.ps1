param([Parameter(Mandatory=$true)][string]$StatePath,
      [Parameter(Mandatory=$true)][int]$ClientProcessId,
      [int]$PolicyProcessId = 0)
$ErrorActionPreference = 'Stop'
# Portable packages may remove extracted resources immediately after client exit.
$restore = [ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'unlock-firewall.ps1')))
# Finish applying policy before restoring it if Electron exits during setup.
if ($PolicyProcessId -gt 0) { Wait-Process -Id $PolicyProcessId -ErrorAction SilentlyContinue }
Wait-Process -Id $ClientProcessId -ErrorAction SilentlyContinue
& $restore -StatePath $StatePath
