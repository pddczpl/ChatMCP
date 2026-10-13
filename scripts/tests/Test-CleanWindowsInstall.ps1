#requires -Version 5.1
<#
.SYNOPSIS
Runs real setup, desktop, in-place upgrade and uninstall in a fresh owned Sandbox.
.DESCRIPTION
Requires two different standalone installer artifacts and the Microsoft-signed
offline WebView2 prerequisite. Never installs or uninstalls anything on the host.
Evidence is retained in OutputDirectory; only the returned owned Sandbox is stopped.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$BaselineInstaller,
    [Parameter(Mandatory=$true)][string]$CandidateInstaller,
    [Parameter(Mandatory=$true)][string]$WebView2Prerequisite,
    [string]$OutputDirectory
)
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runId=[guid]::NewGuid().ToString()
if (-not $OutputDirectory) { $OutputDirectory=Join-Path $repoRoot ('.tmp\g6-clean-windows-' + $runId) }
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Choose a new evidence directory for each run.' }
$wsb=Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wsb.exe'
if (-not (Test-Path -LiteralPath $wsb)) { throw 'Windows Sandbox CLI is unavailable.' }
function Get-SandboxIds {
    $rawList=& $wsb list --raw
    if ($LASTEXITCODE -ne 0) { throw 'Sandbox list command failed; ownership cannot be confirmed.' }
    $snapshot=$rawList | ConvertFrom-Json
    if ($null -eq $snapshot -or -not ($snapshot.PSObject.Properties.Name -contains 'WindowsSandboxEnvironments') -or
        $snapshot.WindowsSandboxEnvironments -isnot [System.Array]) { throw 'Malformed Sandbox inventory; ownership cannot be confirmed.' }
    foreach ($instance in $snapshot.WindowsSandboxEnvironments) {
        if ($null -eq $instance -or -not ($instance.PSObject.Properties.Name -contains 'Id') -or
            $instance.Id -isnot [string] -or $instance.Id -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { throw 'Malformed Sandbox UUID.' }
        $instance.Id
    }
}
if (@(Get-SandboxIds).Count -ne 0) { throw 'Close existing Sandbox work before starting this exclusive lifecycle test.' }
foreach ($file in @($BaselineInstaller,$CandidateInstaller,$WebView2Prerequisite)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing test artifact: $file" }
}
$signature=Get-AuthenticodeSignature -LiteralPath $WebView2Prerequisite
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation,') {
    throw 'WebView2 prerequisite must have a valid Microsoft Corporation Authenticode signature.'
}
$inputDir=Join-Path $OutputDirectory 'input'
$evidenceDir=Join-Path $OutputDirectory 'evidence'
New-Item -ItemType Directory -Path $inputDir,$evidenceDir | Out-Null
Copy-Item -LiteralPath $BaselineInstaller -Destination (Join-Path $inputDir 'BaselineSetup.exe')
Copy-Item -LiteralPath $CandidateInstaller -Destination (Join-Path $inputDir 'CandidateSetup.exe')
Copy-Item -LiteralPath $WebView2Prerequisite -Destination (Join-Path $inputDir 'WebView2RuntimeInstallerX64.exe')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-installer\guest-lifecycle.ps1') -Destination $inputDir
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-installer\desktop-probe.mjs') -Destination $inputDir
[IO.File]::WriteAllText((Join-Path $inputDir 'run-id.txt'),$runId)
$escapedInput=[Security.SecurityElement]::Escape($inputDir)
$escapedOutput=[Security.SecurityElement]::Escape($evidenceDir)
$config="<Configuration><Networking>Disable</Networking><ClipboardRedirection>Disable</ClipboardRedirection><PrinterRedirection>Disable</PrinterRedirection><MappedFolders><MappedFolder><HostFolder>$escapedInput</HostFolder><SandboxFolder>C:\G6Input</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>$escapedOutput</HostFolder><SandboxFolder>C:\G6Output</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders></Configuration>"
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'sandbox.wsb'),$config)
$metadata=[ordered]@{ runId=$runId; hostOS=[Environment]::OSVersion.VersionString; commit=(& git.exe -C $repoRoot rev-parse HEAD | Out-String).Trim(); dirty=(@(& git.exe -C $repoRoot status --porcelain).Count -gt 0); startedUtc=[DateTime]::UtcNow.ToString('o'); ownedId=$null; guestExitCode=$null; cleanupConfirmed=$false }
$owned=$false
try {
    $started=& $wsb start --id $runId --config $config --raw | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $started.Id -ne $runId) { throw 'Sandbox did not return the requested owned UUID.' }
    $owned=$true
    $metadata.ownedId=$runId
    # Establish the guest interactive session needed by the real Windows UI.
    $connection=Start-Process -FilePath $wsb -ArgumentList 'connect','--id',$runId,'--raw' -WindowStyle Hidden -PassThru
    $ready=$false
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        # Windows PowerShell promotes native stderr to a terminating error when
        # ErrorActionPreference=Stop. A not-yet-ready login is an expected retry.
        try {
            $ErrorActionPreference='Continue'
            $probe=& $wsb exec --id $runId --run-as ExistingLogin --command 'cmd.exe /d /c exit 0' --raw 2>$null
            $probeExit=$LASTEXITCODE
        } finally { $ErrorActionPreference='Stop' }
        if ($probeExit -eq 0) {
            $probeResult=$probe | ConvertFrom-Json
            if ($null -ne $probeResult -and ($probeResult.PSObject.Properties.Name -contains 'ExitCode') -and $probeResult.ExitCode -eq 0) { $ready=$true; break }
        }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Guest interactive session could not be established.' }
    Write-Host "Owned G6 Sandbox: $runId. Evidence: $evidenceDir"
    $guestCommand="powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\G6Input\guest-lifecycle.ps1 -RunId $runId"
    $raw=& $wsb exec --id $runId --run-as ExistingLogin --command $guestCommand --raw
    [IO.File]::WriteAllText((Join-Path $evidenceDir 'wsb-exec.json'),($raw | Out-String))
    if ($LASTEXITCODE -ne 0) { throw 'Windows Sandbox CLI execution failed.' }
    $result=$raw | ConvertFrom-Json
    $metadata.guestExitCode=$result.ExitCode
    $report=Get-Content -LiteralPath (Join-Path $evidenceDir 'lifecycle-report.json') -Raw | ConvertFrom-Json
    if ($result.ExitCode -ne 0 -or $report.result -ne 'PASS') { throw "G6 lifecycle failed: $($report.error)" }
} finally {
    if ($owned) {
        try {
            & $wsb stop --id $runId --raw
            if ($LASTEXITCODE -ne 0) { throw 'Owned Sandbox stop command failed.' }
            $afterIds=@(Get-SandboxIds)
            # Do not touch any other guest even if another caller created one.
            $metadata.cleanupConfirmed= -not ($afterIds -contains $runId)
        } catch { $metadata.cleanupError=$_.Exception.Message }
    }
    $metadata.finishedUtc=[DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText((Join-Path $evidenceDir 'host-run.json'),($metadata | ConvertTo-Json -Depth 10))
}
if (-not $metadata.cleanupConfirmed) { throw 'Owned Sandbox cleanup was not confirmed.' }
Write-Host "PASS: G6 native lifecycle ($(@($report.checks).Count) checks), owned cleanup confirmed."
