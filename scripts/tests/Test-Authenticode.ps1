#requires -Version 5.1
# CI only: negative controls, NEVER a mock public code-signing certificate.
[CmdletBinding()]
param()
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$signer = [IO.Path]::GetFullPath((Join-Path $scriptDir '..\Sign-Authenticode.ps1'))
$parseErrors = $null
$tokens = $null
$null = [Management.Automation.Language.Parser]::ParseFile($signer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) {
    throw 'Authenticode signing script contains PowerShell syntax errors.'
}
Write-Host 'PASS: Authenticode helper passes PowerShell parser checks.'

$scratch = Join-Path ([IO.Path]::GetTempPath()) ('ChatMCP-SigningTest-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
$unsigned = Join-Path $scratch 'ChatMCPSetup.exe'

function Require-Failure {
    param([scriptblock]$Action, [string]$Description)
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    if (-not $failed) { throw ('Signing guard must fail closed: ' + $Description) }
    Write-Host ('PASS: ' + $Description)
}

try {
    [IO.File]::WriteAllBytes($unsigned, ([byte[]]@(0x4D, 0x5A, 0x00, 0x00, 0x01, 0x02, 0x03)))
    $hashBefore = (Get-FileHash -LiteralPath $unsigned -Algorithm SHA256).Hash
    Require-Failure { & $signer -FilePath $unsigned -VerifyOnly -WriteChecksum } 'unsigned bytes are never treated as a signed release'
    Require-Failure { & $signer -FilePath $unsigned } 'signing cannot proceed without owner certificate thumbprint'
    Require-Failure { & $signer -FilePath (Join-Path $scratch 'missing\ChatMCPSetup.exe') -VerifyOnly } 'missing binary is rejected'
    $hashAfter = (Get-FileHash -LiteralPath $unsigned -Algorithm SHA256).Hash
    if ($hashBefore -ne $hashAfter) { throw 'Failed signing attempts modified the binary.' }
    if (Test-Path -LiteralPath ($unsigned + '.sha256')) {
        throw 'A failed signature check must not produce a distributable checksum.'
    }
    Write-Host 'PASS: rejected signatures cannot alter bytes or publish a checksum.'
    Write-Host 'PASS: Authenticode fail-closed regression (4 checks, no trusted signer required).'
} finally {
    if ((Split-Path -Leaf $scratch) -notmatch '^ChatMCP-SigningTest-[0-9a-f]{32}$') {
        throw 'Refusing cleanup outside this test fixture directory.'
    }
    if (Test-Path -LiteralPath $scratch) {
        Remove-Item -LiteralPath $scratch -Recurse -Force
    }
}
