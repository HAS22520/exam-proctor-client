param([Parameter(Mandatory=$true)][string]$StatePath,
      [Parameter(Mandatory=$true)][int]$ClientProcessId)
$ErrorActionPreference = 'Stop'
Wait-Process -Id $ClientProcessId -ErrorAction SilentlyContinue
& (Join-Path $PSScriptRoot 'unlock-firewall.ps1') -StatePath $StatePath
