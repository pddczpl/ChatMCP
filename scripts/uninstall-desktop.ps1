#requires -Version 5.1
<#
.SYNOPSIS
  Removes ChatMCP Studio desktop shortcuts on Windows.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$desktopDir = [Environment]::GetFolderPath('Desktop')
$startMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'ChatMCP'

$desktopLnk = Join-Path $desktopDir 'ChatMCP Studio.lnk'
$startMenuLnk = Join-Path $startMenuDir 'ChatMCP Studio.lnk'

if (Test-Path -LiteralPath $desktopLnk) {
    Remove-Item -LiteralPath $desktopLnk -Force
    Write-Host "Removed desktop shortcut: $desktopLnk" -ForegroundColor Green
}

if (Test-Path -LiteralPath $startMenuDir) {
    Remove-Item -LiteralPath $startMenuDir -Recurse -Force
    Write-Host "Removed Start Menu shortcuts: $startMenuDir" -ForegroundColor Green
}

Write-Host "ChatMCP Desktop shortcuts removed successfully."
exit 0
