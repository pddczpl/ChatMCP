#requires -Version 5.1
<#
.SYNOPSIS
  Installs ChatMCP Studio desktop application and shortcuts on Windows 11 / Windows 10.

.DESCRIPTION
  Performs complete desktop application setup:
  1. Compiles or verifies native ChatMCP.exe desktop binary (via .NET / WebView2)
  2. Generates Desktop shortcut with official ChatMCP brand icon
  3. Generates Start Menu application entry with official brand icon
  4. Registers ChatMCP in Windows Registry (Settings -> Installed Apps)
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
$distExe = Join-Path $repoRoot 'desktop-shell\bin\dist\ChatMCP.exe'
$brandIcon = Join-Path $repoRoot 'assets\icons\chatmcp.ico'

# 1. Prerequisite checks
Write-Host "`n[1/4] Checking prerequisites..." -ForegroundColor Yellow
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

# 2. Native Desktop Binary Verification / Build
Write-Host "`n[2/4] Verifying native desktop executable..." -ForegroundColor Yellow
$targetAppPath = $launcherCmd

if (-not (Test-Path -LiteralPath $distExe -PathType Leaf)) {
    $dotnetCmd = Get-Command dotnet.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $csprojPath = Join-Path $repoRoot 'desktop-shell\ChatMCP.csproj'
    if ($null -ne $dotnetCmd -and (Test-Path -LiteralPath $csprojPath -PathType Leaf)) {
        Write-Host "  Building native ChatMCP.exe desktop shell..." -ForegroundColor Cyan
        try {
            & $dotnetCmd.Path publish $csprojPath -c Release -r win-x64 --self-contained false -o (Join-Path $repoRoot 'desktop-shell\bin\dist') -p:PublishSingleFile=true | Out-Null
        }
        catch {
            Write-Host "  [!] Dotnet publish skipped: $($_.Exception.Message)" -ForegroundColor DarkYellow
        }
    }
}

if (Test-Path -LiteralPath $distExe -PathType Leaf) {
    $targetAppPath = $distExe
    Write-Host "  [OK] Native Desktop Executable ready: $distExe" -ForegroundColor Green
} else {
    Write-Host "  [OK] Using 1-Click launcher: $launcherCmd" -ForegroundColor Green
}

# Ensure brand icon exists
if (-not (Test-Path -LiteralPath $brandIcon -PathType Leaf)) {
    $iconGenPy = Join-Path $repoRoot 'scripts\generate-brand-icon.py'
    $pythonCmd = Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $pythonCmd -and (Test-Path -LiteralPath $iconGenPy -PathType Leaf)) {
        & $pythonCmd.Path $iconGenPy | Out-Null
    }
}

# 3. Create Shortcuts with Official Branding Icon
Write-Host "`n[3/4] Generating Desktop & Start Menu shortcuts with official branding..." -ForegroundColor Yellow
$wscript = New-Object -ComObject WScript.Shell

$desktopDir = [Environment]::GetFolderPath('Desktop')
$startMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'ChatMCP'

if (-not (Test-Path -LiteralPath $startMenuDir)) {
    New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null
}

$desktopLnk = Join-Path $desktopDir 'ChatMCP Studio.lnk'
$startMenuLnk = Join-Path $startMenuDir 'ChatMCP Studio.lnk'

foreach ($targetLnk in @($desktopLnk, $startMenuLnk)) {
    $shortcut = $wscript.CreateShortcut($targetLnk)
    $shortcut.TargetPath = $targetAppPath
    $shortcut.WorkingDirectory = $repoRoot
    if ($targetAppPath.EndsWith('.cmd', [System.StringComparison]::OrdinalIgnoreCase)) {
        $shortcut.WindowStyle = 7 # Minimized launch for cmd
    } else {
        $shortcut.WindowStyle = 1 # Normal window for native exe
    }
    $shortcut.Description = "ChatMCP - Autonomous AI Coding Agent Desktop Studio"
    if (Test-Path -LiteralPath $brandIcon -PathType Leaf) {
        $shortcut.IconLocation = "$brandIcon,0"
    }
    $shortcut.Save()
    Write-Host "  [OK] Created shortcut: $targetLnk" -ForegroundColor Green
}

# 4. Register in Windows Registry (Settings -> Installed Apps)
Write-Host "`n[4/4] Registering ChatMCP in Windows Installed Apps registry..." -ForegroundColor Yellow
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatMCP"
$uninstallScript = Join-Path $repoRoot 'scripts\uninstall-desktop.ps1'

try {
    if (-not (Test-Path -LiteralPath $uninstallKey)) {
        New-Item -Path $uninstallKey -Force | Out-Null
    }
    Set-ItemProperty -Path $uninstallKey -Name "DisplayName" -Value "ChatMCP Studio - AI Coding Agent"
    Set-ItemProperty -Path $uninstallKey -Name "DisplayVersion" -Value "2.6.0"
    Set-ItemProperty -Path $uninstallKey -Name "Publisher" -Value "Phan Danh Dat"
    Set-ItemProperty -Path $uninstallKey -Name "InstallLocation" -Value $repoRoot
    Set-ItemProperty -Path $uninstallKey -Name "UninstallString" -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$uninstallScript`""
    Set-ItemProperty -Path $uninstallKey -Name "URLInfoAbout" -Value "https://github.com/pddczpl/ChatMCP"
    if (Test-Path -LiteralPath $brandIcon -PathType Leaf) {
        Set-ItemProperty -Path $uninstallKey -Name "DisplayIcon" -Value "$brandIcon,0"
    }
    Write-Host "  [OK] Registered in Windows Registry: $uninstallKey" -ForegroundColor Green
}
catch {
    Write-Host "  [!] Notice: Could not register uninstall entry in registry: $($_.Exception.Message)" -ForegroundColor DarkYellow
}

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "        Desktop Native App Installation Complete!        " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "You can now launch ChatMCP anytime directly from:"
Write-Host "  * Desktop icon: 'ChatMCP Studio' (with official brand icon)"
Write-Host "  * Start Menu: Start -> ChatMCP -> ChatMCP Studio"
Write-Host "  * Native Executable: .\desktop-shell\bin\dist\ChatMCP.exe"
Write-Host "  * Windows Settings: Apps -> Installed apps -> ChatMCP Studio"
Write-Host "----------------------------------------------------------"
Write-Host "To uninstall later, run: .\scripts\uninstall-desktop.ps1`n"
exit 0
