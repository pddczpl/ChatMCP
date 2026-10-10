#requires -Version 5.1
# Self-contained test for Rotate-CloudHarnessToken.ps1. Uses only fake secrets in a temp folder.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot '..\Rotate-CloudHarnessToken.ps1'
$powershell = (Get-Process -Id $PID).Path
$failures = 0
function Check([bool]$Condition, [string]$Label) {
    if ($Condition) { Write-Host "  ok - $Label" } else { Write-Host "  FAIL - $Label"; $script:failures++ }
}
function New-Fixture([string]$AuthMode = 'owner-bearer') {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('rotate-test-' + [guid]::NewGuid().ToString('N'))
    $repo = Join-Path $root 'cloud-harness-mcp'
    $dir = Join-Path $repo 'deploy\.generated'
    New-Item -ItemType Directory -Path (Join-Path $dir 'chatmcp-hub') -Force | Out-Null
    $old = 'FAKE-OLD-TOKEN-' + ('x' * 40)
    [IO.File]::WriteAllText((Join-Path $repo '.env'), "AUTH_MODE=$AuthMode`r`nMCP_BEARER_TOKEN=$old`r`nRUNNER_TOKEN=fake-runner-token-unchanged`r`n")
    $client = '{ "mcpServers": { "cloud-harness": { "url": "http://127.0.0.1:3100/mcp", "headers": { "Authorization": "Bearer ' + $old + '" } } } }'
    [IO.File]::WriteAllText((Join-Path $dir 'mcp-client.proxy.json'), $client)
    [IO.File]::WriteAllText((Join-Path $dir 'chatmcp-hub\mcp-client.hub.json'), $client)
    [IO.File]::WriteAllText((Join-Path $dir 'chatmcp-hub\mcp-client.hub.json.before-1.bak'), $client)
    [IO.File]::WriteAllText((Join-Path $dir 'mcp-client.local.json'), '{ "mcpServers": {} }')
    return @{ Root = $root; Repo = $repo; Dir = $dir; Old = $old }
}
function Invoke-Script($Fixture, [string[]]$Extra) {
    # The child writes its errors to stderr; do not let them become terminating errors here.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $powershell -NoProfile -ExecutionPolicy Bypass -File $script -RepoRoot $Fixture.Repo @Extra 2>&1 | ForEach-Object { $_.ToString() } | Out-String
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previous }
    return @{ Output = $output; Code = $code }
}

Write-Host 'dry run changes nothing and prints no token'
$f = New-Fixture
$before = [IO.File]::ReadAllText((Join-Path $f.Repo '.env'))
$r = Invoke-Script $f @()
Check ($r.Code -eq 0) 'dry run exits 0'
Check (-not $r.Output.Contains($f.Old)) 'dry run output does not contain the token'
Check ([IO.File]::ReadAllText((Join-Path $f.Repo '.env')) -eq $before) '.env untouched'
Check ($r.Output -match 'Client files containing the old token: 2') 'reports the two editable client files'
Check ($r.Output -match 'not modified\): 1') 'reports the .bak copy without editing it'
Remove-Item -LiteralPath $f.Root -Recurse -Force

Write-Host 'default repository location is ..\cloud-harness-mcp relative to the script'
$f = New-Fixture
New-Item -ItemType Directory -Path (Join-Path $f.Root 'scripts') | Out-Null
Copy-Item -LiteralPath $script -Destination (Join-Path $f.Root 'scripts\Rotate-CloudHarnessToken.ps1')
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$defaultRun = & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $f.Root 'scripts\Rotate-CloudHarnessToken.ps1') 2>&1 | ForEach-Object { $_.ToString() } | Out-String
$defaultCode = $LASTEXITCODE
$ErrorActionPreference = $previous
Check ($defaultCode -eq 0 -and $defaultRun -match 'Client files containing the old token: 2') 'dry run without -RepoRoot finds the sibling cloud-harness-mcp folder'
Remove-Item -LiteralPath $f.Root -Recurse -Force

Write-Host 'apply rotates .env and client files, keeps other secrets, writes a backup'
$f = New-Fixture
$r = Invoke-Script $f @('-Apply', '-SkipRestart')
Check ($r.Code -eq 0) 'apply exits 0'
$envNow = [IO.File]::ReadAllText((Join-Path $f.Repo '.env'))
$newToken = [regex]::Match($envNow, '(?m)^MCP_BEARER_TOKEN=([^\r\n]*)').Groups[1].Value
Check ($newToken.Length -eq 64 -and $newToken -match '^[A-Za-z0-9_-]{64}$') 'new token is 64 URL-safe characters'
Check ($newToken -ne $f.Old) 'token changed'
Check ($envNow.Contains('RUNNER_TOKEN=fake-runner-token-unchanged')) 'other .env secrets untouched'
Check ($envNow.Contains("`r`n")) 'line endings preserved'
foreach ($name in @('mcp-client.proxy.json', 'chatmcp-hub\mcp-client.hub.json')) {
    $text = [IO.File]::ReadAllText((Join-Path $f.Dir $name))
    Check ($text.Contains($newToken) -and -not $text.Contains($f.Old)) "$name carries only the new token"
    $null = $text | ConvertFrom-Json
}
Check ([IO.File]::ReadAllText((Join-Path $f.Dir 'chatmcp-hub\mcp-client.hub.json.before-1.bak')).Contains($f.Old)) '.bak copy left alone'
Check (@(Get-ChildItem -LiteralPath $f.Dir -Directory -Filter 'rotation-backup-*').Count -eq 1) 'one backup folder created'
Check (-not $r.Output.Contains($f.Old) -and -not $r.Output.Contains($newToken)) 'apply output prints no token'
Remove-Item -LiteralPath $f.Root -Recurse -Force

Write-Host 'refuses other auth modes'
$f = New-Fixture 'cloudflare-access'
$r = Invoke-Script $f @('-Apply', '-SkipRestart')
Check ($r.Code -ne 0 -and $r.Output -match 'only rotates the owner-bearer') 'non owner-bearer mode is refused'
Check ([IO.File]::ReadAllText((Join-Path $f.Repo '.env')).Contains($f.Old)) '.env untouched after refusal'
Remove-Item -LiteralPath $f.Root -Recurse -Force

if ($failures -gt 0) { Write-Host "FAILED: $failures check(s)"; exit 1 }
Write-Host 'PASS: Rotate-CloudHarnessToken tests'
