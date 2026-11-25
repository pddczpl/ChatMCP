<#
.SYNOPSIS
  Derives every value of a DatGold release from the repository, so that .github/workflows/release.yml hard-codes none of them.

.DESCRIPTION
  Up to v3.11.2 every release had its own hand-written publish-vX.Y.Z.yml in which the version, the Companion version, the title and the
  asset names were typed in; the titles were copied by hand from the release notes (the plan's defect E2). This script reads them instead
  and refuses a tree in which they disagree. It checks:

    - the version: X.Y.Z, by default the one in DATGOLD-HUB/package.json, and the same in DATGOLD-HUB/ui/package.json,
      DATGOLD-HUB/ui/package-lock.json (top level and the root package entry), and the one <Version> of desktop-shell/ChatMCP.csproj
      and of installer/ChatMCP.Installer.csproj (the files publish-v3.11.2.yml checked);
    - the Companion version: DATGOLD-HUB/extension/manifest.json, equal to -CompanionVersion when that is given, and equal to the
      version that scripts/tests/Test-NativeLifecycle.ps1 asserts for the installed Companion;
    - docs/releases/RELEASE-NOTES-v<version>.md exists, and the release title is its first H1 (outside code blocks), which must start with
      "DatGold v<version> " and carry "(test build)" exactly when -Prerelease is true; an em or en dash becomes " - ", as in the
      titles that were published;
    - the asset names: the installer that scripts/Build-Installer.ps1 writes to dist must be DatGoldSetup.exe and the archive of
      scripts/Build-BrowserCompanion.ps1 must be DatGold-Browser-Companion.zip; no old-named Companion archive may be built (the owner's
      decision of 2026-10-28, from v3.11.1 on);
    - the upgrade baseline stays the published v3.9.0 ChatMCPSetup.exe pinned by its SHA-256 (the owner's decision); with
      -BaselineRelease (the JSON of `gh api repos/{repo}/releases/tags/v3.9.0`) the digest GitHub records for that asset must equal the pin.

  Every problem is reported on stderr, then the script exits with 1. On success it prints key=value lines on stdout and, with
  -GitHubOutput, appends the same lines to that file (UTF-8, no byte order mark). It runs in PowerShell 7 and in Windows PowerShell 5.1.
  It reads files only; it never starts a build, calls GitHub, or writes anywhere but -GitHubOutput.

.EXAMPLE
  pwsh -NoProfile -File scripts/Resolve-ReleaseInputs.ps1
  pwsh -NoProfile -File scripts/Resolve-ReleaseInputs.ps1 -Version 3.12.0 -Prerelease true -BaselineRelease baseline.json -GitHubOutput $env:GITHUB_OUTPUT
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$Version = '',
    [string]$CompanionVersion = '',
    [string]$Prerelease = 'false',
    [string]$BaselineRelease = '',
    [string]$GitHubOutput = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

# The fixed points of a release. Changing one of them is an owner decision (docs/RELEASING.md).
$InstallerAsset = 'DatGoldSetup.exe'
$CompanionAsset = 'DatGold-Browser-Companion.zip'
$OldCompanionAsset = 'ChatMCP-Browser-Companion.zip'
$ManifestAsset = 'RELEASE-MANIFEST.json'
$BaselineTag = 'v3.9.0'
$BaselineVersion = '3.9.0'
$BaselineAsset = 'ChatMCPSetup.exe'
$BaselineSha256 = 'ef75e9a3721c5ba94a510de1ff00c1449031a4ac797570cb0d901861b509786e'
$SemVer = '^\d+\.\d+\.\d+$'

if ([string]::IsNullOrEmpty($Root)) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path -LiteralPath $Root).Path
$problems = New-Object System.Collections.Generic.List[string]
function Add-Problem([string]$text) { $problems.Add($text) }

function Read-RepoText([string]$relative) {
    $path = Join-Path $Root $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Add-Problem "$relative is missing"; return $null }
    $text = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    return $text -replace "`r`n", "`n"
}

# The top-level "version" of a JSON file, read with a regular expression on purpose: Windows PowerShell 5.1 cannot parse a
# package-lock.json whose keys differ only in case, and only top-level keys are indented by exactly two spaces in npm's output.
function Get-TopLevelJsonVersion([string]$relative) {
    $text = Read-RepoText $relative
    if ($null -eq $text) { return $null }
    $found = [regex]::Matches($text, '(?m)^  "version"\s*:\s*"([^"]*)"')
    if ($found.Count -ne 1) { Add-Problem "$relative has $($found.Count) top-level ""version"" entries, expected exactly one"; return $null }
    return $found[0].Groups[1].Value
}

# ---- the version -------------------------------------------------------------------------------------------------------------------
$hubVersion = Get-TopLevelJsonVersion 'DATGOLD-HUB/package.json'
if ([string]::IsNullOrEmpty($Version)) { $Version = $hubVersion }
$versionValid = ($null -ne $Version) -and ($Version -cmatch $SemVer)
if (-not $versionValid) {
    Add-Problem "the version '$Version' is not X.Y.Z (three numbers, no 'v', no suffix)"
} else {
    if ($null -ne $hubVersion -and $hubVersion -ne $Version) { Add-Problem "DATGOLD-HUB/package.json has version $hubVersion, expected $Version" }
    foreach ($file in @('DATGOLD-HUB/ui/package.json', 'DATGOLD-HUB/ui/package-lock.json')) {
        $found = Get-TopLevelJsonVersion $file
        if ($null -ne $found -and $found -ne $Version) { Add-Problem "$file has version $found, expected $Version" }
    }
    $lock = Read-RepoText 'DATGOLD-HUB/ui/package-lock.json'
    if ($null -ne $lock) {
        $rootEntry = [regex]::Match($lock, '(?ms)^    "": \{\n(.*?)^    \}')
        $rootVersion = if ($rootEntry.Success) { [regex]::Match($rootEntry.Groups[1].Value, '(?m)^      "version"\s*:\s*"([^"]*)"') } else { $null }
        if ($null -eq $rootVersion -or -not $rootVersion.Success) { Add-Problem 'DATGOLD-HUB/ui/package-lock.json has no version in its root package entry (packages."")' }
        elseif ($rootVersion.Groups[1].Value -ne $Version) { Add-Problem "DATGOLD-HUB/ui/package-lock.json root package entry has version $($rootVersion.Groups[1].Value), expected $Version" }
    }
    foreach ($file in @('desktop-shell/ChatMCP.csproj', 'installer/ChatMCP.Installer.csproj')) {
        $text = Read-RepoText $file
        if ($null -eq $text) { continue }
        $found = [regex]::Matches($text, '<Version>([^<]*)</Version>')
        if ($found.Count -ne 1) { Add-Problem "$file has $($found.Count) <Version> elements, expected exactly one"; continue }
        if ($found[0].Groups[1].Value -ne $Version) { Add-Problem "$file has <Version>$($found[0].Groups[1].Value)</Version>, expected $Version" }
    }
}

# ---- pre-release -------------------------------------------------------------------------------------------------------------------
$isPrerelease = $false
if ($Prerelease -ceq 'true') { $isPrerelease = $true }
elseif ($Prerelease -cne 'false') { Add-Problem "-Prerelease must be 'true' or 'false', not '$Prerelease'" }

# ---- the Companion -----------------------------------------------------------------------------------------------------------------
$companion = Get-TopLevelJsonVersion 'DATGOLD-HUB/extension/manifest.json'
if ($null -ne $companion) {
    if ($companion -cnotmatch $SemVer) { Add-Problem "DATGOLD-HUB/extension/manifest.json has version '$companion', which is not X.Y.Z" }
    if (-not [string]::IsNullOrEmpty($CompanionVersion) -and $CompanionVersion -ne $companion) {
        Add-Problem "the Companion version input is $CompanionVersion, but DATGOLD-HUB/extension/manifest.json has $companion"
    }
    $lifecycle = Read-RepoText 'scripts/tests/Test-NativeLifecycle.ps1'
    if ($null -ne $lifecycle) {
        $pin = [regex]::Matches($lifecycle, "manifest\.json'\) -Raw \| ConvertFrom-Json\)\.version -eq '([^']*)'")
        if ($pin.Count -ne 1) { Add-Problem "scripts/tests/Test-NativeLifecycle.ps1 has $($pin.Count) checks of the installed Companion version, expected exactly one (update this script if that check moved)" }
        elseif ($pin[0].Groups[1].Value -ne $companion) { Add-Problem "scripts/tests/Test-NativeLifecycle.ps1 expects the installed Companion $($pin[0].Groups[1].Value), but DATGOLD-HUB/extension/manifest.json has $companion" }
    }
}

# ---- release notes and title -------------------------------------------------------------------------------------------------------
$notesFile = "docs/releases/RELEASE-NOTES-v$Version.md"
$title = $null
if ($versionValid) {
    $notes = Read-RepoText $notesFile
    if ($null -ne $notes) {
        $inFence = $false
        foreach ($line in $notes -split "`n") {
            if ($line -match '^\s*(```|~~~)') { $inFence = -not $inFence; continue }
            if (-not $inFence -and $line -match '^# +(\S.*?)\s*#*\s*$') { $title = $Matches[1]; break }
        }
        if ($null -eq $title) {
            Add-Problem "$notesFile has no H1 (a line '# DatGold v$Version - ...'); the release title is taken from it"
        } else {
            $title = ($title -replace "\s*[$([char]0x2014)$([char]0x2013)]\s*", ' - ').Trim()
            $prefix = "DatGold v$Version "
            if (-not $title.StartsWith($prefix, [StringComparison]::Ordinal) -or $title.Length -le $prefix.Length) {
                Add-Problem "the H1 of $notesFile is '$title'; it must start with '$prefix' and go on with the name of the release"
            }
            $saysTestBuild = $title.Contains('(test build)')
            if ($saysTestBuild -and -not $isPrerelease) { Add-Problem "the H1 of $notesFile says '(test build)', but the release is not a pre-release (prerelease=false)" }
            if ($isPrerelease -and -not $saysTestBuild) { Add-Problem "the release is a pre-release (prerelease=true), but the H1 of $notesFile does not say '(test build)'" }
        }
    }
}

# ---- asset names -------------------------------------------------------------------------------------------------------------------
$build = Read-RepoText 'scripts/Build-Installer.ps1'
if ($null -ne $build) {
    $setup = [regex]::Matches($build, '(?m)^\s*\$setupExe\s*=\s*Join-Path\s+\$distDir\s+''([^'']+)''')
    if ($setup.Count -ne 1) { Add-Problem "scripts/Build-Installer.ps1 does not write exactly one installer to dist (`$setupExe = Join-Path `$distDir '$InstallerAsset')" }
    elseif ($setup[0].Groups[1].Value -cne $InstallerAsset) { Add-Problem "scripts/Build-Installer.ps1 writes $($setup[0].Groups[1].Value), the release asset is $InstallerAsset" }
}
$companionBuild = Read-RepoText 'scripts/Build-BrowserCompanion.ps1'
if ($null -ne $companionBuild) {
    $archive = [regex]::Matches($companionBuild, "(?m)^\s*\`$filename\s*=\s*'([^']+)'")
    if ($archive.Count -ne 1) { Add-Problem "scripts/Build-BrowserCompanion.ps1 does not name exactly one archive (`$filename = '$CompanionAsset')" }
    elseif ($archive[0].Groups[1].Value -cne $CompanionAsset) { Add-Problem "scripts/Build-BrowserCompanion.ps1 builds $($archive[0].Groups[1].Value), the release asset is $CompanionAsset" }
    if ($companionBuild.Contains($OldCompanionAsset)) { Add-Problem "scripts/Build-BrowserCompanion.ps1 names the old-named Companion asset $OldCompanionAsset, which no release publishes since v3.11.1" }
}

# ---- the upgrade baseline ----------------------------------------------------------------------------------------------------------
if (-not [string]::IsNullOrEmpty($BaselineRelease)) {
    if (-not (Test-Path -LiteralPath $BaselineRelease -PathType Leaf)) {
        Add-Problem "the baseline release file $BaselineRelease is missing"
    } else {
        $release = $null
        try { $release = [IO.File]::ReadAllText($BaselineRelease, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { Add-Problem "the baseline release file is not JSON: $($_.Exception.Message)" }
        if ($null -ne $release) {
            $names = @($release.PSObject.Properties | ForEach-Object { $_.Name })
            if ($names -notcontains 'tag_name' -or $release.tag_name -cne $BaselineTag) { Add-Problem "the baseline release is not $BaselineTag" }
            if ($names -contains 'draft' -and $release.draft -eq $true) { Add-Problem "the baseline release $BaselineTag is a draft" }
            $asset = @()
            if ($names -contains 'assets') { $asset = @($release.assets | Where-Object { $_.name -ceq $BaselineAsset }) }
            if ($asset.Count -ne 1) {
                Add-Problem "the baseline release $BaselineTag has $($asset.Count) assets named $BaselineAsset, expected exactly one"
            } else {
                $digest = $null
                if (@($asset[0].PSObject.Properties | ForEach-Object { $_.Name }) -contains 'digest') { $digest = $asset[0].digest }
                if ([string]::IsNullOrEmpty($digest)) { Add-Problem "GitHub records no digest for $BaselineAsset of $BaselineTag, so the pin cannot be cross-checked" }
                elseif ($digest -cne "sha256:$BaselineSha256") { Add-Problem "GitHub records $digest for $BaselineAsset of $BaselineTag, the pinned SHA-256 is $BaselineSha256" }
            }
        }
    }
}

if ($problems.Count -gt 0) {
    foreach ($problem in $problems) { [Console]::Error.WriteLine("Resolve-ReleaseInputs: $problem") }
    [Console]::Error.WriteLine("Resolve-ReleaseInputs: $($problems.Count) problem(s); nothing is released.")
    exit 1
}

$values = [ordered]@{
    version           = $Version
    tag               = "v$Version"
    title             = $title
    notes_file        = $notesFile
    prerelease        = $(if ($isPrerelease) { 'true' } else { 'false' })
    companion_version = $companion
    installer_asset   = $InstallerAsset
    companion_asset   = $CompanionAsset
    manifest_asset    = $ManifestAsset
    artifact_prefix   = "ChatMCP-v$Version"
    baseline_tag      = $BaselineTag
    baseline_asset    = $BaselineAsset
    baseline_version  = $BaselineVersion
    baseline_sha256   = $BaselineSha256
}
$lines = foreach ($key in $values.Keys) {
    $value = [string]$values[$key]
    if ($value -match "[`r`n]") { [Console]::Error.WriteLine("Resolve-ReleaseInputs: $key holds a line break"); exit 1 }
    "$key=$value"
}
$text = ($lines -join "`n") + "`n"
[Console]::Out.Write($text)
if (-not [string]::IsNullOrEmpty($GitHubOutput)) {
    [IO.File]::AppendAllText($GitHubOutput, $text, (New-Object System.Text.UTF8Encoding $false))
}
exit 0
