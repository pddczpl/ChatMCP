#requires -Version 5.1
# Authenticode signing gate for the ChatMCP Windows setup executable.
# A trusted CA-issued Code Signing certificate and access to its private key
# are mandatory for -CertificateThumbprint. NEVER use self-signed test
# certificates for public releases; CI signing tests are not publisher proof.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$FilePath,

    # Certificate in the CurrentUser\My store; hardware-token/HSM providers
    # can expose a private key here without exporting it.
    [string]$CertificateThumbprint = '',

    # Use when a trusted remote service/HSM has already signed the binary.
    [switch]$VerifyOnly,

    # Exact certificate common name (CN), not a substring of the subject.
    [string]$ExpectedPublisher = '',

    # RFC3161 timestamp endpoint; supply one authorized by your CA.
    [string]$TimestampUrl = 'http://timestamp.digicert.com',

    # Only after successful chain, signature, and timestamp verification.
    [switch]$WriteChecksum
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Find-SignTool {
    $kitRoot = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Windows Kits\10\bin'
    if (Test-Path -LiteralPath $kitRoot -PathType Container) {
        $candidates = @(Get-ChildItem -LiteralPath $kitRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object -Property Name -Descending)
        foreach ($item in $candidates) {
            $candidate = Join-Path $item.FullName 'x64\signtool.exe'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
    $inPath = Get-Command signtool.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($inPath) { return $inPath.Source }
    throw 'SignTool.exe was not found. Install the Microsoft Windows SDK before signing.'
}

function Assert-PublisherName {
    param(
        [System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate,
        [string]$ExpectedName
    )
    if ($ExpectedName) {
        $actual = $Certificate.GetNameInfo(
            [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
            $false
        )
        if (-not [string]::Equals($actual, $ExpectedName, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Code Signing certificate common name does not exactly match -ExpectedPublisher.'
        }
    }
}

function Normalize-Thumbprint {
    param([string]$Value)
    $normal = ($Value -replace '\s', '').ToUpperInvariant()
    if ($normal -and $normal -notmatch '^[0-9A-F]{40}$') {
        throw 'The code-signing certificate thumbprint must be exactly 40 hexadecimal characters.'
    }
    return $normal
}

if ($env:OS -ne 'Windows_NT') {
    throw 'Authenticode signing and verification require a Windows OS.'
}

$target = [IO.Path]::GetFullPath($FilePath)
if (([IO.Path]::GetFileName($target)) -cne 'ChatMCPSetup.exe') {
    throw 'This signing gate only accepts the exact ChatMCPSetup.exe filename.'
}
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw 'ChatMCPSetup.exe does not exist at the supplied path.'
}

$thumbprint = Normalize-Thumbprint $CertificateThumbprint
if (($VerifyOnly -or $WriteChecksum) -and -not $thumbprint -and [string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
    throw 'Release verification requires an exact -ExpectedPublisher common name or -CertificateThumbprint.'
}
$before = Get-AuthenticodeSignature -LiteralPath $target
if (-not $VerifyOnly) {
    if (-not $thumbprint) {
        throw 'Signing requires -CertificateThumbprint for a trusted Code Signing certificate in CurrentUser\My.'
    }
    if ($before.Status -ne 'NotSigned') {
        throw 'Refusing to overwrite or re-sign an existing signature; use -VerifyOnly to check it.'
    }
    if (-not [Uri]::IsWellFormedUriString($TimestampUrl, [UriKind]::Absolute)) {
        throw 'A valid RFC3161 timestamp URL is required.'
    }

    $cert = Get-Item -LiteralPath ("Cert:\CurrentUser\My\" + $thumbprint) -ErrorAction SilentlyContinue
    if (-not $cert) { throw 'The Code Signing certificate was not found in CurrentUser\My.' }
    if (-not $cert.HasPrivateKey) { throw 'Certificate has no private key; use the HSM/token that owns it.' }
    if ((Get-Date) -lt $cert.NotBefore -or (Get-Date) -ge $cert.NotAfter) {
        throw 'Code Signing certificate has expired or is not yet valid.'
    }
    if (@($cert.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq '1.3.6.1.5.5.7.3.3' }).Count -lt 1) {
        throw 'Certificate lacks the Code Signing extended key usage (1.3.6.1.5.5.7.3.3).'
    }
    Assert-PublisherName -Certificate $cert -ExpectedName $ExpectedPublisher

    $signtool = Find-SignTool
    & $signtool sign /sha1 $thumbprint /s My /fd SHA256 /tr $TimestampUrl /td SHA256 /d 'ChatMCP Studio' $target
    if ($LASTEXITCODE -ne 0) { throw "SignTool failed to sign ChatMCPSetup.exe (exit $LASTEXITCODE)." }
}

# ALWAYS inspect real Authenticode metadata after the signing attempt.
$signature = Get-AuthenticodeSignature -LiteralPath $target
if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
    throw "Authenticode signature is not valid or trusted on this Windows machine (status: $($signature.Status))."
}
if (-not $signature.TimeStamperCertificate) {
    throw 'The Authenticode signature has no verifiable timestamp; refusing release.'
}
if ($thumbprint -and $signature.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $thumbprint) {
    throw 'Unexpected publisher certificate thumbprint.'
}
Assert-PublisherName -Certificate $signature.SignerCertificate -ExpectedName $ExpectedPublisher
$signtool = Find-SignTool
& $signtool verify /pa /tw /v $target
if ($LASTEXITCODE -ne 0) {
    throw "SignTool Authenticode chain/policy verification failed (exit $LASTEXITCODE)."
}

$sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
if ($WriteChecksum) {
    $checksum = $target + '.sha256'
    [IO.File]::WriteAllText(
        $checksum,
        ($sha256 + '  ChatMCPSetup.exe' + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
    Write-Host 'Wrote checksum for the verified signed binary.'
}
Write-Host 'Authenticode signature: Valid (trusted chain and timestamp present).'
Write-Host ('Publisher: ' + $signature.SignerCertificate.Subject)
Write-Host ('Signed installer SHA-256: ' + $sha256)
