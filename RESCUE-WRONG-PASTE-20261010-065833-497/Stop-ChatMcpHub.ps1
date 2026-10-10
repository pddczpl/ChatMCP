#requires -Version 5.1
<#
Stop the existing ChatMCP Hub through its authenticated local shutdown endpoint.
Examples:
  & 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd'
  & 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd' -Port 3007
#>
[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 3007
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$hubStopBase = 'http://127.0.0.1:' + $Port
$hubStopClient = $null
$hubStopHandler = $null
$hubStopPhase = 'preparing the local request'

function Test-HubConnectionRefused {
    param([System.Exception]$Exception)
    for ($item = $Exception; $null -ne $item; $item = $item.InnerException) {
        if ($item -is [System.Net.Sockets.SocketException] -and $item.SocketErrorCode -eq [System.Net.Sockets.SocketError]::ConnectionRefused) { return $true }
        if ($item -is [System.Net.WebException] -and $item.Status -eq [System.Net.WebExceptionStatus]::ConnectFailure) { return $true }
    }
    return $false
}

function Test-HubRequestTimeout {
    param([System.Exception]$Exception)
    for ($item = $Exception; $null -ne $item; $item = $item.InnerException) {
        if ($item -is [System.OperationCanceledException]) { return $true }
        if ($item -is [System.Net.WebException] -and $item.Status -eq [System.Net.WebExceptionStatus]::Timeout) { return $true }
    }
    return $false
}

function Invoke-HubStopJson {
    param([string]$Endpoint, [string]$Method = 'GET', [hashtable]$Headers = @{}, [int]$TimeoutMs = 2000)
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $hubStopBase + $Endpoint)
    $cancellation = [System.Threading.CancellationTokenSource]::new()
    $response = $null
    try {
        foreach ($entry in $Headers.GetEnumerator()) { [void]$request.Headers.TryAddWithoutValidation([string]$entry.Key, [string]$entry.Value) }
        if ($Method -eq 'POST') { $request.Content = [System.Net.Http.StringContent]::new('{}', [Text.Encoding]::UTF8, 'application/json') }
        $cancellation.CancelAfter($TimeoutMs)
        $response = $hubStopClient.SendAsync($request, $cancellation.Token).GetAwaiter().GetResult()
        if ($response.StatusCode -ne [System.Net.HttpStatusCode]::OK) { throw ('The local endpoint returned HTTP ' + [int]$response.StatusCode + '.') }
        $json = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        return (ConvertFrom-Json -InputObject $json -ErrorAction Stop)
    }
    finally {
        if ($null -ne $response) { $response.Dispose() }
        $request.Dispose()
        $cancellation.Dispose()
    }
}

function Assert-HubIdentity {
    param([object]$Health)
    if ($null -eq $Health -or $null -eq $Health.PSObject.Properties['app'] -or $Health.app -ne 'chatmcp-local-hub') {
        throw ('Port ' + $Port + ' does not identify itself as ChatMCP Hub. Shutdown was not sent.')
    }
}

try {
    Add-Type -AssemblyName System.Net.Http
    $hubStopHandler = [System.Net.Http.HttpClientHandler]::new()
    $hubStopHandler.AllowAutoRedirect = $false
    $hubStopHandler.UseProxy = $false
    $hubStopClient = [System.Net.Http.HttpClient]::new($hubStopHandler)
    $hubStopClient.MaxResponseContentBufferSize = 65536

    $hubStopPhase = 'verifying the service on port ' + $Port
    try { $hubStopHealth = Invoke-HubStopJson -Endpoint '/api/health' }
    catch {
        if (Test-HubConnectionRefused -Exception $_.Exception) {
            Write-Host ('[CHATMCP-HUB] Already stopped: nothing is listening at ' + $hubStopBase + '.')
            exit 0
        }
        throw
    }
    Assert-HubIdentity -Health $hubStopHealth

    $hubStopPhase = 'reading the verified Hub session'
    $hubStopState = Invoke-HubStopJson -Endpoint '/api/state'
    $hubStopToken = $hubStopState.PSObject.Properties['csrfToken']
    if ($null -eq $hubStopToken -or $hubStopToken.Value -isnot [string] -or $hubStopToken.Value -notmatch '^[A-Za-z0-9_-]{16,256}$') {
        throw 'The verified Hub did not provide a valid local session token.'
    }

    $hubStopPhase = 'requesting Hub shutdown'
    try {
        $hubStopResult = Invoke-HubStopJson -Endpoint '/api/hub/shutdown' -Method 'POST' -Headers @{
            'Origin' = $hubStopBase
            'X-ChatMCP-Request' = 'local-dashboard'
            'X-ChatMCP-CSRF' = $hubStopToken.Value
        }
        if ($null -eq $hubStopResult -or $null -eq $hubStopResult.PSObject.Properties['ok'] -or $hubStopResult.ok -ne $true) {
            throw 'The Hub did not acknowledge shutdown.'
        }
    }
    catch {
        # An accepted shutdown can close the connection before its ACK arrives.
        # Check the port below; never send the shutdown request a second time.
        if (-not (Test-HubConnectionRefused -Exception $_.Exception) -and -not (Test-HubRequestTimeout -Exception $_.Exception)) { throw }
    }
    Write-Host '[CHATMCP-HUB] Waiting for the Hub to close (up to 15 seconds)...'
    $hubStopPhase = 'waiting for Hub shutdown'
    $hubStopWatch = [Diagnostics.Stopwatch]::StartNew()
    while ($hubStopWatch.ElapsedMilliseconds -lt 15000) {
        $remaining = 15000 - $hubStopWatch.ElapsedMilliseconds
        $pollTimeout = [int][Math]::Max(1, [Math]::Min(750, $remaining))
        try {
            $hubStopHealth = Invoke-HubStopJson -Endpoint '/api/health' -TimeoutMs $pollTimeout
            if ($null -eq $hubStopHealth -or $null -eq $hubStopHealth.PSObject.Properties['app'] -or $hubStopHealth.app -ne 'chatmcp-local-hub') {
                throw ('Another service is now answering on port ' + $Port + '. Its processes were not changed.')
            }
        }
        catch {
            if (Test-HubConnectionRefused -Exception $_.Exception) {
                Write-Host '[CHATMCP-HUB] Stopped. You can replace the bundle and start it again.'
                exit 0
            }
            if (-not (Test-HubRequestTimeout -Exception $_.Exception)) { throw }
        }
        $remaining = 15000 - $hubStopWatch.ElapsedMilliseconds
        if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min(250, $remaining)) }
    }
    Write-Host '[CHATMCP-HUB] Shutdown was requested, but closure was not confirmed within 15 seconds.'
    Write-Host '[CHATMCP-HUB] Wait and run this stop command again before replacing files.'
    exit 2
}
catch {
    Write-Host ('[CHATMCP-HUB] Could not finish: ' + $hubStopPhase + '.')
    # Do not print response bodies, exception stacks or the local session token.
    Write-Host '[CHATMCP-HUB] Check the Hub dashboard and the selected port, then try again.'
    exit 1
}
finally {
    if ($null -ne $hubStopClient) { $hubStopClient.Dispose() }
    elseif ($null -ne $hubStopHandler) { $hubStopHandler.Dispose() }
}
