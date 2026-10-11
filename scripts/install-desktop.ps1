#requires -Version 5.1
<#
.SYNOPSIS
  Installs ChatMCP Studio desktop shortcuts on Windows 11 / Windows 10.

.DESCRIPTION
  Creates:
  1. Desktop Shortcut: "ChatMCP Studio" on current user's desktop
  2. Start Menu Entry: "ChatMCP Studio" under Programs folder
  
  Both shortcuts execute START-CHATMCP-DESKTOP.cmd in windowed native app mode.
#>
[CmdletBinding()]
param(
    [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       ChatMCP Studio - Desktop Native App Installer      " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptDir '..'))
$launcherCmd = Join-Path $repoRoot 'START-CHATMCP-DESKTOP.cmd'

if (-not (Test-Path -LiteralPath $launcherCmd -PathType Leaf)) {
    Write-Error "Could not find launcher script: $launcherCmd"
    exit 1
}

# 1. Prerequisite checks
Write-Host "`n[1/3] Checking prerequisites..." -ForegroundColor Yellow
$nodeCmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $nodeCmd) {
    Write-Error "Node.js 22+ is required. Please install Node.js from https://nodejs.org"
    exit 1
}
$nodeVersion = (& $nodeCmd.Path --version).Trim()
Write-Host "  [OK] Node.js found: $nodeVersion" -ForegroundColor Green

$gitCmd = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $gitCmd) {
    $gitVersion = (& $gitCmd.Path --version).Trim()
    Write-Host "  [OK] Git found: $gitVersion" -ForegroundColor Green
} else {
    Write-Host "  [!] Git not found. Git is recommended for full version control support." -ForegroundColor DarkYellow
}

# 2. Create Shortcuts
Write-Host "`n[2/3] Generating Desktop & Start Menu shortcuts..." -ForegroundColor Yellow
$wscript = New-Object -ComObject WScript.Shell

$desktopDir = [Environment]::GetFolderPath('Desktop')
$startMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'ChatMCP'

if (-not (Test-Path -LiteralPath $startMenuDir)) {
    New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null
}

$desktopLnk = Join-Path $desktopDir 'ChatMCP Studio.lnk'
$startMenuLnk = Join-Path $startMenuDir 'ChatMCP Studio.lnk'

# Preferred icon: Edge or Shell32
$iconPath = Join-Path $env:SystemRoot 'System32\shell32.dll'
$iconIndex = 220 # Computer/Console/Window icon

foreach ($targetLnk in @($desktopLnk, $startMenuLnk)) {
    $shortcut = $wscript.CreateShortcut($targetLnk)
    $shortcut.TargetPath = $launcherCmd
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.WindowStyle = 7 # Minimized launch to keep console invisible
    $shortcut.Description = "ChatMCP - AI Coding Agent Desktop Studio"
    $shortcut.IconLocation = "$iconPath,$iconIndex"
    $shortcut.Save()
    Write-Host "  [OK] Created: $targetLnk" -ForegroundColor Green
}

# 3. Complete
Write-Host "`n[3/3] Desktop installation complete!" -ForegroundColor Cyan
Write-Host "----------------------------------------------------------"
Write-Host "You can now launch ChatMCP anytime directly from:"
Write-Host "  * Desktop icon: 'ChatMCP Studio'"
Write-Host "  * Start Menu: Start -> ChatMCP -> ChatMCP Studio"
Write-Host "  * Command line: .\START-CHATMCP-DESKTOP.cmd"
Write-Host "----------------------------------------------------------"
Write-Host "To uninstall shortcuts later, run: .\scripts\uninstall-desktop.ps1`n"
exit 0
