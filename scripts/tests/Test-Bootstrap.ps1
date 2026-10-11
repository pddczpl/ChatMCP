#requires -Version 5.1
# Tests scripts\bootstrap-cloud-harness.ps1 against a local fixture repository (no network).
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot '..\bootstrap-cloud-harness.ps1'
$powershell = (Get-Process -Id $PID).Path
$failures = 0
function Check([bool]$Condition, [string]$Label, [string]$Details = '') {
    if ($Condition) { Write-Host "  ok - $Label" }
    else {
        Write-Host "  FAIL - $Label"
        if ($Details) { Write-Host "    Details: $Details" }
        $script:failures++
    }
}
function Invoke-TestGit([string[]]$GitArguments) {
    $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $null = & git @GitArguments 2>&1; if ($LASTEXITCODE -ne 0) { throw "git $($GitArguments -join ' ') failed" } } finally { $ErrorActionPreference = $previous }
}
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('bootstrap-test-' + [guid]::NewGuid().ToString('N'))
$up = Join-Path $tmp 'upstream'
New-Item -ItemType Directory -Path $up -Force | Out-Null
Invoke-TestGit @('-C', $up, 'init', '-q', '-b', 'main')
Invoke-TestGit @('-C', $up, 'config', 'user.email', 'test@example.invalid')
Invoke-TestGit @('-C', $up, 'config', 'user.name', 'test')
[IO.File]::WriteAllText((Join-Path $up 'LICENSE'), "MIT License`nfixture`n")
Invoke-TestGit @('-C', $up, 'add', 'LICENSE')
Invoke-TestGit @('-C', $up, 'commit', '-q', '-m', 'init')
Invoke-TestGit @('-C', $up, 'tag', 'v0.0.1')
$commit = (& git -C $up rev-parse HEAD).Trim()
$sha = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $up 'LICENSE')).Hash.ToLowerInvariant()
$lockFile = Join-Path $tmp 'lock.json'
function Write-Lock([string]$Commit, [string]$Sha) {
    $lock = [ordered]@{ name = 'fixture'; repository = ([Uri]$up).AbsoluteUri; tag = 'v0.0.1'; commit = $Commit; license = 'MIT'; licenseFile = 'LICENSE'; licenseSha256 = $Sha }
    [IO.File]::WriteAllText($lockFile, ($lock | ConvertTo-Json))
}
function Invoke-Bootstrap([string]$Destination) {
    $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $out = & $powershell -NoProfile -ExecutionPolicy Bypass -File $script -Destination $Destination -LockFile $lockFile 2>&1 | ForEach-Object { $_.ToString() } | Out-String
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    return @{ Output = $out; Code = $code }
}

try {
    Write-Host 'clone and verify'
    Write-Lock $commit $sha
    $dest = Join-Path $tmp 'dest'
    $r = Invoke-Bootstrap $dest
    Check ($r.Code -eq 0 -and $r.Output -match 'OK \(cloned\)') 'fresh clone succeeds' $r.Output

    Write-Host 'verify existing checkout'
    $r = Invoke-Bootstrap $dest
    Check ($r.Code -eq 0 -and $r.Output -match 'verified existing checkout') 'existing checkout verifies' $r.Output

    Write-Host 'modified tracked file is rejected and not touched'
    Add-Content -LiteralPath (Join-Path $dest 'LICENSE') -Value 'extra'
    $r = Invoke-Bootstrap $dest
    Check ($r.Code -ne 0 -and $r.Output -match 'modified') 'modified checkout fails'
    Check (Test-Path -LiteralPath (Join-Path $dest 'LICENSE')) 'file left in place'
    Invoke-TestGit @('-C', $dest, 'checkout', '-q', '--', 'LICENSE')

    Write-Host 'wrong commit in the lock is rejected without deleting the checkout'
    Write-Lock '0000000000000000000000000000000000000000' $sha
    $dest2 = Join-Path $tmp 'dest2'
    $r = Invoke-Bootstrap $dest2
    Check ($r.Code -ne 0 -and $r.Output -match 'requires') 'commit mismatch fails'
    Check (Test-Path -LiteralPath $dest2) 'checkout kept for inspection'

    Write-Host 'wrong license hash is rejected'
    Write-Lock $commit ('0' * 64)
    $r = Invoke-Bootstrap $dest
    Check ($r.Code -ne 0 -and $r.Output -match 'license|LICENSE') 'license mismatch fails'
}
finally {
    # git marks pack files read-only on Windows
    if (Test-Path -LiteralPath $tmp) { Get-ChildItem -LiteralPath $tmp -Recurse -Force -File | ForEach-Object { $_.Attributes = 'Normal' }; Remove-Item -LiteralPath $tmp -Recurse -Force }
}
if ($failures -gt 0) { Write-Host "FAILED: $failures check(s)"; exit 1 }
Write-Host 'PASS: bootstrap-cloud-harness.ps1 tests'
