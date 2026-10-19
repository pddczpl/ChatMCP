# Test the configured Gateway using the same API key already stored by ChatMCP Hub.
# No key is passed to the shell, printed, or saved by this script.
# The Hub's UI build is read from /api/health, so this script needs no edit for a new release.
param([string]$BaseUrl = 'http://127.0.0.1:3007', [string]$StateDir = '')
$ErrorActionPreference = 'Stop'
$BaseUrl = $BaseUrl.TrimEnd('/')
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
try {
    if ($BaseUrl -notmatch '^http://(?:127\.0\.0\.1|localhost):\d{4,5}$') { throw 'Only localhost Hub URLs are supported.' }
    # The Hub listens on 127.0.0.1 only. The name localhost may resolve to ::1 first, where another program could be listening, so connect to 127.0.0.1.
    $BaseUrl = $BaseUrl -replace '^http://localhost:', 'http://127.0.0.1:'
    $health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -TimeoutSec 6
    if ($health.app -ne 'chatmcp-local-hub') { throw "Expected a ChatMCP Hub on $BaseUrl." }
    $auth = Get-HubSessionHeaders $BaseUrl $StateDir
    $state = Invoke-RestMethod -Uri "$BaseUrl/api/state" -Headers $auth -TimeoutSec 6
    if (-not $state.ai.configured) { throw 'API key/model are not configured. Open the Hub dashboard and finish the model setup first.' }
    $headers = @{
      'Origin' = $BaseUrl
      'X-ChatMCP-Request' = 'local-dashboard'
      'X-ChatMCP-CSRF' = $state.csrfToken
      'X-ChatMCP-UI-Build' = [string]$health.uiBuild
    }
    foreach ($entry in $auth.GetEnumerator()) { $headers[$entry.Key] = $entry.Value }
    Write-Host "Hub $($health.version) (UI $($health.uiBuild))" -ForegroundColor Cyan
    Write-Host "Testing configured gateway: $($state.ai.apiBaseUrl)  model=$($state.ai.model)" -ForegroundColor Cyan
    Write-Host 'This sends a REAL API request with the credential held in Hub memory/DPAPI. API usage may incur cost.'
    $result = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/ai/test" -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 45
    Write-Host "SUCCESS. protocol=$($result.protocol) authMode=$($result.authMode) responsePresent=$($result.responsePresent) toolCalling=$($result.toolCalling)" -ForegroundColor Green
    if ($result.toolCalling -in 'unsupported', 'unreliable') { Write-Host 'The agent needs tool calling to edit files and run commands. Pick another model for agent work.' -ForegroundColor Yellow }
    $result.attempts | Format-Table protocol, authMode, status, success, detail -AutoSize
} catch {
    Write-Host ('Gateway test failed: ' + $_.Exception.Message) -ForegroundColor Yellow
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
    exit 1
}
