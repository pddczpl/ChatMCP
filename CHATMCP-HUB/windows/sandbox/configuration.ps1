# Windows Sandbox Configuration Helper (Phase 1, PR 2)
# Generates and validates hardened .wsb configuration for disposable test isolation.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InputDirectory,

    [Parameter(Mandatory = $true)]
    [string]$ExportDirectory,

    [int]$MemoryMb = 1024,
    [switch]$ProtectedClient,
    [string]$LogonCommand = "",
    [string]$OutputFile = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Escape-XmlText([string]$text) {
    if (-not $text) { return "" }
    return $text.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;").Replace("'", "&apos;")
}

function Test-SafePath([string]$pathToCheck, [bool]$isWritable) {
    if (-not [System.IO.Path]::IsPathRooted($pathToCheck)) {
        throw "Path must be absolute: $pathToCheck"
    }
    if ($pathToCheck.Contains("..")) {
        throw "Path traversal sequences ('..') are strictly prohibited: $pathToCheck"
    }
    $resolved = [System.IO.Path]::GetFullPath($pathToCheck)
    if ($isWritable) {
        $userHome = [System.IO.Path]::GetFullPath($HOME)
        if ($resolved -eq $userHome) {
            throw "User home directory cannot be mapped as writable: $resolved"
        }
    }
    return $resolved
}

$safeInput = Test-SafePath -pathToCheck $InputDirectory -isWritable $false
$safeExport = Test-SafePath -pathToCheck $ExportDirectory -isWritable $true

if ($safeInput -eq $safeExport) {
    throw "Input and Export directories must be distinct paths."
}

$memory = [Math]::Max(512, [Math]::Min($MemoryMb, 8192))
$escapedInput = Escape-XmlText $safeInput
$escapedExport = Escape-XmlText $safeExport
$escapedLogon = Escape-XmlText $LogonCommand

$xmlLines = @(
    '<Configuration>',
    '  <!-- ChatMCP Hardened Windows Sandbox Policy -->',
    '  <VGpu>Disable</VGpu>',
    '  <Networking>Disable</Networking>',
    '  <ClipboardRedirection>Disable</ClipboardRedirection>',
    '  <AudioInput>Disable</AudioInput>',
    '  <VideoInput>Disable</VideoInput>',
    '  <PrinterRedirection>Disable</PrinterRedirection>',
    "  <MemoryInMB>$memory</MemoryInMB>"
)

if ($ProtectedClient) {
    $xmlLines += '  <ProtectedClient>Enable</ProtectedClient>'
}

$xmlLines += @(
    '  <MappedFolders>',
    '    <MappedFolder>',
    "      <HostFolder>$escapedInput</HostFolder>",
    '      <SandboxFolder>C:\ChatMCP\Input</SandboxFolder>',
    '      <ReadOnly>true</ReadOnly>',
    '    </MappedFolder>',
    '    <MappedFolder>',
    "      <HostFolder>$escapedExport</HostFolder>",
    '      <SandboxFolder>C:\ChatMCP\Output</SandboxFolder>',
    '      <ReadOnly>false</ReadOnly>',
    '    </MappedFolder>',
    '  </MappedFolders>'
)

if ($escapedLogon) {
    $xmlLines += @(
        '  <LogonCommand>',
        "    <Command>$escapedLogon</Command>",
        '  </LogonCommand>'
    )
}

$xmlLines += '</Configuration>'
$configContent = $xmlLines -join "`r`n"

if ($OutputFile) {
    $parent = [System.IO.Path]::GetDirectoryName($OutputFile)
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Set-Content -Path $OutputFile -Value $configContent -Encoding UTF8 -Force
}

return $configContent
