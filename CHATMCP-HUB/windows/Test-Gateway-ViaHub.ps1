# Test the configured Gateway using the same API key already stored by ChatMCP Hub.
# No key is passed to the shell, printed, or saved by this script.
# The Hub's UI build is read from /api/health, so this script needs no edit for a new release.
param([string]$BaseUrl = 'http://127.0.0.1:3007', [string]$StateDir = '')
$ErrorActionPreference = 'Stop'
$BaseUrl = $BaseUrl.TrimEnd('/')
# The Hub requires its per-launch secret (a bearer) on every API call. It publishes it in <state dir>\run\hub-session.json, which
# only this Windows account can read. A Hub that predates the secret (v3.9.0 and older) has no such file and needs no header.
function Get-HubSessionHeaders([string]$Url, [string]$Directory) {
  if ([string]::IsNullOrWhiteSpace($Directory)) { $Directory = $env:CHATMCP_STATE_DIR }
  if ([string]::IsNullOrWhiteSpace($Directory)) { $Directory = Join-Path $env:LOCALAPPDATA 'ChatMCP\hub' }
  $file = Join-Path (Join-Path $Directory 'run') 'hub-session.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return @{} }
  try { $session = Get-Content -LiteralPath $file -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { return @{} }
  if ($null -eq $session.PSObject.Properties['secret'] -or $null -eq $session.PSObject.Properties['port']) { return @{} }
  if ([int]$session.port -ne ([uri]$Url).Port -or $session.secret -isnot [string] -or $session.secret -notmatch '^[A-Za-z0-9_-]{32,256}$') { return @{} }
  return @{ Authorization = 'Bearer ' + $session.secret }
}
try {
    if ($BaseUrl -notmatch '^http://(?:127\.0\.0\.1|localhost):\d{4,5}$') { throw 'Only localhost Hub URLs are supported.' }
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
