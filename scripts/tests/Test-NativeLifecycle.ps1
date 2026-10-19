#requires -Version 5.1
<# Runs real release installers and ChatMCP.exe on a disposable GitHub Windows runner.
   Never run against an owner's installed application or existing Hub/data directory. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$BaselineInstaller,
    [Parameter(Mandatory=$true)][string]$CandidateInstaller,
    [string]$OutputDirectory = 'native-lifecycle-evidence',
    [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$ExpectedBaselineVersion,
    [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$ExpectedCandidateVersion
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'Programs\ChatMCP'
$data = Join-Path $env:LOCALAPPDATA 'ChatMCP'
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatMCP'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or (Test-Path $root) -or (Test-Path $registry)) {
    throw ('Disposable hosted runner required; rootExists=' + (Test-Path $root) + '; registered=' + (Test-Path $registry) + '; environment=' + $env:RUNNER_ENVIRONMENT)
}
# Earlier regression suites may have created fixture state. Never delete it.
# Isolate it by an atomic same-volume rename and restore it in finally.
$priorData = $null
if (Get-NetTCPConnection -LocalPort 3007 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 3007 is already occupied; no existing process will be changed.' }
$BaselineInstaller = (Resolve-Path $BaselineInstaller).Path
$CandidateInstaller = (Resolve-Path $CandidateInstaller).Path
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$report = [ordered]@{ result='FAIL'; commit=$env:GITHUB_SHA; checks=@(); error=$null; baselineVersion=$null; candidateVersion=$null; candidateSha256=$null }
$owned = New-Object 'System.Collections.Generic.List[object]'
function Assert-Native([bool]$condition, [string]$message) {
    if (-not $condition) { throw $message }
    $script:report.checks += $message
    Write-Host "PASS $message"
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Window-For($process) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $process.Refresh()
        if ($process.HasExited) { throw 'Native executable exited before its window was ready.' }
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) { return [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle) }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Native window timeout.'
}
function Control-ByName($window, [string]$name) {
    $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$name)
    $window.FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
}
function Wait-Button($window, [string]$name) {
    $deadline = [DateTime]::UtcNow.AddMinutes(4)
    do {
        $button = Control-ByName $window $name
        if ($null -ne $button -and $button.Current.IsEnabled) { return $button }
        Start-Sleep -Milliseconds 400
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Wizard did not show $name."
}
function Click($button) { $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
function Wait-Health([string]$version) {
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    do {
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:3007/api/health' -TimeoutSec 2
            if ($health.version -eq $version -and $health.initialized) { return $health }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Hub $version did not become ready."
}
function Assert-NoNativeError($process, [string]$pattern, [int]$seconds = 8) {
    # The shell hides its status label once the dashboard has loaded, so a diagnostic still readable after the wait means it did not attach.
    $window = Window-For $process
    $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
    do {
        foreach ($text in $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
            # Only the shell's own WinForms status label: WebView2 exposes the dashboard's text through UI Automation too, and a
            # page that happens to say "Error:" is not a failed attach.
            if ($text.Current.ClassName -notlike 'WindowsForms10.*') { continue }
            if ($text.Current.Name -cmatch $pattern) { throw ('Native window shows a diagnostic instead of attaching: ' + $text.Current.Name) }
        }
        Start-Sleep -Milliseconds 400
    } while ([DateTime]::UtcNow -lt $deadline)
}
function Stop-InstalledHub {
    & (Join-Path $root 'CHATMCP-HUB\STOP-CHATMCP-HUB.cmd') -Port 3007
    if ($LASTEXITCODE -ne 0) { throw 'Owned test Hub shutdown was not confirmed.' }
}
function Start-Desktop {
    $p=Start-Process -FilePath (Join-Path $root 'ChatMCP.exe') -PassThru
    $script:owned.Add($p)
    $null=Window-For $p
    return $p
}
function Close-Desktop($p) {
    $null=$p.CloseMainWindow()
    Assert-Native ($p.WaitForExit(15000)) 'actual installed desktop closes without a forced process-tree kill'
}
function Quiet-Install {
    $p = Start-Process -FilePath $CandidateInstaller -ArgumentList @('--quiet','--install-dir',('"'+$root+'"')) -PassThru
    $script:owned.Add($p)
    if (-not $p.WaitForExit(240000)) { throw 'Candidate installer timed out.' }
    return $p.ExitCode
}
function Assert-NativeError($process, [string]$pattern) {
    $window=Window-For $process
    $deadline=[DateTime]::UtcNow.AddSeconds(15)
    do {
        $texts=$window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
        foreach($text in $texts) { if($text.Current.Name -match $pattern) { return } }
        Start-Sleep -Milliseconds 300
    } while([DateTime]::UtcNow -lt $deadline)
    throw "Native window did not show expected diagnostic: $pattern"
}
try {
    if (Test-Path $data) {
        if ((Get-Item -LiteralPath $data).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked prior test state.' }
        $priorData = $data + '.prior-native-fixture-' + [guid]::NewGuid().ToString('N')
        [IO.Directory]::Move($data, $priorData)
    }
    $report.baselineVersion=(Get-Item $BaselineInstaller).VersionInfo.ProductVersion
    $report.candidateVersion=(Get-Item $CandidateInstaller).VersionInfo.ProductVersion
    $report.candidateSha256=(Get-FileHash $CandidateInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-Native ($report.baselineVersion -like "$ExpectedBaselineVersion*") ("published baseline EXE metadata matches " + $ExpectedBaselineVersion + ": " + $report.baselineVersion)
    Assert-Native ($report.candidateVersion -like "$ExpectedCandidateVersion*") ("candidate EXE metadata matches " + $ExpectedCandidateVersion + ": " + $report.candidateVersion)
    # Baseline is the byte-verified published installer; use its real GUI.
    $setup=Start-Process $BaselineInstaller -PassThru; $owned.Add($setup)
    $window=Window-For $setup
    Click (Wait-Button $window 'Install')
    $finish=Wait-Button $window 'Finish'
    $launch=Control-ByName $window 'Launch ChatMCP Studio now'
    $toggle=$launch.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
    if ($toggle.Current.ToggleState -eq [Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
    Click $finish
    Assert-Native ($setup.WaitForExit(30000) -and $setup.ExitCode -eq 0) 'published baseline setup wizard completes'
    $first=Start-Desktop
    $null=Wait-Health $ExpectedBaselineVersion
    Assert-Native $true 'published baseline ChatMCP.exe starts the bundled Hub'
    Close-Desktop $first
    Stop-InstalledHub
    # Reproduce the independent old Hub that previous installers did not stop.
    $node=Join-Path $root 'runtimes\node\node.exe'
    $entry=Join-Path $root 'CHATMCP-HUB\hub.mjs'
    $oldHub=Start-Process $node -ArgumentList @(('"'+$entry+'"'),'--port','3007','--no-open') -PassThru -WindowStyle Hidden
    $owned.Add($oldHub); $null=Wait-Health $ExpectedBaselineVersion
    # Releases up to 3.9.0 have no per-launch secret: their Hub hands its CSRF token to any local caller, and the candidate
    # installer's preflight must still be able to stop exactly that Hub (legacy flow after the secret path finds no session).
    $oldHealth = Invoke-RestMethod 'http://127.0.0.1:3007/api/health' -TimeoutSec 5
    $legacyBaseline = ($null -eq $oldHealth.PSObject.Properties['auth'])
    if ($legacyBaseline) {
        $oldState = Invoke-RestMethod 'http://127.0.0.1:3007/api/state' -TimeoutSec 5
        Assert-Native (($oldState.csrfToken -is [string]) -and $oldState.csrfToken.Length -ge 16) 'baseline Hub is secretless (an unauthenticated caller receives its CSRF token): the legacy shutdown flow is what the preflight must handle'
    }
    $canary=Join-Path $root 'unrelated-user-file.txt'
    [IO.File]::WriteAllText($canary,'PRESERVE-USER-DATA')
    $stateCanary=Join-Path $data 'unrelated-user-state.txt'
    [IO.File]::WriteAllText($stateCanary,'PRESERVE-STATE')
    Assert-Native ((Quiet-Install) -eq 0) 'real candidate installer upgrades with independent old Hub running'
    Assert-Native ($oldHub.HasExited) 'upgrade confirms exact old Hub exited'
    Assert-Native ((Get-Content (Join-Path $root 'CHATMCP-HUB\package.json') -Raw | ConvertFrom-Json).version -eq $ExpectedCandidateVersion) "installed Hub package is $ExpectedCandidateVersion"
    Assert-Native ((Get-Item (Join-Path $root 'ChatMCP.exe')).VersionInfo.ProductVersion -like "$ExpectedCandidateVersion*") "installed launcher EXE is $ExpectedCandidateVersion"
    Assert-Native ((Get-ItemProperty $registry).DisplayVersion -eq $ExpectedCandidateVersion) 'Windows Installed Apps reports the assembly version'
    Assert-Native ((Get-Content (Join-Path $root 'CHATMCP-HUB\extension\manifest.json') -Raw | ConvertFrom-Json).version -eq '1.5.2') 'installed Companion is 1.5.2'
    Assert-Native ([IO.File]::ReadAllText($canary) -eq 'PRESERVE-USER-DATA' -and [IO.File]::ReadAllText($stateCanary) -eq 'PRESERVE-STATE') 'upgrade preserves unrelated application and state files'
    $candidate=Start-Desktop; $newHealth=Wait-Health $ExpectedCandidateVersion
    $ownerId=(Get-NetTCPConnection -LocalPort 3007 -State Listen).OwningProcess
    Assert-Native ($newHealth.auth -eq 'bearer') 'candidate Hub requires its per-launch secret'
    $unauthenticatedStatus = 0
    try { Invoke-RestMethod 'http://127.0.0.1:3007/api/state' -TimeoutSec 5 | Out-Null } catch { if ($_.Exception.Response) { $unauthenticatedStatus = [int]$_.Exception.Response.StatusCode } }
    Assert-Native ($unauthenticatedStatus -eq 401) 'candidate Hub refuses an unauthenticated local caller (HTTP 401)'
    $sessionFile = Join-Path $data 'hub\run\hub-session.json'
    Assert-Native (Test-Path $sessionFile) 'candidate Hub published run\hub-session.json in its data folder'
    $session = Get-Content $sessionFile -Raw | ConvertFrom-Json
    Assert-Native (($session.port -eq 3007) -and ($session.pid -eq $ownerId) -and ($session.secret -match '^[A-Za-z0-9_-]{32,256}$')) 'the session names the process that listens on port 3007'
    $mySid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $principals = @((Get-Acl $sessionFile).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
    Assert-Native (($principals.Count -eq 1) -and ($principals[0] -eq $mySid)) 'the session file is readable by the current Windows account only'
    $authorized = Invoke-RestMethod 'http://127.0.0.1:3007/api/state' -Headers @{ Authorization = ('Bearer ' + $session.secret) } -TimeoutSec 5
    Assert-Native (($authorized.csrfToken -is [string]) -and $authorized.csrfToken.Length -ge 16) 'the published secret authenticates'
    Assert-NoNativeError $candidate 'Error:|Hub disconnected|predates session authentication'
    Assert-Native $true 'new shell attached to the new Hub with the secret (no diagnostic in its window)'
    $duplicate=Start-Process (Join-Path $root 'ChatMCP.exe') -PassThru; $owned.Add($duplicate)
    Assert-Native ($duplicate.WaitForExit(10000)) 'second launcher activates existing instance then exits'
    Assert-Native (-not $candidate.HasExited -and (Get-NetTCPConnection -LocalPort 3007 -State Listen).OwningProcess -eq $ownerId) 'second invocation does not stop the primary window or Hub'
    Close-Desktop $candidate
    $null=Wait-Health $ExpectedCandidateVersion
    Assert-Native ((Get-NetTCPConnection -LocalPort 3007 -State Listen).OwningProcess -eq $ownerId) 'closing GUI leaves the same Hub alive without replay'
    $candidate=Start-Desktop; $null=Wait-Health $ExpectedCandidateVersion
    Assert-Native ((Get-NetTCPConnection -LocalPort 3007 -State Listen).OwningProcess -eq $ownerId) 'reopening GUI reuses the exact-version Hub'
    Close-Desktop $candidate
    Stop-InstalledHub
    # Positive HTTP 200 from the wrong version must not be loaded into WebView2.
    $fakeFile=Join-Path $OutputDirectory 'foreign-service.mjs'
    [IO.File]::WriteAllText($fakeFile,"import http from 'node:http';http.createServer((q,s)=>{s.setHeader('Content-Type','application/json');s.end(JSON.stringify({app:'chatmcp-local-hub',version:'$ExpectedBaselineVersion',uiBuild:'${ExpectedBaselineVersion}-react-agent',initialized:true}));}).listen(3007,'127.0.0.1');")
    $fake=Start-Process (Get-Command node.exe).Source -ArgumentList ('"'+$fakeFile+'"') -WindowStyle Hidden -PassThru; $owned.Add($fake)
    $null=Wait-Health $ExpectedBaselineVersion
    $candidate=Start-Desktop
    # With a different baseline version the version check fires first; with the same version number the missing auth field does.
    $fakeDiagnostic = if ($ExpectedBaselineVersion -eq $ExpectedCandidateVersion) { 'predates session authentication' } else { 'Hub version mismatch' }
    Assert-NativeError $candidate $fakeDiagnostic
    Assert-Native (-not $fake.HasExited) 'launcher refuses a Hub without session authentication or of the wrong version, without stopping the foreign process'
    Close-Desktop $candidate
    $before=(Get-FileHash (Join-Path $root 'ChatMCP.exe') -Algorithm SHA256).Hash
    Assert-Native ((Quiet-Install) -ne 0) 'installer refuses a foreign port owner'
    Assert-Native ((Get-FileHash (Join-Path $root 'ChatMCP.exe') -Algorithm SHA256).Hash -eq $before -and -not $fake.HasExited) 'foreign-port refusal leaves installed bytes and unrelated process unchanged'
    $fake.Kill(); $null=$fake.WaitForExit(10000)
    # Actual uninstall also stops a Hub kept alive after closing the GUI.
    $candidate=Start-Desktop; $null=Wait-Health $ExpectedCandidateVersion; Close-Desktop $candidate
    $uninstall=Start-Process (Join-Path $root 'Uninstall.exe') -ArgumentList '--quiet','--uninstall' -PassThru; $owned.Add($uninstall)
    Assert-Native ($uninstall.WaitForExit(120000) -and $uninstall.ExitCode -eq 0) 'actual installed uninstaller completes with live idle Hub'
    Assert-Native (-not (Get-NetTCPConnection -LocalPort 3007 -State Listen -ErrorAction SilentlyContinue)) 'uninstall confirms Hub listener is gone'
    Assert-Native (-not (Test-Path (Join-Path $root 'ChatMCP.exe')) -and -not (Test-Path $registry)) 'uninstall removes owned launcher and registration'
    Assert-Native ([IO.File]::ReadAllText($canary) -eq 'PRESERVE-USER-DATA' -and [IO.File]::ReadAllText($stateCanary) -eq 'PRESERVE-STATE') 'uninstall preserves unrelated files and user state'
    $report.result='PASS'
} catch {
    $report.error=$_.Exception.ToString()
    Write-Host ('FAIL ' + $report.error)
} finally {
    foreach($p in $owned) { try { if(-not $p.HasExited) {$p.Kill();$null=$p.WaitForExit(5000)} } catch {} }
    if (Test-Path (Join-Path $data 'logs')) { Copy-Item (Join-Path $data 'logs') (Join-Path $OutputDirectory 'installer-logs') -Recurse -Force }
    if ($null -ne $priorData -and (Test-Path $priorData)) {
        if (Test-Path $data) { [IO.Directory]::Move($data, ($data + '.completed-native-fixture-' + [guid]::NewGuid().ToString('N'))) }
        [IO.Directory]::Move($priorData, $data)
    }
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'report.json'),($report | ConvertTo-Json -Depth 8))
}
if ($report.result -ne 'PASS') { exit 1 }
