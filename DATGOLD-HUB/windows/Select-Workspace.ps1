#requires -Version 5.1
<#
Native Windows folder picker, launched by the hub with powershell.exe -STA.
Stdout is exactly one UTF-8 JSON object: {"path":"..."} or {"path":null}.
Cancellation is successful (exit 0). An error writes a short stderr message
and returns {"path":null} with exit 1. No selected directory is modified.
#>
[CmdletBinding()]
param([string]$InitialPath, [switch]$Probe)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$pickedPath = $null
$pickerExitCode = 0
$dialog = $null
$ownerWindow = $null

try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
    if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne [System.Threading.ApartmentState]::STA) {
        throw 'STA_REQUIRED'
    }

    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'DatGold - Select the folder to use as your local workspace'
    $dialog.ShowNewFolderButton = $true
    if ($dialog.PSObject.Properties.Name -contains 'AutoUpgradeEnabled') {
        $dialog.AutoUpgradeEnabled = $true
    }
    # Leave RootFolder at Desktop to avoid unsupported shell namespace roots
    # on Windows versions with a different legacy FolderBrowserDialog.
    if (-not [string]::IsNullOrWhiteSpace($InitialPath) -and (Test-Path -LiteralPath $InitialPath -PathType Container)) {
        $initialResolved = Resolve-Path -LiteralPath $InitialPath
        if ($initialResolved.Provider.Name -eq 'FileSystem') {
            $dialog.SelectedPath = $initialResolved.ProviderPath
        }
    }

    # -Probe validates UTF-8, STA and the native folder dialog constructor
    # without opening a GUI; used by Windows CI smoke tests.
    if ($Probe) {
        $probeOk = $true
    }
    else {
    # Use a topmost native owner so the chooser opens above WebView2 desktop.
    # The parent PowerShell process MUST NOT be launched with windowsHide:true.
    $ownerWindow = New-Object System.Windows.Forms.Form
    $ownerWindow.ShowInTaskbar = $false
    $ownerWindow.TopMost = $true
    $ownerWindow.Opacity = 0.01
    $ownerWindow.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $ownerWindow.Size = New-Object -TypeName System.Drawing.Size -ArgumentList 1, 1
    $ownerWindow.Show()
    $ownerWindow.Activate()
    $selection = $dialog.ShowDialog($ownerWindow)
    if ($selection -eq [System.Windows.Forms.DialogResult]::OK) {
        $selected = Resolve-Path -LiteralPath $dialog.SelectedPath
        if ($selected.Provider.Name -ne 'FileSystem' -or -not (Test-Path -LiteralPath $selected.ProviderPath -PathType Container)) {
            throw 'SELECTED_FOLDER_UNAVAILABLE'
        }
        $pickedPath = $selected.ProviderPath
    }
    }
}
catch {
    $pickerExitCode = 1
    [Console]::Error.WriteLine('[CHATMCP-HUB] Folder picker failed: ' + $_.Exception.GetType().Name)
}
finally {
    if ($null -ne $dialog) { $dialog.Dispose() }
    if ($null -ne $ownerWindow) { $ownerWindow.Dispose() }
}

[Console]::Out.WriteLine(([pscustomobject]@{ path = $pickedPath; probe = [bool]$Probe } | ConvertTo-Json -Compress))
exit $pickerExitCode
