#Requires -Version 5.1
<#[.SYNOPSIS] Optional node-pty installer for true Windows ConPTY; requires network.
No command runs without explicit confirmation. Installs only in the selected Hub.
#>
param([switch]$Install)
$hub=Split-Path -Parent $PSScriptRoot
Write-Host 'ChatMCP Studio optional native terminal support (node-pty / ConPTY)'
Write-Host "Hub: $hub"
Write-Host 'Needs Node.js, compatible native binaries or MSVC Build Tools, Internet access.'
if(-not $Install){Write-Host "Review then run: & '$PSCommandPath' -Install";exit 0}
$choice=Read-Host 'Install node-pty in this Hub? (YES to confirm)'
if($choice -ne 'YES'){Write-Host 'Cancelled.';exit 0}
Push-Location $hub
try{ & npm install --no-save --no-audit --no-fund node-pty@1.0.0; if($LASTEXITCODE -ne 0){throw "npm returned $LASTEXITCODE"} }
finally{Pop-Location}
Write-Host 'Restart the Hub; new interactive terminals will report mode=conpty when loaded.'
