#requires -Version 5.1
<#
Start the ChatMCP local dashboard and its managed MCP processes in the background.
The Node launcher reuses an existing owned instance or starts a new one,
waits for its health response, opens the dashboard, and returns to this terminal.

Examples, from Windows PowerShell or a VS Code PowerShell terminal:
  & 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd'
  & 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd' -ProjectPath .

Use the existing Cloud Harness repository. This launcher does not change
PowerShell execution policy, register login startup, or kill other processes.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$ProjectPath,
    [string]$RepoRoot = 'F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp',
    [ValidateRange(1024, 65535)]
    [int]$Port = 3007
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$phase = 'checking prerequisites'
$previousConsoleEncoding = $null

function Write-HubLine {
    param([object]$Value)
    try {
        $line = [string]$Value
        # The hub sanitizes its subprocess logs. This is an extra output guard.
        if ($line -match '(?i)\bauthorization\b|\bbearer\b|_authToken') {
            $line = '[CHATMCP-HUB] Authentication details hidden.'
        }
        Write-Host $line
    }
    catch { Write-Host '[CHATMCP-HUB] Log line hidden.' }
}

try {
    if ($env:OS -ne 'Windows_NT') {
        throw 'Run this launcher on Windows.'
    }
    $hubPath = Join-Path $PSScriptRoot 'lib\launch.mjs'
    if (-not (Test-Path -LiteralPath $hubPath -PathType Leaf)) {
        throw 'lib\launch.mjs is missing. Extract the entire CHATMCP-HUB folder first.'
    }
    if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
        throw 'The Cloud Harness repository folder does not exist. Check -RepoRoot.'
    }
    $resolvedRepo = Resolve-Path -LiteralPath $RepoRoot
    if ($resolvedRepo.Provider.Name -ne 'FileSystem') {
        throw 'RepoRoot must be a Windows filesystem folder.'
    }
    $RepoRoot = $resolvedRepo.ProviderPath

    if (-not [string]::IsNullOrWhiteSpace($ProjectPath)) {
        if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) {
            throw 'The selected project folder does not exist. Check -ProjectPath.'
        }
        $resolvedProject = Resolve-Path -LiteralPath $ProjectPath
        if ($resolvedProject.Provider.Name -ne 'FileSystem') {
            throw 'ProjectPath must be a Windows filesystem folder.'
        }
        $ProjectPath = $resolvedProject.ProviderPath
    }

    # Get-Command can find several Node installations. Always choose one path.
    $nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $hubUtf8 = New-Object System.Text.UTF8Encoding($false)
    $previousConsoleEncoding = [Console]::OutputEncoding
    [Console]::OutputEncoding = $hubUtf8

    # Run --version rather than JavaScript through -e: PS 5.1 can strip quotes.
    $savedPreference = $ErrorActionPreference
    $versionExitCode = $null
    try {
        $ErrorActionPreference = 'Continue'
        $nodeVersionLines = @(& $nodePath --version 2>&1)
        $versionExitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    if ($versionExitCode -ne 0 -or $nodeVersionLines.Count -eq 0) {
        throw 'Node.js could not start. Check the Node.js installation.'
    }
    $nodeVersion = ([string]$nodeVersionLines[0]).Trim()
    if ($nodeVersion -notmatch '^v(\d+)\.(\d+)\.(\d+)') {
        throw 'Could not identify the Node.js version.'
    }
    $nodeMajor = [int]$Matches[1]
    $nodeMinor = [int]$Matches[2]
    if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 12)) {
        throw 'Node.js 22.12 or newer is required.'
    }

    $hubArguments = @($hubPath, '--repo-root', $RepoRoot, '--port', ([string]$Port))
    if (-not [string]::IsNullOrWhiteSpace($ProjectPath)) {
        $hubArguments += @('--project', $ProjectPath)
    }
    Write-Host ('[CHATMCP-HUB] Node.js {0}' -f $nodeVersion)
    Write-Host '[CHATMCP-HUB] Starting the Hub in the background and opening its dashboard.'
    $phase = 'starting the background Hub'
    $hubExitCode = $null
    $savedPreference = $ErrorActionPreference
    try {
        # Ordinary native stderr is not a terminating PowerShell 5.1 error.
        $ErrorActionPreference = 'Continue'
        & $nodePath @hubArguments 2>&1 | ForEach-Object { Write-HubLine -Value $_ }
        $hubExitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    if ($hubExitCode -ne 0) {
        throw ('The hub exited with code {0}. Review its messages above.' -f $hubExitCode)
    }
}
catch {
    $hubFailure = $_
    Write-Host ('[CHATMCP-HUB] STOPPED during {0}.' -f $phase)
    Write-HubLine -Value ('[CHATMCP-HUB] Reason: {0}' -f $hubFailure.Exception.Message)
    exit 1
}
finally {
    if ($null -ne $previousConsoleEncoding) {
        try { [Console]::OutputEncoding = $previousConsoleEncoding }
        catch { }
    }
}
