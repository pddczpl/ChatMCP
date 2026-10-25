#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RunId)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if ($env:USERNAME -ne 'WDAGUtilityAccount' -or -not (Test-Path -LiteralPath 'C:\G6Input\run-id.txt') -or
    [IO.File]::ReadAllText('C:\G6Input\run-id.txt') -ne $RunId) { throw 'This destructive lifecycle test only runs in its owned disposable Windows Sandbox.' }
$report = [ordered]@{ result='FAIL'; runId=$RunId; os=[Environment]::OSVersion.VersionString; user=$env:USERNAME; checks=@(); error=$null }
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\ChatMCP'
$appData = Join-Path $env:LOCALAPPDATA 'ChatMCP'
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'ChatMCP Studio.lnk'
$startFolder = Join-Path ([Environment]::GetFolderPath('Programs')) 'ChatMCP'
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatMCP'
function Assert-Check([bool]$condition, [string]$label) {
    if (-not $condition) { throw $label }
    $script:report.checks += $label
    [IO.File]::AppendAllText('C:\G6Output\progress.txt', "PASS: $label`r`n")
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class InstallerWindow {
 public delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc e,IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int z,bool b);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
 public static IntPtr Find(uint pid) {IntPtr found=IntPtr.Zero;EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);var s=new StringBuilder(1024);GetWindowText(h,s,1024);if(owner==pid && (s.ToString().StartsWith("DatGold") || s.ToString().StartsWith("ChatMCP")))found=h;return true;},IntPtr.Zero);return found;}
}
"@
function Find-Control($window, [string]$name, $type) {
    $condition = New-Object Windows.Automation.AndCondition(
        (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, $name)),
        (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, $type)))
    $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}
function Wait-Window($process) {
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        if ($process.HasExited) { throw 'Native application exited before creating its window.' }
        $handle = [InstallerWindow]::Find($process.Id)
        if ($handle -ne [IntPtr]::Zero) {
            $null = [InstallerWindow]::MoveWindow($handle,-20000,-20000,1366,850,$true)
            $null = [InstallerWindow]::ShowWindow($handle,4)
            return [Windows.Automation.AutomationElement]::FromHandle($handle)
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Native window timeout.'
}
function Wait-Button($window, [string]$name) {
    $deadline = [DateTime]::UtcNow.AddMinutes(4)
    do {
        $button = Find-Control $window $name ([Windows.Automation.ControlType]::Button)
        if ($null -ne $button -and $button.Current.IsEnabled) { return $button }
        Start-Sleep -Milliseconds 400
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Wizard did not show '$name'."
}
function Invoke-Button($button) { $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
function Install-Wizard([string]$file, [string]$phase) {
    $process = Start-Process -FilePath $file -WindowStyle Hidden -PassThru
    $window = Wait-Window $process
    Invoke-Button (Wait-Button $window 'Install')
    $finish = Wait-Button $window 'Finish'
    $launch = Find-Control $window 'Launch ChatMCP Studio now' ([Windows.Automation.ControlType]::CheckBox)
    $toggle = $launch.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
    if ($toggle.Current.ToggleState -eq [Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
    Invoke-Button $finish
    Assert-Check ($process.WaitForExit(30000) -and $process.ExitCode -eq 0) "$phase actual setup wizard completes with exit 0"
}
function Launch-Desktop([string]$phase) {
    # WebView2 150+ ignores user environment/HKCU flags for elevated hosts.
    # WDAG's desktop account is elevated, so use the documented HKLM policy
    # scoped to this executable inside this disposable guest only.
    $debugPolicy='HKLM:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
    New-Item -Path $debugPolicy -Force | Out-Null
    New-ItemProperty -LiteralPath $debugPolicy -Name 'ChatMCP.exe' -Value '--remote-debugging-port=9229' -PropertyType String -Force | Out-Null
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName=Join-Path $installDir 'ChatMCP.exe'
    $start.UseShellExecute=$false
    $start.CreateNoWindow=$true
    $start.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
    $start.EnvironmentVariables['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS']='--remote-debugging-port=9229'
    $process=[Diagnostics.Process]::Start($start)
    $null = Wait-Window $process
    try {
        $probeStart=New-Object Diagnostics.ProcessStartInfo
        $probeStart.FileName=Join-Path $installDir 'runtimes\node\node.exe'
        $probeStart.Arguments="C:\G6Input\desktop-probe.mjs $phase C:\G6Output"
        $probeStart.UseShellExecute=$false
        $probeStart.CreateNoWindow=$true
        $probeStart.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
        $probeStart.RedirectStandardOutput=$true
        $probeStart.RedirectStandardError=$true
        $probe=[Diagnostics.Process]::Start($probeStart)
        $probeOutput=$probe.StandardOutput.ReadToEndAsync()
        $probeError=$probe.StandardError.ReadToEndAsync()
        if (-not $probe.WaitForExit(240000)) { Stop-Process -Id $probe.Id; throw "$phase desktop probe timed out" }
        [IO.File]::WriteAllText("C:\G6Output\$phase-probe.log",$probeOutput.GetAwaiter().GetResult())
        [IO.File]::WriteAllText("C:\G6Output\$phase-probe-error.log",$probeError.GetAwaiter().GetResult())
        $report[($phase+'ProbeExitCode')]=$probe.ExitCode
        Assert-Check ($probe.ExitCode -eq 0) "$phase actual desktop WebView2, React and Hub first launch"
        $nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -eq (Join-Path $installDir 'runtimes\node\node.exe') })
        Assert-Check ($nodes.Count -eq 1) "$phase Hub uses only bundled Node"
    } finally {
        $null = [InstallerWindow]::PostMessage([InstallerWindow]::Find($process.Id),0x0010,[IntPtr]::Zero,[IntPtr]::Zero)
        Assert-Check ($process.WaitForExit(30000)) "$phase desktop closes gracefully"
        Remove-ItemProperty -LiteralPath $debugPolicy -Name 'ChatMCP.exe' -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    $remaining = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -eq (Join-Path $installDir 'runtimes\node\node.exe') })
    $installedVersion = (Get-Content -LiteralPath (Join-Path $installDir 'CHATMCP-HUB\package.json') -Raw | ConvertFrom-Json).version
    if ([version]$installedVersion -ge [version]'3.8.3') {
        Assert-Check ($remaining.Count -eq 1) "$phase session Hub survives GUI close without replay"
        & (Join-Path $installDir 'CHATMCP-HUB\STOP-CHATMCP-HUB.cmd')
        Assert-Check ($LASTEXITCODE -eq 0) "$phase explicit session Hub shutdown succeeds"
    } else { Assert-Check ($remaining.Count -eq 0) "$phase legacy owned Hub exits with desktop" }
}
try {
    foreach ($tool in @('node.exe','dotnet.exe','git.exe','npm.cmd')) {
        Assert-Check ($null -eq (Get-Command $tool -ErrorAction SilentlyContinue)) "clean guest has no $tool on PATH"
    }
    foreach ($directory in @($installDir,$appData)) { Assert-Check (-not (Test-Path -LiteralPath $directory)) "clean guest has no previous $directory" }
    Assert-Check (-not (Test-Path -LiteralPath $registry)) 'clean guest has no registered ChatMCP installation'
    # WebView2 is the documented runtime prerequisite, never a developer tool.
    $runtime = Start-Process -FilePath 'C:\G6Input\WebView2RuntimeInstallerX64.exe' -ArgumentList '/silent','/install' -WindowStyle Hidden -PassThru
    $runtimeFinished=$runtime.WaitForExit(180000)
    $report.webView2InstallerFinished=$runtimeFinished
    $report.webView2InstallerExitCode=if($runtimeFinished){$runtime.ExitCode}else{$null}
    Assert-Check ($runtimeFinished -and $runtime.ExitCode -eq 0) 'Microsoft WebView2 prerequisite installed offline in guest only'
    $report.baselineSha256 = (Get-FileHash -LiteralPath 'C:\G6Input\BaselineSetup.exe' -Algorithm SHA256).Hash
    $report.candidateSha256 = (Get-FileHash -LiteralPath 'C:\G6Input\CandidateSetup.exe' -Algorithm SHA256).Hash
    $report.baselineVersion = (Get-Item -LiteralPath 'C:\G6Input\BaselineSetup.exe').VersionInfo.ProductVersion
    $report.candidateVersion = (Get-Item -LiteralPath 'C:\G6Input\CandidateSetup.exe').VersionInfo.ProductVersion
    Assert-Check ($report.baselineSha256 -ne $report.candidateSha256) 'upgrade uses a different real installer artifact'
    Install-Wizard 'C:\G6Input\BaselineSetup.exe' 'baseline'
    $baselineFiles=@(Get-ChildItem -LiteralPath $installDir -File -Recurse | ForEach-Object { $_.FullName.Substring($installDir.Length+1) })
    [IO.File]::WriteAllText('C:\G6Output\baseline-file-inventory.json',($baselineFiles | ConvertTo-Json))
    foreach ($file in @('ChatMCP.exe','WebView2Loader.dll','runtimes\node\node.exe','runtimes\node\node.exe.sha256','CHATMCP-HUB\hub.mjs','CHATMCP-HUB\web\dist\index.html','CHATMCP-HUB\runtimes\windows-sandbox\GuestSupervisor.exe','CHATMCP-HUB\runtimes\windows-sandbox\GuestSupervisor.exe.sha256','CHATMCP-HUB\runtimes\ripgrep\rg.exe','CHATMCP-HUB\runtimes\ripgrep\LICENSE-MIT','CHATMCP-HUB\runtimes\ripgrep\UNLICENSE','Uninstall.exe')) {
        Assert-Check (Test-Path -LiteralPath (Join-Path $installDir $file)) "installed layout includes $file"
    }
    Assert-Check ((Test-Path -LiteralPath $desktopLink) -and (Test-Path -LiteralPath (Join-Path $startFolder 'ChatMCP Studio.lnk'))) 'desktop and Start Menu shortcuts exist'
    Assert-Check ((Get-ItemProperty -LiteralPath $registry).InstallLocation -eq $installDir) 'Windows Installed Apps registration points to installed path'
    foreach ($file in @('runtimes\node\node.exe','CHATMCP-HUB\runtimes\windows-sandbox\GuestSupervisor.exe')) {
        $actual=(Get-FileHash -LiteralPath (Join-Path $installDir $file) -Algorithm SHA256).Hash
        $expected=([IO.File]::ReadAllText((Join-Path $installDir ($file+'.sha256'))).Trim() -split '\s+')[0]
        Assert-Check ($actual -eq $expected) "installed runtime SHA-256 matches $file"
    }
    Launch-Desktop 'baseline'
    # Current createHubServer stores AI profiles at its BUNDLE_ROOT fallback;
    # the ownership manifest must preserve this real runtime-created file too.
    $settingsFile=Join-Path $installDir 'CHATMCP-HUB\ai-profiles.json'
    $settingsBefore=(Get-FileHash -LiteralPath $settingsFile -Algorithm SHA256).Hash
    $markers=@((Join-Path $installDir 'unrelated-user-document.txt'),(Join-Path $installDir 'CHATMCP-HUB\user-settings.txt'),(Join-Path $startFolder 'unrelated-user-document.txt'),(Join-Path $env:USERPROFILE 'Documents\unrelated-g6-document.txt'))
    foreach ($marker in $markers) { [IO.File]::WriteAllText($marker,$RunId) }
    Install-Wizard 'C:\G6Input\CandidateSetup.exe' 'upgrade'
    Assert-Check ((Get-FileHash -LiteralPath (Join-Path $installDir 'Uninstall.exe') -Algorithm SHA256).Hash -eq $report.candidateSha256) 'in-place upgrade replaces baseline installer with candidate'
    # The candidate is the build under test: it carries the license texts of what is compiled into rg.exe, PCRE2 and the Rust standard library included (the baseline may predate them).
    foreach ($file in @('CHATMCP-HUB\licenses\ripgrep\MANIFEST.json','CHATMCP-HUB\licenses\ripgrep\libpcre2-10.46\LICENCE.md','CHATMCP-HUB\licenses\ripgrep\rust-std-da80ed070\COPYRIGHT')) {
        Assert-Check (Test-Path -LiteralPath (Join-Path $installDir $file)) "upgraded layout includes $file"
    }
    Assert-Check ((Get-FileHash -LiteralPath $settingsFile -Algorithm SHA256).Hash -eq $settingsBefore) 'upgrade preserves real BYO profile settings byte for byte'
    foreach ($marker in $markers) { Assert-Check ([IO.File]::ReadAllText($marker) -eq $RunId) "upgrade preserves $marker" }
    Launch-Desktop 'upgrade'
    # Separate synthetic regression for manifest-aware maintenance. This does
    # not manufacture ownership metadata for the genuine legacy baseline.
    $maintenanceManifestPath=Join-Path $installDir '.chatmcp-installed-files.json'
    $maintenanceManifest=Get-Content -LiteralPath $maintenanceManifestPath -Raw | ConvertFrom-Json
    $obsoleteName='CHATMCP-HUB/web/dist/assets/g6-obsolete-owned.js'
    $modifiedName='CHATMCP-HUB/web/dist/assets/g6-modified-owned.js'
    foreach($name in @($obsoleteName,$modifiedName)) {
        $file=Join-Path $installDir $name
        [IO.File]::WriteAllText($file,'original owned fixture')
        $maintenanceManifest | Add-Member -MemberType NoteProperty -Name $name -Value (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    }
    [IO.File]::WriteAllText((Join-Path $installDir $modifiedName),$RunId)
    [IO.File]::WriteAllText($maintenanceManifestPath,($maintenanceManifest | ConvertTo-Json))
    $hardlinkCanary=Join-Path $env:USERPROFILE 'Documents\g6-hardlink-canary.txt'
    [IO.File]::WriteAllText($hardlinkCanary,$RunId)
    $uninstallerPath=Join-Path $installDir 'Uninstall.exe'
    Remove-Item -LiteralPath $uninstallerPath
    New-Item -ItemType HardLink -Path $uninstallerPath -Target $hardlinkCanary | Out-Null
    Install-Wizard 'C:\G6Input\CandidateSetup.exe' 'manifest-aware maintenance fixture'
    Assert-Check (-not (Test-Path -LiteralPath (Join-Path $installDir $obsoleteName))) 'maintenance removes unchanged obsolete owned file'
    Assert-Check ([IO.File]::ReadAllText((Join-Path $installDir $modifiedName)) -eq $RunId) 'maintenance preserves modified obsolete owned file'
    Assert-Check ([IO.File]::ReadAllText($hardlinkCanary) -eq $RunId) 'maintenance replaces Uninstall.exe hardlink without writing unrelated target'
    $manifest = Get-Content -LiteralPath (Join-Path $installDir '.chatmcp-installed-files.json') -Raw | ConvertFrom-Json
    $report.ownedFileCount = @($manifest.PSObject.Properties).Count
    $uninstaller = Start-Process -FilePath (Join-Path $installDir 'Uninstall.exe') -WindowStyle Hidden -PassThru
    $window=Wait-Window $uninstaller
    Invoke-Button (Wait-Button $window 'Uninstall')
    Invoke-Button (Wait-Button $window 'Close')
    Assert-Check ($uninstaller.WaitForExit(30000) -and $uninstaller.ExitCode -eq 0) 'actual uninstall wizard completes with exit 0'
    $deadline=[DateTime]::UtcNow.AddSeconds(30)
    while ((Test-Path -LiteralPath (Join-Path $installDir 'Uninstall.exe')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
    foreach ($file in $manifest.PSObject.Properties.Name) { if (Test-Path -LiteralPath (Join-Path $installDir $file)) { throw "Uninstall left owned file: $file" } }
    Assert-Check $true 'uninstall removes every manifest-owned payload file including its own executable'
    $legacyLeftovers=@($baselineFiles | Where-Object { Test-Path -LiteralPath (Join-Path $installDir $_) })
    $report.legacyBaselineLeftovers=$legacyLeftovers
    Assert-Check ($legacyLeftovers.Count -eq 0) 'uninstall removes the genuine legacy baseline file inventory too'
    Assert-Check (-not (Test-Path -LiteralPath $registry)) 'uninstall removes Windows Installed Apps entry'
    Assert-Check (-not (Test-Path -LiteralPath $desktopLink) -and -not (Test-Path -LiteralPath (Join-Path $startFolder 'ChatMCP Studio.lnk'))) 'uninstall removes owned shortcuts'
    foreach ($marker in $markers) { Assert-Check ([IO.File]::ReadAllText($marker) -eq $RunId) "uninstall preserves $marker" }
    Assert-Check ((Get-FileHash -LiteralPath $settingsFile -Algorithm SHA256).Hash -eq $settingsBefore) 'uninstall preserves real user model settings'
    Assert-Check (Test-Path -LiteralPath (Join-Path $appData 'webview2-data')) 'uninstall preserves WebView2 user preferences'
    Assert-Check ([IO.File]::ReadAllText((Join-Path $installDir $modifiedName)) -eq $RunId) 'uninstall preserves modified obsolete file from maintenance fixture'
    Assert-Check ([IO.File]::ReadAllText($hardlinkCanary) -eq $RunId) 'uninstall preserves unrelated hardlink target from maintenance fixture'
    $report.result='PASS'
} catch { $report.error=$_.Exception.ToString(); $report.errorLine=$_.InvocationInfo.ScriptLineNumber }
finally { [IO.File]::WriteAllText('C:\G6Output\lifecycle-report.json',($report | ConvertTo-Json -Depth 10)) }
if ($report.result -ne 'PASS') { exit 1 }
exit 0
