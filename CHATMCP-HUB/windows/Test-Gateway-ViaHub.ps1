# Test the configured Gateway using the same API key already stored by ChatMCP Hub.
# No key is passed to the shell, printed, or saved by this script.
$ErrorActionPreference = 'Stop'
$baseUrl = 'http://127.0.0.1:3007'
try {
    $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 6
    if ($health.app -ne 'chatmcp-local-hub' -or $health.version -ne '2.2.6') { throw 'Expected ChatMCP Hub 2.2.6 on localhost:3007.' }
    $state = Invoke-RestMethod -Uri "$baseUrl/api/state" -TimeoutSec 6
    if (-not $state.ai.configured) { throw 'API key/model are not configured in Studio Settings.' }
    $headers = @{
      'Origin' = $baseUrl
      'X-ChatMCP-Request' = 'local-dashboard'
      'X-ChatMCP-CSRF' = $state.csrfToken
      'X-ChatMCP-UI-Build' = '2.2.6-react-offline'
    }
    Write-Host "Testing configured gateway: $($state.ai.apiBaseUrl)  model=$($state.ai.model)" -ForegroundColor Cyan
    Write-Host 'This sends a REAL API request with the credential held in Hub memory/DPAPI. API usage may incur cost.'
    $result = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/ai/test" -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 45
    Write-Host "SUCCESS. protocol=$($result.protocol) authMode=$($result.authMode) responsePresent=$($result.responsePresent)" -ForegroundColor Green
    $result.attempts | Format-Table protocol, authMode, status, success, detail -AutoSize
} catch {
    Write-Host ('Gateway test failed: ' + $_.Exception.Message) -ForegroundColor Yellow
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
    exit 1
}
