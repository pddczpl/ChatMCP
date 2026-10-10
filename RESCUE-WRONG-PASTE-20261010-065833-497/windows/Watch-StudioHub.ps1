#Requires -Version 5.1
<#
Optional watchdog for the local Hub only (not ChatGPT Web, Docker, or network).
Does not kill processes, change networking, alter the selected workspace,
register a service, or restart any known-to-be-running previous Hub release.
Run interactively in a dedicated PowerShell terminal. Ctrl+C to stop.
#>
param(
    [ValidateRange(10,120)][int]$IntervalSeconds = 20,
    [ValidateRange(2,20)][int]$FailureThreshold = 3,
    [ValidateRange(1,30)][int]$MaxRestarts = 5,
    [string]$BaseUrl = 'http://127.0.0.1:3007',
    [string]$LogDirectory = "$env:LOCALAPPDATA\ChatMCPStudio\diagnostics"
)
$ErrorActionPreference = 'Stop'
if ($BaseUrl -notmatch '^http://(?:127\.0\.0\.1|localhost):\d{4,5}$') {
    throw 'Only a localhost Hub URL is supported.'
}
$start = Join-Path (Split-Path -Parent $PSScriptRoot) 'START-CHATMCP-HUB.cmd'
if (-not (Test-Path -LiteralPath $start -PathType Leaf)) { throw "Launcher not found: $start" }
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$log = Join-Path $LogDirectory ("watchdog-"+(Get-Date -Format 'yyyyMMdd-HHmmss')+".log")
$failures = 0
$restarts = 0
function Probe {
    try {
        $reply = Invoke-RestMethod -Uri ($BaseUrl+'/api/health') -TimeoutSec 5 -ErrorAction Stop
        if ($reply.app -ne 'chatmcp-local-hub') { return 'foreign' }
        if ($reply.version -ne '2.2.0') { return 'wrong-version' }
        return 'healthy'
    } catch { return 'unreachable' }
}
function Note([string]$Message) {
    $line = ('{0}  {1}' -f (Get-Date -Format 'o'), $Message)
    Write-Host $line
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}
Note "Watchdog started; target=$BaseUrl interval=$IntervalSeconds seconds. Ctrl+C to stop."
while ($true) {
    $health = Probe
    if ($health -eq 'healthy') {
        if ($failures -gt 0) { Note 'Hub responsive again.' }
        $failures = 0
    } elseif ($health -eq 'foreign' -or $health -eq 'wrong-version') {
        Note "STOP: port occupied by a different service or version ($health). No automatic restart."
        exit 2
    } else {
        $failures++
        Note "Hub unreachable ($failures/$FailureThreshold)."
        if ($failures -ge $FailureThreshold) {
            if ($restarts -ge $MaxRestarts) { Note 'Maximum restart attempts reached; manual diagnosis required.'; exit 1 }
            $restarts++
            Note "Attempting restart $restarts/$MaxRestarts (local launcher)."
            try {
                & $start 2>&1 | ForEach-Object {
                    $line = [string]$_
                    if ($line -match '(?i)authorization|bearer|api.?key|token|secret') { $line='[sensitive launcher output hidden]' }
                    Note $line
                }
            } catch { Note ('Launcher error: '+$_.Exception.Message) }
            Start-Sleep -Seconds 15
            if ((Probe) -eq 'healthy') { Note 'Hub recovery successful.'; $failures=0 }
        }
    }
    Start-Sleep -Seconds $IntervalSeconds
}
