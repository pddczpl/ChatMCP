#requires -Version 5.1
[CmdletBinding()]
param()
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir '..\InstallerPayload.ps1')
$scratchRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$scratch = Join-Path $scratchRoot ('ChatMCP-Payload-Test-' + [guid]::NewGuid().ToString('N'))
$fixture = Join-Path $scratch 'checkout'
$destination = Join-Path $scratch 'package'
$count = 0
function Assert-Payload {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "FAIL: $Message" }
    $script:count++
    Write-Host "PASS: $Message"
}
function Write-Fixture {
    param([string]$Relative, [string]$Content = 'fixture')
    $file = Join-Path $fixture $Relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
    [IO.File]::WriteAllText($file, $Content)
}
function Invoke-FixtureGit {
    param([string[]]$Arguments)
    & git.exe -C $fixture @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Fixture Git failed: $Arguments" }
}
function Assert-Rejected {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    $rejected = $false
    try { & $Action | Out-Null } catch { if ($_.Exception.Message -notmatch $Pattern) { throw }; $rejected = $true }
    Assert-Payload $rejected $Message
}
try {
    foreach ($script in @((Join-Path $scriptDir '..\InstallerPayload.ps1'), (Join-Path $scriptDir '..\Build-Installer.ps1'), $MyInvocation.MyCommand.Path)) {
        $parseErrors = $null; $tokens = $null
        $null = [Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$parseErrors)
        Assert-Payload ($parseErrors.Count -eq 0) ('PowerShell 5.1 syntax: ' + [IO.Path]::GetFileName($script))
        Assert-Payload (-not ([IO.File]::ReadAllBytes($script) | Where-Object { $_ -gt 127 })) ('ASCII source: ' + [IO.Path]::GetFileName($script))
    }
    $builder = [IO.File]::ReadAllText((Join-Path $scriptDir '..\Build-Installer.ps1'))
    Assert-Payload ($builder.Contains('Copy-InstallerSourcePayload -RepositoryRoot $repoRoot -Destination $payloadDir')) 'real builder uses the tested source copy helper'
    Assert-Payload ($builder.Contains('Copy-InstallerDesktopPayload -PublishDirectory $shellDist -Destination $payloadDir')) 'real builder requires the tested native payload check'
    Assert-Payload ($builder.Contains('$supervisorProject = Join-Path $repoRoot') -and $builder.Contains('GuestSupervisor.exe.sha256')) 'trusted guest helper built and hashed explicitly, never from tracked C# sources'
    $assembler = [IO.File]::ReadAllText((Join-Path $scriptDir '..\..\CHATMCP-HUB\lib\assemble.mjs'))
    Assert-Payload ($builder.Contains('$stagingNode = Join-Path $payloadDir ''runtimes\node''') -and
        $assembler.Contains("nodeToolchainDirectory:path.resolve(bundleRoot,'..','runtimes','node')")) 'pinned Node runtime path matches installed payload layout'
    Assert-Payload ($builder.Contains('$shellDist = Join-Path $stagingDir ''desktop-publish''') -and $builder.Contains('$installerPublish = Join-Path $stagingDir ''installer-publish''')) 'each native publish uses private fresh output'
    New-Item -ItemType Directory -Path $fixture -Force | Out-Null
    Invoke-FixtureGit @('init', '-q')
    Write-Fixture '.gitignore' "installed-plugins.json`nsecrets.json`ntest-results/`nnode_modules/`n"
    foreach ($file in @('START-CHATMCP-DESKTOP.cmd', 'CHATMCP-HUB/hub.mjs', 'CHATMCP-HUB/package.json', 'CHATMCP-HUB/lib/agent.mjs', 'CHATMCP-HUB/lib/space name.mjs', 'CHATMCP-HUB/windows/sandbox/GuestSupervisor/Program.cs', 'CHATMCP-HUB/tests/private-fixture.json', 'CHATMCP-HUB/ui/src/App.tsx', 'CHATMCP-HUB/web/dist/index.html', 'CHATMCP-HUB/web/dist/assets/old-hash.js', 'scripts/Start-DesktopApp.ps1', 'scripts/uninstall-desktop.ps1', 'scripts/Build-Installer.ps1', 'scripts/tests/developer.ps1', 'assets/icons/app.ico', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md')) { Write-Fixture $file }
    $unicodeSource = 'CHATMCP-HUB/lib/caf' + [char]0x00e9 + '.mjs'
    Write-Fixture $unicodeSource
    Invoke-FixtureGit @('add', '--all')
    # Personal state and downloaded third-party material are never tracked.
    foreach ($file in @('CHATMCP-HUB/installed-plugins.json', 'CHATMCP-HUB/secrets.json', 'CHATMCP-HUB/test-results/private-log.json', 'CHATMCP-HUB/node_modules/dev-package/index.js', 'CHATMCP-HUB/skills/downloaded/SKILL.md', 'scripts/local-personal.ps1', 'assets/private.png')) { Write-Fixture $file 'PRIVATE-STATE-MUST-NOT-SHIP' }
    Write-Fixture 'CHATMCP-HUB/lib/agent.mjs' 'current modified runtime'
    # Model Vite emptyOutDir + its freshly emitted untracked content.
    Remove-Item -LiteralPath (Join-Path $fixture 'CHATMCP-HUB/web/dist/assets/old-hash.js')
    Write-Fixture 'CHATMCP-HUB/web/dist/index.html' '<script src="./assets/new-hash.js"></script>'
    Write-Fixture 'CHATMCP-HUB/web/dist/assets/new-hash.js' 'fresh UI'
    Copy-InstallerSourcePayload -RepositoryRoot $fixture -Destination $destination
    Assert-Payload (Test-Path -LiteralPath (Join-Path $destination 'CHATMCP-HUB/hub.mjs')) 'tracked Hub entry ships'
    Assert-Payload ([IO.File]::ReadAllText((Join-Path $destination 'CHATMCP-HUB/lib/agent.mjs')) -eq 'current modified runtime') 'current working tree content ships for tracked runtime files'
    Assert-Payload (Test-Path -LiteralPath (Join-Path $destination 'CHATMCP-HUB/lib/space name.mjs')) 'tracked paths containing spaces survive enumeration'
    Assert-Payload (Test-Path -LiteralPath (Join-Path $destination $unicodeSource)) 'tracked Unicode paths survive Git output decoding'
    Assert-Payload ((Test-Path -LiteralPath (Join-Path $destination 'LICENSE')) -and (Test-Path -LiteralPath (Join-Path $destination 'NOTICE'))) 'Apache-2.0 LICENSE and NOTICE ship at the payload root'
    Invoke-FixtureGit @('rm', '--cached', '-q', 'LICENSE')
    Assert-Rejected { Get-InstallerPayloadFiles -RepositoryRoot $fixture } 'not tracked: LICENSE' 'a payload without the license text fails closed'
    Invoke-FixtureGit @('add', 'LICENSE')
    Assert-Payload (Test-Path -LiteralPath (Join-Path $destination 'THIRD-PARTY-NOTICES.md')) 'THIRD-PARTY-NOTICES.md ships at the payload root'
    Invoke-FixtureGit @('rm', '--cached', '-q', 'THIRD-PARTY-NOTICES.md')
    Assert-Rejected { Get-InstallerPayloadFiles -RepositoryRoot $fixture } 'not tracked: THIRD-PARTY-NOTICES.md' 'a payload without the third-party notices fails closed'
    Invoke-FixtureGit @('add', 'THIRD-PARTY-NOTICES.md')
    Assert-Payload (Test-Path -LiteralPath (Join-Path $destination 'CHATMCP-HUB/web/dist/assets/new-hash.js')) 'new generated UI asset ships'
    Assert-Payload (-not (Test-Path -LiteralPath (Join-Path $destination 'CHATMCP-HUB/web/dist/assets/old-hash.js'))) 'stale tracked UI asset is not resurrected'
    foreach ($excluded in @('CHATMCP-HUB/installed-plugins.json', 'CHATMCP-HUB/secrets.json', 'CHATMCP-HUB/test-results', 'CHATMCP-HUB/node_modules', 'CHATMCP-HUB/skills', 'CHATMCP-HUB/tests', 'CHATMCP-HUB/ui', 'CHATMCP-HUB/windows/sandbox/GuestSupervisor', 'scripts/tests', 'scripts/Build-Installer.ps1', 'scripts/local-personal.ps1', 'assets/private.png')) {
        Assert-Payload (-not (Test-Path -LiteralPath (Join-Path $destination $excluded))) "excluded from payload: $excluded"
    }
    Assert-Payload ([IO.File]::ReadAllText((Join-Path $fixture 'CHATMCP-HUB/installed-plugins.json')) -eq 'PRIVATE-STATE-MUST-NOT-SHIP') 'user state remains untouched'
    Invoke-FixtureGit @('add', '-f', 'CHATMCP-HUB/installed-plugins.json')
    $selected = @(Get-InstallerPayloadFiles -RepositoryRoot $fixture)
    Assert-Payload (-not ($selected | Where-Object { $_.RelativePath -eq 'CHATMCP-HUB/installed-plugins.json' })) 'runtime allowlist excludes accidentally tracked user state too'
    Write-Fixture 'CHATMCP-HUB/web/dist/secrets.json' 'PRIVATE-STATE-MUST-NOT-SHIP'
    Assert-Rejected { Get-InstallerPayloadFiles -RepositoryRoot $fixture } 'Unexpected file' 'unexpected generated output fails closed'
    Remove-Item -LiteralPath (Join-Path $fixture 'CHATMCP-HUB/web/dist/secrets.json')
    $outside = Join-Path $scratch 'outside'
    New-Item -ItemType Directory -Path $outside | Out-Null
    $junction = Join-Path $fixture 'CHATMCP-HUB/web/dist/assets/escape'
    New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
    Assert-Rejected { Get-InstallerPayloadFiles -RepositoryRoot $fixture } 'junction' 'generated output junction is rejected before traversal'
    # Remove only the junction itself, never its target.
    [IO.Directory]::Delete($junction)
    Assert-Payload (Test-Path -LiteralPath $outside) 'junction rejection preserves external target'
    Assert-Rejected { Remove-InstallerStagingDirectory -StagingDirectory $fixture -TemporaryRoot $scratch } 'unsafe' 'cleanup refuses the checkout path'
    $safeStage = Join-Path $scratch ('ChatMCP-Staging-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $safeStage | Out-Null
    Remove-InstallerStagingDirectory -StagingDirectory $safeStage -TemporaryRoot $scratch
    Assert-Payload (-not (Test-Path -LiteralPath $safeStage)) 'validated private staging directory is cleaned'
    $native = Join-Path $scratch 'native-publish'
    $nativePayload = Join-Path $scratch 'native-payload'
    New-Item -ItemType Directory -Path $native | Out-Null
    [IO.File]::WriteAllText((Join-Path $native 'ChatMCP.exe'), 'fixture executable')
    Assert-Rejected { Copy-InstallerDesktopPayload -PublishDirectory $native -Destination $nativePayload } 'missing or empty.*WebView2Loader' 'missing loader blocks packaging'
    Assert-Payload (-not (Test-Path -LiteralPath $nativePayload)) 'missing loader cannot leave a success payload'
    $loaderBytes = New-Object byte[] 128
    $loaderBytes[0] = 0x4d; $loaderBytes[1] = 0x5a; $loaderBytes[0x3c] = 64
    $loaderBytes[64] = 0x50; $loaderBytes[65] = 0x45; $loaderBytes[68] = 0x4c; $loaderBytes[69] = 0x01
    [IO.File]::WriteAllBytes((Join-Path $native 'WebView2Loader.dll'), $loaderBytes)
    Assert-Rejected { Copy-InstallerDesktopPayload -PublishDirectory $native -Destination $nativePayload } 'must target x64' 'wrong-architecture loader blocks packaging'
    $loaderBytes[68] = 0x64; $loaderBytes[69] = 0x86
    [IO.File]::WriteAllBytes((Join-Path $native 'WebView2Loader.dll'), $loaderBytes)
    foreach ($name in @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'ChatMCP.pdb', 'Microsoft.Web.WebView2.Core.xml')) {
        [IO.File]::WriteAllText((Join-Path $native $name), 'optional publish file')
    }
    Copy-InstallerDesktopPayload -PublishDirectory $native -Destination $nativePayload
    Assert-Payload ((Test-Path -LiteralPath (Join-Path $nativePayload 'ChatMCP.exe')) -and (Test-Path -LiteralPath (Join-Path $nativePayload 'WebView2Loader.dll'))) 'validated desktop and x64 loader are both copied'
    Assert-Payload ((Test-Path -LiteralPath (Join-Path $nativePayload 'Microsoft.Web.WebView2.Core.dll')) -and (Test-Path -LiteralPath (Join-Path $nativePayload 'Microsoft.Web.WebView2.WinForms.dll'))) 'separately emitted WebView2 runtime assemblies are retained'
    Assert-Payload (-not (Test-Path -LiteralPath (Join-Path $nativePayload 'ChatMCP.pdb')) -and -not (Test-Path -LiteralPath (Join-Path $nativePayload 'Microsoft.Web.WebView2.Core.xml'))) 'publish debug symbols and XML documentation do not ship'
    # Node.js LICENSE: node.exe may only be packaged together with the licence text of its bundled components.
    Assert-Payload ($builder.Contains('Copy-InstallerNodeLicense -NodeExecutable $sysNode -Destination $stagingNode')) 'real builder copies the Node.js LICENSE next to the bundled node.exe'
    $nodeHome = Join-Path $scratch 'node-home'
    $nodeStage = Join-Path $scratch 'node-stage'
    New-Item -ItemType Directory -Path $nodeHome | Out-Null
    [IO.File]::WriteAllText((Join-Path $nodeHome 'node.exe'), 'fixture node')
    $nodeLicenseText = "Node.js is licensed for use as follows:`nPermission is hereby granted, free of charge, to any person obtaining a copy of this software`n" + ('This fixture stands in for the long Node.js LICENSE file. ' * 30)
    Assert-Rejected { Copy-InstallerNodeLicense -NodeExecutable (Join-Path $nodeHome 'node.exe') -Destination $nodeStage -SuppliedLicense '' } 'No Node.js LICENSE' 'node.exe without a LICENSE beside it is not packaged'
    Assert-Payload (-not (Test-Path -LiteralPath (Join-Path $nodeStage 'LICENSE'))) 'the refused Node.js build leaves no LICENSE behind'
    [IO.File]::WriteAllText((Join-Path $nodeHome 'LICENSE'), 'MIT')
    Assert-Rejected { Copy-InstallerNodeLicense -NodeExecutable (Join-Path $nodeHome 'node.exe') -Destination $nodeStage -SuppliedLicense '' } 'not the Node.js licence' 'a stub LICENSE file is refused'
    [IO.File]::WriteAllText((Join-Path $nodeHome 'LICENSE'), $nodeLicenseText)
    Copy-InstallerNodeLicense -NodeExecutable (Join-Path $nodeHome 'node.exe') -Destination $nodeStage -SuppliedLicense ''
    Assert-Payload ([IO.File]::ReadAllText((Join-Path $nodeStage 'LICENSE')) -eq $nodeLicenseText) 'the LICENSE beside node.exe is copied byte for byte'
    Remove-Item -LiteralPath (Join-Path $nodeHome 'LICENSE') -Force
    $suppliedLicense = Join-Path $scratch 'supplied-node-license.txt'
    [IO.File]::WriteAllText($suppliedLicense, $nodeLicenseText)
    Remove-Item -LiteralPath (Join-Path $nodeStage 'LICENSE') -Force
    Copy-InstallerNodeLicense -NodeExecutable (Join-Path $nodeHome 'node.exe') -Destination $nodeStage -SuppliedLicense $suppliedLicense
    Assert-Payload (Test-Path -LiteralPath (Join-Path $nodeStage 'LICENSE')) 'a supplied Node.js LICENSE file is accepted for an MSI-installed Node.js'
    Assert-Rejected { Copy-InstallerNodeLicense -NodeExecutable (Join-Path $nodeHome 'node.exe') -Destination $nodeStage -SuppliedLicense (Join-Path $scratch 'no-such-file') } 'does not name an existing file' 'a supplied LICENSE path that does not exist is an error, not a silent fallback'
    Write-Host "PASS: Installer payload regression ($count passed, 0 failed, 0 skipped)"
} finally {
    $resolved = [IO.Path]::GetFullPath($scratch).TrimEnd('\', '/')
    if ([IO.Path]::GetDirectoryName($resolved) -ne $scratchRoot -or [IO.Path]::GetFileName($resolved) -notmatch '^ChatMCP-Payload-Test-[0-9a-f]{32}$') { throw 'Unsafe regression cleanup path.' }
    Assert-InstallerNoReparsePath -Path $resolved
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
