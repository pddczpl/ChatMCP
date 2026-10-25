# DatGold v3.10.1 (test build) — fixes and notices after v3.10.0

This is the second **test build**, published as a *pre-release*: GitHub keeps showing v3.9.0 as the latest release. It is v3.10.0 plus what was merged after it (pull requests #53 to #60): three fixes, the license notices of the bundled `rg.exe`, and changes to tests and CI. It adds nothing that the application can do; the features are those of v3.10.0 (see its release notes), and it is meant to be installed and tried, not to be read as a stable release.

## What changed since v3.10.0

**PowerShell in the Hub.** A Hub started from a PowerShell 7 (`pwsh`) window used to hand the module path of PowerShell 7 to the Windows PowerShell that it starts, and Windows PowerShell then lost `Get-FileHash`, `New-Guid`, `New-TemporaryFile`, `Format-Hex`, `Import-PowerShellDataFile` and `ConvertFrom-SddlString` without any error at start. Every Windows PowerShell that the Hub starts now gets the module path of the machine: the command runner (every shell it starts on Windows, a `powershell.exe` started from `bash` included), background tasks, the terminal, the folder picker, the DPAPI helper, the Windows Sandbox probe and the launcher. Hooks that name `args` or `"shell": "cmd"` still get the environment as it is ([docs/HOOKS.md](docs/HOOKS.md)).

**Uninstaller.** Started from a PowerShell 7 window, the uninstaller used to leave `Uninstall.exe` in the install folder, because its self-delete helper lost `Get-FileHash` for the same reason. That helper and the Hub ownership query now start Windows PowerShell without `PSModulePath`.

**Agents that start together.** Two `git worktree add` at once on one repository can make Git fail, which left an agent `uncertain` and the agents that wait for it `blocked`. The worktrees of one repository are now made one at a time, so the checkouts of agents that start together run one after the other (8 agents on a tiny repository took about 0.7 s before and 1.5 s after; a large repository will be slower). The worktree tool of the studio and the coding orchestrator's own worktrees do not share this turn with the pool.

**Notices.** The installer now carries the license texts of what is compiled into `rg.exe`: PCRE2, 30 Rust crates and the Rust standard library, with an inventory that the installer build checks against the shipped binary (the version string of PCRE2, the source paths of the Rust toolchain, and that the binary imports no C runtime DLL). [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) also summarises the Microsoft C/C++ runtime terms that apply to the static C runtime in `rg.exe` and to `vcruntime140` in the CPython archive; it names what Microsoft publishes and says what is left open, and it is an inventory kept by the maintainers, not legal advice. The Tree-sitter grammar notices are listed as shipped.

**Tests and CI.** The narrow-window browser test no longer hangs on a late media-query event; the native lifecycle unit tests (65 checks) run in the pull request CI; a failing suite shows its whole assertion difference in the log.

## Upgrade

Download `ChatMCPSetup.exe` and its `.sha256` file from this release, compare the digest with `RELEASE-MANIFEST.json`, stop active tasks and install over v3.10.0 or v3.9.0. The installer keeps your settings and history. The Browser Companion is unchanged (version **1.5.2**).

The Hub's health version is `3.10.1` and the UI build identifier is `3.10.1-react-agent`. If you ran the uninstaller of v3.10.0 from a PowerShell 7 window and `Uninstall.exe` is still in the install folder, delete it by hand.

## What to try

- Install over v3.10.0: your connection and history should still be there.
- Start the Hub from a PowerShell 7 window and ask the agent to run a command that calls `Get-FileHash`.
- Run a workflow with several agents at once in a Git repository: none should end `uncertain`.
- Run the uninstaller from a PowerShell 7 window: `Uninstall.exe` should be gone afterwards.

## What is not verified

- The upgrade from v3.10.0 to v3.10.1 was not run by CI, which runs the upgrade from the published v3.9.0. `guest-lifecycle.ps1` (Windows Sandbox) was not run.
- **No test called a live provider**, as for v3.10.0. The part of the thinking-block work that needs a live Anthropic account (the `drop_block` beta header and the logging of input transformations) is not built.
- The installer is not Authenticode-signed and no signed-in Edge/ChatGPT session was tried; `RELEASE-MANIFEST.json` says so.

## How it was built

It is published by a copy of the v3.10.0 release workflow, which refuses to publish unless the full regression on the exact release commit, the installer build, the installed upgrade from the published v3.9.0, the WebView2 smoke test and the asset checksums have all passed. It does not claim equivalence with other coding agents. See [Security](SECURITY.md) and [the upgrade checkpoint](docs/UPGRADE-IMPLEMENTATION-STATUS.md).
