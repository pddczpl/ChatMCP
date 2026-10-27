#Requires -Version 5.1
<#[.SYNOPSIS] Non-destructive Windows smoke test for a running ChatMCP Hub.
Does not stop/start the Hub, touch the user's project, or reveal API keys.
The expected version is "version" in ..\package.json (the folder this script belongs to); -ExpectedVersion overrides it.
The expected UI build is the one the Hub itself reports on /api/health. Nothing here has to be edited for a new release.
Start the Hub first (START-CHATMCP-HUB.cmd) and select a workspace; the checks that read the workspace need one.
#>
param([string]$BaseUrl='http://127.0.0.1:3007', [string]$ExpectedVersion='', [string]$StateDir='')
$ErrorActionPreference='Stop'
$BaseUrl=$BaseUrl.TrimEnd('/')
if ($BaseUrl -notmatch '^http://(?:127\.0\.0\.1|localhost):\d{4,5}$') { throw 'Only localhost Hub URLs are supported.' }
# The Hub listens on 127.0.0.1 only. The name localhost may resolve to ::1 first, where another program could be listening, so connect to 127.0.0.1.
$BaseUrl = $BaseUrl -replace '^http://localhost:', 'http://127.0.0.1:'
if (-not $ExpectedVersion) {
  $package=Join-Path (Split-Path -Parent $PSScriptRoot) 'package.json'
  if (Test-Path -LiteralPath $package -PathType Leaf) { try { $ExpectedVersion=[string](Get-Content -LiteralPath $package -Raw | ConvertFrom-Json).version } catch { $ExpectedVersion='' } }
}
# The Hub requires its per-launch secret (a bearer) on every API call. It publishes it in <state dir>\run\hub-session.json, which
# only this Windows account can read. A Hub that predates the secret (v3.9.0 and older) has no such file and needs no header.
# The secret is presented only to the process that listens on the port and is the one the file names (see Assert-HubSessionListener).
# BEGIN hub-listener-check
# The same text is in Stop-ChatMcpHub.ps1, windows/Run-StudioSmoke.ps1 and windows/Test-Gateway-ViaHub.ps1 (tests/verify-hub-listener-powershell.mjs
# compares the copies and runs this code). The session file outlives a crash and any program can answer /api/health, so the secret in the file
# is presented only to the process that listens on the port and is the one the file names (the desktop app and the Node launcher do the same).
function Get-HubListenerPid {
    # The process id that owns the listening socket a connection to 127.0.0.1:<port> reaches; $null when nobody listens there.
    # Throws when that cannot be told: the TCP table cannot be read, a listener has no known owner, or several processes share the port.
    param([int]$ListenPort)
    try { $rows = @(Get-NetTCPConnection -State Listen -LocalPort $ListenPort -ErrorAction Stop) }
    catch {
        # The message is localised; the error id is not. Only "no such listener" means that nobody listens.
        if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { return $null }
        throw ('the TCP table cannot be read: ' + $_.Exception.Message)
    }
    $exact = @()
    $wildcard = @()
    foreach ($row in $rows) {
        $address = [string]$row.LocalAddress
        # Other interfaces and ::1 alone are not reached by a connection to 127.0.0.1.
        if ($address -ne '127.0.0.1' -and $address -ne '0.0.0.0' -and $address -ne '::') { continue }
        $owner = [int64]$row.OwningProcess
        if ($owner -lt 1) { throw ('a socket that listens on port ' + $ListenPort + ' has no known owner') }
        if ($address -eq '127.0.0.1') { $exact += $owner } else { $wildcard += $owner }
    }
    # Windows hands a connection to the most specific listener: a wildcard listener beside one bound to 127.0.0.1 receives nothing.
    $owners = $wildcard
    if ($exact.Count -gt 0) { $owners = $exact }
    $owners = @($owners | Sort-Object -Unique)
    if ($owners.Count -gt 1) { throw ('processes ' + ($owners -join ', ') + ' all listen on port ' + $ListenPort) }
    if ($owners.Count -eq 0) { return $null }
    return [int64]$owners[0]
}

function Assert-HubSessionListener {
    # Throws a readable message, before any request carries the secret, unless the process that listens on the port wrote the session file.
    param([int64]$SessionPid, [int]$ListenPort)
    $advice = ' The session secret was not sent. Close the program that holds the port, or point this script at the right Hub (its port and -StateDir).'
    try { $listener = Get-HubListenerPid -ListenPort $ListenPort }
    catch { throw ('Cannot tell which process listens on port ' + $ListenPort + ' (' + $_.Exception.Message + '), so it is not certain to be the Hub (process ' + $SessionPid + ') that wrote hub-session.json.' + $advice) }
    if ($null -eq $listener) { throw ('Nothing listens on port ' + $ListenPort + ', although hub-session.json says that the Hub (process ' + $SessionPid + ') runs there: the file is left over from a crash.' + $advice) }
    if ($listener -ne $SessionPid) { throw ('Port ' + $ListenPort + ' is held by process ' + $listener + ', not by the Hub (process ' + $SessionPid + ') that wrote hub-session.json: the file is left over from a crash, or another program took the port.' + $advice) }
}
# END hub-listener-check
function Get-HubSessionHeaders([string]$Url, [string]$Directory) {
  if ([string]::IsNullOrWhiteSpace($Directory)) { $Directory = $env:CHATMCP_STATE_DIR }
  if ([string]::IsNullOrWhiteSpace($Directory)) { $Directory = Join-Path $env:LOCALAPPDATA 'ChatMCP\hub' }
  $file = Join-Path (Join-Path $Directory 'run') 'hub-session.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return @{} }
  try { $session = Get-Content -LiteralPath $file -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { return @{} }
  if ($null -eq $session.PSObject.Properties['secret'] -or $null -eq $session.PSObject.Properties['port']) { return @{} }
  if ([int]$session.port -ne ([uri]$Url).Port -or $session.secret -isnot [string] -or $session.secret -notmatch '^[A-Za-z0-9_-]{32,256}$') { return @{} }
  $filePid = if ($null -ne $session.PSObject.Properties['pid']) { $session.pid } else { $null }
  if (($filePid -isnot [int] -and $filePid -isnot [long]) -or $filePid -lt 1) { return @{} }
  # The file outlives a crash and any program can answer /api/health: the secret goes only to the process that wrote the file.
  # A refusal throws, so the caller stops instead of carrying on without the header.
  Assert-HubSessionListener -SessionPid ([int64]$filePid) -ListenPort ([uri]$Url).Port
  return @{ Authorization = 'Bearer ' + $session.secret }
}
try { $Auth=Get-HubSessionHeaders $BaseUrl $StateDir }
catch { Write-Host ('Smoke test stopped: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
$results=New-Object System.Collections.Generic.List[object]
$script:Health=$null
function Check([string]$Name, [scriptblock]$Fn) {
  try { & $Fn; $results.Add([pscustomobject]@{Test=$Name;Status='PASS'}) }
  catch { $results.Add([pscustomobject]@{Test=$Name;Status='FAIL';Detail=$_.Exception.Message}) }
}
Write-Host 'ChatMCP Hub Windows smoke test (read-only)' -ForegroundColor Cyan
Check 'Hub health and version' {
  $h=Invoke-RestMethod -Uri "$BaseUrl/api/health" -TimeoutSec 8
  if($h.app -ne 'chatmcp-local-hub'){throw "Not a ChatMCP Hub (app=$($h.app))"}
  if($h.version -notmatch '^\d+\.\d+\.\d+'){throw "Unexpected version string: $($h.version)"}
  if(-not $h.uiBuild){throw 'The Hub reported no UI build'}
  $script:Health=$h
  Write-Host "Hub $($h.version); UI $($h.uiBuild); backend $($h.backend)"
  if($ExpectedVersion -and $h.version -ne $ExpectedVersion){throw "Wrong version: the Hub on $BaseUrl is $($h.version) but this folder is $ExpectedVersion. Run STOP-CHATMCP-HUB.cmd, then START-CHATMCP-HUB.cmd."}
}
Check 'Read state without logging secrets' { $s=Invoke-RestMethod -Uri "$BaseUrl/api/state" -Headers $Auth -TimeoutSec 8; if(-not $s.csrfToken){throw 'Missing state CSRF token'} }
Check 'API refuses callers without the Hub session secret' {
  if ($script:Health.auth -ne 'bearer') { Write-Host 'This Hub predates the session secret; nothing to verify.'; return }
  $refusal = $null
  try { Invoke-RestMethod -Uri "$BaseUrl/api/state" -TimeoutSec 8 | Out-Null } catch { $refusal = $_.Exception }
  if ($null -eq $refusal) { throw 'The Hub answered /api/state without the session secret.' }
  if ($null -eq $refusal.Response -or [int]$refusal.Response.StatusCode -ne 401) { throw ('Expected HTTP 401 without the session secret: ' + $refusal.Message) }
}
Check 'Code intelligence status' { $r=Invoke-RestMethod -Uri "$BaseUrl/api/studio/intelligence/status" -Headers $Auth -TimeoutSec 8; if(-not $r.capabilities){throw 'Index endpoint unavailable'} }
Check 'Docker sandbox probe (informational)' { $r=Invoke-RestMethod -Uri "$BaseUrl/api/studio/sandbox" -Headers $Auth -TimeoutSec 8; Write-Host "Docker ready=$($r.ready); $($r.detail)" }
Check 'Preview validator' { $r=Invoke-RestMethod -Uri "$BaseUrl/api/studio/preview?port=65534" -Headers $Auth -TimeoutSec 8; if($r.url -ne 'http://127.0.0.1:65534/'){throw 'Preview not restricted to loopback'} }
Check 'Browser assets served locally' {
  $build=$script:Health.uiBuild
  if(-not $build){throw 'No UI build to compare with (the health check failed)'}
  $r=Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/react-app.js" -TimeoutSec 8
  if($r.StatusCode -ne 200 -or -not ([string]$r.Content).Contains($build)){throw "UI assets are not build $build"}
}
$results | Format-Table -AutoSize
$failed=@($results|Where-Object Status -eq 'FAIL').Count
if($failed){Write-Warning "$failed smoke checks failed";exit 1}else{Write-Host 'Smoke checks passed' -ForegroundColor Green;exit 0}
