#requires -Version 5.1
# Shared by the installer builder and its disposable-repository regression test.
Set-StrictMode -Version 2.0

function Invoke-InstallerGitRead {
    param([string]$Git, [string]$Root, [string]$Arguments)
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Git
    # Windows path names cannot contain double quotes; Root has no trailing slash.
    $start.Arguments = '-C "' + $Root + '" ' + $Arguments
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $start.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        $null = $process.Start()
        $output = $process.StandardOutput.ReadToEnd()
        $errorText = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw "Cannot enumerate installer Git source: $errorText" }
        return $output
    } finally { $process.Dispose() }
}

# A step of the build that runs a long program (dotnet publish): it shows nothing when it works, and when it fails it puts the last lines of what the program printed in the error. The publish lines used
# to throw everything away behind "| Out-Null", so a failed publish said only "Desktop publish failed with exit code 1" and the cause (MSBuild prints its errors on the standard output) was lost.
# Only the standard output is kept: the error output of the program reaches the console as it always did, and is not turned into error records (Windows PowerShell 5.1 would stop the build at the first
# line of it under $ErrorActionPreference = 'Stop'). The command is a script block so that the line that runs the program stays as written in the builder, argument by argument.
function Invoke-InstallerBuildStep {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Command,
        [Parameter(Mandatory = $true)][string]$Description,
        [int]$TailLines = 40
    )
    $global:LASTEXITCODE = 0
    $tail = @(& $Command | Select-Object -Last $TailLines)
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        $shown = if ($tail.Count -gt 0) { " The last $($tail.Count) lines of what it printed:`n" + ($tail -join "`n") } else { ' It printed nothing on its standard output.' }
        # (an error record with an id of its own, thrown as it is: Windows PowerShell 5.1 makes the message of a thrown string or exception the FullyQualifiedErrorId of the error as well and prints the forty lines
        # twice; and it ends the script whatever $ErrorActionPreference is, which the method that ends only the statement does not under 'Continue')
        $record = [System.Management.Automation.ErrorRecord]::new([System.InvalidOperationException]::new("$Description failed with exit code $code.$shown"), 'InstallerBuildStepFailed', [System.Management.Automation.ErrorCategory]::OperationStopped, $Description)
        throw $record
    }
}

function Assert-InstallerNoReparsePath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Installer payload refuses a symlink or junction: $current"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

# For a TEST build only (Build-Installer.ps1 -ReleaseKeysFile): the full path of a key list that the desktop shell is built with and that the Hub the installer installs reads, so that the
# end-to-end test of the updater can build two versions that trust a key made for the run. A release is built from the committed DATGOLD-HUB\lib\release-keys.json and from nothing else, so a
# publish workflow refuses it. What is checked is the FILE: where it is, that nothing on its way is a link, that it is small, and that it holds an entry that says use "release" with a key of the
# size of a P-256 SubjectPublicKeyInfo (91 bytes, 124 characters of base64). The shell and the Hub read the keys themselves, strictly (native-shared/UpdatePackage.cs, lib/release-signature.mjs).
function Resolve-InstallerReleaseKeysFile {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    if ($env:GITHUB_WORKFLOW -like 'Publish*') { throw 'A release is built from the committed DATGOLD-HUB\lib\release-keys.json and from nothing else: -ReleaseKeysFile is for test builds.' }
    if ($Path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)') { throw "-ReleaseKeysFile must be a full path: $Path" }
    $full = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "-ReleaseKeysFile is not a file: $full" }
    Assert-InstallerNoReparsePath -Path $full
    $length = (Get-Item -LiteralPath $full -Force).Length
    if ($length -lt 2 -or $length -gt 16384) { throw "-ReleaseKeysFile must hold between 2 bytes and 16 KiB: $full" }
    try { $document = [IO.File]::ReadAllText($full) | ConvertFrom-Json } catch { throw "-ReleaseKeysFile is not JSON: $full" }
    $entries = @()
    if ($null -ne $document -and $null -ne $document.PSObject.Properties['keys']) { $entries = @($document.keys) }
    $releaseKeys = @($entries | Where-Object {
        $null -ne $_ -and $null -ne $_.PSObject.Properties['use'] -and $_.use -ceq 'release' -and
        $null -ne $_.PSObject.Properties['spki'] -and $_.spki -is [string] -and $_.spki -cmatch '^[A-Za-z0-9+/]{122}==$'
    })
    if ($releaseKeys.Count -lt 1) { throw "-ReleaseKeysFile holds no release key (an entry that says use ""release"" with a 91-byte public key): $full" }
    return $full
}

# A value that goes on the command line of MSBuild as a property (-p:Name=value). MSBuild splits it at ';' and ',', and reads '%' and the other characters of its syntax as the start of an escape, so a
# repository in C:\My Repos, Inc\ or in C:\a;b\ failed every build with "MSB1006: Property is not valid" once the key list was named on each of them. Each such character is written as %XX (the percent sign
# first), which MSBuild turns back into the character when the value is used.
function ConvertTo-InstallerMsbuildValue {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
    $escaped = $Value.Replace('%', '%25')
    foreach ($pair in @(@('*', '%2A'), @('?', '%3F'), @('@', '%40'), @('$', '%24'), @('(', '%28'), @(')', '%29'), @(';', '%3B'), @("'", '%27'), @(',', '%2C'))) { $escaped = $escaped.Replace($pair[0], $pair[1]) }
    return $escaped
}

# The build does not believe how it asked for the key list, it PROVES what it made. MSBuild reads an environment variable called ReleaseKeysFile as a property, so in a publish workflow one that is
# set is refused outright (a release is built from the committed file and from nothing else); in any other workflow it changes nothing the proofs below would not see.
function Assert-InstallerNoAmbientReleaseKeysFile {
    [CmdletBinding()]
    param()
    if ($env:GITHUB_WORKFLOW -like 'Publish*' -and -not [string]::IsNullOrEmpty($env:ReleaseKeysFile)) {
        throw 'A release is built from the committed DATGOLD-HUB\lib\release-keys.json and from nothing else: the environment variable ReleaseKeysFile is set in this publish workflow, and MSBuild would read it as a property. Remove it.'
    }
}

# Whether the bytes are somewhere in the file. A program is 100 MB, so it is read in blocks and never held whole; the last bytes of a block are carried into the next one, so that a match that a block
# ends in the middle of is still found. A byte is a character of the Latin-1 text of the block (one to one), and the search is an ordinal one.
function Test-InstallerFileContains {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Needle,
        [int]$BlockSize = 8388608
    )
    if ($Needle.Length -lt 1) { throw 'Test-InstallerFileContains: there is nothing to look for (an empty list of bytes is in every file).' }
    if ($BlockSize -lt 1) { throw 'Test-InstallerFileContains: a block holds at least one byte.' }
    $latin1 = [Text.Encoding]::GetEncoding(28591)
    $needleText = $latin1.GetString($Needle)
    $carried = $Needle.Length - 1
    $buffer = New-Object byte[] ($carried + $BlockSize)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $held = 0
        while ($true) {
            $read = $stream.Read($buffer, $held, $BlockSize)
            if ($read -le 0) { return $false }
            $length = $held + $read
            if ($latin1.GetString($buffer, 0, $length).IndexOf($needleText, [StringComparison]::Ordinal) -ge 0) { return $true }
            $held = [Math]::Min($carried, $length)
            [Array]::Copy($buffer, $length - $held, $buffer, 0, $held)
        }
    } finally { $stream.Dispose() }
}

# The desktop shell carries its key list as an embedded resource, which is the file byte for byte. So the program that was published must hold the exact bytes of the list the build meant to give it:
# the committed DATGOLD-HUB\lib\release-keys.json, or the one a TEST build named. A program that holds anything else would trust other keys than the build says.
# What is proved is that these bytes OCCUR in the published program, which is what an embedded resource of that file looks like; that the resource IS those bytes is not proved (the same bytes held elsewhere
# in the program, a string or a second resource, would pass too). The project embeds the list one way only, and the shell reads it from there; docs/THREAT-MODEL.md U23 says the same.
function Assert-InstallerReleaseKeysBuiltIn {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Executable, [Parameter(Mandatory = $true)][string]$KeysFile)
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "The program that should carry the key list is not a file: $Executable" }
    if (-not (Test-Path -LiteralPath $KeysFile -PathType Leaf)) { throw "The key list that was meant to be built in is not a file: $KeysFile" }
    $keys = [IO.File]::ReadAllBytes($KeysFile)
    if ($keys.Length -lt 1) { throw "The key list that was meant to be built in is empty: $KeysFile" }
    if (-not (Test-InstallerFileContains -Path $Executable -Needle $keys)) {
        throw "$Executable does not carry the key list that was meant to be built into it ($KeysFile): the program would trust other keys than this build says."
    }
}

# The Hub reads its keys from the installed files: the copy in the payload must be the list the shell was built with.
function Assert-InstallerReleaseKeysShipped {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$PayloadDirectory, [Parameter(Mandatory = $true)][string]$KeysFile)
    $shipped = Join-Path $PayloadDirectory 'CHATMCP-HUB\lib\release-keys.json'
    if (-not (Test-Path -LiteralPath $shipped -PathType Leaf)) { throw "The Hub of the payload has no key list, it is not a file: $shipped" }
    if (-not (Test-Path -LiteralPath $KeysFile -PathType Leaf)) { throw "The key list that was meant to be shipped is not a file: $KeysFile" }
    if ((Get-FileHash -LiteralPath $shipped -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $KeysFile -Algorithm SHA256).Hash) {
        throw "The key list in the payload is not the key list this build was meant to carry ($KeysFile): the Hub would trust other keys than the shell."
    }
}

# The folder of the Hub is DATGOLD-HUB in the repository and stays CHATMCP-HUB in the installation: the shell, the installer, the updater and every installation that an earlier
# version made look for the Hub there. So the payload keeps the name, and this is the one place that maps the one to the other.
function ConvertTo-InstallerPayloadPath {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$RepositoryRelativePath)
    if ($RepositoryRelativePath.StartsWith('DATGOLD-HUB/', [StringComparison]::Ordinal)) { return 'CHATMCP-HUB/' + $RepositoryRelativePath.Substring('DATGOLD-HUB/'.Length) }
    return $RepositoryRelativePath
}

function Get-InstallerPayloadFiles {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)
    $root = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\', '/')
    Assert-InstallerNoReparsePath -Path $root
    $git = Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $top = (Invoke-InstallerGitRead -Git $git.Path -Root $root -Arguments 'rev-parse --show-toplevel').Trim()
    if ([IO.Path]::GetFullPath($top).TrimEnd('\', '/') -ne $root) {
        throw 'Installer source must be the root of its Git checkout.'
    }
    # NUL records preserve spaces and Unicode without relying on Git quotePath.
    $raw = Invoke-InstallerGitRead -Git $git.Path -Root $root -Arguments 'ls-files --stage -z -- assets DATGOLD-HUB scripts START-CHATMCP-DESKTOP.cmd LICENSE NOTICE THIRD-PARTY-NOTICES.md'
    $files = New-Object 'System.Collections.Generic.List[object]'
    foreach ($record in $raw.Split([char]0)) {
        if (-not $record) { continue }
        if ($record -notmatch '^([0-9]{6}) [0-9a-f]+ ([0-3])\t([^\r\n\t]+)$') { throw 'Unexpected Git index record.' }
        $mode = $Matches[1]; $stage = $Matches[2]; $relative = $Matches[3]
        # Only runtime sources are shipped. Personal state, imported skills,
        # test output, build helpers and UI development dependencies stay out.
        $include = $relative -match '^assets/' -or
            $relative -match '^scripts/(Start-DesktopApp|install-desktop|uninstall-desktop)\.ps1$' -or
            $relative -eq 'START-CHATMCP-DESKTOP.cmd' -or
            $relative -match '^(LICENSE|NOTICE|THIRD-PARTY-NOTICES\.md)$' -or
            $relative -match '^DATGOLD-HUB/(lib|workers|extension|windows)/' -or
            ($relative -match '^DATGOLD-HUB/web/' -and $relative -notmatch '^DATGOLD-HUB/web/dist/') -or
            $relative -match '^DATGOLD-HUB/(hub\.mjs|package\.json|README\.md|THIRD-PARTY-NOTICES\.txt|Start-ChatMcpHub\.ps1|Stop-ChatMcpHub\.ps1|START-CHATMCP-HUB\.cmd|STOP-CHATMCP-HUB\.cmd)$'
        # Native helper is published as a pinned self-contained runtime. Never ship its
        # tracked development source, generated obj/bin or raw fixture helpers.
        if ($relative -match '^DATGOLD-HUB/windows/sandbox/GuestSupervisor/' -or
            $relative -match '(^|/)(bin|obj|publish)/') { continue }
        if (-not $include -or $relative -match '(^|/)(tests|test-results|node_modules|\.git)/' -or
            $relative -match '^DATGOLD-HUB/windows/(Test-|Run-StudioSmoke|Run-StudioSoak)') { continue }
        if ($mode -notin @('100644', '100755') -or $stage -ne '0') { throw "Installer source must be a regular, resolved Git file: $relative" }
        if ($relative -match '(^|/)\.\.?(/|$)|[:\\]' -or $relative.StartsWith('/')) { throw "Unsafe installer source path: $relative" }
        $source = [IO.Path]::GetFullPath((Join-Path $root $relative))
        if (-not $source.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Source escaped checkout: $relative" }
        Assert-InstallerNoReparsePath -Path $source
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Tracked runtime file is missing: $relative" }
        $files.Add([pscustomobject]@{ RelativePath = (ConvertTo-InstallerPayloadPath -RepositoryRelativePath $relative); Source = $source })
    }

    # Vite empties this directory immediately before building. Its new hashed
    # assets are intentionally not required to be tracked yet; old tracked
    # hashes must never be resurrected from the Git index.
    $uiRoot = Join-Path $root 'DATGOLD-HUB\web\dist'
    Assert-InstallerNoReparsePath -Path $uiRoot
    if (-not (Test-Path -LiteralPath (Join-Path $uiRoot 'index.html') -PathType Leaf)) { throw 'Fresh React build is missing index.html.' }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($uiRoot)
    while ($pending.Count -gt 0) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            Assert-InstallerNoReparsePath -Path $item.FullName
            if ($item.PSIsContainer) { $pending.Push($item.FullName); continue }
            $relativeUi = $item.FullName.Substring($uiRoot.Length + 1).Replace('\', '/')
            if ($relativeUi -ne 'index.html' -and $relativeUi -notmatch '^assets/[^/]+\.(js|css|woff2?|ttf|otf|png|jpe?g|svg|gif|webp|ico)$') {
                throw "Unexpected file in generated React output: $relativeUi"
            }
            $files.Add([pscustomobject]@{ RelativePath = 'CHATMCP-HUB/web/dist/' + $relativeUi; Source = $item.FullName })
        }
    }
    # Apache-2.0 section 4(a): recipients of a redistributed copy must receive the license (and NOTICE). The third-party notices
    # travel with them: the components that ChatMCP redistributes are not covered by that license.
    foreach ($required in @('CHATMCP-HUB/hub.mjs', 'CHATMCP-HUB/package.json', 'START-CHATMCP-DESKTOP.cmd', 'scripts/Start-DesktopApp.ps1', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md')) {
        if (-not ($files | Where-Object { $_.RelativePath -eq $required })) { throw "Required runtime source is not tracked: $required" }
    }
    return $files.ToArray()
}

function Copy-InstallerSourcePayload {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    $targetRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')
    Assert-InstallerNoReparsePath -Path $targetRoot
    $files = @(Get-InstallerPayloadFiles -RepositoryRoot $RepositoryRoot)
    foreach ($file in $files) {
        $target = [IO.Path]::GetFullPath((Join-Path $targetRoot $file.RelativePath))
        if (-not $target.StartsWith($targetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer destination escaped staging.' }
        Assert-InstallerNoReparsePath -Path $target
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
        Copy-Item -LiteralPath $file.Source -Destination $target -Force
    }
}

function Copy-InstallerNodeLicense {
    # node.exe is redistributed. Node.js is MIT, but the binary contains V8, OpenSSL, ICU, zlib and others whose notices Node.js
    # collects in the LICENSE file of each official release archive. That file must travel with node.exe (docs/LICENSE-SCAN.md, finding 1).
    # A Node.js installed by the MSI has no LICENSE beside node.exe; the official ZIP of the same version does (setup-node uses it).
    # Override: CHATMCP_NODE_LICENSE_FILE names a LICENSE file taken from the ZIP archive of the Node.js version being packaged.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$NodeExecutable,
        [Parameter(Mandatory = $true)][string]$Destination,
        [string]$SuppliedLicense = $env:CHATMCP_NODE_LICENSE_FILE
    )
    if ($SuppliedLicense) {
        if (-not (Test-Path -LiteralPath $SuppliedLicense -PathType Leaf)) { throw 'CHATMCP_NODE_LICENSE_FILE does not name an existing file.' }
        $source = $SuppliedLicense
    } else {
        $source = Join-Path (Split-Path -Parent $NodeExecutable) 'LICENSE'
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw 'No Node.js LICENSE file beside node.exe. Build with the Node.js ZIP distribution (it carries LICENSE), or set CHATMCP_NODE_LICENSE_FILE to the LICENSE of the same Node.js version; the bundled node.exe may not be redistributed without it.'
        }
    }
    $text = [IO.File]::ReadAllText($source)
    if ($text.Length -lt 1024 -or $text -notmatch 'Node\.js' -or $text -notmatch 'Permission is hereby granted') {
        throw 'The Node.js LICENSE file is empty or is not the Node.js licence text; refusing to package node.exe without it.'
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination (Join-Path $Destination 'LICENSE') -Force
}

function Assert-InstallerRipgrepNotices {
    # rg.exe is linked with PCRE2, with Rust crates and with the Rust standard library, whose license texts are not in the ripgrep archive. They are vendored in
    # scripts/intelligence-runtime/licenses/ripgrep, stage.mjs stages them as licenses/ripgrep and the licenses folder travels into the payload.
    # This refuses a payload in which the inventory (MANIFEST.json) or a text that it lists is missing or empty, or which does not list PCRE2.
    # The hashes are compared by verify.mjs; this is the check of the payload tree itself.
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$HubRoot)
    $directory = Join-Path $HubRoot 'licenses\ripgrep'
    $inventory = Join-Path $directory 'MANIFEST.json'
    if (-not (Test-Path -LiteralPath $inventory -PathType Leaf)) {
        throw 'The payload has no licenses\ripgrep\MANIFEST.json: the notices of PCRE2, of the Rust standard library and of the Rust crates linked into rg.exe are required.'
    }
    $manifest = [IO.File]::ReadAllText($inventory) | ConvertFrom-Json
    $names = @($manifest.components | ForEach-Object { [string]$_.name })
    # case-sensitive: the Rust crate pcre2 (the binding) is not PCRE2 (the C library)
    if ($names -cnotcontains 'PCRE2') { throw 'The ripgrep notice inventory does not list PCRE2, which rg.exe is built with.' }
    foreach ($component in @($manifest.components)) {
        $files = @($component.files)
        if ($files.Count -eq 0) { throw ('The ripgrep notice inventory lists no license text for ' + $component.id + '.') }
        foreach ($file in $files) {
            $relative = [string]$file.path
            if ($relative -notmatch '^[A-Za-z0-9_.+-]+/[A-Za-z0-9_.+-]+$' -or $relative -match '(^|/)\.+(/|$)') { throw ('Unsafe ripgrep notice path in the inventory: ' + $relative) }
            $text = Join-Path $directory $relative.Replace('/', '\')
            if (-not (Test-Path -LiteralPath $text -PathType Leaf) -or (Get-Item -LiteralPath $text).Length -eq 0) { throw ('Missing or empty ripgrep notice: ' + $relative) }
        }
    }
}

function Copy-InstallerDesktopPayload {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$PublishDirectory,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    $publish = [IO.Path]::GetFullPath($PublishDirectory)
    Assert-InstallerNoReparsePath -Path $publish
    foreach ($name in @('ChatMCP.exe', 'WebView2Loader.dll')) {
        $file = Join-Path $publish $name
        Assert-InstallerNoReparsePath -Path $file
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -eq 0) {
            throw "Required desktop publish file is missing or empty: $name"
        }
    }
    # Refuse an x86/ARM loader in the x64 installer, even if a stale file has the
    # expected name. The PE machine header is read without executing the DLL.
    $loader = Join-Path $publish 'WebView2Loader.dll'
    $stream = [IO.File]::OpenRead($loader)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5a4d) { throw 'WebView2Loader.dll is not a valid x64 PE file.' }
        $stream.Position = 0x3c
        $pe = $reader.ReadInt32()
        if ($pe -lt 64 -or $pe -gt $stream.Length - 6) { throw 'WebView2Loader.dll has an invalid PE header.' }
        $stream.Position = $pe
        if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'WebView2Loader.dll must target x64.' }
    } finally { $reader.Dispose(); $stream.Dispose() }
    $target = [IO.Path]::GetFullPath($Destination)
    Assert-InstallerNoReparsePath -Path $target
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    foreach ($name in @('ChatMCP.exe', 'WebView2Loader.dll', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll')) {
        $source = Join-Path $publish $name
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Assert-InstallerNoReparsePath -Path $source
            Assert-InstallerNoReparsePath -Path (Join-Path $target $name)
            Copy-Item -LiteralPath $source -Destination (Join-Path $target $name) -Force
        }
    }
}

function Remove-InstallerStagingDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$StagingDirectory,
        [Parameter(Mandatory = $true)][string]$TemporaryRoot
    )
    $tempRoot = [IO.Path]::GetFullPath($TemporaryRoot).TrimEnd('\', '/')
    $target = [IO.Path]::GetFullPath($StagingDirectory).TrimEnd('\', '/')
    if ([IO.Path]::GetDirectoryName($target) -ne $tempRoot -or [IO.Path]::GetFileName($target) -notmatch '^ChatMCP-Staging-[0-9a-f]{32}$') {
        throw "Refusing unsafe installer staging cleanup: $target"
    }
    Assert-InstallerNoReparsePath -Path $target
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
