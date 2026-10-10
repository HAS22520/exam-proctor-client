@echo off
setlocal
set "PROCTOR_RECOVERY_STATE=%APPDATA%\HydroProctorClient\network-state.json"
if not "%~1"=="" set "PROCTOR_RECOVERY_STATE=%~1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0unlock-firewall.ps1" -StatePath "%PROCTOR_RECOVERY_STATE%"
if errorlevel 1 (echo Recovery failed. Run this script as administrator. & exit /b 1)
echo Saved exam firewall policy restored.
