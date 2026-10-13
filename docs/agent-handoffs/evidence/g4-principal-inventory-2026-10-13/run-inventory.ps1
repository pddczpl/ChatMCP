$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$runId=[guid]::NewGuid().ToString()
$out=Join-Path $root $runId
$inputDir=Join-Path $out 'input'
$evidence=Join-Path $out 'evidence'
New-Item -ItemType Directory -Path $inputDir,$evidence | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'guest-inventory.ps1') -Destination $inputDir
[IO.File]::WriteAllText((Join-Path $inputDir 'run-id.txt'),$runId)
$wsb=Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wsb.exe'
function List-Ids {
 $raw=& $wsb list --raw
 if($LASTEXITCODE -ne 0) { throw 'List failed.' }
 $r=$raw|ConvertFrom-Json
 if($null -eq $r -or $r.WindowsSandboxEnvironments -isnot [Array]) { throw 'Invalid list shape.' }
 foreach($entry in $r.WindowsSandboxEnvironments){if($entry.Id -isnot [string] -or $entry.Id -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$'){throw 'Invalid ID.'};$entry.Id}
}
if(@(List-Ids).Count -ne 0) { throw 'Sandbox busy.' }
$escInput=[Security.SecurityElement]::Escape($inputDir)
$escOut=[Security.SecurityElement]::Escape($evidence)
$config="<Configuration><Networking>Disable</Networking><ClipboardRedirection>Disable</ClipboardRedirection><PrinterRedirection>Disable</PrinterRedirection><MappedFolders><MappedFolder><HostFolder>$escInput</HostFolder><SandboxFolder>C:\G4PrincipalInput</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>$escOut</HostFolder><SandboxFolder>C:\G4PrincipalOutput</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders></Configuration>"
[IO.File]::WriteAllText((Join-Path $out 'sandbox.wsb'),$config)
$record=[ordered]@{runId=$runId;startedUtc=[DateTime]::UtcNow.ToString('o');purpose='Read-only clean guest principal inventory';owned=$false;cleanupConfirmed=$false;guestExitCode=$null}
try {
 $raw=& $wsb start --id $runId --config $config --raw
 if($LASTEXITCODE -ne 0){throw 'Start failed.'}
 $r=$raw|ConvertFrom-Json
 if($r.Id -ne $runId){throw 'Owned UUID mismatch.'}
 $record.owned=$true
 Write-Output "Owned diagnostic Sandbox: $runId"
 $connect=Start-Process -FilePath $wsb -ArgumentList 'connect','--id',$runId,'--raw' -WindowStyle Hidden -PassThru
 $ready=$false
 for($n=0;$n -lt 30;$n++){
  try{$ErrorActionPreference='Continue';$raw=& $wsb exec --id $runId --run-as ExistingLogin --command 'cmd.exe /d /c exit 0' --raw 2>$null;$cli=$LASTEXITCODE}finally{$ErrorActionPreference='Stop'}
  if($cli -eq 0){$r=$raw|ConvertFrom-Json;if($r.PSObject.Properties.Name -contains 'ExitCode' -and $r.ExitCode -eq 0){$ready=$true;break}}
  Start-Sleep -Seconds 1
 }
 if(-not $ready){throw 'Login readiness failed.'}
 $raw=& $wsb exec --id $runId --run-as System --command "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\G4PrincipalInput\guest-inventory.ps1 -RunId $runId" --raw
 $cli=$LASTEXITCODE
 [IO.File]::WriteAllText((Join-Path $evidence 'wsb-exec.json'),($raw|Out-String))
 if($cli -ne 0){throw 'Diagnostic CLI failed.'}
 $r=$raw|ConvertFrom-Json
 $record.guestExitCode=$r.ExitCode
 if($r.ExitCode -ne 0){throw 'Diagnostic guest failed.'}
 $result=Get-Content -LiteralPath (Join-Path $evidence 'principal-inventory.json') -Raw | ConvertFrom-Json
 if($result.runId -ne $runId){throw 'Inventory run mismatch.'}
} finally {
 if($record.owned){try{& $wsb stop --id $runId --raw;if($LASTEXITCODE -ne 0){throw 'Stop failed.'};$remaining=@(List-Ids);$record.cleanupConfirmed= -not ($remaining -contains $runId)}catch{$record.cleanupError=$_.Exception.Message}}
 $record.finishedUtc=[DateTime]::UtcNow.ToString('o')
 [IO.File]::WriteAllText((Join-Path $evidence 'host-run.json'),($record|ConvertTo-Json -Depth 8))
}
if(-not $record.cleanupConfirmed){throw 'Owned cleanup not confirmed.'}
Write-Output "Inventory recorded: $evidence"
