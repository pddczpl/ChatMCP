# A real diagnostic POST, executed on the user's Windows PC. Never embeds a key.
[CmdletBinding()]
param(
    [string]$BaseUrl = 'https://p090-vertex-gateway-1036721532620.asia-southeast1.run.app',
    [string]$Model = 'gemini-3.8-flash',
    [ValidateSet('google-key', 'bearer')][string]$AuthMode = 'google-key'
)
$ErrorActionPreference = 'Stop'
$expectedHost = 'p090-vertex-gateway-1036721532620.asia-southeast1.run.app'
try { $base = [Uri]$BaseUrl.TrimEnd('/') } catch { throw 'Gateway URL is invalid.' }
if ($base.Scheme -ne 'https' -or $base.Host -ne $expectedHost -or $base.UserInfo -or $base.Query -or $base.Fragment) {
    throw 'Safety check: only the explicitly requested HTTPS gateway hostname is accepted.'
}
if ($Model -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,150}$') { throw 'Model name is not valid.' }
$stem = $BaseUrl.TrimEnd('/') -replace '/v1beta$', ''
$endpoint = "$stem/v1beta/models/$($Model):generateContent"
$apiKey = $env:GOOGLE_API_KEY
$privateKeyProvided = -not [string]::IsNullOrWhiteSpace($apiKey)
if (-not $privateKeyProvided) {
    $secure = Read-Host 'Paste gateway API key (hidden input)' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $secure.Dispose() }
}
if ([string]::IsNullOrWhiteSpace($apiKey)) { throw 'API key cannot be empty.' }
$headers = @{}
if ($AuthMode -eq 'bearer') { $headers['Authorization'] = "Bearer $apiKey" }
else { $headers['x-goog-api-key'] = $apiKey }
$payload = @{ contents = @(@{ role = 'user'; parts = @(@{ text = 'Reply OK.' }) }) } | ConvertTo-Json -Depth 8 -Compress
function Redact([string]$Value) {
    if (-not $Value) { return '' }
    $safe = $Value.Replace($apiKey, '[REDACTED]')
    $safe = [regex]::Replace($safe, '(?i)(authorization|x-goog-api-key|api[_-]?key)\s*[=:]\s*\S+', '[REDACTED]')
    return $safe.Substring(0, [Math]::Min($safe.Length, 1600))
}
try {
    Write-Host "Testing: $endpoint [$AuthMode]"
    $response = Invoke-WebRequest -Uri $endpoint -Method Post -ContentType 'application/json' -Headers $headers -Body $payload -TimeoutSec 20 -MaximumRedirection 0 -UseBasicParsing
    Write-Host "HTTP $([int]$response.StatusCode) - gateway accepted the request" -ForegroundColor Green
    Write-Host (Redact ([string]$response.Content))
} catch {
    $status = 0
    $raw = ''
    $serverResponse = $_.Exception.Response
    if ($serverResponse) {
        try { $status = [int]$serverResponse.StatusCode } catch {}
        try {
            $stream = $serverResponse.GetResponseStream()
            if ($stream) { $reader = New-Object System.IO.StreamReader($stream); $raw = $reader.ReadToEnd(); $reader.Dispose() }
        } catch {}
    }
    if ($status) {
        Write-Host "HTTP $status - gateway rejected the request" -ForegroundColor Yellow
        Write-Host (Redact $raw)
    } else {
        Write-Host ('Network/client error: ' + (Redact ([string]$_.Exception.Message))) -ForegroundColor Red
    }
    exit 1
} finally {
    $apiKey = $null
    $headers.Clear()
}
