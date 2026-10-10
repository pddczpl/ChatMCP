#requires -Version 5.1
<#
Start the ChatMCP local dashboard in the background.

By default the Hub runs on its own: only Node.js 22.12 or newer is required.
The coding tools run inside the Hub, so Docker, Cloud Harness and Desktop
Commander are NOT needed. The original MCP flow is still available with
-Backend mcp.

Examples, from Windows PowerShell or a VS Code PowerShell terminal (the .cmd
file next to this script passes all arguments on):
  .\START-CHATMCP-HUB.cmd                         standalone; choose the folder in the dashboard
  .\START-CHATMCP-HUB.cmd -ProjectPath .          open the current folder as the workspace
  .\START-CHATMCP-HUB.cmd -StateDir D:\ChatMCP    keep Hub data (settings, sessions, checkpoints) elsewhere
  .\START-CHATMCP-HUB.cmd -Backend mcp            original flow; needs the Cloud Harness repository

Parameters
  -ProjectPath  Folder to open as the workspace (optional).
  -Backend      auto (default) = local, or mcp when -RepoRoot is given | local | mcp
  -RepoRoot     Cloud Harness repository (mcp backend only). With -Backend mcp and no
                -RepoRoot, the folder "cloud-harness-mcp" next to this repository is used.
  -StateDir     Where the Hub keeps its data. Default: %LOCALAPPDATA%\ChatMCP\hub
                (the mcp backend keeps it inside the Cloud Harness repository).
  -Port         Dashboard port, default 3007 (3006 belongs to the MCP proxy).
  -NoOpen       Do not open the browser.

This launcher does not change PowerShell execution policy, register login
startup, or kill other processes.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$ProjectPath,
    [ValidateSet('auto', 'local', 'mcp')]
    [string]$Backend = 'auto',
    [string]$RepoRoot,
    [string]$StateDir,
    [ValidateRange(1024, 65535)]
    [int]$Port = 3007,
    [switch]$NoOpen
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

function Resolve-HubFolder {
    # Returns a full Windows path. -MustExist rejects folders that are not there yet.
    param([string]$Path, [string]$Label, [switch]$MustExist)
    $provider = $null
    $drive = $null
    $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path, [ref]$provider, [ref]$drive)
    if ($provider.Name -ne 'FileSystem') {
        throw ('{0} must be a Windows filesystem folder.' -f $Label)
    }
    if ($MustExist -and -not (Test-Path -LiteralPath $full -PathType Container)) {
        throw ('The folder for {0} does not exist.' -f $Label)
    }
    # A trailing backslash before a closing quote breaks native argument passing in PowerShell 5.1.
    if ($full.Length -gt 3) { $full = $full.TrimEnd('\') }
    return $full
}

try {
    if ($env:OS -ne 'Windows_NT') {
        throw 'Run this launcher on Windows.'
    }
    $hubPath = Join-Path $PSScriptRoot 'lib\launch.mjs'
    if (-not (Test-Path -LiteralPath $hubPath -PathType Leaf)) {
        throw 'lib\launch.mjs is missing. Extract the entire CHATMCP-HUB folder first.'
    }
    if ($Port -eq 3006) {
        throw 'Port 3006 is reserved for the MCP proxy. Choose another -Port.'
    }

    # Decide the backend first. Without -RepoRoot the Hub needs nothing but Node.js.
    $repoGiven = $PSBoundParameters.ContainsKey('RepoRoot') -and -not [string]::IsNullOrWhiteSpace($RepoRoot)
    $chosenBackend = $Backend
    if ($chosenBackend -eq 'auto') {
        if ($repoGiven) { $chosenBackend = 'mcp' } else { $chosenBackend = 'local' }
    }
    if ($chosenBackend -eq 'mcp') {
        if (-not $repoGiven) {
            $sibling = Join-Path (Split-Path -Parent $PSScriptRoot) 'cloud-harness-mcp'
            if (-not (Test-Path -LiteralPath $sibling -PathType Container)) {
                throw 'The mcp backend needs the Cloud Harness repository. Pass -RepoRoot <folder> or put a "cloud-harness-mcp" folder next to this repository. The local backend needs neither.'
            }
            $RepoRoot = $sibling
        }
        $RepoRoot = Resolve-HubFolder -Path $RepoRoot -Label '-RepoRoot (Cloud Harness repository)' -MustExist
    }
    elseif ($repoGiven) {
        Write-Host '[CHATMCP-HUB] -RepoRoot is only used by the mcp backend. Ignored.'
    }

    if (-not [string]::IsNullOrWhiteSpace($ProjectPath)) {
        $ProjectPath = Resolve-HubFolder -Path $ProjectPath -Label '-ProjectPath' -MustExist
    }
    if (-not [string]::IsNullOrWhiteSpace($StateDir)) {
        # May not exist yet; the Hub creates it.
        $StateDir = Resolve-HubFolder -Path $StateDir -Label '-StateDir'
    }

    # Get-Command can find several Node installations. Always choose one path.
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $nodeCommand) {
        throw 'Node.js was not found. Install Node.js 22.12 or newer from https://nodejs.org and open a new terminal.'
    }
    $nodePath = $nodeCommand.Source
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

    # Git is optional for starting, but the Git tools and the diff view need it.
    $gitCommand = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $gitCommand) {
        Write-Host '[CHATMCP-HUB] Note: Git for Windows was not found. Editing works, but the Git tools and the diff view need it (https://git-scm.com/download/win).'
    }

    $hubArguments = @($hubPath, '--port', ([string]$Port), '--backend', $chosenBackend)
    if ($chosenBackend -eq 'mcp') { $hubArguments += @('--repo-root', $RepoRoot) }
    if (-not [string]::IsNullOrWhiteSpace($StateDir)) { $hubArguments += @('--state-dir', $StateDir) }
    if (-not [string]::IsNullOrWhiteSpace($ProjectPath)) { $hubArguments += @('--project', $ProjectPath) }
    if ($NoOpen) { $hubArguments += '--no-open' }

    Write-Host ('[CHATMCP-HUB] Node.js {0}, backend: {1}' -f $nodeVersion, $chosenBackend)
    if ($NoOpen) { Write-Host '[CHATMCP-HUB] Starting the Hub in the background.' }
    else { Write-Host '[CHATMCP-HUB] Starting the Hub in the background and opening its dashboard.' }
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
