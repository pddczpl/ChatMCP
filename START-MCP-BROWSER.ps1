#requires -Version 5.1
<#
Starts the Cloud Harness browser proxy with a narrow MCP SuperAssistant fix.

The first run installs mcp-superassistant-proxy 0.1.8 into a private local
folder under deploy/.generated/browser-proxy-compat. Later runs reuse it.
The adapter omits only each tool's top-level outputSchema from tools/list.
Input schemas, tool calls, tool results, and upstream authentication are kept.

Uses the existing mcp-client.proxy.json (local Docker ingress configuration).
Stop the previous proxy before running this script. Keep Docker running.

Run from PowerShell:
  & 'F:\Personal_Project\Vin\ChatMCP\START-MCP-BROWSER.ps1'

This file contains no credentials. It reads and masks configured header values.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = 'F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp',
    [ValidateRange(1024, 65535)]
    [int]$Port = 3006
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$redactions = @()
$phase = 'checking local prerequisites'

function Write-SafeLine {
    param([object]$Value)

    try {
        $safeLine = [string]$Value
        foreach ($secret in $redactions) {
            if (-not [string]::IsNullOrWhiteSpace($secret)) {
                $safeLine = $safeLine.Replace($secret, '[REDACTED]')
            }
        }
        if ($safeLine -match '(?i)\bheaders?\b|\bauthorization\b|\bbearer\b') {
            $safeLine = '[Proxy authentication details hidden]'
        }
        Write-Host $safeLine
    }
    catch {
        Write-Host '[Log line hidden]'
    }
}

function Invoke-SafeNative {
    param(
        [string]$Executable,
        [string[]]$ArgumentList
    )

    $savedPreference = $ErrorActionPreference
    $nativeExitCode = $null
    try {
        # Windows PowerShell can otherwise treat normal native stderr as fatal.
        $ErrorActionPreference = 'Continue'
        & $Executable @ArgumentList 2>&1 | ForEach-Object {
            Write-SafeLine -Value $_
        }
        $nativeExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $savedPreference
    }
    if ($nativeExitCode -ne 0) {
        Write-Host ('Native process exit code: {0}' -f $nativeExitCode)
        throw 'Native process failed. See the sanitized output above.'
    }
}

try {
    $nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $npmPath = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $generated = Join-Path $RepoRoot 'deploy\.generated'
    $configPath = Join-Path $generated 'mcp-client.proxy.json'
    $runtimeDirectory = Join-Path $generated 'browser-proxy-compat'

    $phase = 'reading mcp-client.proxy.json'
    $config = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
    $cloudServer = $config.mcpServers.'cloud-harness'
    $authorization = [string]$cloudServer.headers.Authorization
    if ($authorization -notmatch '(?i)^Bearer\s+\S+$') {
        throw 'The cloud-harness Bearer configuration is missing.'
    }
    if ([string]$cloudServer.url -notmatch '^http://127\.0\.0\.1:[0-9]+/mcp/?$') {
        Write-Host 'Expected the existing local Docker MCP URL in mcp-client.proxy.json.'
        throw 'Unexpected upstream URL.'
    }

    foreach ($entry in $config.mcpServers.PSObject.Properties) {
        $headerProperty = $entry.Value.PSObject.Properties['headers']
        if ($null -eq $headerProperty -or $null -eq $headerProperty.Value) {
            continue
        }
        foreach ($header in $headerProperty.Value.PSObject.Properties) {
            $value = [string]$header.Value
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                $redactions += $value
                $redactions += ($value -replace '(?i)^Bearer\s+', '')
            }
        }
    }
    $redactions = @($redactions | Sort-Object -Property Length -Descending)

    $phase = 'checking the browser proxy port'
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
        Write-Host ('Port {0} is already in use. Press Ctrl+C in the OLD proxy window, then run this script again.' -f $Port)
        return
    }

    [IO.Directory]::CreateDirectory($runtimeDirectory) | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $packageManifest = Join-Path $runtimeDirectory 'package.json'
    if (-not (Test-Path -LiteralPath $packageManifest -PathType Leaf)) {
        [IO.File]::WriteAllText(
            $packageManifest,
            '{"name":"cloud-harness-browser-compat","version":"1.0.0","private":true}',
            $utf8
        )
    }

    $installedManifest = Join-Path $runtimeDirectory 'node_modules\@srbhptl39\mcp-superassistant-proxy\package.json'
    $needsInstall = $true
    if (Test-Path -LiteralPath $installedManifest -PathType Leaf) {
        try {
            $installed = [IO.File]::ReadAllText($installedManifest) | ConvertFrom-Json
            $needsInstall = ([string]$installed.version -ne '0.1.8')
        }
        catch {
            $needsInstall = $true
        }
    }

    if ($needsInstall) {
        $phase = 'installing the pinned browser proxy package'
        Write-Host '[MCP-COMPAT] Installing the local proxy package (first run only)...'
        Invoke-SafeNative -Executable $npmPath -ArgumentList @(
            'install', '--prefix', $runtimeDirectory,
            '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel', 'error',
            '--save-exact', '@srbhptl39/mcp-superassistant-proxy@0.1.8'
        )
    }

    $phase = 'writing the browser compatibility adapter'
    $adapterPath = Join-Path $runtimeDirectory 'browser-compat.mjs'
    $adapterSource = @'
import { readFile } from 'node:fs/promises';

const packageRoot = new URL(
  './node_modules/@srbhptl39/mcp-superassistant-proxy/',
  import.meta.url,
);
const manifest = JSON.parse(
  await readFile(new URL('package.json', packageRoot), 'utf8'),
);
if (manifest.version !== '0.1.8') {
  throw new Error('Expected mcp-superassistant-proxy version 0.1.8.');
}

const { McpServerManager } = await import(
  new URL('dist/lib/mcpServerManager.js', packageRoot).href
);
const originalHandleRequest = McpServerManager.prototype.handleRequest;
if (typeof originalHandleRequest !== 'function') {
  throw new Error('Unsupported proxy module layout.');
}

let reportedTools = false;
McpServerManager.prototype.handleRequest = async function (request) {
  const response = await originalHandleRequest.call(this, request);
  if (request?.method !== 'tools/list' || !Array.isArray(response?.result?.tools)) {
    return response;
  }

  let removed = 0;
  const tools = response.result.tools.map((tool) => {
    const copy = { ...tool };
    if (Object.prototype.hasOwnProperty.call(copy, 'outputSchema')) {
      delete copy.outputSchema;
      removed += 1;
    }
    return copy;
  });

  if (!reportedTools) {
    console.log(`[MCP-COMPAT] Browser tools: ${tools.length}; outputSchema removed: ${removed}`);
    reportedTools = true;
  }

  return { ...response, result: { ...response.result, tools } };
};

console.log('[MCP-COMPAT] Browser compatibility adapter enabled.');
// Import AFTER applying the adapter. The original CLI reads the same argv.
await import(new URL('dist/index.js', packageRoot).href);
'@
    [IO.File]::WriteAllText($adapterPath, $adapterSource, $utf8)

    $phase = 'checking the adapter syntax'
    Invoke-SafeNative -Executable $nodePath -ArgumentList @('--check', $adapterPath)

    Write-Host ''
    Write-Host '[MCP-COMPAT] Starting the browser proxy. Keep this window open.'
    Write-Host ('[MCP-COMPAT] Extension: Streamable HTTP | http://127.0.0.1:{0}/mcp' -f $Port)
    $phase = 'running the browser proxy'
    Invoke-SafeNative -Executable $nodePath -ArgumentList @(
        $adapterPath,
        '--config', $configPath,
        '--outputTransport', 'streamableHttp', '--stateful',
        '--host', '127.0.0.1', '--port', ([string]$Port),
        '--logLevel', 'info',
        '--cors', 'https://chatgpt.com',
        'chrome-extension://kngiafgkdnlkgmefdafaibkibegkcaef'
    )
}
catch {
    Write-Host ('[MCP-COMPAT] Stopped during: {0}.' -f $phase)
    Write-Host '[MCP-COMPAT] Review the sanitized messages above. Configuration contents are not printed.'
    exit 1
}
