#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Destination)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# Pinned to the Python Software Foundation's official Windows distribution manifest:
# https://www.python.org/ftp/python/3.11.9/windows-3.11.9.json
$source = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embeddable-amd64.zip'
$expected = '33b448f95fecb7c6f802157dbd5e6b40a2ad9bfc8b95ca634a06ba4073ad1ac0'
$destinationFull = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationFull) {
    throw 'Embedded Python stage destination must be absent before download.'
}
$archivePath = Join-Path ([IO.Path]::GetTempPath()) ('chatmcp-python-' + [guid]::NewGuid().ToString('N') + '.zip')
try {
    # On an approved offline build machine, an identically hashed archive may
    # be provided through this optional build-only environment variable.
    $supplied = $env:CHATMCP_PYTHON_EMBED_ARCHIVE
    if ($supplied) {
        if (-not (Test-Path -LiteralPath $supplied -PathType Leaf)) { throw 'Supplied Python archive does not exist.' }
        Copy-Item -LiteralPath $supplied -Destination $archivePath
    } else {
        Invoke-WebRequest -Uri $source -OutFile $archivePath -UseBasicParsing
    }
    $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw 'Embedded CPython archive SHA-256 mismatch; refusing to package.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        New-Item -ItemType Directory -Path $destinationFull -Force | Out-Null
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName -ne $entry.Name -or $entry.Name -notmatch '^[A-Za-z0-9_.-]+$' -or
                $entry.Name -eq '.' -or $entry.Name -eq '..') {
                throw 'Unexpected archive path in embedded CPython.'
            }
            # Reject Unix symlinks and any non-regular entries in the archive.
            $fileType = (($entry.ExternalAttributes -shr 16) -band 61440)
            if ($fileType -eq 40960) { throw 'Embedded CPython archive contains a symbolic link.' }
            $output = Join-Path $destinationFull $entry.Name
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $output, $false)
        }
    } finally { $zip.Dispose() }
    foreach ($required in @('python.exe','python311.dll','python3.dll','python311.zip','python311._pth')) {
        if (-not (Test-Path -LiteralPath (Join-Path $destinationFull $required) -PathType Leaf)) {
            throw ('Missing embedded CPython component: ' + $required)
        }
    }
    # The stdlib archive must remain zipped; -I must not load system site-packages.
    $embedded = Join-Path $destinationFull 'python.exe'
    $output = & $embedded -I -X utf8 -c "import ast, json, sys; assert sys.version_info[:3] == (3, 11, 9); print(json.dumps({'python': sys.version.split()[0], 'ast': ast.parse('x=1').body[0].__class__.__name__}))"
    if ($LASTEXITCODE -ne 0 -or $output -notmatch '"ast": "Assign"') {
        throw 'Embedded CPython AST smoke failed.'
    }
    Write-Host ('Embedded Python verified: ' + $output)
} finally {
    if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
}
