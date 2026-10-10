@echo off
powershell.exe -NoProfile -File "%~dp0cloud-harness-mcp\deploy\.generated\start-cloud-harness.ps1"
if errorlevel 1 echo Could not start. Open Docker Desktop and check the message above.
pause