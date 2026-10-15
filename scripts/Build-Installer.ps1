#requires -Version 5.1
<#
.SYNOPSIS
  Builds the commercial ChatMCPSetup.exe standalone installer.

.DESCRIPTION
  Automated build pipeline:
  1. Generates official brand icons
  2. Compiles native desktop executable (ChatMCP.exe)
  3. Prepares distribution payload and compresses to installer/payload.zip
  4. Compiles and embeds payload into standalone dist/ChatMCPSetup.exe
#>
[CmdletBinding()]
param(
    [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       ChatMCP Studio - Commercial Installer Builder      " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptDir '..'))
. (Join-Path $scriptDir 'InstallerPayload.ps1')
$distDir = Join-Path $repoRoot 'dist'
$installerDir = Join-Path $repoRoot 'installer'
$temporaryRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\', '/')
Assert-InstallerNoReparsePath -Path $temporaryRoot
$stagingDir = Join-Path $temporaryRoot ('ChatMCP-Staging-' + [guid]::NewGuid().ToString('N'))

# 1. Prerequisite checks
Write-Host "`n[1/5] Checking build prerequisites..." -ForegroundColor Yellow
$dotnetCmd = Get-Command dotnet.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $dotnetCmd) {
    Write-Error ".NET SDK is required to build ChatMCPSetup.exe. Please install from https://dot.net"
    exit 1
}
$dotnetVer = (& $dotnetCmd.Path --version).Trim()
Write-Host "  [OK] .NET SDK found: $dotnetVer" -ForegroundColor Green
if ([version]$dotnetVer -lt [version]'10.0') {
    throw ".NET SDK 10.0+ is required (desktop-shell and installer target net10.0-windows)."
}
$nodeCmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $nodeCmd -or $null -eq $npmCmd) {
    throw "Node.js 22+ and npm are required to compile and package the offline frontend."
}
$null = Get-Command git.exe -CommandType Application -ErrorAction Stop
$nodeVersion = (& $nodeCmd.Path --version).Trim()
if ([version]($nodeVersion.TrimStart('v').Split('-')[0]) -lt [version]'22.0') {
    throw "Node.js 22+ is required; found $nodeVersion."
}
$hubManifest = Get-Content -LiteralPath (Join-Path $repoRoot 'CHATMCP-HUB\package.json') -Raw | ConvertFrom-Json
[xml]$shellManifest = Get-Content -LiteralPath (Join-Path $repoRoot 'desktop-shell\ChatMCP.csproj') -Raw
[xml]$installerManifest = Get-Content -LiteralPath (Join-Path $repoRoot 'installer\ChatMCP.Installer.csproj') -Raw
if ($hubManifest.version -ne [string]$shellManifest.Project.PropertyGroup.Version -or
    $hubManifest.version -ne [string]$installerManifest.Project.PropertyGroup.Version) {
    throw "Version mismatch: Hub, Desktop and Installer must share one version before release."
}
Write-Host "  [OK] Node $nodeVersion and release version $($hubManifest.version)." -ForegroundColor Green

# Build the frontend from source. Packaging stale web/dist would make new
# React features invisible even when the backend and installer are updated.
Write-Host "  Building the latest offline React/TypeScript UI..." -ForegroundColor Cyan
Push-Location (Join-Path $repoRoot 'CHATMCP-HUB\ui')
try {
    & $npmCmd.Path ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
    & $npmCmd.Path run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'CHATMCP-HUB\web\dist\index.html') -PathType Leaf)) {
    throw "Built React UI not found at CHATMCP-HUB\web\dist\index.html."
}
Write-Host "  [OK] Fresh UI compiled and ready for packaging." -ForegroundColor Green

# 2. Brand Icons
Write-Host "`n[2/5] Ensuring brand icons..." -ForegroundColor Yellow
$brandIcon = Join-Path $repoRoot 'assets\icons\chatmcp.ico'
if (-not (Test-Path -LiteralPath $brandIcon -PathType Leaf)) {
    $pythonCmd = Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $pythonCmd) {
        Write-Host "  Rendering official brand icons..." -ForegroundColor Cyan
        & $pythonCmd.Path (Join-Path $repoRoot 'scripts\generate-brand-icon.py')
    }
}
Write-Host "  [OK] Brand icons ready." -ForegroundColor Green

# 3. Compile Native Desktop Shell (ChatMCP.exe)
Write-Host "`n[3/5] Compiling native desktop shell (ChatMCP.exe)..." -ForegroundColor Yellow
if (Test-Path -LiteralPath $stagingDir) { throw "Private staging directory already exists: $stagingDir" }
New-Item -ItemType Directory -Path $stagingDir | Out-Null
try {
$shellCsproj = Join-Path $repoRoot 'desktop-shell\ChatMCP.csproj'
$shellDist = Join-Path $stagingDir 'desktop-publish'
$payloadDir = Join-Path $stagingDir 'payload'
& $dotnetCmd.Path publish $shellCsproj -c Release -r win-x64 --self-contained true -o $shellDist -p:PublishSingleFile=true | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Desktop publish failed with exit code $LASTEXITCODE" }
$desktopExe = Join-Path $shellDist 'ChatMCP.exe'
if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) {
    throw "Failed to compile desktop shell: $desktopExe not found."
}
Write-Host "  [OK] Compiled ChatMCP.exe: $([Math]::Round((Get-Item $desktopExe).Length / 1MB, 2)) MB" -ForegroundColor Green

# 4. Prepare Staging & Build Payload Zip
Write-Host "`n[4/5] Packaging payload archive..." -ForegroundColor Yellow
# Both the executable and a valid x64 WebView2 loader are mandatory. A reused
# publish folder can silently omit native files on incremental publish.
Copy-InstallerDesktopPayload -PublishDirectory $shellDist -Destination $payloadDir

# Copy tracked runtime source files and the freshly generated UI only. Never
# recurse over source folders: ignored files may contain private user state.
Copy-InstallerSourcePayload -RepositoryRoot $repoRoot -Destination $payloadDir

# Trusted Sandbox Supervisor: publish from checked source into a fresh private
# staging directory. Never recursively package GuestSupervisor bin/obj/source.
# This binary does not make OS isolation available until the production
# broker authenticates published guest results and the dedicated gate passes.
$supervisorProject = Join-Path $repoRoot 'CHATMCP-HUB\windows\sandbox\GuestSupervisor\GuestSupervisor.csproj'
$supervisorPublish = Join-Path $stagingDir 'supervisor-publish'
& $dotnetCmd.Path publish $supervisorProject -c Release -r win-x64 --self-contained true -p:PublishAot=true -p:PublishSingleFile=false -o $supervisorPublish | Out-Null
if ($LASTEXITCODE -ne 0) { throw "GuestSupervisor publish failed with exit code $LASTEXITCODE" }
$trustedSupervisor = Join-Path $supervisorPublish 'GuestSupervisor.exe'
if (-not (Test-Path -LiteralPath $trustedSupervisor -PathType Leaf)) { throw 'Published GuestSupervisor.exe is missing.' }
$supervisorSize = (Get-Item -LiteralPath $trustedSupervisor).Length
if ($supervisorSize -le 0) { throw 'Published GuestSupervisor.exe is empty.' }
# Exercise the exact AOT image being packaged. This inert native parser suite
# never starts a guest and does not attest Sandbox isolation.
& $trustedSupervisor --blackbox-grader-self-test
if ($LASTEXITCODE -ne 0) { throw "Published GuestSupervisor native grader self-test failed with exit code $LASTEXITCODE" }
$trustedDestination = Join-Path $payloadDir 'CHATMCP-HUB\runtimes\windows-sandbox'
New-Item -ItemType Directory -Path $trustedDestination -Force | Out-Null
Copy-Item -LiteralPath $trustedSupervisor -Destination (Join-Path $trustedDestination 'GuestSupervisor.exe') -Force
$supervisorSha = (Get-FileHash -LiteralPath $trustedSupervisor -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $trustedDestination 'GuestSupervisor.exe.sha256'), $supervisorSha + "  GuestSupervisor.exe" + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Write-Host "  [OK] Published trusted guest helper with SHA-256 manifest (not sandbox attestation)." -ForegroundColor Green

# Bundle portable Node.js runtime so setup runs on any machine without Node.js installed
$stagingNode = Join-Path $payloadDir 'runtimes\node'
New-Item -ItemType Directory -Path $stagingNode -Force | Out-Null
$sysNode = $nodeCmd.Path
if ($sysNode -and (Test-Path -LiteralPath $sysNode -PathType Leaf)) {
    $nodeDestination = Join-Path $stagingNode 'node.exe'
    Copy-Item -LiteralPath $sysNode -Destination $nodeDestination -Force
    $nodeSha = (Get-FileHash -LiteralPath $nodeDestination -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $stagingNode 'node.exe.sha256'), $nodeSha + '  node.exe' + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Host "  [OK] Bundled portable Node.js runtime with SHA-256 manifest." -ForegroundColor Green
}

# Assemble the complete offline Code Intelligence runtime from locked npm
# packages and a hash-pinned CPython embeddable distribution.
$intelligenceScripts = Join-Path $repoRoot 'scripts\intelligence-runtime'
$intelligenceStage = Join-Path $stagingDir 'intelligence-runtime'
Push-Location $intelligenceScripts
try {
    & $npmCmd.Path ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Locked Code Intelligence npm installation failed.' }
    & $nodeCmd.Path (Join-Path $intelligenceScripts 'stage.mjs') $intelligenceStage
    if ($LASTEXITCODE -ne 0) { throw 'Offline intelligence staging failed.' }
    & $nodeCmd.Path (Join-Path $intelligenceScripts 'verify.mjs') $intelligenceStage
    if ($LASTEXITCODE -ne 0) { throw 'Offline intelligence staged manifest verification failed.' }
} finally { Pop-Location }
$hubPayload = Join-Path $payloadDir 'CHATMCP-HUB'
Copy-Item -LiteralPath (Join-Path $intelligenceStage 'grammars') -Destination (Join-Path $hubPayload 'grammars') -Recurse -ErrorAction Stop
Copy-Item -Path (Join-Path $intelligenceStage 'runtimes\*') -Destination (Join-Path $hubPayload 'runtimes') -Recurse -ErrorAction Stop
Copy-Item -LiteralPath (Join-Path $intelligenceStage 'licenses') -Destination (Join-Path $hubPayload 'licenses') -Recurse -ErrorAction Stop
Copy-Item -LiteralPath (Join-Path $intelligenceStage 'runtime-manifest.json') -Destination (Join-Path $hubPayload 'runtime-manifest.json') -ErrorAction Stop
& $nodeCmd.Path (Join-Path $intelligenceScripts 'verify.mjs') $hubPayload
if ($LASTEXITCODE -ne 0) { throw 'Offline intelligence installed payload verification failed.' }
Write-Host '  [OK] Bundled Code Intelligence verified inside installer payload.' -ForegroundColor Green
# Execute actual bundled Node, TypeScript/Pyright LSP, and embedded Python
# against fresh local workspaces before the installer is created.
& $nodeDestination (Join-Path $intelligenceScripts 'test-runtime.mjs') $hubPayload $nodeDestination
if ($LASTEXITCODE -ne 0) { throw 'Bundled runtime integration test failed.' }
Write-Host '  [OK] Bundled LSP and CPython worker integration tests passed.' -ForegroundColor Green

# Stage the npm-lock-pinned Playwright JavaScript runtime from the UI dependencies.
# Browser executable is NOT bundled. On Windows the agent first tries installed
# Microsoft Edge and then a separately provisioned Playwright Chromium.
$browserStage = Join-Path $hubPayload 'runtimes\browser'
$browserModules = Join-Path $browserStage 'node_modules'
New-Item -ItemType Directory -Path $browserModules -Force | Out-Null
$uiNodeModules = Join-Path $repoRoot 'CHATMCP-HUB\ui\node_modules'
foreach ($packageName in @('playwright', 'playwright-core')) {
    $packageSource = Join-Path $uiNodeModules $packageName
    $manifestSource = Join-Path $packageSource 'package.json'
    if (-not (Test-Path -LiteralPath $manifestSource -PathType Leaf)) {
        throw "Locked browser runtime package is missing: $packageName"
    }
    Copy-Item -LiteralPath $packageSource -Destination (Join-Path $browserModules $packageName) -Recurse -ErrorAction Stop
    if (-not (Test-Path -LiteralPath (Join-Path $browserModules "$packageName\package.json") -PathType Leaf)) {
        throw "Playwright runtime package was not staged: $packageName"
    }
}
$playwrightPackage = Get-Content -LiteralPath (Join-Path $browserModules 'playwright\package.json') -Raw | ConvertFrom-Json
$playwrightCorePackage = Get-Content -LiteralPath (Join-Path $browserModules 'playwright-core\package.json') -Raw | ConvertFrom-Json
if ($playwrightPackage.version -ne $playwrightCorePackage.version) {
    throw 'Playwright and playwright-core versions differ in staged installer.'
}
$runtimeMarker = '{"name":"chatmcp-browser-runtime","private":true,"type":"commonjs"}'
[IO.File]::WriteAllText((Join-Path $browserStage 'package.json'), $runtimeMarker, [Text.UTF8Encoding]::new($false))
& $nodeDestination (Join-Path $repoRoot 'scripts\Verify-BrowserRuntime.mjs') $browserStage
if ($LASTEXITCODE -ne 0) { throw 'Bundled Playwright module load validation failed.' }
Write-Host "  [OK] Playwright JS $($playwrightPackage.version) staged; Windows Edge/Chromium browser executable remains required." -ForegroundColor Green

# Compress staging directory to installer/payload.zip
$payloadZip = Join-Path $installerDir 'payload.zip'
if (Test-Path -LiteralPath $payloadZip) {
    Remove-Item -LiteralPath $payloadZip -Force
}
Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
[System.IO.Compression.ZipFile]::CreateFromDirectory($payloadDir, $payloadZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
$zipSizeMb = [Math]::Round((Get-Item $payloadZip).Length / 1MB, 2)
Write-Host "  [OK] Created payload.zip ($zipSizeMb MB)" -ForegroundColor Green

# 5. Compile Standalone Installer (ChatMCPSetup.exe)
Write-Host "`n[5/5] Compiling commercial ChatMCPSetup.exe..." -ForegroundColor Yellow
if (-not (Test-Path -LiteralPath $distDir)) {
    New-Item -ItemType Directory -Path $distDir -Force | Out-Null
}

$installerCsproj = Join-Path $installerDir 'ChatMCP.Installer.csproj'
$installerPublish = Join-Path $stagingDir 'installer-publish'
& $dotnetCmd.Path publish $installerCsproj -c Release -r win-x64 --self-contained true -o $installerPublish -p:PublishSingleFile=true | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Installer publish failed with exit code $LASTEXITCODE" }

$publishedSetup = Join-Path $installerPublish 'ChatMCPSetup.exe'
if (-not (Test-Path -LiteralPath $publishedSetup -PathType Leaf)) {
    throw 'Failed to build ChatMCPSetup.exe.'
}
$setupExe = Join-Path $distDir 'ChatMCPSetup.exe'
Copy-Item -LiteralPath $publishedSetup -Destination $setupExe -Force

$setupSizeMb = [Math]::Round((Get-Item $setupExe).Length / 1MB, 2)
Write-Host "  [OK] Built standalone installer: $setupExe ($setupSizeMb MB)" -ForegroundColor Green
$checksum = (Get-FileHash -LiteralPath $setupExe -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumFile = "$setupExe.sha256"
Set-Content -LiteralPath $checksumFile -Value "$checksum  ChatMCPSetup.exe" -Encoding Ascii
Write-Host "  [OK] SHA-256: $checksum" -ForegroundColor Green
Write-Host "  [OK] Checksum file: $checksumFile" -ForegroundColor Green
} finally {
    # Absolute parent/name/reparse checks cover both fresh publish outputs and
    # the separate payload directory before recursive cleanup on every exit.
    Remove-InstallerStagingDirectory -StagingDirectory $stagingDir -TemporaryRoot $temporaryRoot
}

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "         ChatMCPSetup.exe Built Successfully!             " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Output File: $setupExe"
Write-Host "You can now distribute or double-click ChatMCPSetup.exe to install."
Write-Host "----------------------------------------------------------`n"
exit 0
