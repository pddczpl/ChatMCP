#requires -Version 5.1
<#
Builds the CANONICAL DatGold Hub Companion MV3 extension as a standalone ZIP
and verifies exact-source parity with the Windows installer payload.
Never zip the repository root: its legacy manifest.json is a different helper.
Users must extract and manually choose "Load unpacked" in Chrome / Edge.
#>
[CmdletBinding()]
param([switch]$VerifyInstallerPayload)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$extension = Join-Path $root 'DATGOLD-HUB\extension'
$dist = Join-Path $root 'dist'
$filename = 'DatGold-Browser-Companion.zip'
# Releases up to 3.10.2 published this file as ChatMCP-Browser-Companion.zip, and every installed version links to
# releases/latest/download/ChatMCP-Browser-Companion.zip. The old name is therefore published too, as a byte-identical copy
# with a checksum file of its own (a .sha256 file names the file it belongs to). It can go when no supported version links to it.
$legacyFilename = 'ChatMCP-Browser-Companion.zip'
$output = Join-Path $dist $filename
$legacyOutput = Join-Path $dist $legacyFilename
$checksumPath = "$output.sha256"
$legacyChecksumPath = "$legacyOutput.sha256"
$temp = Join-Path $dist ("." + $filename + "." + [Guid]::NewGuid().ToString('N') + '.tmp')

# Explicit allowlist prevents bundling a tracked legacy helper or ignored user
# state such as tokens, profiles and local conversation records.
$files = @(
    'manifest.json',
    'background.js',
    'browser-background.js',
    'browser-popup.js',
    'browser-runner.js',
    'chat-route.js',
    'compat.js',
    'bridge.js',
    'composer.js',
    'hub-wake.js',
    'popup.html',
    'popup.js',
    'popup.css',
    'bridge.css',
    'INSTALL-EXTENSION.txt'
)
$manifest = Get-Content -LiteralPath (Join-Path $extension 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.manifest_version -ne 3 -or $manifest.name -ne 'DatGold Hub Companion' -or
    $manifest.version -notmatch '^\d+\.\d+\.\d+$') {
    throw 'Not the canonical DatGold Hub Companion Manifest V3 source.'
}
if ($manifest.background.service_worker -ne 'background.js' -or
    $manifest.action.default_popup -ne 'popup.html') {
    throw 'Browser companion entrypoints changed. Review and update the package allowlist.'
}
$expectedHosts = @('http://127.0.0.1:3007/*', 'https://chatgpt.com/*')
$hosts = @($manifest.host_permissions)
if (@($hosts | Where-Object { $_ -notin $expectedHosts }).Count -ne 0 -or
    @($hosts).Count -ne 2) {
    throw 'Unexpected browser extension host permissions. Review before release.'
}
$allowedPermissions = @('storage','alarms','scripting')
if (@($manifest.permissions | Where-Object { $_ -notin $allowedPermissions }).Count -ne 0) {
    throw 'Unexpected browser extension permissions. Review before release.'
}
$declared = @($manifest.background.service_worker, $manifest.action.default_popup)
foreach ($script in $manifest.content_scripts) {
    $declared += @($script.js)
    # MV3 content_scripts.css is optional. PowerShell StrictMode throws when
    # reading an absent PSObject property, even with an @() wrapper.
    if ($null -ne $script.PSObject.Properties['css']) {
        $declared += @($script.css)
    }
}
$declared += @('browser-background.js', 'popup.css', 'popup.js', 'browser-popup.js', 'chat-route.js')
foreach ($name in ($declared | Select-Object -Unique)) {
    if ($name -notin $files) { throw "Required browser source is missing from release archive: $name" }
}
$srcHashes = @{}
foreach ($name in $files) {
    if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Unsafe extension archive name: $name" }
    $file = Join-Path $extension $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing Browser Companion source: $name" }
    if (((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing linked extension source: $name"
    }
    $srcHashes[$name] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
}
if (-not (Test-Path -LiteralPath $dist -PathType Container)) {
    New-Item -ItemType Directory -Path $dist -Force | Out-Null
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-ZipParity {
    param(
        [Parameter(Mandatory=$true)][string]$ZipPath,
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Prefix,
        [Parameter(Mandatory=$true)][hashtable]$ExpectedHashes,
        [switch]$ExactContents
    )
    $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $entries = @($archive.Entries)
        # .NET Framework ZipFile.CreateFromDirectory on Windows may preserve
        # Windows backslashes in payload.zip entry names. Normalize *names
        # only*, not ZIP bytes or source filenames, before matching.
        $names = @($entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        foreach ($name in $ExpectedHashes.Keys) {
            $entryName = $Prefix + $name
            $matches = @($entries | Where-Object { $_.FullName.Replace('\','/') -ceq $entryName })
            if ($matches.Count -ne 1) {
                throw "Extension archive entry missing or duplicated: $entryName"
            }
            $entry = $matches[0]
            if ($null -eq $entry -or $entry.Length -le 0) { throw "Invalid extension entry: $entryName" }
            $stream = $entry.Open()
            $sha = [Security.Cryptography.SHA256]::Create()
            try {
                $bytes = $sha.ComputeHash($stream)
                $actual = ([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
                if ($actual -ne $ExpectedHashes[$name]) { throw "Extension source mismatch: $entryName" }
            } finally { $sha.Dispose(); $stream.Dispose() }
        }
        if ($ExactContents -and $names.Count -ne $ExpectedHashes.Count) {
            throw "Browser ZIP must contain only $($ExpectedHashes.Count) verified source files; got $($names.Count)."
        }
    } finally { $archive.Dispose() }
}

try {
    $archive = [IO.Compression.ZipFile]::Open($temp, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $files) {
            $source = Join-Path $extension $name
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $source, $name, [IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $archive.Dispose() }
    Assert-ZipParity -ZipPath $temp -Prefix '' -ExpectedHashes $srcHashes -ExactContents

    if ($VerifyInstallerPayload) {
        $installerPayload = Join-Path $root 'installer\payload.zip'
        if (-not (Test-Path -LiteralPath $installerPayload -PathType Leaf)) {
            throw 'Windows installer payload.zip is missing; build the installer first.'
        }
        # Prove users installing the EXE get identical extension source, not an
        # older or unrelated copy bundled in the installer.
        Assert-ZipParity -ZipPath $installerPayload -Prefix 'CHATMCP-HUB/extension/' -ExpectedHashes $srcHashes
    }
    if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
    Move-Item -LiteralPath $temp -Destination $output
    $sha256 = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($checksumPath, "$sha256  $filename" + [Environment]::NewLine, [Text.Encoding]::ASCII)
    Copy-Item -LiteralPath $output -Destination $legacyOutput -Force
    if ((Get-FileHash -LiteralPath $legacyOutput -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) { throw 'The copy under the old file name differs from the archive.' }
    [IO.File]::WriteAllText($legacyChecksumPath, "$sha256  $legacyFilename" + [Environment]::NewLine, [Text.Encoding]::ASCII)
    Write-Host "Verified Browser Companion v$($manifest.version) ZIP: $output"
    Write-Host "Same bytes under the old name, which installed versions link to: $legacyOutput"
    Write-Host "SHA-256: $sha256"
    Write-Host 'Manual install only: extract ZIP and choose its folder through chrome://extensions or edge://extensions > Load unpacked.'
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
}
