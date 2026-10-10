#Requires -Version 5.1
<#[.SYNOPSIS] Non-invasive reliability / LAN flap observation for Windows.
Run at least 2-8h during ordinary usage; use Ctrl+C to stop early.
Tracks only health, latency, and Ethernet link state. Does not disable networking,
restart tasks, modify the workspace, or record passwords/tokens/chat text.
#>
param(
  [ValidateRange(1,10080)][int]$DurationMinutes=120,
  [ValidateRange(1,120)][int]$IntervalSeconds=5,
  [string]$BaseUrl='http://127.0.0.1:3007',
  [string]$AdapterName='Ethernet',
  [string]$ReportDirectory="$env:LOCALAPPDATA\ChatMCPStudio\diagnostics"
)
$ErrorActionPreference='Stop'
if($BaseUrl -notmatch '^http://(?:127\.0\.0\.1|localhost):\d{4,5}$'){throw 'Only localhost Hub URLs are supported.'}
New-Item -ItemType Directory -Force -Path $ReportDirectory | Out-Null
$start=Get-Date
$csv=Join-Path $ReportDirectory ("soak-"+$start.ToString('yyyyMMdd-HHmmss')+".csv")
$end=$start.AddMinutes($DurationMinutes)
$rows=New-Object System.Collections.Generic.List[object]
Write-Host "Measuring for $DurationMinutes minutes. Press Ctrl+C to stop. Output: $csv"
while((Get-Date) -lt $end){
  $timer=[System.Diagnostics.Stopwatch]::StartNew();$ok=$false;$version='';$detail=''
  try {
    $health=Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/')+'/api/health') -TimeoutSec 4 -ErrorAction Stop
    $version=[string]$health.version
    $ok=($health.app -eq 'chatmcp-local-hub' -and $health.version -eq '2.2.0')
    if(-not $ok){$detail='wrong hub version'}
  }catch{$detail=$_.Exception.Message.Substring(0,[Math]::Min(160,$_.Exception.Message.Length))}
  $timer.Stop()
  $adapter=Get-NetAdapter -Name $AdapterName -ErrorAction SilentlyContinue
  $status=if($adapter){[string]$adapter.Status}else{'unknown'}
  $speed=if($adapter){[string]$adapter.LinkSpeed}else{'unknown'}
  $row=[pscustomobject]@{Time=(Get-Date).ToString('o');HubOK=$ok;LatencyMs=$timer.ElapsedMilliseconds;Version=$version;Ethernet=$status;LinkSpeed=$speed;Error=$detail}
  $rows.Add($row)
  # Save EVERY sample; if the machine crashes the preceding samples survive.
  $row|Export-Csv -Path $csv -NoTypeInformation -Encoding UTF8 -Append
  if(-not $ok -or $status -ne 'Up'){Write-Warning "$(Get-Date -Format HH:mm:ss) hub=$ok Ethernet=$status latency=$($row.LatencyMs)ms"}
  Start-Sleep -Seconds $IntervalSeconds
}
$valid=@($rows|Where-Object HubOK)
$latencies=@($valid|ForEach-Object LatencyMs|Sort-Object)
$p95=if($latencies.Count){$latencies[[Math]::Min($latencies.Count-1,[Math]::Floor(.95*($latencies.Count-1))) ]}else{'N/A'}
Write-Host "Samples: $($rows.Count), good: $($valid.Count), errors: $($rows.Count-$valid.Count), p95 latency: $p95 ms" -ForegroundColor Cyan
Write-Host "CSV: $csv"
