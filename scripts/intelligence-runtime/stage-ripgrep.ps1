#requires -Version 5.1
[CmdletBinding()]
param([string]$Destination = '')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# ripgrep for the search_files and find_files tools (DATGOLD-HUB/lib/ripgrep.mjs looks for DATGOLD-HUB/runtimes/ripgrep/rg.exe).
# Pinned to the official release of https://github.com/BurntSushi/ripgrep; the SHA-256 is the digest GitHub states for the asset
# ripgrep-15.2.0-x86_64-pc-windows-msvc.zip (1,789,611 bytes), checked against the file that is downloaded or supplied.
$source = 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip'
$expected = '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5'
$expectedVersion = '15.2.0'

# ripgrep is dual-licensed MIT OR Unlicense. Its archive has a folder of its own; only these files are taken, from the top of the archive
# or from the one folder below it, and both licence texts must be among them.
$wanted = @('rg.exe', 'COPYING', 'LICENSE-MIT', 'UNLICENSE')
$required = @('rg.exe', 'LICENSE-MIT', 'UNLICENSE')

function Read-ZipEntryText {
    param([Parameter(Mandatory = $true)]$Entry)
    $reader = New-Object System.IO.StreamReader($Entry.Open(), [System.Text.Encoding]::UTF8)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Expand-RipgrepArchive {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$Target
    )
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $found = @{}
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($name.StartsWith('/') -or $name -match '^[A-Za-z]:' -or $name -match '(^|/)\.\.(/|$)') {
                throw 'Unexpected archive path in ripgrep.'
            }
            # Reject Unix symlinks and any non-regular entries wherever they are in the archive.
            $fileType = (($entry.ExternalAttributes -shr 16) -band 61440)
            if ($fileType -eq 40960) { throw 'The ripgrep archive contains a symbolic link.' }
            if ($name.EndsWith('/')) { continue }
            $parts = $name.Split('/')
            $leaf = $parts[$parts.Length - 1]
            if ($parts.Length -gt 2 -or $wanted -notcontains $leaf) { continue }
            if ($found.ContainsKey($leaf)) { throw ('The ripgrep archive holds more than one ' + $leaf) }
            $found[$leaf] = $entry
        }
        foreach ($name in $required) {
            if (-not $found.ContainsKey($name)) { throw ('Missing ripgrep component: ' + $name) }
        }
        # The licence texts are redistributed with the binary, so they must be what they say. They are read before anything is extracted.
        $mit = Read-ZipEntryText $found['LICENSE-MIT']
        if ($mit.Length -lt 256 -or $mit -notmatch 'Permission is hereby granted, free of charge') {
            throw 'ripgrep LICENSE-MIT is empty or is not the MIT licence text; refusing to package.'
        }
        $unlicense = Read-ZipEntryText $found['UNLICENSE']
        if ($unlicense.Length -lt 256 -or $unlicense -notmatch 'free and unencumbered software released into the public domain') {
            throw 'ripgrep UNLICENSE is empty or is not the Unlicense text; refusing to package.'
        }
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
        foreach ($name in $found.Keys) {
            [IO.Compression.ZipFileExtensions]::ExtractToFile($found[$name], (Join-Path $Target $name), $false)
        }
    } finally { $zip.Dispose() }
}

function Test-RipgrepBinary {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$Version
    )
    $output = & $Executable --version
    if ($LASTEXITCODE -ne 0 -or ($output | Select-Object -First 1) -notmatch ('^ripgrep ' + [regex]::Escape($Version) + '(\s|$)')) {
        throw ('The staged rg.exe does not report ripgrep ' + $Version + '.')
    }
    Write-Host ('ripgrep verified: ' + ($output | Select-Object -First 1))
}

# Dot-sourcing this file (the tests do) defines the functions and runs nothing.
if ($MyInvocation.InvocationName -ne '.') {
    if (-not $Destination) { throw 'A -Destination folder is required.' }
    $destinationFull = [IO.Path]::GetFullPath($Destination)
    if (Test-Path -LiteralPath $destinationFull) {
        throw 'ripgrep stage destination must be absent before download.'
    }
    $archivePath = Join-Path ([IO.Path]::GetTempPath()) ('chatmcp-ripgrep-' + [guid]::NewGuid().ToString('N') + '.zip')
    try {
        # On an approved offline build machine, an identically hashed archive may
        # be provided through this optional build-only environment variable.
        $supplied = $env:CHATMCP_RIPGREP_ARCHIVE
        if ($supplied) {
            if (-not (Test-Path -LiteralPath $supplied -PathType Leaf)) { throw 'Supplied ripgrep archive does not exist.' }
            Copy-Item -LiteralPath $supplied -Destination $archivePath
        } else {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $source -OutFile $archivePath -UseBasicParsing
        }
        $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { throw 'ripgrep archive SHA-256 mismatch; refusing to package.' }
        Expand-RipgrepArchive -ArchivePath $archivePath -Target $destinationFull
        Test-RipgrepBinary -Executable (Join-Path $destinationFull 'rg.exe') -Version $expectedVersion
    } finally {
        if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
    }
}
