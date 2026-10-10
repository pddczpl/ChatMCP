#Requires -Version 5.1
<#[.SYNOPSIS] Non-destructive Windows smoke test for ChatMCP Studio 2.2.
Does not stop/start the Hub, touch the user's project, or reveal API keys.
#>
param([string]$BaseUrl='http://127.0.0.1:3007')
$ErrorActionPreference='Stop'
$BaseUrl=$BaseUrl.TrimEnd('/')
if ($BaseUrl -notmatch '^http://(?:127\.0\.0\.1|localhost):\d{4,5}$') { throw 'Only localhost Hub URLs are supported.' }
$results=New-Object System.Collections.Generic.List[object]
function Check([string]$Name, [scriptblock]$Fn) {
  try { & $Fn; $results.Add([pscustomobject]@{Test=$Name;Status='PASS'}) }
  catch { $results.Add([pscustomobject]@{Test=$Name;Status='FAIL';Detail=$_.Exception.Message}) }
}
Write-Host 'ChatMCP Studio Windows smoke test (read-only)' -ForegroundColor Cyan
Check 'Hub 2.2 health' { $h=Invoke-RestMethod -Uri "$BaseUrl/api/health" -TimeoutSec 8; if($h.app -ne 'chatmcp-local-hub' -or $h.version -ne '2.2.0'){throw "Wrong version: $($h.version)"}; Write-Host "Hub $($h.version); UI $($h.uiBuild)" }
Check 'Read state without logging secrets' { $s=Invoke-RestMethod -Uri "$BaseUrl/api/state" -TimeoutSec 8; if(-not $s.csrfToken){throw 'Missing state CSRF token'} }
Check 'Code intelligence status' { $r=Invoke-RestMethod -Uri "$BaseUrl/api/studio/intelligence/status" -TimeoutSec 8; if(-not $r.capabilities){throw 'Index endpoint unavailable'} }
Check 'Docker sandbox probe' { $r=Invoke-RestMethod -Uri "$BaseUrl/api/studio/sandbox" -TimeoutSec 8; Write-Host "Docker ready=$($r.ready); $($r.detail)" }
Check 'Preview validator' { $r=Invoke-RestMethod -Uri "$BaseUrl/api/studio/preview?port=65534" -TimeoutSec 8; if($r.url -ne 'http://127.0.0.1:65534/'){throw 'Preview not restricted to loopback'} }
Check 'Browser assets served locally' { $r=Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/react-app.js" -TimeoutSec 8; if($r.StatusCode -ne 200 -or $r.Content -notlike '*2.2.0-react-offline*'){throw 'Old UI assets'} }
$results | Format-Table -AutoSize
$failed=@($results|Where-Object Status -eq 'FAIL').Count
if($failed){Write-Warning "$failed smoke checks failed";exit 1}else{Write-Host 'Smoke checks passed' -ForegroundColor Green;exit 0}
