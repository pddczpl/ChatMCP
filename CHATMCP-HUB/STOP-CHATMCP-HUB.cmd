@echo off
setlocal
powershell.exe -NoLogo -NoProfile -File "%~dp0Stop-ChatMcpHub.ps1" %*
exit /b %ERRORLEVEL%
