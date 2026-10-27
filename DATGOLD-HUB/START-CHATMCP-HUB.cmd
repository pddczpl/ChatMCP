@echo off
setlocal
rem The owned Hub runs in the background. This window returns after health check.
powershell.exe -NoLogo -NoProfile -STA -File "%~dp0Start-ChatMcpHub.ps1" %*
set "CHATMCP_HUB_EXIT=%ERRORLEVEL%"
if "%CHATMCP_HUB_EXIT%"=="0" exit /b 0
echo.
echo [CHATMCP-HUB] Startup stopped. Review the message above.
echo [CHATMCP-HUB] If Windows blocked a downloaded script, unblock the extracted bundle once.
pause
exit /b %CHATMCP_HUB_EXIT%
