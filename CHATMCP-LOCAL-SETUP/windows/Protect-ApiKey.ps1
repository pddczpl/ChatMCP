#requires -Version 5.1
<#
Protect or unprotect a UTF-8 secret payload using Windows DPAPI CurrentUser.
Accepts API keys or JSON OAuth credentials of arbitrary practical length.
The payload is read from stdin only; never put a secret in process arguments.

Protect:   stdin UTF-8 plaintext -> stdout base64 protected bytes.
Unprotect: stdin base64 bytes   -> stdout the original UTF-8 plaintext.
Errors are generic and go to stderr. No credentials are logged.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Protect', 'Unprotect')]
    [string]$Mode
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$plainBytes = $null
$protectedBytes = $null
$payload = $null
$plainText = $null
$failed = $false

try {
    if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $secretUtf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false, $true
    [Console]::InputEncoding = $secretUtf8
    [Console]::OutputEncoding = $secretUtf8
    $payload = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrEmpty($payload)) { throw 'EMPTY_PAYLOAD' }
    # Keep this label stable so saved credentials survive application updates.
    $entropy = $secretUtf8.GetBytes('ChatMCP Hub Secrets v1')
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser

    if ($Mode -eq 'Protect') {
        $plainBytes = $secretUtf8.GetBytes($payload)
        $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect($plainBytes, $entropy, $scope)
        [Console]::Out.Write([Convert]::ToBase64String($protectedBytes))
    }
    else {
        $protectedBytes = [Convert]::FromBase64String($payload)
        $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protectedBytes, $entropy, $scope)
        $plainText = $secretUtf8.GetString($plainBytes)
        [Console]::Out.Write($plainText)
    }
}
catch {
    $failed = $true
    [Console]::Error.WriteLine('[CHATMCP-HUB] Windows credential protection failed.')
}
finally {
    if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
    if ($null -ne $protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
    $payload = $null
    $plainText = $null
}

if ($failed) { exit 1 }
