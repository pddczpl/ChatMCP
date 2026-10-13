# G6 clean Windows installer lifecycle

The repeatable harness is `scripts/tests/Test-CleanWindowsInstall.ps1`. It uses a
fresh Windows Sandbox and drives the real setup/uninstall wizard, installed
`ChatMCP.exe`, its WebView2 renderer and its bundled Node executable. It does not
install, remove, enable Windows features, or reboot anything on the host.

## Run

Supply a retained baseline installer, a newly built candidate, and Microsoft's
[Evergreen standalone x64 WebView2 installer](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).
The harness requires a valid Microsoft Corporation Authenticode signature for the
WebView2 installer. WebView2 is an existing documented runtime prerequisite;
Node, npm, .NET SDK/runtime and Git are not installed into the guest. Both ChatMCP
executables are self-contained and the app uses its own portable Node.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\tests\Test-CleanWindowsInstall.ps1 `
  -BaselineInstaller C:\TestArtifacts\BaselineSetup.exe `
  -CandidateInstaller .\dist\ChatMCPSetup.exe `
  -WebView2Prerequisite C:\TestArtifacts\MicrosoftEdgeWebView2RuntimeInstallerX64.exe `
  -OutputDirectory .\.tmp\g6-clean-windows-run
```

The output directory must be new. Existing Sandbox instances cause refusal,
never termination. The harness requests a fresh UUID, verifies the returned ID,
and stops only that owned ID in `finally`. Networking and clipboard redirection
are disabled. Input binaries/scripts are mapped read-only; only the dedicated
evidence folder is writable. The native windows are moved off screen inside the
guest. No AI calls or credentials are needed. WebView2 remote debugging is
enabled only for `ChatMCP.exe` inside the disposable guest through the documented
HKLM policy, then removed after each launch. WebView2 150+ ignores environment
debugging flags for elevated processes, including the Sandbox desktop account;
this test account is separate from G4's restricted child-token security test.

## Acceptance evidence

- No previous ChatMCP installation, app state, node, npm, dotnet or Git on PATH.
- Real baseline setup wizard completes; runtime layout, hashes, shortcuts and
  Windows Installed Apps entry are checked.
- The installed desktop launches the installed Hub using bundled Node; the
  native WebView2 renders React and fresh onboarding. Its real API saves a BYO
  model profile with no key and selects a new empty workspace without Git.
- A different candidate setup artifact installs over the baseline. Actual model
  settings remain byte-identical; WebView2 onboarding preferences and workspace
  selection survive and are observed in the relaunched desktop.
- The candidate's installed preflight reports unavailable OS isolation when the
  clean guest has no Windows Sandbox prerequisite. Nothing enables the feature
  or forces a restart.
- Real uninstall removes all unchanged payload files, its executable, owned
  shortcuts and registry registration. User settings, WebView2 profile, and
  unrelated files inside/outside the installation and Start Menu remain.
- Desktop shutdown leaves no owned Hub child. Host evidence confirms cleanup of
  the owned Sandbox.
- A separately labeled manifest-aware maintenance fixture checks removal of
  unchanged obsolete assets, preservation of modified obsolete assets, and that
  replacing an `Uninstall.exe` hardlink does not alter its unrelated target.

`evidence/lifecycle-report.json` records every check and exact installer hashes;
`host-run.json` records source commit, dirty state, OS, owned UUID, guest exit code
and cleanup. `baseline-desktop.json`, `upgrade-desktop.json` and their PNGs are
observations from the actual installed renderer. The test exits nonzero for any
missing or failed gate.

## Installer fix

Previously uninstall recursively deleted every file beneath the installation
directory and the whole ChatMCP Start Menu folder, and terminated every process
named ChatMCP. The installer now records a SHA-256 manifest of its own payload.
Uninstall validates bounded paths, refuses junctions/symlinks and removes only
unchanged owned files. It preserves user-created and modified files, targets only
the installed executable and verifies shortcut targets/registry location.
The running uninstaller schedules deletion of only its own unchanged executable
after it exits. Payload files are replaced atomically to avoid writing through
hardlinks; fresh installations refuse unrelated filename collisions. Existing
manifests also allow removal of unchanged obsolete files during upgrades.
A missing uninstall manifest fails closed with a reinstall instruction.

## Scope

A same-version baseline-to-candidate run proves in-place replacement and data
retention for those two hashes. It does not prove migration from every historic
release, Windows 10 support, ARM64, code signing, or G4 publisher authenticity.
Legacy releases without an ownership manifest cannot safely classify arbitrary
old-only files. The harness captures the actual baseline's file inventory and
requires that inventory to be removed too; this is observation of the specific
tested legacy artifact, not a fabricated ownership manifest or a blanket
guarantee for older installers with different assets.
No merge, tag or release is implied by G6 passing.
