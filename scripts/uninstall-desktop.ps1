#requires -Version 5.1
<#
.SYNOPSIS
  Removes ChatMCP Studio desktop shortcuts and unregisters from Windows.
#>
[CmdletBinding()]
param(
    [switch]$Quiet
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$desktopDir = [Environment]::GetFolderPath('Desktop')
$startMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'ChatMCP'

$desktopLnk = Join-Path $desktopDir 'ChatMCP Studio.lnk'
$startMenuLnk = Join-Path $startMenuDir 'ChatMCP Studio.lnk'

# 1. Remove shortcuts
if (Test-Path -LiteralPath $desktopLnk) {
    Remove-Item -LiteralPath $desktopLnk -Force -ErrorAction SilentlyContinue
    if (-not $Quiet) { Write-Host "Removed desktop shortcut: $desktopLnk" -ForegroundColor Green }
}

if (Test-Path -LiteralPath $startMenuDir) {
    Remove-Item -LiteralPath $startMenuDir -Recurse -Force -ErrorAction SilentlyContinue
    if (-not $Quiet) { Write-Host "Removed Start Menu shortcuts: $startMenuDir" -ForegroundColor Green }
}

# 2. Remove Windows Registry Uninstall key
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatMCP"
if (Test-Path -LiteralPath $uninstallKey) {
    Remove-Item -Path $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    if (-not $Quiet) { Write-Host "Unregistered ChatMCP from Windows Installed Apps registry." -ForegroundColor Green }
}

if (-not $Quiet) {
    Write-Host "ChatMCP Desktop shortcuts and registry entries uninstalled successfully."
}
exit 0
