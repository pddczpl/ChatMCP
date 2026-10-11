@echo off
rem ============================================================================
rem  ChatMCP Studio - Native Desktop Application Launcher
rem ============================================================================
if exist "%~dp0ChatMCP.exe" (
    start "" "%~dp0ChatMCP.exe" %*
    exit /b 0
)
set "DIST_EXE=%~dp0desktop-shell\bin\dist\ChatMCP.exe"
if exist "%DIST_EXE%" (
    start "" "%DIST_EXE%" %*
    exit /b 0
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-DesktopApp.ps1" %*
if errorlevel 1 (
    echo.
    echo [ChatMCP Desktop] Could not start. Check that Node.js 22+ is installed.
    pause
)
