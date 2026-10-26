# Cài đặt DatGold trên Windows 10/11 (local-only)

Hub mặc định chạy trên **127.0.0.1:3007** dưới tài khoản Windows hiện tại. Docker, Cloud Harness, proxy MCP cũ, Render và public authentication **không còn là thành phần ứng dụng**.

## 1. Yêu cầu

| Thành phần | Mức độ |
| --- | --- |
| Windows 10/11 x64 | Bắt buộc cho native desktop |
| WebView2 Runtime | Bắt buộc để mở cửa sổ desktop |
| Git for Windows | Cần cho Git và parallel worktrees |
| Node.js 22.12+ | Cần khi chạy từ mã nguồn; bản installer đã bundle portable Node |
| Model provider | API key theo nhà cung cấp; hoặc Ollama/LM Studio tool-capable ở loopback |
| .NET SDK 10 | Chỉ khi build lại ChatMCP.exe / DatGoldSetup.exe |

## 2. Lấy mã nguồn

~~~powershell
git clone https://github.com/pddczpl/ChatMCP.git
cd ChatMCP
# Chỉ khi kiểm thử nhánh PR local-only chưa merge:
# git fetch origin
# git switch refactor/local-only-remove-cloud
npm ci --prefix .\CHATMCP-HUB\ui
npm run build --prefix .\CHATMCP-HUB\ui
~~~

## 3. Khởi động Hub

~~~powershell
.\CHATMCP-HUB\START-CHATMCP-HUB.cmd -ProjectPath 'C:\Projects\Demo'
# Hoặc mở native desktop
.\START-CHATMCP-DESKTOP.cmd
~~~

Launcher hỗ trợ -ProjectPath, -Port, -StateDir, -NoOpen và -Backend local để tương thích lệnh cũ. **Không hỗ trợ -Backend mcp hoặc -RepoRoot**. CHATMCP_PUBLIC=1 bị từ chối. Hub không tự mở cổng ra LAN/Internet.

Dừng bằng:

~~~powershell
.\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd
~~~

## 4. Lần đầu sử dụng

Mở local dashboard, chọn Git workspace, nhà cung cấp AI, model và thiết lập quyền Review. Đọc [User Guide](USER-GUIDE.md) trước khi chọn Autonomous/Full Access.

## 5. Dữ liệu và quyền riêng tư

Dữ liệu Hub theo mặc định ở %LOCALAPPDATA%\ChatMCP\hub; ứng dụng giữ hội thoại, checkpoint, logs và cấu hình ở đây. Không đưa thư mục này vào Git hoặc chia sẻ với người khác. Local-only **vẫn có thể** kết nối với API model và GitHub khi bạn sử dụng các chức năng tương ứng.

## 6. Tùy chọn

- Local models: cấu hình Ollama hoặc LM Studio bằng base URL loopback trong UI.
- GitHub Skills: tải nội dung từ những nguồn GitHub được cho phép, kiểm tra hash; skills mới mặc định disabled.
- Git coding workers: Hub vẫn có route cho chúng (`/api/studio/coding/*`) nhưng giao diện không còn mục để bắt đầu chúng (đã gỡ 2026-10-25); mỗi worker chạy trên worktree riêng và Hub bắt buộc đọc diff trước khi integrate/publish Draft PR.
- Docker test sandbox là tính năng **cục bộ tùy chọn**, không phải Docker hosting.

## 7. Kiểm thử trước khi phát hành

~~~powershell
node .\CHATMCP-HUB\tests\run-all.mjs
.\scripts\Build-Installer.ps1
Get-FileHash .\dist\DatGoldSetup.exe -Algorithm SHA256
~~~

Test bản cài trên Windows sạch, đặc biệt WebView2, giữ lại dữ liệu sau nâng cấp, và việc gỡ cài đặt. Xem [Desktop Release Guide](DESKTOP-APP.md) và [Security](../SECURITY.md).

## Native lifecycle and upgrades (3.8.3)

The native launcher is single-instance per user/session and checks the running Hub's exact version before loading its UI. Closing the GUI no longer kills the Hub; reopen the installed shortcut to reconnect, or use the installed `CHATMCP-HUB/STOP-CHATMCP-HUB.cmd` to explicitly stop it. No task is automatically replayed.

Finish active agent/terminal/background work before upgrading. The installer verifies and stops only its own idle Hub, stages the payload and rolls back touched application files on an error. Logs are under `%LOCALAPPDATA%\ChatMCP\logs`. A retained `.chatmcp-update-pending.json` indicates an interrupted update or failed rollback; keep its backup directory for recovery rather than deleting it or launching a mixed bundle.

Setup names what it puts in front of a person DatGold Studio: the Desktop shortcut, the Start menu folder `DatGold` (the launcher and the uninstaller) and the entry in Windows Settings > Apps > Installed apps. Versions up to 3.10.1 used the old product name for these. When setup installs over such a version it removes those shortcuts (only the ones that point into the installation it is replacing, whichever shortcut choices the wizard shows) and their Start menu folder if nothing else is in it; the uninstaller removes both sets. A tile pinned to the taskbar or to Start from an old shortcut keeps its old name until it is unpinned and pinned again. Which names keep the old spelling, and why: [naming](NAMING.md).

Unattended installation is opt-in and has the same safety checks as the wizard:

~~~powershell
# The setup of releases up to v3.10.2 is called ChatMCPSetup.exe.
.\DatGoldSetup.exe --quiet --install-dir "$env:LOCALAPPDATA\Programs\ChatMCP"
# Use only from the actual installed directory:
.\Uninstall.exe --quiet --uninstall
~~~

Exit 1 indicates failure. Installing the desktop does not silently replace a Browser Companion loaded unpacked from another directory; update/reload that extension separately.

**Update mode.** The desktop app starts the setup of a downloaded release in a third form, after it has checked the file itself (`docs/THREAT-MODEL.md`, Surface 8): `DatGoldSetup.exe --quiet --update --install-dir "<the installation>" [--wait-pid <process id>] [--relaunch] [--result "<drive>:\...\x.json"]`. The two quiet forms above take exactly the arguments they took before; an update takes exactly these, each at most once, and anything else is refused with the usage text. With `--wait-pid` the setup waits at most 30 seconds for that process to exit, and only when it is the installed `ChatMCP.exe`; a process id that is gone, or has been handed on to another program, is not waited for. `--relaunch` opens the right app at the end: the new one after an update, the old one after a refusal or a clean rollback, and none while `.chatmcp-update-pending.json` is on disk (the launcher would refuse to start). `--result` names a `.json` file on a drive, which the setup writes whole, as one line: `{"format":1,"ok":true,"version":"x.y.z","previous":"x.y.z","state":"installed","reason":null,"rolledBack":false}` where `state` is `installed`, `unchanged` (nothing was replaced), `rolled_back` (files were replaced and all of them put back) or `needs_recovery` (the rollback is incomplete, or an earlier update left its marker: the marker and the backup stay and the launcher, the setup and the uninstaller refuse to go on until the installation is recovered by hand, see below), and `reason` is one of `shell_not_exited`, `no_installation`, `not_newer`, `disk_full`, `pending_recovery`, `tasks_running`, `foreign_listener`, `hub_stop_failed`, `window_open`, `another_update`, `payload_invalid`, `install_failed` (never the text of an exception, which can hold a path). The app gives it a path in the Hub's data folder (`%LOCALAPPDATA%\ChatMCP\hub\update-result.json`); the setup writes the file only when no program listens on port 3007, because the Hub reads it once, when it starts, and removes it (a note left beside a Hub that is already running would be read by nobody until some later start). A refusal that stopped nothing, such as a task that is running, is told in the window of the update and leaves no file. The setup says in its window that the app was opened again only when it really was. This form never reinstalls or downgrades (`not_newer`), refuses an earlier update that did not finish (`pending_recovery`) and a disk with less room than the payload plus 128 MiB or a quarter of it (`disk_full`), keeps the shortcuts the installation has (a shortcut that was deleted stays deleted; the ones that versions up to 3.10.1 made under the old product name are replaced by the DatGold ones) and applies the same checks for work and for a foreign listener as the other forms. While it works it shows a small window with no button; after a failure the window says why, in what state DatGold is left, and has one button, Close. Exit code 0 means that the new version is in place.

**Recovering an installation by hand.** When an update stops halfway and its rollback cannot put every file back (a file was in use, or somebody else changed it while the update worked), or when the marker of such an update is found, the file `.chatmcp-update-pending.json` stays in the installation folder together with a backup folder it names (`.ChatMCP-update-<id>`, holding `journal.json` and the files that were replaced). DatGold does not start behind it, the setup (in every form) and the uninstaller refuse to go on, and running the setup again does not help; the window of the update and the page say so. Nothing recovers it for you yet. To put the installation back to what it was before the update, close DatGold, then run this in Windows PowerShell as the same user (set `$install` to the folder DatGold is installed in); it puts back every file the update replaced or removed from its backup, removes every file the update created, and then removes the marker and the backup, so that DatGold and the setup work again:

~~~powershell
# recovery-from-retained-backup
$install = "$env:LOCALAPPDATA\Programs\ChatMCP"
$ErrorActionPreference = 'Stop'
$markerFile = Join-Path $install '.chatmcp-update-pending.json'
$backups = (Get-Content -LiteralPath $markerFile -Raw | ConvertFrom-Json).backupDirectory
foreach ($entry in (Get-Content -LiteralPath (Join-Path $backups 'journal.json') -Raw | ConvertFrom-Json)) {
    $target = Join-Path $install ($entry.Relative -replace '/', '\')
    if ($entry.Backup) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item -LiteralPath $entry.Backup -Destination $target -Force
    } elseif (-not $entry.OldHash -and (Test-Path -LiteralPath $target)) {
        Remove-Item -LiteralPath $target -Force
    }
}
Remove-Item -LiteralPath $markerFile -Force
Remove-Item -LiteralPath $backups -Recurse -Force
~~~

It stops at the first error and then leaves the marker and the backup where they are, so it can be run again after the cause (a file that is open, say) is gone. It is run for real on a retained backup by the native tests (`scripts/tests/native-lifecycle`), from this text.

To test the updater, build two versions that trust a key made for the run: `.\scripts\Build-Installer.ps1 -ReleaseKeysFile <full path of a key file>` builds that key list into the desktop shell and copies it over `CHATMCP-HUB\lib\release-keys.json` of the payload, so that the Hub the setup installs trusts the same list. The committed file is not touched, the script says that it is a test build, a publish workflow refuses the parameter, and the file must be a plain file of at most 16 KiB with an entry that says use `release` and a 91-byte key.

The installer and the uninstaller start Windows PowerShell as a child in two places: the helper that deletes `Uninstall.exe` once the uninstaller has ended, and the Hub ownership check of the preflight. Both go through `HubLifecycle.WindowsPowerShell` (`native-shared/HubLifecycle.cs`) and get no `PSModulePath`. A program started from a PowerShell 7 window hands PowerShell 7's module folders on, and Windows PowerShell would load them before its own and lose `Get-FileHash` (an uninstaller started that way used to leave `Uninstall.exe` behind). `scripts/tests/legacy-hub-upgrade/run.mjs` and `scripts/tests/Test-NativeLifecycle.ps1` start both from a stand-in for PowerShell 7's module folder, and `CHATMCP-HUB/tests/verify-native-hardening.mjs` keeps `HubLifecycle.cs` the only C# file that names `powershell.exe`.
