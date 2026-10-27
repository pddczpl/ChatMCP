#requires -Version 5.1
<#
.SYNOPSIS
  Builds the two setups of the end-to-end proof of the in-app updater: the commit under test twice, as an old version and as a newer one, both trusting the key list of the run.

.DESCRIPTION
  TEST BUILDS ONLY. Nothing here is a release: the versions are given at build time (no version bump is committed), the key list is a throwaway one made for the run, and the setups are never published
  (Build-Installer.ps1 refuses -ReleaseKeysFile in a workflow named Publish*, and so does this script).

  1. a Git work tree of HEAD for each setup, under -Work (a copy of the checkout, so the checkout itself is not touched);
  2. the version of each tree is set (set-build-version.mjs: only the places a build reads its version from);
  3. scripts\Build-Installer.ps1 -ReleaseKeysFile <the key list> runs in both trees AT THE SAME TIME (each is 5 to 7 minutes; the trees share nothing but the package caches);
  4. each setup is copied to <Work>\old\ and <Work>\new\ and looked at: its product, its description and its version are what the desktop shell and the proof expect, and the two differ.
  The result is <Work>\build-report.json (paths, sizes, digests, versions). The work trees are removed unless -KeepWorkTrees is given.

.PARAMETER Work
  A folder that does not exist yet, OUTSIDE every Git work tree (the signing keys of the run live beside it), with no spaces in the path of the trees it holds if it can be helped.
.PARAMETER KeysFile
  The full path of the key list of the run (Build-Installer.ps1 -ReleaseKeysFile).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Work,
    [Parameter(Mandatory = $true)][string]$KeysFile,
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$OldVersion,
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$NewVersion,
    [switch]$KeepWorkTrees
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ($env:GITHUB_WORKFLOW -like 'Publish*') { throw 'This builds test setups with a throwaway key list; a publish workflow never does.' }
if ([version]$NewVersion -le [version]$OldVersion) { throw "The new version ($NewVersion) must be higher than the old one ($OldVersion): an update never installs the same version or an older one." }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptDir '..\..\..')).TrimEnd('\', '/')
$Work = [IO.Path]::GetFullPath($Work).TrimEnd('\', '/')
$KeysFile = [IO.Path]::GetFullPath($KeysFile)
if (-not (Test-Path -LiteralPath $KeysFile -PathType Leaf)) { throw "The key list is not a file: $KeysFile" }
if (Test-Path -LiteralPath $Work) { throw "The work folder already exists: $Work" }
$git = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Path
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Path
$top = ((& $git -C $repoRoot rev-parse --show-toplevel) | Select-Object -First 1).Trim()
if ([IO.Path]::GetFullPath($top).TrimEnd('\', '/') -ne $repoRoot) { throw "The repository root is not the root of its Git work tree: $repoRoot" }
$commit = ((& $git -C $repoRoot rev-parse HEAD) | Select-Object -First 1).Trim()
New-Item -ItemType Directory -Path $Work | Out-Null

function Write-Phase([string]$Text) { Write-Host ('[{0:HH:mm:ss}] {1}' -f (Get-Date), $Text) -ForegroundColor Cyan }
function Quote([string]$Text) { return '"' + $Text + '"' }

$roles = @(
    [pscustomobject]@{ Name = 'old'; Version = $OldVersion; Tree = (Join-Path $Work 'src-old'); Log = (Join-Path $Work 'build-old.log'); Error = (Join-Path $Work 'build-old.err.log'); Process = $null },
    [pscustomobject]@{ Name = 'new'; Version = $NewVersion; Tree = (Join-Path $Work 'src-new'); Log = (Join-Path $Work 'build-new.log'); Error = (Join-Path $Work 'build-new.err.log'); Process = $null }
)
$report = [ordered]@{ commit = $commit; keysFile = $KeysFile; old = $null; new = $null }
try {
    Write-Phase "Work trees of $commit"
    foreach ($role in $roles) {
        & $git -C $repoRoot worktree add --quiet --detach $role.Tree $commit | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "git worktree add failed for the $($role.Name) tree" }
    }

    Write-Phase "Versions: old $OldVersion, new $NewVersion"
    foreach ($role in $roles) {
        & $node (Join-Path $scriptDir 'set-build-version.mjs') $role.Tree $role.Version
        if ($LASTEXITCODE -ne 0) { throw "set-build-version.mjs failed for the $($role.Name) tree" }
    }

    Write-Phase 'Building both setups at the same time (scripts\Build-Installer.ps1 -ReleaseKeysFile)'
    # A PowerShell 7 that runs this script hands its module path to every child, and Windows PowerShell 5.1 then cannot find Get-FileHash (docs/DEVELOPMENT.md, the pwsh trap): the builds are started
    # without it and find their own, and this session gets its own back afterwards.
    $savedModulePath = $env:PSModulePath
    Remove-Item -LiteralPath 'Env:\PSModulePath' -ErrorAction SilentlyContinue
    try {
        foreach ($role in $roles) {
            $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Quote (Join-Path $role.Tree 'scripts\Build-Installer.ps1')), '-ReleaseKeysFile', (Quote $KeysFile))
            $role.Process = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $arguments -WorkingDirectory $role.Tree `
                -RedirectStandardOutput $role.Log -RedirectStandardError $role.Error -PassThru -WindowStyle Hidden
            # Without the handle held, Windows PowerShell reports no exit code for a process that has ended ($null, which this script would read as a failure, or worse as a success).
            $null = $role.Process.Handle
        }
    } finally {
        if ($null -ne $savedModulePath) { $env:PSModulePath = $savedModulePath }
    }
    $started = Get-Date
    $lastReport = $started
    while (@($roles | Where-Object { -not $_.Process.HasExited }).Count -gt 0) {
        Start-Sleep -Seconds 5
        if (((Get-Date) - $lastReport).TotalSeconds -ge 60) {
            $lastReport = Get-Date
            foreach ($role in $roles) {
                $tail = if (Test-Path -LiteralPath $role.Log) { (Get-Content -LiteralPath $role.Log -Tail 1 -ErrorAction SilentlyContinue) } else { '' }
                Write-Host ('  [{0:mm\:ss}] {1}: {2}{3}' -f ((Get-Date) - $started), $role.Name, $(if ($role.Process.HasExited) { "ended with $($role.Process.ExitCode); " } else { '' }), $tail)
            }
        }
        # one that failed early does not make the other one run to its end
        $failed = @($roles | Where-Object { $_.Process.HasExited -and ($null -eq $_.Process.ExitCode -or $_.Process.ExitCode -ne 0) })
        if ($failed.Count -gt 0) {
            foreach ($role in $roles) { if (-not $role.Process.HasExited) { try { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $role.Process.Id /T /F | Out-Null } catch { } } }
            break
        }
    }
    foreach ($role in $roles) { $null = $role.Process.WaitForExit() }
    $bad = @($roles | Where-Object { $null -eq $_.Process.ExitCode -or $_.Process.ExitCode -ne 0 })
    if ($bad.Count -gt 0) {
        foreach ($role in $bad) {
            Write-Host ("--- build of the $($role.Name) setup ended with exit code '$($role.Process.ExitCode)'; the end of its log:") -ForegroundColor Red
            Get-Content -LiteralPath $role.Log -Tail 60 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
            Get-Content -LiteralPath $role.Error -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
        }
        throw 'A build failed.'
    }
    Write-Phase ('Both setups built in {0:mm\:ss}' -f ((Get-Date) - $started))

    foreach ($role in $roles) {
        $built = Join-Path $role.Tree 'dist\DatGoldSetup.exe'
        if (-not (Test-Path -LiteralPath $built -PathType Leaf)) { throw "The $($role.Name) build left no DatGoldSetup.exe" }
        $folder = Join-Path $Work $role.Name
        New-Item -ItemType Directory -Path $folder | Out-Null
        $setup = Join-Path $folder 'DatGoldSetup.exe'
        Copy-Item -LiteralPath $built -Destination $setup
        $info = (Get-Item -LiteralPath $setup).VersionInfo
        # the same fields the desktop shell reads before it runs a setup (native-shared/UpdateStaging.cs): a setup that says anything else would never be accepted
        if ($info.ProductName -cne 'DatGold Studio Setup' -or $info.FileDescription -cne 'DatGold Studio Setup') { throw "The $($role.Name) setup is not called DatGold Studio Setup: $($info.ProductName) / $($info.FileDescription)" }
        if (($info.ProductVersion -split '\+')[0] -ne $role.Version) { throw "The $($role.Name) setup says version $($info.ProductVersion), not $($role.Version)" }
        $item = Get-Item -LiteralPath $setup
        $sha = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
        $report[$role.Name] = [ordered]@{ path = $setup; version = $role.Version; productVersion = $info.ProductVersion; bytes = $item.Length; sha256 = $sha }
        Write-Host ("  {0}: {1} ({2:N1} MB) sha256 {3}" -f $role.Name, $setup, ($item.Length / 1MB), $sha)
    }
    if ($report['old'].sha256 -eq $report['new'].sha256) { throw 'The two setups are the same file.' }
    $json = $report | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText((Join-Path $Work 'build-report.json'), $json, [Text.UTF8Encoding]::new($false))
    Write-Phase "Done: $(Join-Path $Work 'build-report.json')"
} finally {
    # The clean-up must not be what fails: under 'Stop' a native command that writes a line to stderr is an error, and it would replace the one that brought this script here.
    $ErrorActionPreference = 'Continue'
    foreach ($role in $roles) {
        if ($null -ne $role.Process -and -not $role.Process.HasExited) { try { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $role.Process.Id /T /F | Out-Null } catch { } }
    }
    # Only the two work trees this script made are removed; the other work trees of the repository (a developer machine has dozens) are never touched.
    if (-not $KeepWorkTrees) {
        foreach ($role in $roles) {
            if (Test-Path -LiteralPath $role.Tree) { try { & $git -C $repoRoot worktree remove --force $role.Tree 2>&1 | Out-Null } catch { } }
        }
    }
}
