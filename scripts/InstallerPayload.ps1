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
    $raw = Invoke-InstallerGitRead -Git $git.Path -Root $root -Arguments 'ls-files --stage -z -- assets CHATMCP-HUB scripts START-CHATMCP-DESKTOP.cmd'
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
            $relative -match '^CHATMCP-HUB/(lib|workers|extension|windows)/' -or
            ($relative -match '^CHATMCP-HUB/web/' -and $relative -notmatch '^CHATMCP-HUB/web/dist/') -or
            $relative -match '^CHATMCP-HUB/(hub\.mjs|package\.json|README\.md|THIRD-PARTY-NOTICES\.txt|Start-ChatMcpHub\.ps1|Stop-ChatMcpHub\.ps1|START-CHATMCP-HUB\.cmd|STOP-CHATMCP-HUB\.cmd)$'
        # Native helper is published as a pinned self-contained runtime. Never ship its
        # tracked development source, generated obj/bin or raw fixture helpers.
        if ($relative -match '^CHATMCP-HUB/windows/sandbox/GuestSupervisor/' -or
            $relative -match '(^|/)(bin|obj|publish)/') { continue }
        if (-not $include -or $relative -match '(^|/)(tests|test-results|node_modules|\.git)/' -or
            $relative -match '^CHATMCP-HUB/windows/(Test-|Run-StudioSmoke|Run-StudioSoak)') { continue }
        if ($mode -notin @('100644', '100755') -or $stage -ne '0') { throw "Installer source must be a regular, resolved Git file: $relative" }
        if ($relative -match '(^|/)\.\.?(/|$)|[:\\]' -or $relative.StartsWith('/')) { throw "Unsafe installer source path: $relative" }
        $source = [IO.Path]::GetFullPath((Join-Path $root $relative))
        if (-not $source.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Source escaped checkout: $relative" }
        Assert-InstallerNoReparsePath -Path $source
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Tracked runtime file is missing: $relative" }
        $files.Add([pscustomobject]@{ RelativePath = $relative; Source = $source })
    }

    # Vite empties this directory immediately before building. Its new hashed
    # assets are intentionally not required to be tracked yet; old tracked
    # hashes must never be resurrected from the Git index.
    $uiRoot = Join-Path $root 'CHATMCP-HUB\web\dist'
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
    foreach ($required in @('CHATMCP-HUB/hub.mjs', 'CHATMCP-HUB/package.json', 'START-CHATMCP-DESKTOP.cmd', 'scripts/Start-DesktopApp.ps1')) {
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
