#requires -Version 5.1
<#
Stop the existing ChatMCP Hub through its authenticated local shutdown endpoint.
The Hub publishes a per-launch secret in <state dir>\run\hub-session.json (readable by your Windows account only); this
script presents it as a bearer token. A Hub from before that secret existed (v3.9.0 and older) has no such file and is
stopped with the older session-token flow instead.
Examples:
  & 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd'
  & 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd' -Port 3007
  & 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd' -Port 3010 -StateDir 'D:\hub-state'
#>
[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 3007,
    # The Hub's --state-dir. Default: CHATMCP_STATE_DIR, else %LOCALAPPDATA%\ChatMCP\hub (what the Hub itself defaults to).
    [string]$StateDir = ''
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
    param([string]$Endpoint, [string]$Method = 'GET', [hashtable]$Headers = @{}, [int]$TimeoutMs = 5000)
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

function Test-HubPortListening {
    # True when a program is listening on this port on IPv4 loopback, any IPv4 address or any IPv6 address.
    # It reads the TCP table instead of connecting: on Windows 11 a refused connection from .NET is only
    # reported after about two seconds, which is indistinguishable from a timeout and made a stopped Hub
    # look as if it was still running.
    try {
        foreach ($endpoint in [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()) {
            if ($endpoint.Port -ne $Port) { continue }
            $address = $endpoint.Address
            if ($address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and [System.Net.IPAddress]::IsLoopback($address)) { return $true }
            if ($address.Equals([System.Net.IPAddress]::Any) -or $address.Equals([System.Net.IPAddress]::IPv6Any)) { return $true }
        }
        return $false
    }
    catch { return $true }
}

function Read-HubSessionSecret {
    # The secret of the Hub that owns this port, from the session file it published; $null when there is no usable file.
    $directory = $StateDir
    if ([string]::IsNullOrWhiteSpace($directory)) { $directory = $env:CHATMCP_STATE_DIR }
    if ([string]::IsNullOrWhiteSpace($directory)) { $directory = Join-Path $env:LOCALAPPDATA 'ChatMCP\hub' }
    $file = Join-Path (Join-Path $directory 'run') 'hub-session.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    try { $session = Get-Content -LiteralPath $file -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { return $null }
    if ($null -eq $session.PSObject.Properties['secret'] -or $null -eq $session.PSObject.Properties['port']) { return $null }
    if ([int]$session.port -ne $Port -or $session.secret -isnot [string] -or $session.secret -notmatch '^[A-Za-z0-9_-]{32,256}$') { return $null }
    return $session.secret
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
    if (-not (Test-HubPortListening)) {
        Write-Host ('[CHATMCP-HUB] Already stopped: nothing is listening at ' + $hubStopBase + '.')
        exit 0
    }
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
    # A Hub that says auth=bearer gets the secret from its session file. One that does not predates the secret and only
    # knows the older flow (the session token its /api/state hands out); the secret is never sent to it.
    $hubStopAuth = @{}
    $hubStopRequiresBearer = ($null -ne $hubStopHealth.PSObject.Properties['auth'] -and $hubStopHealth.auth -eq 'bearer')
    if ($hubStopRequiresBearer) {
        $hubStopSecret = Read-HubSessionSecret
        if ($null -eq $hubStopSecret) {
            Write-Host ('[CHATMCP-HUB] This Hub requires its session file, which was not found or does not match port ' + $Port + '. Use -StateDir with the folder the Hub was started with (--state-dir).')
            throw 'No usable Hub session file.'
        }
        $hubStopAuth['Authorization'] = 'Bearer ' + $hubStopSecret
    }
    $hubStopState = Invoke-HubStopJson -Endpoint '/api/state' -Headers $hubStopAuth
    $hubStopToken = $hubStopState.PSObject.Properties['csrfToken']
    if ($null -eq $hubStopToken -or $hubStopToken.Value -isnot [string] -or $hubStopToken.Value -notmatch '^[A-Za-z0-9_-]{16,256}$') {
        throw 'The verified Hub did not provide a valid local session token.'
    }

    $hubStopPhase = 'requesting Hub shutdown'
    try {
        $hubStopShutdownHeaders = @{
            'Origin' = $hubStopBase
            'X-ChatMCP-Request' = 'local-dashboard'
            'X-ChatMCP-CSRF' = $hubStopToken.Value
        }
        foreach ($entry in $hubStopAuth.GetEnumerator()) { $hubStopShutdownHeaders[$entry.Key] = $entry.Value }
        $hubStopResult = Invoke-HubStopJson -Endpoint '/api/hub/shutdown' -Method 'POST' -Headers $hubStopShutdownHeaders
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
        if (-not (Test-HubPortListening)) {
            Write-Host '[CHATMCP-HUB] Stopped. You can replace the bundle and start it again.'
            exit 0
        }
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
