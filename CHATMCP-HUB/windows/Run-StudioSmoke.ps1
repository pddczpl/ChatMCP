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
if (-not $ExpectedVersion) {
  $package=Join-Path (Split-Path -Parent $PSScriptRoot) 'package.json'
  if (Test-Path -LiteralPath $package -PathType Leaf) { try { $ExpectedVersion=[string](Get-Content -LiteralPath $package -Raw | ConvertFrom-Json).version } catch { $ExpectedVersion='' } }
}
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
$Auth=Get-HubSessionHeaders $BaseUrl $StateDir
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
