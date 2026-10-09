@echo off
chcp 65001 >nul
echo ====================================================
echo   正在紧急恢复 Windows 全局网络与防火墙设置...
echo ====================================================

:: 重置代理
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f >nul

:: 执行防火墙恢复脚本 (请求管理员提权执行)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"\"%~dp0unlock-firewall.ps1\"\"'"

echo.
echo [OK] 全局网络与防火墙已全部恢复正常！
echo ====================================================
pause
