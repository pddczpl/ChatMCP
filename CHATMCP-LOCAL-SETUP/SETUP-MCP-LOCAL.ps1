#requires -Version 5.1
<#
Adds native Windows Desktop Commander to the EXISTING ChatMCP browser proxy.
Version 1.0.0. No administrator rights are required.

Run this after stopping the browser proxy with Ctrl+C. Keep Docker running.
The adjacent configure-local.mjs must remain beside this script.
This installer contains no credentials and never prints MCP configuration.
#>
[CmdletBinding()]
param(
    [string]$ProjectPath = 'F:\Personal_Project\Vin\K4-Track4-Day23-PhanDanhDat-02627-Sensor-Fusion-Student',
    [string]$RepoRoot = 'F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp',
    [ValidateRange(1024, 65535)]
    [int]$Port = 3006
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$phase = 'checking prerequisites'
$redactions = @()
$redactionsReady = $false
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-SafeLine {
    param([object]$Value)
    try {
        $safeLine = [string]$Value
        foreach ($secret in $redactions) {
            if (-not [string]::IsNullOrWhiteSpace($secret)) {
                $safeLine = $safeLine.Replace($secret, '[REDACTED]')
            }
        }
        if ($safeLine -match '(?i)\bheaders?\b|\bauthorization\b|\bbearer\b|_authToken') {
            $safeLine = '[Authentication details hidden]'
        }
        Write-Host $safeLine
    }
    catch { Write-Host '[Log line hidden]' }
}

function Invoke-SafeNative {
    param([string]$Executable, [string[]]$ArgumentList)
    $savedPreference = $ErrorActionPreference
    $nativeExitCode = $null
    try {
        # PowerShell 5.1 can report ordinary npm stderr as NativeCommandError.
        $ErrorActionPreference = 'Continue'
        & $Executable @ArgumentList 2>&1 | ForEach-Object { Write-SafeLine $_ }
        $nativeExitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    if ($nativeExitCode -ne 0) {
        throw ('Native command failed; exit code: {0}. See sanitized output above.' -f $nativeExitCode)
    }
}

try {
    Write-Host '[MCP-LOCAL] Setup version 1.0.0'
    if ($env:OS -ne 'Windows_NT') { throw 'Run this installer in Windows PowerShell.' }
    if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) {
        throw 'The project folder does not exist. Check -ProjectPath.'
    }
    $ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).ProviderPath
    $helperSource = Join-Path $PSScriptRoot 'configure-local.mjs'
    if (-not (Test-Path -LiteralPath $helperSource -PathType Leaf)) {
        throw 'Extract the entire ZIP first; configure-local.mjs is missing.'
    }

    # Select exactly ONE executable, even when npm has two PATH entries.
    $nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $npmPath = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    # Run a file instead of node -e: PS 5.1 can strip embedded double quotes.
    Invoke-SafeNative -Executable $nodePath -ArgumentList @($helperSource, '--check-node')

    $generated = Join-Path $RepoRoot 'deploy\.generated'
    $configPath = Join-Path $generated 'mcp-client.proxy.json'
    $runtimeDirectory = Join-Path $generated 'desktop-commander-local'
    $phase = 'reading the existing proxy configuration'
    $config = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
    $serversProperty = $config.PSObject.Properties['mcpServers']
    if ($null -eq $serversProperty -or $null -eq $serversProperty.Value) {
        throw 'The existing file has no mcpServers object.'
    }
    foreach ($entry in $serversProperty.Value.PSObject.Properties) {
        $headerProperty = $entry.Value.PSObject.Properties['headers']
        if ($null -eq $headerProperty -or $null -eq $headerProperty.Value) { continue }
        foreach ($header in $headerProperty.Value.PSObject.Properties) {
            $value = [string]$header.Value
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                $redactions += $value
                $redactions += ($value -replace '(?i)^Bearer\s+', '')
            }
        }
    }
    $redactions = @($redactions | Sort-Object -Property Length -Descending)
    $redactionsReady = $true

    $phase = 'checking the browser proxy port'
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
        throw ('Press Ctrl+C in the OLD browser proxy window (port {0}), then run this installer again. Keep Docker running.' -f $Port)
    }

    [IO.Directory]::CreateDirectory($runtimeDirectory) | Out-Null
    $packageManifest = Join-Path $runtimeDirectory 'package.json'
    if (-not (Test-Path -LiteralPath $packageManifest -PathType Leaf)) {
        [IO.File]::WriteAllText($packageManifest, '{"name":"chatmcp-local-commander","version":"1.0.0","private":true}', $utf8)
    }
    $installedManifest = Join-Path $runtimeDirectory 'node_modules\@wonderwhy-er\desktop-commander\package.json'
    $installedEntry = Join-Path $runtimeDirectory 'node_modules\@wonderwhy-er\desktop-commander\dist\index.js'
    $installMarker = Join-Path $runtimeDirectory 'install-complete-0.2.52.txt'
    $needsInstall = $true
    if ((Test-Path -LiteralPath $installedManifest -PathType Leaf) -and (Test-Path -LiteralPath $installedEntry -PathType Leaf) -and (Test-Path -LiteralPath $installMarker -PathType Leaf)) {
        try {
            $installed = [IO.File]::ReadAllText($installedManifest) | ConvertFrom-Json
            $needsInstall = ([string]$installed.version -ne '0.2.52')
        }
        catch { $needsInstall = $true }
    }
    if ($needsInstall) {
        $phase = 'installing Desktop Commander 0.2.52'
        if (Test-Path -LiteralPath $installMarker -PathType Leaf) {
            Remove-Item -LiteralPath $installMarker -Force
        }
        Write-Host '[MCP-LOCAL] Installing Desktop Commander 0.2.52 and its dependencies...'
        Write-Host '[MCP-LOCAL] The first installation can take several minutes. Keep this window open.'
        Invoke-SafeNative -Executable $npmPath -ArgumentList @(
            'install', '--prefix', $runtimeDirectory, '--save-exact',
            '--omit=dev', '--no-audit', '--no-fund', '--loglevel', 'warn',
            '@wonderwhy-er/desktop-commander@0.2.52'
        )
        [IO.File]::WriteAllText($installMarker, 'Desktop Commander 0.2.52 installed successfully.', $utf8)
    }

    $phase = 'configuring and testing the local MCP server'
    $helperPath = Join-Path $runtimeDirectory 'configure-local.mjs'
    Copy-Item -LiteralPath $helperSource -Destination $helperPath -Force
    Invoke-SafeNative -Executable $nodePath -ArgumentList @('--check', $helperPath)
    Invoke-SafeNative -Executable $nodePath -ArgumentList @($helperPath, $ProjectPath, $configPath, $runtimeDirectory)

    Write-Host ''
    Write-Host '[MCP-LOCAL] SETUP COMPLETE. The browser proxy must now be restarted.'
    Write-Host ('[MCP-LOCAL] Project: {0}' -f $ProjectPath)
    Write-Host '[MCP-LOCAL] Run the existing START-MCP-BROWSER.ps1 and keep its window open.'
    Write-Host ('[MCP-LOCAL] Extension: Streamable HTTP | http://127.0.0.1:{0}/mcp' -f $Port)
}
catch {
    $setupFailure = $_
    Write-Host ('[MCP-LOCAL] STOPPED during: {0}.' -f $phase)
    Write-Host ('[MCP-LOCAL] Error type: {0}' -f $setupFailure.Exception.GetType().FullName)
    Write-Host ('[MCP-LOCAL] Script line: {0}' -f $setupFailure.InvocationInfo.ScriptLineNumber)
    if ($redactionsReady -or $phase -eq 'checking prerequisites') {
        Write-SafeLine ('[MCP-LOCAL] Reason: {0}' -f $setupFailure.Exception.Message)
    }
    else {
        Write-Host '[MCP-LOCAL] Configuration contents are hidden. Check the existing proxy JSON locally.'
    }
    exit 1
}
