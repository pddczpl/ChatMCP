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
# Shortcuts: releases up to 3.10.1 made theirs under the product's old name; this build makes them as DatGold Studio and removes the old ones (installer/InstallerEngine.cs, ReplaceShortcuts).
$desktopFolder = [Environment]::GetFolderPath('Desktop')
$programsFolder = [Environment]::GetFolderPath('Programs')
$oldShortcuts = @((Join-Path $desktopFolder 'ChatMCP Studio.lnk'), (Join-Path $programsFolder 'ChatMCP\ChatMCP Studio.lnk'), (Join-Path $programsFolder 'ChatMCP\Uninstall ChatMCP Studio.lnk'))
$newShortcuts = @((Join-Path $desktopFolder 'DatGold Studio.lnk'), (Join-Path $programsFolder 'DatGold\DatGold Studio.lnk'), (Join-Path $programsFolder 'DatGold\Uninstall DatGold Studio.lnk'))
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
$report = [ordered]@{ result='FAIL'; commit=$env:GITHUB_SHA; checks=@(); skipped=@(); error=$null; baselineVersion=$null; candidateVersion=$null; candidateSha256=$null }
$owned = New-Object 'System.Collections.Generic.List[object]'
function Assert-Native([bool]$condition, [string]$message) {
    if (-not $condition) { throw $message }
    $script:report.checks += $message
    Write-Host "PASS $message"
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Assert-Shortcuts([string[]]$paths, [bool]$exist, [string]$message) {
    $wrong = @($paths | Where-Object { (Test-Path -LiteralPath $_) -ne $exist })
    if ($wrong.Count -ne 0) { throw ($message + ': ' + ($wrong -join '; ')) }
    Assert-Native $true $message
}
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
function New-PowerShell7ModuleStandIn([string]$Directory) {
    # A process started from a PowerShell 7 session hands PSModulePath on with PowerShell 7's module folders first, and the Windows PowerShell it starts then
    # loses Get-FileHash (measured under pwsh 7.6.7 on windows-latest). This is the module folder that does the same on any machine: Microsoft.PowerShell.Utility
    # 7.0.0.0 for the Core edition, exporting every command of Windows PowerShell's own module (CHATMCP-HUB/tests/support/powershell-environment.mjs does it for node).
    $names = @((Get-Command -Module Microsoft.PowerShell.Utility).Name | Where-Object { $_ -match '^[A-Za-z]+-[A-Za-z]+$' })
    if ($names -notcontains 'Get-FileHash') { throw 'Windows PowerShell did not list the commands of Microsoft.PowerShell.Utility.' }
    $modules = Join-Path $Directory 'Modules'
    $folder = Join-Path $modules 'Microsoft.PowerShell.Utility\7.0.0.0'
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $manifest = @('@{', "  GUID = '1da87e53-152b-403e-98dc-74d7b4d63d59'", "  ModuleVersion = '7.0.0.0'", "  CompatiblePSEditions = @('Core')", "  PowerShellVersion = '3.0'",
        "  NestedModules = @('Microsoft.PowerShell.Commands.Utility.dll')", "  CmdletsToExport = @($(($names | ForEach-Object { "'$_'" }) -join ', '))", '}')
    [IO.File]::WriteAllText((Join-Path $folder 'Microsoft.PowerShell.Utility.psd1'), ($manifest -join "`r`n") + "`r`n")
    return $modules
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
function Assert-NativeError($process, [string]$pattern, [int]$Seconds = 15) {
    $window=Window-For $process
    $deadline=[DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $texts=$window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
        foreach($text in $texts) { if($text.Current.Name -match $pattern) { return } }
        Start-Sleep -Milliseconds 300
    } while([DateTime]::UtcNow -lt $deadline)
    throw "Native window did not show expected diagnostic: $pattern"
}
# The update mode of the candidate setup (installer/UpdateRun.cs), started the way the desktop shell starts it. Start-Process joins its arguments with spaces, so the paths are quoted here.
function Update-Arguments([string]$WaitPid = '', [bool]$Relaunch = $false, [string]$ResultFile = '') {
    $arguments = @('--quiet', '--update', '--install-dir', ('"' + $root + '"'))
    if ($WaitPid -ne '') { $arguments += @('--wait-pid', $WaitPid) }
    if ($Relaunch) { $arguments += '--relaunch' }
    if ($ResultFile -ne '') { $arguments += @('--result', ('"' + $ResultFile + '"')) }
    return $arguments
}
function Start-InstallerUpdate([string[]]$Arguments) {
    $p = Start-Process -FilePath $CandidateInstaller -ArgumentList $Arguments -PassThru
    $script:owned.Add($p)
    return $p
}
function Close-UpdateWindow($process) {
    # An update that did not go through leaves its window open with the reason and ONE button, Close: the person ends it.
    $window = Window-For $process
    Click (Wait-Button $window 'Close')
    if (-not $process.WaitForExit(30000)) { throw 'The update window did not end after Close.' }
    return $process.ExitCode
}
function Read-UpdateResult([string]$Path, [int]$Seconds = 240) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while (-not (Test-Path -LiteralPath $Path) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-Path -LiteralPath $Path)) { throw "The update left no result file within $Seconds seconds: $Path" }
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}
function Assert-UpdateResult($result, [bool]$ok, [string]$state, $reason, [string]$previous, [string]$message) {
    $reasonMatches = if ($null -eq $reason) { $null -eq $result.reason } else { $result.reason -eq $reason }
    Assert-Native (($result.format -eq 1) -and ($result.ok -eq $ok) -and ($result.state -eq $state) -and $reasonMatches -and ($result.version -eq $ExpectedCandidateVersion) -and ($result.previous -eq $previous) -and ($result.rolledBack -eq ($state -eq 'rolled_back'))) $message
}
function Wait-InstalledApp([datetime]$Since) {
    # The app the installer opens: ChatMCP.exe of the installation, started after the update began.
    $exe = Join-Path $root 'ChatMCP.exe'
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        $found = @(Get-Process -Name 'ChatMCP' -ErrorAction SilentlyContinue | Where-Object { try { ($_.Path -eq $exe) -and ($_.StartTime -gt $Since) } catch { $false } })
        if ($found.Count -gt 0) { $script:owned.Add($found[0]); return $found[0] }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The installer did not open the installed app.'
}
function Get-HubState {
    $session = Get-Content (Join-Path $data 'hub\run\hub-session.json') -Raw | ConvertFrom-Json
    return Invoke-RestMethod 'http://127.0.0.1:3007/api/state' -Headers @{ Authorization = ('Bearer ' + $session.secret) } -TimeoutSec 5
}
function Install-Baseline([string]$Message) {
    $s = Start-Process $BaselineInstaller -PassThru; $script:owned.Add($s)
    $w = Window-For $s
    Click (Wait-Button $w 'Install')
    $done = Wait-Button $w 'Finish'
    $launchBox = Control-ByName $w 'Launch DatGold Studio now'
    if ($null -eq $launchBox) { $launchBox = Control-ByName $w 'Launch ChatMCP Studio now' }
    $switch = $launchBox.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
    if ($switch.Current.ToggleState -eq [Windows.Automation.ToggleState]::On) { $switch.Toggle() }
    Click $done
    Assert-Native ($s.WaitForExit(30000) -and $s.ExitCode -eq 0) $Message
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
    # The desktop shell reads these two fields of a setup before it runs one (native-shared/UpdateStaging.cs, ExpectedProduct and ExpectedDescription): the real single-file setup must carry them, or no
    # update would ever be accepted. Asked of the real file, with the same API the shell uses (FileVersionInfo).
    $candidateNames = (Get-Item $CandidateInstaller).VersionInfo
    Assert-Native (($candidateNames.ProductName -ceq 'DatGold Studio Setup') -and ($candidateNames.FileDescription -ceq 'DatGold Studio Setup')) 'the candidate setup carries the product and description names that the desktop shell checks before it runs an installer'
    # A hosted runner's profile may lack the Desktop or the Start menu folder, which a person's profile always has (setup ignores a shortcut it cannot save): make them, so
    # that the test is about what setup does with shortcuts and not about the profile it runs in.
    foreach ($folder in @($desktopFolder, $programsFolder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
    # Baseline is the byte-verified published installer; use its real GUI.
    $setup=Start-Process $BaselineInstaller -PassThru; $owned.Add($setup)
    $window=Window-For $setup
    Click (Wait-Button $window 'Install')
    $finish=Wait-Button $window 'Finish'
    # The published baseline predates the rename and says ChatMCP Studio; a baseline built after it says DatGold Studio.
    $launch=Control-ByName $window 'Launch DatGold Studio now'
    if ($null -eq $launch) { $launch=Control-ByName $window 'Launch ChatMCP Studio now' }
    $toggle=$launch.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
    if ($toggle.Current.ToggleState -eq [Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
    Click $finish
    Assert-Native ($setup.WaitForExit(30000) -and $setup.ExitCode -eq 0) 'published baseline setup wizard completes'
    if ([version]$ExpectedBaselineVersion -le [version]'3.10.1') {
        Assert-Shortcuts $oldShortcuts $true 'the published baseline made its Desktop and Start menu shortcuts under the old name (the state the upgrade starts from)'
    }
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
    Assert-Native ((Get-ItemProperty $registry).DisplayName -eq 'DatGold Studio') 'Windows Installed Apps lists the product as DatGold Studio'
    Assert-Shortcuts $newShortcuts $true 'the upgrade makes the DatGold Studio shortcuts (Desktop, and Start menu folder DatGold with the launcher and the uninstaller)'
    Assert-Shortcuts $oldShortcuts $false 'and removes the three shortcuts the baseline made under the old name'
    Assert-Native (-not (Test-Path -LiteralPath (Join-Path $programsFolder 'ChatMCP'))) 'and the Start menu folder ChatMCP they leave empty'
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
    # Started the way a person starts it from a PowerShell 7 window: only this process gets PowerShell 7's module folder first in PSModulePath. Its Windows PowerShell helper,
    # which deletes Uninstall.exe once the uninstaller has ended, must not inherit it (Get-FileHash is gone behind it).
    $powerShell7 = New-PowerShell7ModuleStandIn (Join-Path $OutputDirectory 'powershell7-modules')
    $uninstallInfo = New-Object Diagnostics.ProcessStartInfo
    $uninstallInfo.FileName = Join-Path $root 'Uninstall.exe'
    $uninstallInfo.Arguments = '--quiet --uninstall'
    $uninstallInfo.UseShellExecute = $false
    $uninstallInfo.EnvironmentVariables['PSModulePath'] = $powerShell7 + ';' + $env:PSModulePath
    $uninstall=[Diagnostics.Process]::Start($uninstallInfo); $owned.Add($uninstall)
    Assert-Native ($uninstall.WaitForExit(120000) -and $uninstall.ExitCode -eq 0) 'actual installed uninstaller completes with live idle Hub, also when started from a PowerShell 7 session'
    Assert-Native (-not (Get-NetTCPConnection -LocalPort 3007 -State Listen -ErrorAction SilentlyContinue)) 'uninstall confirms Hub listener is gone'
    Assert-Native (-not (Test-Path (Join-Path $root 'ChatMCP.exe')) -and -not (Test-Path $registry)) 'uninstall removes owned launcher and registration'
    Assert-Shortcuts ($newShortcuts + $oldShortcuts) $false 'uninstall removes the Desktop and Start menu shortcuts under either name'
    Assert-Native (-not (Test-Path -LiteralPath (Join-Path $programsFolder 'DatGold')) -and -not (Test-Path -LiteralPath (Join-Path $programsFolder 'ChatMCP'))) 'and the Start menu folders they were in'
    # The helper outlives the uninstaller by a moment.
    $helperDeadline=[DateTime]::UtcNow.AddSeconds(30)
    while ((Test-Path (Join-Path $root 'Uninstall.exe')) -and [DateTime]::UtcNow -lt $helperDeadline) { Start-Sleep -Milliseconds 400 }
    Assert-Native (-not (Test-Path (Join-Path $root 'Uninstall.exe'))) 'uninstaller deletes its own Uninstall.exe through its helper, also when started from a PowerShell 7 session'
    Assert-Native ([IO.File]::ReadAllText($canary) -eq 'PRESERVE-USER-DATA' -and [IO.File]::ReadAllText($stateCanary) -eq 'PRESERVE-STATE') 'uninstall preserves unrelated files and user state'
    # ---- The update mode that the desktop shell uses (installer/UpdateRun.cs, installer/UpdateProgressForm.cs) ------------------------------------------------------------------------------
    # Round 1 above upgraded the baseline with the legacy quiet form, which stays exactly as it was. This round starts again from a baseline install (the uninstall above left none) and drives the
    # candidate setup the way the shell does: --quiet --update --install-dir <dir> --wait-pid <the shell> --relaunch --result <file>. It needs a baseline that is OLDER than the candidate: an update
    # never installs the same version or an older one. The shell's own half (verify the file, ask the Hub, start the setup) is proved by scripts/tests/native-lifecycle; here the setup meets the real
    # baseline, a real Hub, real windows and real shortcuts.
    if ([version]$ExpectedBaselineVersion -ge [version]$ExpectedCandidateVersion) {
        $report.skipped += 'update mode: the baseline is not older than the candidate'
        Write-Host 'SKIP update mode: the baseline is not older than the candidate, and an update never installs the same version or an older one.'
    } else {
        $results = Join-Path $OutputDirectory 'update-results'
        New-Item -ItemType Directory -Path $results -Force | Out-Null
        $exe = Join-Path $root 'ChatMCP.exe'
        Assert-Native (-not (Test-Path -LiteralPath $exe) -and -not (Test-Path $registry)) '[update] the uninstall above left no installation to update'
        Install-Baseline '[update] the published baseline is installed again, the state an update starts from'
        $baselineHash = (Get-FileHash $exe -Algorithm SHA256).Hash
        $baselineHubFile = Join-Path $root 'CHATMCP-HUB\package.json'

        # 1. Another program on the port of the Hub: nothing is replaced and the window says why. The setup stages its whole payload before it looks at the port (the legacy form of round 1 takes about a minute and a half
        # to refuse), so the result is waited for minutes, not seconds. A pid that is not the shell (this PowerShell) is not waited for: had it been, the reason would be shell_not_exited after 30 seconds.
        $fakeHub = Start-Process (Get-Command node.exe).Source -ArgumentList ('"' + $fakeFile + '"') -WindowStyle Hidden -PassThru; $owned.Add($fakeHub)
        $null = Wait-Health $ExpectedBaselineVersion
        $foreignResult = Join-Path $results 'foreign-listener.json'
        $refused = Start-InstallerUpdate (Update-Arguments -WaitPid ([string]$PID) -ResultFile $foreignResult)
        Assert-NativeError $refused 'Another program is using the port' 300
        Assert-Native $true '[update] another program on port 3007 refuses the update in the words of the window ("Another program is using the port"), and the baseline is still installed (a pid that is not the shell is not waited for: had it been, the window would say that DatGold did not close, after 30 seconds)'
        Assert-Native ((Close-UpdateWindow $refused) -eq 1) '[update] the window of a refused update ends with its Close button, and the exit code says it did not go through'
        # The Hub reads the result file once, when it starts. While a program holds the port no result file is left: nobody would read it until some later start, when it would announce a refusal that was long forgotten.
        Assert-Native (-not (Test-Path -LiteralPath $foreignResult)) '[update] and, while a program is on the port of the Hub, no result file is left for a Hub that may start days later'
        Assert-Native ((Get-FileHash $exe -Algorithm SHA256).Hash -eq $baselineHash -and -not $fakeHub.HasExited) '[update] the refusal left the installed bytes and the other program as they were'
        $fakeHub.Kill(); $null = $fakeHub.WaitForExit(10000)

        # 2. A file in use: nothing is replaced (the setup opens every file it will change before it changes one), and the old app is opened again and works.
        $inUse = [IO.File]::Open($baselineHubFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $started = Get-Date
        try {
            $busyResult = Join-Path $results 'file-in-use.json'
            $busy = Start-InstallerUpdate (Update-Arguments -Relaunch $true -ResultFile $busyResult)
            $outcome = Read-UpdateResult $busyResult 300
            Assert-UpdateResult $outcome $false 'unchanged' 'install_failed' $ExpectedBaselineVersion '[update] a file that is in use stops the update before a file is replaced: unchanged, with the reason install_failed'
            Assert-NativeError $busy 'files could not be replaced'
            Assert-Native ((Close-UpdateWindow $busy) -eq 1) '[update] and its window says so and ends with Close'
        } finally { $inUse.Dispose() }
        $reopened = Wait-InstalledApp $started
        $null = Wait-Health $ExpectedBaselineVersion
        Assert-Native ((Get-FileHash $exe -Algorithm SHA256).Hash -eq $baselineHash) '[update] the baseline app was opened again by the update that did not go through, and its Hub answers with the baseline version'
        $null = Window-For $reopened
        Close-Desktop $reopened
        Stop-InstalledHub

        # 3. The update that goes through, from the app that is open: it waits for the shell to close, replaces the files, opens the new app, and leaves the Hub that runs next the word "updated".
        $shell = Start-Desktop
        $null = Wait-Health $ExpectedBaselineVersion
        foreach ($shortcut in @($oldShortcuts[0], $newShortcuts[0])) { if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force } }
        Assert-Shortcuts @($oldShortcuts[0], $newShortcuts[0]) $false '[update] the person has deleted the Desktop shortcut'
        $handOver = Join-Path $data 'hub\update-result.json'
        $started = Get-Date
        $update = Start-InstallerUpdate (Update-Arguments -WaitPid ([string]$shell.Id) -Relaunch $true -ResultFile $handOver)
        $updateWindow = Window-For $update
        Assert-Native ($null -ne (Control-ByName $updateWindow ('Updating DatGold to ' + $ExpectedCandidateVersion))) '[update] the window of an update says what it is doing: Updating DatGold to the candidate version'
        Start-Sleep -Seconds 5
        Assert-Native (-not $update.HasExited -and (Get-FileHash $exe -Algorithm SHA256).Hash -eq $baselineHash -and -not (Test-Path -LiteralPath $handOver)) '[update] the update waits for the shell to close: nothing is replaced while the app is open'
        Close-Desktop $shell
        Assert-Native ($update.WaitForExit(480000) -and $update.ExitCode -eq 0) '[update] once the shell has closed the update goes through (exit code 0) and its window closes by itself'
        $newApp = Wait-InstalledApp $started
        $installedHealth = Wait-Health $ExpectedCandidateVersion
        Assert-Native (((Get-Item $exe).VersionInfo.ProductVersion -like "$ExpectedCandidateVersion*") -and ((Get-Content (Join-Path $root 'CHATMCP-HUB\package.json') -Raw | ConvertFrom-Json).version -eq $ExpectedCandidateVersion) -and ((Get-ItemProperty $registry).DisplayVersion -eq $ExpectedCandidateVersion)) ('[update] the installation is the candidate ' + $ExpectedCandidateVersion + ' in the program, in the Hub and in the Windows Installed Apps entry')
        Assert-Native ($installedHealth.auth -eq 'bearer') '[update] and the app that opened is the new one (its Hub requires the per-launch secret)'
        $applied = $null
        $hubState = Get-HubState
        if ($null -ne $hubState.PSObject.Properties['update'] -and $null -ne $hubState.update -and $null -ne $hubState.update.PSObject.Properties['applied']) { $applied = $hubState.update.applied }
        Assert-Native (($null -ne $applied) -and ($applied.ok -eq $true) -and ($applied.version -eq $ExpectedCandidateVersion) -and ($applied.previous -eq $ExpectedBaselineVersion) -and ($applied.state -eq 'installed')) '[update] the Hub that runs after the update tells the page "updated to x.y.z" (update.applied), from the file the setup left'
        Assert-Native (-not (Test-Path -LiteralPath $handOver)) '[update] and it consumed the result file, so a later start does not announce it again'
        Assert-Shortcuts @($oldShortcuts[0], $newShortcuts[0]) $false '[update] the Desktop shortcut that the person had deleted is not brought back, under either name'
        Assert-Shortcuts @($newShortcuts[1], $newShortcuts[2]) $true '[update] the Start menu shortcuts are the DatGold ones'
        Assert-Shortcuts @($oldShortcuts[1], $oldShortcuts[2]) $false '[update] and none is left under the old name'
        Assert-Native (-not (Test-Path -LiteralPath (Join-Path $programsFolder 'ChatMCP'))) '[update] and the Start menu folder ChatMCP is gone'

        # 4. The same version again: refused in words, nothing replaced, and the app that is installed is opened again (the Hub that ran stays).
        $null = Window-For $newApp
        $sameResult = Join-Path $results 'not-newer.json'
        $started = Get-Date
        $again = Start-InstallerUpdate (Update-Arguments -WaitPid ([string]$newApp.Id) -Relaunch $true -ResultFile $sameResult)
        Close-Desktop $newApp
        Assert-NativeError $again 'not newer than the installed' 120
        Assert-Native ((Close-UpdateWindow $again) -eq 1) '[update] the same version is refused (not_newer) in the words of the window, which ends with Close, and the exit code says it did not go through'
        # The Hub of the app that was closed is still up (nothing was stopped: the refusal comes first), so no Hub is going to start and read a result file: none is left.
        Assert-Native (-not (Test-Path -LiteralPath $sameResult)) '[update] and, the Hub that ran being still up, no result file is left'
        Assert-Native ((Get-Item $exe).VersionInfo.ProductVersion -like "$ExpectedCandidateVersion*") '[update] and nothing is replaced: the installed version is the candidate'
        $reopened = Wait-InstalledApp $started
        $null = Wait-Health $ExpectedCandidateVersion
        Assert-Native $true '[update] the installed app was opened again after the refusal'
        $null = Window-For $reopened
        Close-Desktop $reopened

        # 5. The legacy quiet form, as the lifecycle scripts use it, still works (here over an installation of the same version).
        Assert-Native ((Quiet-Install) -eq 0) '[update] the legacy form --quiet --install-dir still installs, as before the update mode existed'
        Assert-Native ((Get-Item $exe).VersionInfo.ProductVersion -like "$ExpectedCandidateVersion*") '[update] and leaves the candidate installed'

        # 6. What an update leaves uninstalls.
        $uninstallAfter = Start-Process (Join-Path $root 'Uninstall.exe') -ArgumentList @('--quiet', '--uninstall') -PassThru; $owned.Add($uninstallAfter)
        Assert-Native ($uninstallAfter.WaitForExit(120000) -and $uninstallAfter.ExitCode -eq 0) '[update] the installation that the update made uninstalls with its own Uninstall.exe'
        Assert-Native (-not (Test-Path -LiteralPath $exe) -and -not (Test-Path $registry) -and -not (Get-NetTCPConnection -LocalPort 3007 -State Listen -ErrorAction SilentlyContinue)) '[update] and leaves no program, no registration and no Hub'
    }
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
