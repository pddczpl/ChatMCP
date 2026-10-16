#requires -Version 5.1
<#
Use a real Windows folder-selection dialog from a dedicated STA PowerShell.
Stdout is exactly one UTF-8 JSON object with "path": string|null.
Cancellation is a successful no-op. On failure, return exit 1 AND an actionable
stderr diagnostic (without printing the selected folder or credentials).
The -ValidateOnly and -SimulateFailure switches are for Windows CI; neither
opens a dialog or modifies the user's workspace.
#>
[CmdletBinding()]
param(
    [string]$InitialPath,
    [switch]$ValidateOnly,
    [switch]$SimulateFailure
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$pickedPath = $null
$exitCode = 0
$stage = 'initialization'
$dialog = $null
$ownerWindow = $null
$lastError = ''
$shell = $null

function Resolve-ExistingFolder([string]$candidate) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { return $null }
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { return $null }
    $resolved = Resolve-Path -LiteralPath $candidate -ErrorAction Stop
    if ($resolved.Provider.Name -ne 'FileSystem') { return $null }
    return [string]$resolved.ProviderPath
}

function Format-Error([System.Exception]$exception, [string]$where) {
    $message = [string]$exception.Message
    $message = ($message -replace '[\r\n]+', ' ').Trim()
    if ($message.Length -gt 250) { $message = $message.Substring(0, 250) + '...' }
    return ('{0}: {1}: {2}' -f $where, $exception.GetType().Name, $message)
}

try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
    if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne [System.Threading.ApartmentState]::STA) {
        throw 'STA_REQUIRED: Run PowerShell with -STA'
    }
    $stage = 'load Windows Forms'
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop

    $stage = 'initialize FolderBrowserDialog'
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'ChatMCP - Select a local workspace folder'
    $dialog.ShowNewFolderButton = $true
    # Some Windows/.NET hosts do not expose AutoUpgradeEnabled. Do not crash
    # when that optional property is absent.
    if ($null -ne $dialog.PSObject.Properties['AutoUpgradeEnabled']) {
        $dialog.AutoUpgradeEnabled = $true
    }
    $dialog.RootFolder = [System.Environment+SpecialFolder]::MyComputer
    $initial = Resolve-ExistingFolder $InitialPath
    if ($null -ne $initial) { $dialog.SelectedPath = $initial }

    if ($ValidateOnly) {
        # CI smoke-checks assembly loading and dialog construction but never
        # opens a GUI dialog on the Windows runner.
        $stage = 'validated'
    } elseif ($SimulateFailure) {
        $stage = 'simulated failure'
        throw 'SIMULATED_FOLDER_PICKER_FAILURE'
    } else {
        $stage = 'open Windows folder dialog'
        $selection = $null
        try {
            # A tiny topmost owner prevents the Explorer picker from opening
            # behind the ChatMCP window. The dialog itself is a normal Windows
            # native folder chooser and remains interactive.
            $ownerWindow = New-Object System.Windows.Forms.Form
            $ownerWindow.ShowInTaskbar = $false
            $ownerWindow.TopMost = $true
            $ownerWindow.Opacity = 0.01
            $ownerWindow.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
            $ownerWindow.Size = [System.Drawing.Size]::new(1, 1)
            $ownerWindow.Show()
            $ownerWindow.Activate()
            $selection = $dialog.ShowDialog($ownerWindow)
        } catch {
            $lastError = Format-Error $_.Exception 'owned FolderBrowserDialog'
            if ($null -ne $ownerWindow) {
                $ownerWindow.Dispose()
                $ownerWindow = $null
            }
            # A window-owner incompatibility should not make folder selection
            # unusable; fall back to the unowned standard dialog first.
            $stage = 'open unowned Windows folder dialog'
            $selection = $dialog.ShowDialog()
        }

        if ($selection -eq [System.Windows.Forms.DialogResult]::OK) {
            $stage = 'validate selected folder'
            $pickedPath = Resolve-ExistingFolder $dialog.SelectedPath
            if ($null -eq $pickedPath) { throw 'SELECTED_FOLDER_UNAVAILABLE' }
        }
        # Cancel always leaves $pickedPath = null and exits successfully.
    }
} catch {
    $primaryError = Format-Error $_.Exception $stage
    if (-not $ValidateOnly -and -not $SimulateFailure -and $stage -notin @('validate selected folder','initialization')) {
        # Native Shell COM is a fallback for WinForms/owner compatibility
        # problems on a real interactive Windows desktop. No extra binaries,
        # downloads, PowerShell modules, credentials or privileges are needed.
        try {
            $stage = 'Shell.Application folder dialog'
            $shell = New-Object -ComObject Shell.Application -ErrorAction Stop
            $folder = $shell.BrowseForFolder(0,
                'ChatMCP - Select a local workspace folder',
                0x41,
                0)
            if ($null -ne $folder) {
                $pickedPath = Resolve-ExistingFolder ([string]$folder.Self.Path)
                if ($null -eq $pickedPath) { throw 'SELECTED_FOLDER_UNAVAILABLE' }
            }
            $exitCode = 0
        } catch {
            $exitCode = 1
            $lastError = $primaryError + '; ' + (Format-Error $_.Exception $stage)
        } finally {
            if ($null -ne $shell) {
                try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null } catch {}
            }
        }
    } else {
        $exitCode = 1
        $lastError = $primaryError
    }
} finally {
    if ($null -ne $dialog) { $dialog.Dispose() }
    if ($null -ne $ownerWindow) { $ownerWindow.Dispose() }
}

if ($exitCode -ne 0) {
    [Console]::Error.WriteLine('[CHATMCP-HUB] Folder picker failed: ' + $lastError)
}
[Console]::Out.WriteLine(([pscustomobject]@{ path = $pickedPath } | ConvertTo-Json -Compress))
exit $exitCode
