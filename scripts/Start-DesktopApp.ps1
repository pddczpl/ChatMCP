#requires -Version 5.1
<#
.SYNOPSIS
  Launches DatGold Studio as a native desktop window application on Windows.

.DESCRIPTION
  Starts the background DatGold Hub daemon (if not already running) and opens
  the Studio interface in a standalone, dedicated desktop application window
  using Microsoft Edge or Chrome App Mode (no browser URL bars, tabs, or address bars).
  
  Uses an isolated runtime profile in %LOCALAPPDATA%\ChatMCP\desktop-runtime.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$ProjectPath,
    [ValidateRange(1024, 65535)]
    [int]$Port = 3007
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptDir '..'))
# The folder of the Hub is DATGOLD-HUB in an installation and in a source checkout (installations made up to 3.11.0 called it CHATMCP-HUB; the setup replaces them).
$hubDir = Join-Path $repoRoot 'DATGOLD-HUB'
$hubScript = Join-Path $hubDir 'hub.mjs'

# 0. Check for Native ChatMCP.exe desktop shell first
$nativeExe = Join-Path $repoRoot 'desktop-shell\bin\dist\ChatMCP.exe'
if (-not (Test-Path -LiteralPath $nativeExe -PathType Leaf)) {
    $nativeExe = Join-Path $repoRoot 'ChatMCP.exe'
}
if (Test-Path -LiteralPath $nativeExe -PathType Leaf) {
    $procArgs = @()
    if (-not [string]::IsNullOrWhiteSpace($ProjectPath)) {
        $procArgs += @($ProjectPath)
    }
    Start-Process -FilePath $nativeExe -ArgumentList $procArgs
    exit 0
}

# 1. Verify Node.js
$nodeCmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $nodeCmd) {
    [System.Windows.Forms.MessageBox]::Show(
        "Node.js 22+ is required to run DatGold.`nPlease install Node.js from https://nodejs.org",
        "DatGold Desktop",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) 2>$null
    Write-Error "DatGold requires Node.js 22+. Download from https://nodejs.org"
    exit 1
}

# 2. Check if Hub is already running
$healthUrl = "http://127.0.0.1:$Port/healthz"
$hubRunning = $false
try {
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add("User-Agent", "ChatMCP-Desktop-Launcher")
    $resp = $wc.DownloadString($healthUrl)
    if ($resp -match '"ok":true') {
        $hubRunning = $true
    }
}
catch {
    $hubRunning = $false
}

# 3. Start Hub in background if not already running
if (-not $hubRunning) {
    Write-Host "[DatGold Desktop] Starting Hub daemon at port $Port..."
    $hubArgs = @($hubScript, "--port", ([string]$Port), "--no-open")
    if (-not [string]::IsNullOrWhiteSpace($ProjectPath)) {
        $hubArgs += @("--project", $ProjectPath)
    }

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $nodeCmd.Path
    $startInfo.Arguments = ($hubArgs -join ' ')
    $startInfo.WorkingDirectory = $hubDir
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.CreateNoWindow = $true
    $startInfo.UseShellExecute = $true
    [System.Diagnostics.Process]::Start($startInfo) | Out-Null

    # Wait for Hub to be healthy
    $attempts = 0
    $maxAttempts = 40
    while ($attempts -lt $maxAttempts -and -not $hubRunning) {
        Start-Sleep -Milliseconds 250
        $attempts++
        try {
            $wc = New-Object System.Net.WebClient
            $wc.Headers.Add("User-Agent", "ChatMCP-Desktop-Launcher")
            $resp = $wc.DownloadString($healthUrl)
            if ($resp -match '"ok":true') {
                $hubRunning = $true
                break
            }
        }
        catch {
            $hubRunning = $false
        }
    }

    if (-not $hubRunning) {
        Write-Warning "[DatGold Desktop] Hub took longer than expected to start. Opening dashboard anyway..."
    }
}

# 4. Find Browser for Native App Window Mode
$appUrl = "http://127.0.0.1:$Port/"
$userDataDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ChatMCP\desktop-runtime'

$candidateBrowsers = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe"
)

$targetBrowser = $null
foreach ($b in $candidateBrowsers) {
    if (Test-Path -LiteralPath $b -PathType Leaf) {
        $targetBrowser = $b
        break
    }
}

if ($targetBrowser) {
    $browserArgs = @(
        "--app=$appUrl",
        "--user-data-dir=$userDataDir",
        "--window-size=1440,900",
        "--enable-features=OverlayScrollbar",
        "--disable-features=Translate"
    )
    Start-Process -FilePath $targetBrowser -ArgumentList $browserArgs
}
else {
    Start-Process $appUrl
}

Write-Host "[DatGold Desktop] Launched successfully."
exit 0
