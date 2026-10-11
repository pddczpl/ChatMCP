#requires -Version 5.1
<#
.SYNOPSIS
  Fetches or verifies the pinned Cloud Harness MCP checkout described in deps\cloud-harness.lock.json.

.DESCRIPTION
  Destination missing: shallow-clones the pinned tag, then verifies the commit hash.
  Destination present: verifies only (commit hash, unmodified tracked files, LICENSE hash).
  Nothing is modified or deleted. Use -Destination to verify an existing checkout, for example
  the cloud-harness-mcp folder next to this repository.

.PARAMETER Destination
  Default: <repo>\.deps\cloud-harness-mcp (ignored by Git).

.PARAMETER LockFile
  Default: <repo>\deps\cloud-harness.lock.json (the tests override it).
#>
[CmdletBinding()]
param(
    [string]$Destination,
    [string]$LockFile
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $LockFile) { $LockFile = Join-Path $root 'deps\cloud-harness.lock.json' }
if (-not $Destination) { $Destination = Join-Path $root '.deps\cloud-harness-mcp' }
$Destination = [IO.Path]::GetFullPath($Destination)

function Fail([string]$Message) { throw "bootstrap-cloud-harness: $Message" }
function Invoke-Git([string[]]$GitArguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = & git @GitArguments 2>&1 | ForEach-Object { $_.ToString() }; $code = $LASTEXITCODE }
    finally { $ErrorActionPreference = $previous }
    if ($code -ne 0) { Fail ("git {0} failed: {1}" -f ($GitArguments -join ' '), ($output -join ' ')) }
    return ($output -join "`n").Trim()
}

if ($null -eq (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git is required' }
if (-not (Test-Path -LiteralPath $LockFile -PathType Leaf)) { Fail "lock file not found: $LockFile" }
$lock = [IO.File]::ReadAllText($LockFile) | ConvertFrom-Json
foreach ($name in 'repository', 'tag', 'commit', 'licenseFile', 'licenseSha256') {
    if (-not $lock.PSObject.Properties[$name] -or -not $lock.$name) { Fail 'lock file is incomplete' }
}

if (Test-Path -LiteralPath $Destination) {
    $null = Invoke-Git @('-C', $Destination, 'rev-parse', '--git-dir')
    $mode = 'verified existing checkout'
}
else {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    $null = Invoke-Git @('-c', 'core.autocrlf=false', '-c', 'protocol.file.allow=always', 'clone', '--quiet', '--depth', '1', '--branch', $lock.tag, $lock.repository, $Destination)
    $mode = 'cloned'
}

$head = Invoke-Git @('-C', $Destination, 'rev-parse', 'HEAD')
if ($head -ne $lock.commit) { Fail ("HEAD is {0} but the lock requires {1} ({2}). Nothing was deleted; inspect or remove {3} yourself." -f $head, $lock.commit, $lock.tag, $Destination) }
$dirty = Invoke-Git @('-C', $Destination, 'status', '--porcelain', '--untracked-files=no')
if ($dirty) { Fail "tracked files in $Destination were modified. ChatMCP requires an unmodified pinned checkout." }
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Destination $lock.licenseFile)).Hash.ToLowerInvariant()
if ($actual -ne $lock.licenseSha256.ToLowerInvariant()) {
    $raw = [IO.File]::ReadAllText((Join-Path $Destination $lock.licenseFile))
    $norm = $raw -replace "`r`n", "`n"
    $hasher = [Security.Cryptography.SHA256]::Create()
    $normHash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($norm))).Replace('-', '').ToLowerInvariant()
    if ($normHash -ne $lock.licenseSha256.ToLowerInvariant()) {
        Fail "$($lock.licenseFile) hash differs from the lock; review the license before using this checkout."
    }
}

Write-Host ("OK ({0}): {1} {2} @ {3}, {4} license verified, at {5}" -f $mode, $lock.name, $lock.tag, $lock.commit.Substring(0, 12), $lock.license, $Destination)
