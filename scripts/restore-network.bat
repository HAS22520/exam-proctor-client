@echo off
chcp 65001 >nul
echo 正在重置 Windows 网络代理设置...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0notify-wininet.ps1"
echo.
echo ====================================================
echo [OK] Windows 系统代理已关闭，网络已完全恢复正常！
echo ====================================================
pause
