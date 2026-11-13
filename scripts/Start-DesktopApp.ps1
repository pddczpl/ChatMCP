#requires -Version 5.1
<#
.SYNOPSIS
  Opens DatGold from the folder that holds it: the desktop app when it is there, the dashboard in the browser when it is not.

.DESCRIPTION
  1. The desktop app is ChatMCP.exe beside this folder (an installation) or desktop-shell\bin\dist\ChatMCP.exe (a
     checkout in which the desktop shell was published there). When one of them exists it is started and nothing else
     is done: the app starts its own Hub and signs its own window in. It reads no arguments and uses its own port, so
     -ProjectPath and -Port are not passed on; the folder is chosen in the app.
  2. Without the app, the Hub launcher (DATGOLD-HUB\Start-ChatMcpHub.ps1) does the work: it asks /api/health, reuses
     the Hub that already runs or starts one, and opens the dashboard in the default browser with a one-time sign-in
     ticket. This script holds no copy of that logic.
  3. With neither, it stops and says what to install.

  DATGOLD-HUB\tests\verify-launcher.mjs runs a copy of this script and of START-CHATMCP-DESKTOP.cmd with stand-ins.
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

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

$app = $null
foreach ($candidate in @((Join-Path $root 'ChatMCP.exe'), (Join-Path $root 'desktop-shell\bin\dist\ChatMCP.exe'))) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $app = $candidate; break }
}
if ($null -ne $app) {
    if ($PSBoundParameters.ContainsKey('ProjectPath') -or $PSBoundParameters.ContainsKey('Port')) {
        Write-Host '[DatGold Desktop] The desktop app takes no arguments: -ProjectPath and -Port are not passed on. Choose the project folder in the app.'
    }
    # (no -ArgumentList: Windows PowerShell 5.1 refuses an empty one)
    Start-Process -FilePath $app
    exit 0
}

$hubLauncher = Join-Path $root 'DATGOLD-HUB\Start-ChatMcpHub.ps1'
if (-not (Test-Path -LiteralPath $hubLauncher -PathType Leaf)) {
    Write-Host '[DatGold Desktop] STOPPED: this folder holds neither the desktop app (ChatMCP.exe) nor the Hub (DATGOLD-HUB\Start-ChatMcpHub.ps1).'
    Write-Host '[DatGold Desktop] Install DatGold with DatGoldSetup.exe from https://github.com/pddczpl/ChatMCP/releases, or run this from a complete source checkout.'
    exit 1
}

Write-Host '[DatGold Desktop] The desktop app (ChatMCP.exe) is not in this folder, so the dashboard opens in your browser instead.'
Write-Host '[DatGold Desktop] The app itself comes with DatGoldSetup.exe (https://github.com/pddczpl/ChatMCP/releases).'
$hubParameters = @{ Port = $Port }
if (-not [string]::IsNullOrWhiteSpace($ProjectPath)) { $hubParameters['ProjectPath'] = $ProjectPath }
$global:LASTEXITCODE = 0
& $hubLauncher @hubParameters
exit $LASTEXITCODE
