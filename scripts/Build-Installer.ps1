#requires -Version 5.1
<#
.SYNOPSIS
  Builds the commercial ChatMCPSetup.exe standalone installer.

.DESCRIPTION
  Automated build pipeline:
  1. Generates official brand icons
  2. Compiles native desktop executable (ChatMCP.exe)
  3. Prepares distribution payload and compresses to installer/payload.zip
  4. Compiles and embeds payload into standalone dist/ChatMCPSetup.exe
#>
[CmdletBinding()]
param(
    [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       ChatMCP Studio - Commercial Installer Builder      " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptDir '..'))
$distDir = Join-Path $repoRoot 'dist'
$installerDir = Join-Path $repoRoot 'installer'
$stagingDir = Join-Path $env:TEMP 'ChatMCP-Staging'

# 1. Prerequisite checks
Write-Host "`n[1/5] Checking build prerequisites..." -ForegroundColor Yellow
$dotnetCmd = Get-Command dotnet.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $dotnetCmd) {
    Write-Error ".NET SDK is required to build ChatMCPSetup.exe. Please install from https://dot.net"
    exit 1
}
$dotnetVer = (& $dotnetCmd.Path --version).Trim()
Write-Host "  [OK] .NET SDK found: $dotnetVer" -ForegroundColor Green

# 2. Brand Icons
Write-Host "`n[2/5] Ensuring brand icons..." -ForegroundColor Yellow
$brandIcon = Join-Path $repoRoot 'assets\icons\chatmcp.ico'
if (-not (Test-Path -LiteralPath $brandIcon -PathType Leaf)) {
    $pythonCmd = Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $pythonCmd) {
        Write-Host "  Rendering official brand icons..." -ForegroundColor Cyan
        & $pythonCmd.Path (Join-Path $repoRoot 'scripts\generate-brand-icon.py')
    }
}
Write-Host "  [OK] Brand icons ready." -ForegroundColor Green

# 3. Compile Native Desktop Shell (ChatMCP.exe)
Write-Host "`n[3/5] Compiling native desktop shell (ChatMCP.exe)..." -ForegroundColor Yellow
$shellCsproj = Join-Path $repoRoot 'desktop-shell\ChatMCP.csproj'
$shellDist = Join-Path $repoRoot 'desktop-shell\bin\dist'
& $dotnetCmd.Path publish $shellCsproj -c Release -r win-x64 --self-contained false -o $shellDist -p:PublishSingleFile=true | Out-Null
$desktopExe = Join-Path $shellDist 'ChatMCP.exe'
if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) {
    Write-Error "Failed to compile desktop shell: $desktopExe not found."
    exit 1
}
Write-Host "  [OK] Compiled ChatMCP.exe: $([Math]::Round((Get-Item $desktopExe).Length / 1MB, 2)) MB" -ForegroundColor Green

# 4. Prepare Staging & Build Payload Zip
Write-Host "`n[4/5] Packaging payload archive..." -ForegroundColor Yellow
if (Test-Path -LiteralPath $stagingDir) {
    Remove-Item -LiteralPath $stagingDir -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

# Copy main executable and loader
Copy-Item -LiteralPath $desktopExe -Destination (Join-Path $stagingDir 'ChatMCP.exe') -Force
$loaderDll = Join-Path $shellDist 'WebView2Loader.dll'
if (Test-Path -LiteralPath $loaderDll -PathType Leaf) {
    Copy-Item -LiteralPath $loaderDll -Destination (Join-Path $stagingDir 'WebView2Loader.dll') -Force
}

# Copy launcher cmd
Copy-Item -LiteralPath (Join-Path $repoRoot 'START-CHATMCP-DESKTOP.cmd') -Destination (Join-Path $stagingDir 'START-CHATMCP-DESKTOP.cmd') -Force

# Copy assets
$stagingAssets = Join-Path $stagingDir 'assets'
New-Item -ItemType Directory -Path $stagingAssets -Force | Out-Null
Copy-Item -Path (Join-Path $repoRoot 'assets\*') -Destination $stagingAssets -Recurse -Force

# Copy CHATMCP-HUB (excluding tests, .git)
$stagingHub = Join-Path $stagingDir 'CHATMCP-HUB'
New-Item -ItemType Directory -Path $stagingHub -Force | Out-Null
Get-ChildItem -Path (Join-Path $repoRoot 'CHATMCP-HUB') | ForEach-Object {
    if ($_.Name -notmatch '^(tests|node_modules|\.git)$') {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stagingHub $_.Name) -Recurse -Force
    }
}

# Copy scripts (utilities and uninstall)
$stagingScripts = Join-Path $stagingDir 'scripts'
New-Item -ItemType Directory -Path $stagingScripts -Force | Out-Null
Copy-Item -Path (Join-Path $repoRoot 'scripts\*') -Destination $stagingScripts -Recurse -Force

# Compress staging directory to installer/payload.zip
$payloadZip = Join-Path $installerDir 'payload.zip'
if (Test-Path -LiteralPath $payloadZip) {
    Remove-Item -LiteralPath $payloadZip -Force
}
Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
[System.IO.Compression.ZipFile]::CreateFromDirectory($stagingDir, $payloadZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
$zipSizeMb = [Math]::Round((Get-Item $payloadZip).Length / 1MB, 2)
Write-Host "  [OK] Created payload.zip ($zipSizeMb MB)" -ForegroundColor Green

# Clean staging dir
Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue

# 5. Compile Standalone Installer (ChatMCPSetup.exe)
Write-Host "`n[5/5] Compiling commercial ChatMCPSetup.exe..." -ForegroundColor Yellow
if (-not (Test-Path -LiteralPath $distDir)) {
    New-Item -ItemType Directory -Path $distDir -Force | Out-Null
}

$installerCsproj = Join-Path $installerDir 'ChatMCP.Installer.csproj'
& $dotnetCmd.Path publish $installerCsproj -c Release -r win-x64 --self-contained false -o $distDir -p:PublishSingleFile=true | Out-Null

$setupExe = Join-Path $distDir 'ChatMCPSetup.exe'
if (-not (Test-Path -LiteralPath $setupExe -PathType Leaf)) {
    Write-Error "Failed to build ChatMCPSetup.exe."
    exit 1
}

$setupSizeMb = [Math]::Round((Get-Item $setupExe).Length / 1MB, 2)
Write-Host "  [OK] Built standalone installer: $setupExe ($setupSizeMb MB)" -ForegroundColor Green

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "         ChatMCPSetup.exe Built Successfully!             " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Output File: $setupExe"
Write-Host "You can now distribute or double-click ChatMCPSetup.exe to install."
Write-Host "----------------------------------------------------------`n"
exit 0
