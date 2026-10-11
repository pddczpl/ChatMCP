@echo off
rem ============================================================================
rem  ChatMCP Studio - 1-Click Native Desktop Application Launcher
rem ============================================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-DesktopApp.ps1" %*
if errorlevel 1 (
    echo.
    echo [ChatMCP Desktop] Could not start. Check that Node.js 22+ is installed.
    pause
)
