#requires -Version 5.1
<#
.SYNOPSIS
  Rotates the Cloud Harness owner bearer token (MCP_BEARER_TOKEN) and the local MCP client
  configuration files that carry it.

.DESCRIPTION
  DRY RUN BY DEFAULT: without -Apply the script only reports which files would change.
  The script never prints a token, never touches Git, and never deletes anything.

  With -Apply it
    1. copies .env and every file it is about to change into
       deploy\.generated\rotation-backup-<UTC time>,
    2. writes a new random 64-character token to .env (MCP_BEARER_TOKEN) and replaces the old
       token inside the local MCP client files deploy\.generated\mcp-client*.json and
       deploy\.generated\chatmcp-hub\mcp-client*.json,
    3. unless -SkipRestart is given, recreates the Docker services and checks that
       http://127.0.0.1:3100/mcp accepts the new token and rejects the old one.
  If a write fails, the files already changed are restored from the backup.

  Recreating the services restarts the Cloud Harness containers (the runner reads .env too).
  Run it when no job you care about is active.

.PARAMETER RepoRoot
  Cloud Harness checkout. Default: ..\cloud-harness-mcp next to this script's parent folder.

.PARAMETER Apply
  Perform the rotation. Without it the script is read-only.

.PARAMETER SkipRestart
  Do not restart Docker or call the endpoint (used by the automated tests).
#>
[CmdletBinding()]
param(
    [string]$RepoRoot,
    [switch]$Apply,
    [switch]$SkipRestart
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
# $PSScriptRoot is not reliable inside a param() default under Windows PowerShell 5.1 -File, so resolve it here.
if (-not $RepoRoot) { $RepoRoot = Join-Path $PSScriptRoot '..\cloud-harness-mcp' }

function Write-Line([string]$Message) { Write-Host $Message }

$repo = [IO.Path]::GetFullPath($RepoRoot)
$envFile = Join-Path $repo '.env'
$generated = Join-Path $repo 'deploy\.generated'
$utf8 = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw "The private .env file was not found in $repo" }
$envText = [IO.File]::ReadAllText($envFile)
$authMode = [regex]::Match($envText, '(?m)^AUTH_MODE=([^\r\n]*)').Groups[1].Value.Trim()
if ($authMode -ne 'owner-bearer') { throw "AUTH_MODE is '$authMode'. This script only rotates the owner-bearer token." }
$tokenMatch = [regex]::Match($envText, '(?m)^MCP_BEARER_TOKEN=([^\r\n]*)')
if (-not $tokenMatch.Success) { throw 'MCP_BEARER_TOKEN is not set in .env.' }
$oldToken = $tokenMatch.Groups[1].Value.Trim().Trim('"').Trim("'")
if ($oldToken.Length -lt 16) { throw 'MCP_BEARER_TOKEN in .env is empty or too short to be a real token.' }

# Local MCP client files that embed the token. Backup files (*.bak) are reported but never edited.
$clientDirectories = @($generated, (Join-Path $generated 'chatmcp-hub')) | Where-Object { Test-Path -LiteralPath $_ -PathType Container }
$targets = New-Object System.Collections.ArrayList
$staleBackups = 0
foreach ($directory in $clientDirectories) {
    foreach ($file in @(Get-ChildItem -LiteralPath $directory -Filter 'mcp-client*' -File)) {
        $text = [IO.File]::ReadAllText($file.FullName)
        if (-not $text.Contains($oldToken)) { continue }
        if ($file.Extension -eq '.json') { [void]$targets.Add($file) } else { $staleBackups++ }
    }
}

Write-Line ('Mode: ' + $(if ($Apply) { 'APPLY' } else { 'DRY RUN (nothing will be changed)' }))
Write-Line "Repository: $repo"
Write-Line '.env: MCP_BEARER_TOKEN will be replaced by a new random 64-character token.'
Write-Line ("Client files containing the old token: {0}" -f $targets.Count)
foreach ($file in $targets) { Write-Line ('  ' + $file.FullName.Substring($repo.Length).TrimStart('\', '/')) }
Write-Line ("Backup/old copies containing the old token (not modified): {0}" -f $staleBackups)

if (-not $Apply) {
    Write-Line 'Re-run with -Apply to rotate. Nothing was changed.'
    return
}

$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$backup = Join-Path $generated ('rotation-backup-' + $stamp)
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$saved = @{}
$changed = New-Object System.Collections.ArrayList
function Save-Copy([string]$Path) {
    $relative = $Path.Substring($repo.Length).TrimStart('\', '/') -replace '[\\/:]', '__'
    $destination = Join-Path $backup $relative
    Copy-Item -LiteralPath $Path -Destination $destination
    $saved[$Path] = $destination
}

$bytes = New-Object byte[] 48
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
$generator.GetBytes($bytes)
$generator.Dispose()
$newToken = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

try {
    Save-Copy $envFile
    foreach ($file in $targets) { Save-Copy $file.FullName }

    $newEnv = [regex]::Replace($envText, '(?m)^MCP_BEARER_TOKEN=[^\r\n]*', [Text.RegularExpressions.MatchEvaluator] { param($m) 'MCP_BEARER_TOKEN=' + $newToken })
    [IO.File]::WriteAllText($envFile, $newEnv, $utf8)
    [void]$changed.Add($envFile)

    foreach ($file in $targets) {
        $updated = [IO.File]::ReadAllText($file.FullName).Replace($oldToken, $newToken)
        $null = $updated | ConvertFrom-Json   # must still be valid JSON
        [IO.File]::WriteAllText($file.FullName, $updated, $utf8)
        [void]$changed.Add($file.FullName)
    }
}
catch {
    foreach ($path in $changed) { Copy-Item -LiteralPath $saved[$path] -Destination $path -Force }
    throw ("Rotation failed and the changed files were restored from {0}: {1}" -f $backup, $_.Exception.Message)
}
Write-Line ("Token rotated in .env and {0} client file(s). Backup (contains the OLD token and other secrets): {1}" -f $targets.Count, $backup)

if ($SkipRestart) {
    Write-Line 'Restart and verification skipped (-SkipRestart).'
    return
}

function Get-McpStatus([string]$Token) {
    $body = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"token-rotation-check","version":"1"}}}'
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3100/mcp' -Method Post -Body $body -ContentType 'application/json' `
            -Headers @{ Authorization = ('Bearer ' + $Token); Accept = 'application/json, text/event-stream' } -UseBasicParsing -TimeoutSec 20
        return [int]$response.StatusCode
    }
    catch [System.Net.WebException] {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return -1
    }
}

$docker = (Get-Command docker.exe -CommandType Application -ErrorAction Stop).Source
$composeFiles = @('-f', (Join-Path $repo 'compose.yaml'))
$override = Join-Path $repo 'compose.override.yaml'
if (Test-Path -LiteralPath $override -PathType Leaf) { $composeFiles += @('-f', $override) }
Write-Line 'Recreating Cloud Harness services (this restarts the containers)...'
& $docker compose --project-directory $repo --env-file $envFile @composeFiles up -d --wait --wait-timeout 180 runner api ingress provisioning-proxy
if ($LASTEXITCODE -ne 0) { throw "docker compose failed with exit code $LASTEXITCODE. The new token is already in .env; fix Docker and run 'docker compose up -d' again." }

$newStatus = -1
for ($attempt = 0; $attempt -lt 15 -and $newStatus -ne 200; $attempt++) {
    $newStatus = Get-McpStatus $newToken
    if ($newStatus -ne 200) { Start-Sleep -Seconds 2 }
}
$oldStatus = Get-McpStatus $oldToken
Write-Line ("Endpoint check: new token -> HTTP {0}; old token -> HTTP {1}" -f $newStatus, $oldStatus)
if ($newStatus -ne 200) { throw 'The new token is not accepted yet. Check the containers (docker compose ps).' }
if ($oldStatus -eq 200) { throw 'The OLD token is still accepted. Do not use this deployment until that is fixed.' }
Write-Line 'Rotation verified.'
Write-Line 'Next: restart ChatMCP Hub and the browser proxy, update any external client that stores the old token'
Write-Line '(Claude Code / Codex config, CLOUD_HARNESS_MCP_TOKEN, ChatGPT connectors), stop the quick tunnel when it is not needed,'
Write-Line 'and delete deploy\.generated\rotation-backup-* and the mcp-client*.bak files after you are satisfied.'
