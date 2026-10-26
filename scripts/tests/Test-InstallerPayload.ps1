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
    # ripgrep: rg.exe is linked with PCRE2, with Rust crates and with the Rust standard library, whose license texts are not in the ripgrep archive. The texts are vendored in
    # scripts/intelligence-runtime/licenses/ripgrep, stage.mjs stages them as licenses/ripgrep, and the licenses folder travels into the payload.
    Assert-Payload ($builder.Contains('Assert-InstallerRipgrepNotices -HubRoot $hubPayload')) 'real builder checks the ripgrep notices of the payload'
    $hubFixture = Join-Path $scratch 'hub-with-notices'
    New-Item -ItemType Directory -Path (Join-Path $hubFixture 'licenses') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $scriptDir '..\intelligence-runtime\licenses\ripgrep') -Destination (Join-Path $hubFixture 'licenses\ripgrep') -Recurse
    Assert-InstallerRipgrepNotices -HubRoot $hubFixture
    Assert-Payload $true 'the vendored ripgrep notices (PCRE2, the Rust standard library and the Rust crates) make an acceptable payload'
    $noticeManifest = Join-Path $hubFixture 'licenses\ripgrep\MANIFEST.json'
    $noticeJson = [IO.File]::ReadAllText($noticeManifest)
    $firstPath = [string](ConvertFrom-Json $noticeJson).components[0].files[0].path
    $firstNotice = Join-Path $hubFixture ('licenses\ripgrep\' + $firstPath.Replace('/', '\'))
    Move-Item -LiteralPath $noticeManifest -Destination ($noticeManifest + '.hidden')
    Assert-Rejected { Assert-InstallerRipgrepNotices -HubRoot $hubFixture } 'MANIFEST\.json' 'a payload without the ripgrep notice inventory is refused'
    Move-Item -LiteralPath ($noticeManifest + '.hidden') -Destination $noticeManifest
    Move-Item -LiteralPath $firstNotice -Destination ($firstNotice + '.hidden')
    Assert-Rejected { Assert-InstallerRipgrepNotices -HubRoot $hubFixture } 'Missing or empty ripgrep notice' 'a payload without one of the listed license texts is refused'
    Move-Item -LiteralPath ($firstNotice + '.hidden') -Destination $firstNotice
    $firstBytes = [IO.File]::ReadAllBytes($firstNotice)
    [IO.File]::WriteAllBytes($firstNotice, (New-Object byte[] 0))
    Assert-Rejected { Assert-InstallerRipgrepNotices -HubRoot $hubFixture } 'Missing or empty ripgrep notice' 'an empty license text is refused'
    [IO.File]::WriteAllBytes($firstNotice, $firstBytes)
    [IO.File]::WriteAllText($noticeManifest, $noticeJson.Replace('"name": "PCRE2"', '"name": "PCRE3"'))
    Assert-Rejected { Assert-InstallerRipgrepNotices -HubRoot $hubFixture } 'PCRE2' 'an inventory without PCRE2 is refused'
    [IO.File]::WriteAllText($noticeManifest, $noticeJson.Replace('"path": "' + $firstPath + '"', '"path": "../LICENCE.md"'))
    Assert-Rejected { Assert-InstallerRipgrepNotices -HubRoot $hubFixture } 'Unsafe ripgrep notice path' 'an inventory path that leaves the folder is refused'
    [IO.File]::WriteAllText($noticeManifest, $noticeJson)
    Assert-InstallerRipgrepNotices -HubRoot $hubFixture
    Assert-Payload $true 'the restored notices are accepted again (the refusals above were not caused by anything else)'
    # -ReleaseKeysFile: a TEST build can name the key list that the desktop shell (built in) and the Hub (the copy in the payload) trust, so that the end-to-end test of the updater can build two
    # versions that trust a key made for the run. The helper checks the FILE (where it is, how big, that it holds a release key of the right size); the shell and the Hub read the keys with their own strict code.
    $keysFolder = Join-Path $scratch 'keys'
    New-Item -ItemType Directory -Path $keysFolder -Force | Out-Null
    $testSpki = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAExgbXOYRPa08zYU3oyO9jGU1RtUw3JQ9JiLbYgYaNy/nTP5X1eiw8y7GJuVK8y4BUt3t4Ou5ON/htHPhNtjxUcg=='
    $validKeys = '{"version":1,"algorithm":"ES256","keys":[{"kid":"00000000","use":"release","spki":"' + $testSpki + '"}]}'
    function Write-KeyList {
        param([string]$Name, [string]$Text)
        $file = Join-Path $keysFolder $Name
        [IO.File]::WriteAllText($file, $Text)
        return $file
    }
    $validFile = Write-KeyList 'valid.json' $validKeys
    Assert-Payload ((Resolve-InstallerReleaseKeysFile -Path $validFile) -eq $validFile) 'a key list for a test build is accepted as a full path and returned as one'
    Assert-Payload ((Resolve-InstallerReleaseKeysFile -Path ($keysFolder + '/sub/../valid.json')) -eq $validFile) 'and is returned in its plain form (one kind of separator, no dot segments)'
    Assert-Rejected { Resolve-InstallerReleaseKeysFile -Path 'valid.json' } 'full path' 'a relative path is refused (it would mean what the current folder happens to be)'
    Assert-Rejected { Resolve-InstallerReleaseKeysFile -Path '\valid.json' } 'full path' 'so is a path without a drive'
    Assert-Rejected { Resolve-InstallerReleaseKeysFile -Path (Join-Path $keysFolder 'missing.json') } 'not a file' 'a file that is not there is refused'
    Assert-Rejected { Resolve-InstallerReleaseKeysFile -Path $keysFolder } 'not a file' 'a folder is refused'
    Assert-Rejected { Resolve-InstallerReleaseKeysFile -Path (Write-KeyList 'empty.json' '') } 'between' 'an empty file is refused'
    Assert-Rejected { Resolve-InstallerReleaseKeysFile -Path (Write-KeyList 'big.json' ($validKeys + (' ' * 20000))) } 'between' 'a file over 16 KiB is refused'
    Assert-Rejected { Resolve-InstallerReleaseKeysFile -Path (Write-KeyList 'text.json' 'not json at all') } 'not JSON' 'text that is not JSON is refused'
    Assert-Rejected { Resolve-InstallerReleaseKeysFile -Path (Write-KeyList 'array.json' '[]') } 'release key' 'JSON that is not a key list is refused'
    Assert-Rejected { Resolve-InstallerReleaseKeysFile -Path (Write-KeyList 'nokeys.json' '{"keys":[]}') } 'release key' 'a list without a key is refused'
    Assert-Rejected { Resolve-InstallerReleaseKeysFile -Path (Write-KeyList 'placeholder.json' '{"keys":[{"kid":"00000000","use":"placeholder","spki":null}]}') } 'release key' 'the placeholder, which trusts nothing, is refused (a test build that cannot verify anything tests nothing)'
    Assert-Rejected { Resolve-InstallerReleaseKeysFile -Path (Write-KeyList 'nospki.json' '{"keys":[{"kid":"00000000","use":"release","spki":null}]}') } 'release key' 'a release entry without a key is refused'
    Assert-Rejected { Resolve-InstallerReleaseKeysFile -Path (Write-KeyList 'short.json' '{"keys":[{"kid":"00000000","use":"release","spki":"AAAA"}]}') } 'release key' 'a key that is not 91 bytes long is refused'
    Assert-Rejected { Resolve-InstallerReleaseKeysFile -Path (Write-KeyList 'other-use.json' ($validKeys.Replace('"use":"release"', '"use":"test"'))) } 'release key' 'only an entry that says use "release" counts, as for the Hub and the shell'
    $junction = Join-Path $scratch 'keys-junction'
    New-Item -ItemType Junction -Path $junction -Target $keysFolder | Out-Null
    try {
        Assert-Rejected { Resolve-InstallerReleaseKeysFile -Path (Join-Path $junction 'valid.json') } 'symlink or junction' 'a key file reached through a junction is refused'
    } finally { [IO.Directory]::Delete($junction) }
    $savedWorkflow = $env:GITHUB_WORKFLOW
    try {
        $env:GITHUB_WORKFLOW = 'Publish ChatMCP v9.9.9'
        Assert-Rejected { Resolve-InstallerReleaseKeysFile -Path $validFile } 'test builds' 'a publish workflow never builds with a key list of its own (a release is built from the committed one)'
        $env:GITHUB_WORKFLOW = 'CI'
        Assert-Payload ((Resolve-InstallerReleaseKeysFile -Path $validFile) -eq $validFile) 'the CI workflow can (the end-to-end test of the updater runs there)'
    } finally {
        if ($null -eq $savedWorkflow) { Remove-Item -LiteralPath Env:\GITHUB_WORKFLOW -ErrorAction SilentlyContinue } else { $env:GITHUB_WORKFLOW = $savedWorkflow }
    }
    # The build does not believe how it asked for the key list: it PROVES what it made. MSBuild reads an environment variable called ReleaseKeysFile as a property, and any other way of naming the
    # file can go wrong without a word, so the program that was built is searched for the exact bytes of the list it was meant to carry (the resource is the file, byte for byte), the copy that goes
    # to the Hub is compared with it, and a publish workflow refuses the variable altogether. The search is done in blocks (a program is 100 MB): the tests make the blocks tiny so that every place
    # where a block ends is tried.
    $provenFolder = Join-Path $scratch 'proven'
    New-Item -ItemType Directory -Path $provenFolder -Force | Out-Null
    $random = New-Object System.Random 20261027
    function New-NoiseBytes {
        param([int]$Length)
        $noise = New-Object byte[] $Length
        $random.NextBytes($noise)
        return , $noise
    }
    function Write-Program {
        param([string]$Name, [byte[]]$Content)
        $file = Join-Path $provenFolder $Name
        [IO.File]::WriteAllBytes($file, $Content)
        return $file
    }
    $needle = [byte[]](0x7B, 0x00, 0xFF, 0x80, 0x9F, 0x22, 0x6B, 0x0A, 0x7D)
    $noise = New-NoiseBytes 100
    $blockSizes = @(1, 2, 3, 8, 9, 10, 16, 100, 1000)
    $missed = New-Object 'System.Collections.Generic.List[string]'
    foreach ($offset in 0..($noise.Length - $needle.Length)) {
        $haystack = [byte[]]$noise.Clone()
        [Array]::Copy($needle, 0, $haystack, $offset, $needle.Length)
        $haystackFile = Write-Program 'haystack.bin' $haystack
        foreach ($blockSize in $blockSizes) {
            if (-not (Test-InstallerFileContains -Path $haystackFile -Needle $needle -BlockSize $blockSize)) { $missed.Add("offset $offset, block $blockSize") }
        }
    }
    Assert-Payload ($missed.Count -eq 0) ('the search finds the bytes wherever they are, also where a block ends in the middle of them (92 places, 9 block sizes)' + $(if ($missed.Count -gt 0) { ': missed ' + (($missed | Select-Object -First 3) -join '; ') } else { '' }))
    $falseHits = New-Object 'System.Collections.Generic.List[string]'
    $lookalikes = New-Object 'System.Collections.Generic.List[byte[]]'
    for ($position = 0; $position -lt $needle.Length; $position++) { $changed = [byte[]]$needle.Clone(); $changed[$position] = [byte](($changed[$position] + 1) -band 255); $lookalikes.Add($changed) }
    $otherCase = [byte[]]$needle.Clone(); $otherCase[6] = [byte]($otherCase[6] -bxor 0x20); $lookalikes.Add($otherCase) # the letter k as K: a search that ignores case would take it for the same bytes
    foreach ($blockSize in $blockSizes) {
        foreach ($other in $lookalikes) {
            $haystack = [byte[]]$noise.Clone(); [Array]::Copy($other, 0, $haystack, 40, $other.Length)
            if (Test-InstallerFileContains -Path (Write-Program 'lookalike.bin' $haystack) -Needle $needle -BlockSize $blockSize) { $falseHits.Add("a copy that differs in one byte, block $blockSize") }
        }
        foreach ($cut in @(@($needle[0..7], 'its first eight bytes at the end'), @($needle[1..8], 'its last eight bytes at the start'))) {
            $haystack = if ($cut[1] -like '*end') { [byte[]]($noise + $cut[0]) } else { [byte[]]($cut[0] + $noise) }
            if (Test-InstallerFileContains -Path (Write-Program 'cut.bin' $haystack) -Needle $needle -BlockSize $blockSize) { $falseHits.Add("$($cut[1]), block $blockSize") }
        }
        if (Test-InstallerFileContains -Path (Write-Program 'noise.bin' $noise) -Needle $needle -BlockSize $blockSize) { $falseHits.Add("noise only, block $blockSize") }
        if (Test-InstallerFileContains -Path (Write-Program 'empty.bin' (New-Object byte[] 0)) -Needle $needle -BlockSize $blockSize) { $falseHits.Add("an empty file, block $blockSize") }
        if (Test-InstallerFileContains -Path (Write-Program 'short.bin' $needle[0..4]) -Needle $needle -BlockSize $blockSize) { $falseHits.Add("a file shorter than the bytes, block $blockSize") }
    }
    Assert-Payload ($falseHits.Count -eq 0) ('and it finds nothing that is not there: a copy that differs in any one byte, half of the bytes at either end, noise, an empty file, a short one' + $(if ($falseHits.Count -gt 0) { ': ' + (($falseHits | Select-Object -First 3) -join '; ') } else { '' }))
    $exactFile = Write-Program 'exact.bin' $needle
    Assert-Payload ((Test-InstallerFileContains -Path $exactFile -Needle $needle -BlockSize 4) -and (Test-InstallerFileContains -Path $exactFile -Needle $needle)) 'a file that is nothing but the bytes holds them (also with the real block size)'
    Assert-Rejected { Test-InstallerFileContains -Path $exactFile -Needle (New-Object byte[] 0) } 'nothing to look for' 'and an empty list of bytes is not "found in everything": it is refused'
    Assert-Rejected { Test-InstallerFileContains -Path $exactFile -Needle $needle -BlockSize 0 } 'at least one byte' 'and a block of no bytes is refused (it would read nothing and say "not found")'
    $big = New-NoiseBytes (3 * 1024 * 1024 + 17)
    [Array]::Copy($needle, 0, $big, $big.Length - $needle.Length - 5, $needle.Length)
    Assert-Payload (Test-InstallerFileContains -Path (Write-Program 'big.bin' $big) -Needle $needle -BlockSize 1048576) 'bytes near the end of a file of several blocks are found at the real kind of size'
    $keysBytes = [IO.File]::ReadAllBytes($validFile)
    $otherFile = Write-KeyList 'other.json' ($validKeys.Replace('00000000', '00000001'))
    $program = Write-Program 'carries.exe' ([byte[]]((New-NoiseBytes 5000) + $keysBytes + (New-NoiseBytes 3000)))
    Assert-InstallerReleaseKeysBuiltIn -Executable $program -KeysFile $validFile
    Assert-Payload $true 'a program that carries the key list byte for byte passes'
    Assert-Rejected { Assert-InstallerReleaseKeysBuiltIn -Executable $program -KeysFile $otherFile } 'does not carry' 'a program that carries another key list (one character apart) is refused: this is the check that a test list did not reach a release, or the other way round'
    Assert-Rejected { Assert-InstallerReleaseKeysBuiltIn -Executable (Write-Program 'plain.exe' (New-NoiseBytes 9000)) -KeysFile $validFile } 'does not carry' 'a program with no key list in it is refused'
    Assert-Rejected { Assert-InstallerReleaseKeysBuiltIn -Executable (Write-Program 'nothing.exe' (New-Object byte[] 0)) -KeysFile $validFile } 'does not carry' 'an empty program is refused'
    $oneByteOff = [byte[]]$keysBytes.Clone(); $oneByteOff[$oneByteOff.Length - 3] = [byte]($oneByteOff[$oneByteOff.Length - 3] -bxor 1)
    Assert-Rejected { Assert-InstallerReleaseKeysBuiltIn -Executable (Write-Program 'off-by-one.exe' ([byte[]]((New-NoiseBytes 400) + $oneByteOff + (New-NoiseBytes 400)))) -KeysFile $validFile } 'does not carry' 'and so is one whose copy of the list differs in a single byte'
    Assert-Rejected { Assert-InstallerReleaseKeysBuiltIn -Executable $program -KeysFile (Write-KeyList 'zero.json' '') } 'meant to be built in is empty' 'an empty key list is refused by the proof itself (it would be "found" in every program)'
    Assert-Rejected { Assert-InstallerReleaseKeysBuiltIn -Executable $program -KeysFile (Join-Path $keysFolder 'missing.json') } 'not a file' 'a key list that is not there is refused'
    Assert-Rejected { Assert-InstallerReleaseKeysBuiltIn -Executable (Join-Path $provenFolder 'missing.exe') -KeysFile $validFile } 'not a file' 'and so is a program that is not there'
    $payloadFixture = Join-Path $scratch 'proven-payload'
    New-Item -ItemType Directory -Path (Join-Path $payloadFixture 'CHATMCP-HUB\lib') -Force | Out-Null
    Assert-Rejected { Assert-InstallerReleaseKeysShipped -PayloadDirectory $payloadFixture -KeysFile $validFile } 'not a file' 'a payload with no key list for the Hub is refused'
    [IO.File]::WriteAllBytes((Join-Path $payloadFixture 'CHATMCP-HUB\lib\release-keys.json'), $keysBytes)
    Assert-InstallerReleaseKeysShipped -PayloadDirectory $payloadFixture -KeysFile $validFile
    Assert-Payload $true 'a payload whose Hub reads the same list passes'
    Assert-Rejected { Assert-InstallerReleaseKeysShipped -PayloadDirectory $payloadFixture -KeysFile $otherFile } 'not the key list' 'a payload whose Hub reads another list than the shell was built with is refused'
    [IO.File]::WriteAllBytes((Join-Path $payloadFixture 'CHATMCP-HUB\lib\release-keys.json'), [byte[]]($keysBytes + [byte[]](0x20)))
    Assert-Rejected { Assert-InstallerReleaseKeysShipped -PayloadDirectory $payloadFixture -KeysFile $validFile } 'not the key list' 'and so is one with a single space more at its end'
    $savedWorkflowForKeys = $env:GITHUB_WORKFLOW; $savedAmbient = $env:ReleaseKeysFile
    try {
        $env:GITHUB_WORKFLOW = 'Publish ChatMCP v9.9.9'; $env:ReleaseKeysFile = $validFile
        Assert-Rejected { Assert-InstallerNoAmbientReleaseKeysFile } 'environment variable ReleaseKeysFile' 'a publish workflow with a variable called ReleaseKeysFile in its environment is refused (MSBuild would read it as a property)'
        $env:GITHUB_WORKFLOW = 'Publish'
        Assert-Rejected { Assert-InstallerNoAmbientReleaseKeysFile } 'environment variable ReleaseKeysFile' 'whatever follows Publish in the name'
        Remove-Item -LiteralPath Env:\ReleaseKeysFile
        Assert-InstallerNoAmbientReleaseKeysFile
        Assert-Payload $true 'a publish workflow without the variable is fine'
        $env:GITHUB_WORKFLOW = 'CI'; $env:ReleaseKeysFile = $validFile
        Assert-InstallerNoAmbientReleaseKeysFile
        Assert-Payload $true 'another workflow is not stopped by the variable (the program that is built is searched for the list either way)'
        Remove-Item -LiteralPath Env:\GITHUB_WORKFLOW; Remove-Item -LiteralPath Env:\ReleaseKeysFile
        Assert-InstallerNoAmbientReleaseKeysFile
        Assert-Payload $true 'and nor is a machine that is no workflow at all'
    } finally {
        if ($null -eq $savedWorkflowForKeys) { Remove-Item -LiteralPath Env:\GITHUB_WORKFLOW -ErrorAction SilentlyContinue } else { $env:GITHUB_WORKFLOW = $savedWorkflowForKeys }
        if ($null -eq $savedAmbient) { Remove-Item -LiteralPath Env:\ReleaseKeysFile -ErrorAction SilentlyContinue } else { $env:ReleaseKeysFile = $savedAmbient }
    }
    Assert-Payload ($builder.Contains('[string]$ReleaseKeysFile = ''''')) 'the builder takes -ReleaseKeysFile, empty by default (a release is built without it)'
    Assert-Payload ($builder.Contains('Resolve-InstallerReleaseKeysFile -Path $ReleaseKeysFile')) 'the builder checks it with the tested helper before it builds anything'
    # The value of a property on the command line of MSBuild is split at ';' and ',' and its '%' starts an escape: a repository in C:\My Repos, Inc\ or C:\a;b\ made every build fail with "MSB1006: Property is not valid"
    # (the key list is now named on every build). Each such character is written as %XX, which MSBuild turns back into the character when the value is used.
    Assert-Payload ((ConvertTo-InstallerMsbuildValue -Value 'C:\plain path\keys.json') -ceq 'C:\plain path\keys.json') 'a path with nothing special in it goes to MSBuild as it is (spaces are fine)'
    Assert-Payload ((ConvertTo-InstallerMsbuildValue -Value 'C:\a;b\x,y\keys.json') -ceq 'C:\a%3Bb\x%2Cy\keys.json') 'a semicolon and a comma, where MSBuild splits a property value, are escaped'
    Assert-Payload ((ConvertTo-InstallerMsbuildValue -Value 'C:\100%\keys.json') -ceq 'C:\100%25\keys.json') 'and so is a percent sign, which starts an escape of its own'
    Assert-Payload ((ConvertTo-InstallerMsbuildValue -Value 'C:\%3B\keys.json') -ceq 'C:\%253B\keys.json') 'and one that already looks like an escape (the percent sign first, so that it comes back as it was)'
    Assert-Payload ((ConvertTo-InstallerMsbuildValue -Value "C:\a (x86) `$b @c 'd' *e ?f\k.json") -ceq 'C:\a %28x86%29 %24b %40c %27d%27 %2Ae %3Ff\k.json') 'and the other characters of the syntax of MSBuild: parentheses, $, @, quotes, wildcards'
    Assert-Payload ((ConvertTo-InstallerMsbuildValue -Value '') -ceq '') 'an empty value stays empty'
    Assert-Payload ($builder.Contains('$shellKeysArgument = ConvertTo-InstallerMsbuildValue -Value $shellKeysFile') -and $builder.Contains('"-p:ReleaseKeysFile=$shellKeysArgument"') -and -not $builder.Contains('"-p:ReleaseKeysFile=$shellKeysFile"') -and $builder.IndexOf('$shellKeysFile = if') -lt $builder.IndexOf('$shellKeysArgument =') -and $builder.IndexOf('$shellKeysArgument =') -lt $builder.IndexOf('publish $shellCsproj')) 'the desktop shell is built with a key list that is ALWAYS named on the command line (embedded in the program), written so that MSBuild reads the path back as it is'
    Assert-Payload ($builder.Contains('$shellKeysFile = if ($ReleaseKeysFile -ne '''') { $ReleaseKeysFile } else { Join-Path $repoRoot ''CHATMCP-HUB\lib\release-keys.json'' }')) 'the one it names is the committed CHATMCP-HUB\lib\release-keys.json unless a test build gives another (MSBuild reads environment variables as properties: left to the default of the project, a variable called ReleaseKeysFile in the environment of a release build would be the list the program trusts)'
    Assert-Payload ($builder.Contains('-not (Test-Path -LiteralPath $shellKeysFile -PathType Leaf)')) 'and the build stops, before it compiles anything, when that file is not there'
    Assert-Payload ($builder.IndexOf('$shellKeysFile = if') -lt $builder.IndexOf('publish $shellCsproj')) 'the key list is chosen before the shell is published'
    Assert-Payload (-not $builder.Contains('@shellKeys')) 'and nothing leaves it out (an empty list of extra arguments, as before, is gone)'
    Assert-Payload ($builder.Contains('Copy-Item -LiteralPath $ReleaseKeysFile -Destination (Join-Path $payloadDir ''CHATMCP-HUB\lib\release-keys.json'') -Force')) 'and the Hub the installer installs gets the same file'
    Assert-Payload ([regex]::Matches($builder, 'ReleaseKeysFile=').Count -eq 1) 'nothing else is built with it (not the installer, not the guest helper)'
    Assert-Payload ([regex]::Matches($builder, 'publish \$shellCsproj').Count -eq 1) 'and the shell is published once, with it'
    Assert-Payload ($builder.IndexOf('Copy-InstallerSourcePayload -RepositoryRoot') -lt $builder.IndexOf('Copy-Item -LiteralPath $ReleaseKeysFile')) 'the copy of the key list comes after the tracked files are copied (before, it would be overwritten)'
    Assert-Payload ($builder.Contains('TEST BUILD')) 'and the build says, in its output, that it is a test build'
    Assert-Payload ([regex]::Matches($builder, 'Assert-InstallerNoAmbientReleaseKeysFile').Count -eq 1 -and $builder.IndexOf('Assert-InstallerNoAmbientReleaseKeysFile') -lt $builder.IndexOf('Resolve-InstallerReleaseKeysFile -Path $ReleaseKeysFile') -and $builder.IndexOf('Assert-InstallerNoAmbientReleaseKeysFile') -lt $builder.IndexOf('[1/5] Checking build prerequisites')) 'the builder refuses a variable called ReleaseKeysFile in a publish workflow before anything is built'
    Assert-Payload ([regex]::Matches($builder, 'Assert-InstallerReleaseKeysBuiltIn -Executable \$desktopExe -KeysFile \$shellKeysFile').Count -eq 1 -and $builder.IndexOf('publish $shellCsproj') -lt $builder.IndexOf('Assert-InstallerReleaseKeysBuiltIn') -and $builder.IndexOf('Assert-InstallerReleaseKeysBuiltIn') -lt $builder.IndexOf('Copy-InstallerDesktopPayload -PublishDirectory')) 'the program that was published is searched for the list it was meant to carry, before it goes into the payload'
    Assert-Payload ([regex]::Matches($builder, 'Assert-InstallerReleaseKeysShipped -PayloadDirectory \$payloadDir -KeysFile \$shellKeysFile').Count -eq 1 -and $builder.IndexOf('Copy-Item -LiteralPath $ReleaseKeysFile') -lt $builder.IndexOf('Assert-InstallerReleaseKeysShipped') -and $builder.IndexOf('Assert-InstallerReleaseKeysShipped') -lt $builder.IndexOf('CreateFromDirectory')) 'and the Hub of the payload is compared with the same list, after every copy that could change it and before the payload is packed'
    # The pure helpers of the native lifecycle script, which itself runs only on a disposable hosted runner: the argument list it gives the setup in update mode is vector 1 of the contract
    # (native-shared/UpdateContract.cs, UpdateArguments.Build), and it judges the result file strictly. Their definitions are taken from the script (never the script, which refuses to run anywhere else).
    & {
        $lifecycle = Join-Path $scriptDir 'Test-NativeLifecycle.ps1'
        $lifecycleErrors = $null; $lifecycleTokens = $null
        $lifecycleAst = [Management.Automation.Language.Parser]::ParseFile($lifecycle, [ref]$lifecycleTokens, [ref]$lifecycleErrors)
        foreach ($helper in @('Update-Arguments', 'Assert-UpdateResult', 'New-RetainedUpdate', 'Get-RecoveryScript')) {
            $definition = $lifecycleAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $helper }, $true)
            Assert-Payload ($null -ne $definition) ('the lifecycle script defines ' + $helper)
            Invoke-Expression $definition.Extent.Text
        }
        function Assert-Native([bool]$condition, [string]$message) { Assert-Payload $condition ('lifecycle helper: ' + $message) }
        $root = 'C:\Users\x\AppData\Local\Programs\ChatMCP'
        $ExpectedCandidateVersion = '3.11.0'
        $vector = Update-Arguments -WaitPid '4242' -Relaunch $true -ResultFile 'C:\r\x.json'
        Assert-Payload (($vector -join '|') -ceq '--quiet|--update|--install-dir|"C:\Users\x\AppData\Local\Programs\ChatMCP"|--wait-pid|4242|--relaunch|--result|"C:\r\x.json"') 'the update arguments of the lifecycle script are vector 1 of the contract, with the paths quoted for Start-Process'
        Assert-Payload (((Update-Arguments) -join '|') -ceq '--quiet|--update|--install-dir|"C:\Users\x\AppData\Local\Programs\ChatMCP"') 'and the wait, the relaunch and the result file are only there when asked for'
        $refusal = '{"format":1,"ok":false,"version":"3.11.0","previous":"3.10.2","state":"unchanged","reason":"not_newer","rolledBack":false}' | ConvertFrom-Json
        Assert-UpdateResult $refusal $false 'unchanged' 'not_newer' '3.10.2' 'a refusal as the setup writes it is accepted'
        $success = '{"format":1,"ok":true,"version":"3.11.0","previous":"3.10.2","state":"installed","reason":null,"rolledBack":false}' | ConvertFrom-Json
        Assert-UpdateResult $success $true 'installed' $null '3.10.2' 'a success has no reason'
        Assert-Rejected { Assert-UpdateResult $refusal $false 'unchanged' 'foreign_listener' '3.10.2' 'x' } 'FAIL' 'the helper refuses another reason'
        Assert-Rejected { Assert-UpdateResult $refusal $true 'unchanged' 'not_newer' '3.10.2' 'x' } 'FAIL' 'and another ok'
        Assert-Rejected { Assert-UpdateResult $refusal $false 'unchanged' 'not_newer' '3.9.0' 'x' } 'FAIL' 'and another previous version'
        Assert-Rejected { Assert-UpdateResult $success $true 'installed' 'oops' '3.10.2' 'x' } 'FAIL' 'and a reason on a success'
        Assert-Rejected { Assert-UpdateResult $refusal $false 'rolled_back' 'not_newer' '3.10.2' 'x' } 'FAIL' 'and a rollback flag that does not agree with the state'
        # The recovery of an installation behind the marker of an update that stopped halfway ("needs recovery"): the lifecycle script makes one the way installer/InstallTransaction.cs leaves it and runs the
        # block of the setup guide on it, on a disposable runner. Both are tried here, in a scratch folder and with the real Windows PowerShell, and the journal is held to the fields of the record the installer writes.
        $guide = Join-Path $scriptDir '..\..\docs\WINDOWS-SETUP.md'
        $retainedInstall = Join-Path $scratch 'retained-install'
        New-Item -ItemType Directory -Path $retainedInstall -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $retainedInstall 'replaced.txt'), 'REPLACED-ORIGINAL')
        [IO.File]::WriteAllText((Join-Path $retainedInstall 'removed.txt'), 'REMOVED-ORIGINAL')
        [IO.File]::WriteAllText((Join-Path $retainedInstall 'untouched.txt'), 'UNTOUCHED')
        $retainedBackups = New-RetainedUpdate -Install $retainedInstall -Replaced 'replaced.txt' -Removed 'removed.txt' -Created 'sub/created.txt'
        $retainedMarker = Join-Path $retainedInstall '.chatmcp-update-pending.json'
        $pending = Get-Content -LiteralPath $retainedMarker -Raw | ConvertFrom-Json
        Assert-Native (($pending.version -eq 1) -and ($pending.backupDirectory -eq $retainedBackups) -and ((Split-Path -Parent $retainedBackups) -eq $retainedInstall) -and ((Split-Path -Leaf $retainedBackups) -match '^\.ChatMCP-update-[0-9a-f]{32}$')) 'the marker names a backup folder of the installation, the way the installer writes it'
        $changeFields = @([regex]::Match([IO.File]::ReadAllText((Join-Path $scriptDir '..\..\installer\InstallTransaction.cs')), 'record Change\(([^)]*)\)').Groups[1].Value -split ',' | ForEach-Object { ($_.Trim() -split '\s+')[-1] })
        Assert-Native (($changeFields -join '|') -ceq 'Relative|Staged|NewHash|Backup|OldHash') 'premise: the installer writes its journal as records with these five fields'
        # (Windows PowerShell 5.1 hands a JSON array on as ONE object: it is unrolled here)
        $journal = @(Get-Content -LiteralPath (Join-Path $retainedBackups 'journal.json') -Raw | ConvertFrom-Json | ForEach-Object { $_ })
        Assert-Native (($journal.Count -eq 3) -and (@($journal | Where-Object { (($_.PSObject.Properties.Name) -join '|') -ceq ($changeFields -join '|') }).Count -eq 3)) 'the journal has one record for each file, with exactly the fields of the installer'
        Assert-Native (([IO.File]::ReadAllText((Join-Path $retainedInstall 'replaced.txt')) -ne 'REPLACED-ORIGINAL') -and -not (Test-Path -LiteralPath (Join-Path $retainedInstall 'removed.txt')) -and (Test-Path -LiteralPath (Join-Path $retainedInstall 'sub\created.txt'))) 'the installation is left as the half-done update left it: one file replaced, one removed, one created'
        $recoveryText = Get-RecoveryScript -Guide $guide -Install $retainedInstall
        Assert-Native ($recoveryText.Contains('$install = ''' + $retainedInstall + '''') -and -not $recoveryText.Contains('LOCALAPPDATA')) 'the block of the setup guide is pointed at that folder and at nothing else'
        $recoveryFile = Join-Path $scratch 'recover.ps1'
        [IO.File]::WriteAllText($recoveryFile, $recoveryText)
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $recoveryFile
        Assert-Native ($LASTEXITCODE -eq 0) 'the block runs to its end in Windows PowerShell'
        Assert-Native (([IO.File]::ReadAllText((Join-Path $retainedInstall 'replaced.txt')) -ceq 'REPLACED-ORIGINAL') -and ([IO.File]::ReadAllText((Join-Path $retainedInstall 'removed.txt')) -ceq 'REMOVED-ORIGINAL') -and -not (Test-Path -LiteralPath (Join-Path $retainedInstall 'sub\created.txt')) -and ([IO.File]::ReadAllText((Join-Path $retainedInstall 'untouched.txt')) -ceq 'UNTOUCHED')) 'it puts back the file that was replaced and the one that was removed, removes the one that was created, and leaves the rest'
        Assert-Native (-not (Test-Path -LiteralPath $retainedMarker) -and -not (Test-Path -LiteralPath $retainedBackups)) 'and the marker and the backup are gone, so the setup works again'
        Assert-Rejected { Get-RecoveryScript -Guide (Join-Path $scriptDir 'Test-InstallerPayload.ps1') -Install $retainedInstall } 'recovery-from-retained-backup' 'a guide without the block is an error and not an empty script'
        # and the scenario itself is in the lifecycle script, between the file in use (2) and the update that goes through (3)
        $lifecycleText = [IO.File]::ReadAllText($lifecycle)
        $first = $lifecycleText.IndexOf('# 2. A file in use'); $recover = $lifecycleText.IndexOf('# 2b.'); $second = $lifecycleText.IndexOf('# 3. The update that goes through')
        Assert-Native (($first -gt 0) -and ($recover -gt $first) -and ($second -gt $recover)) 'the lifecycle script has the scenario of an installation behind the marker, between the file in use and the update that goes through'
        $scenario = $lifecycleText.Substring($recover, $second - $recover)
        Assert-Native ($scenario.Contains('New-RetainedUpdate -Install $root') -and $scenario.Contains('Get-RecoveryScript -Guide') -and $scenario.Contains('WINDOWS-SETUP.md') -and $scenario.Contains('Start-InstallerUpdate') -and $scenario.Contains('Quiet-Install') -and ([regex]::Matches($scenario, '\[recovery\]').Count -ge 8)) 'and it makes the retained update, has the real setup refuse it (the update form and the quiet one), runs the block of the guide, and checks the result'
    }
    Write-Host "PASS: Installer payload regression ($count passed, 0 failed, 0 skipped)"
} finally {
    $resolved = [IO.Path]::GetFullPath($scratch).TrimEnd('\', '/')
    if ([IO.Path]::GetDirectoryName($resolved) -ne $scratchRoot -or [IO.Path]::GetFileName($resolved) -notmatch '^ChatMCP-Payload-Test-[0-9a-f]{32}$') { throw 'Unsafe regression cleanup path.' }
    Assert-InstallerNoReparsePath -Path $resolved
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
