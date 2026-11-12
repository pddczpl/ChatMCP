@echo off
rem ============================================================================
rem  DatGold Studio - Native Desktop Application Launcher
rem ============================================================================
rem  The desktop app reads no arguments, so none is passed on to it. Without the
rem  app, scripts\Start-DesktopApp.ps1 opens the dashboard in the browser through
rem  the Hub launcher (and says so).
set "DATGOLD_APP=%~dp0ChatMCP.exe"
if not exist "%DATGOLD_APP%" set "DATGOLD_APP=%~dp0desktop-shell\bin\dist\ChatMCP.exe"
if not exist "%DATGOLD_APP%" goto :script
if not "%~1"=="" echo [DatGold Desktop] The desktop app takes no arguments: nothing is passed on. Choose the project folder in the app.
start "" "%DATGOLD_APP%"
exit /b 0

:script
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-DesktopApp.ps1" %*
if errorlevel 1 (
    echo.
    echo [DatGold Desktop] Could not start. Review the message above.
    pause
    exit /b 1
)
exit /b 0
