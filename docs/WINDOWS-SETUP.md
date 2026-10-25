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
| .NET SDK 10 | Chỉ khi build lại ChatMCP.exe / ChatMCPSetup.exe |

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
Get-FileHash .\dist\ChatMCPSetup.exe -Algorithm SHA256
~~~

Test bản cài trên Windows sạch, đặc biệt WebView2, giữ lại dữ liệu sau nâng cấp, và việc gỡ cài đặt. Xem [Desktop Release Guide](DESKTOP-APP.md) và [Security](../SECURITY.md).

## Native lifecycle and upgrades (3.8.3)

The native launcher is single-instance per user/session and checks the running Hub's exact version before loading its UI. Closing the GUI no longer kills the Hub; reopen the installed shortcut to reconnect, or use the installed `CHATMCP-HUB/STOP-CHATMCP-HUB.cmd` to explicitly stop it. No task is automatically replayed.

Finish active agent/terminal/background work before upgrading. The installer verifies and stops only its own idle Hub, stages the payload and rolls back touched application files on an error. Logs are under `%LOCALAPPDATA%\ChatMCP\logs`. A retained `.chatmcp-update-pending.json` indicates an interrupted update or failed rollback; keep its backup directory for recovery rather than deleting it or launching a mixed bundle.

Setup names what it puts in front of a person DatGold Studio: the Desktop shortcut, the Start menu folder `DatGold` (the launcher and the uninstaller) and the entry in Windows Settings > Apps > Installed apps. Versions up to 3.10.1 used the old product name for these. When setup installs over such a version it removes those shortcuts (only the ones that point into the installation it is replacing, whichever shortcut choices the wizard shows) and their Start menu folder if nothing else is in it; the uninstaller removes both sets. A tile pinned to the taskbar or to Start from an old shortcut keeps its old name until it is unpinned and pinned again. Which names keep the old spelling, and why: [naming](NAMING.md).

Unattended installation is opt-in and has the same safety checks as the wizard:

~~~powershell
.\ChatMCPSetup.exe --quiet --install-dir "$env:LOCALAPPDATA\Programs\ChatMCP"
# Use only from the actual installed directory:
.\Uninstall.exe --quiet --uninstall
~~~

Exit 1 indicates failure. Installing the desktop does not silently replace a Browser Companion loaded unpacked from another directory; update/reload that extension separately.

The installer and the uninstaller start Windows PowerShell as a child in two places: the helper that deletes `Uninstall.exe` once the uninstaller has ended, and the Hub ownership check of the preflight. Both go through `HubLifecycle.WindowsPowerShell` (`native-shared/HubLifecycle.cs`) and get no `PSModulePath`. A program started from a PowerShell 7 window hands PowerShell 7's module folders on, and Windows PowerShell would load them before its own and lose `Get-FileHash` (an uninstaller started that way used to leave `Uninstall.exe` behind). `scripts/tests/legacy-hub-upgrade/run.mjs` and `scripts/tests/Test-NativeLifecycle.ps1` start both from a stand-in for PowerShell 7's module folder, and `CHATMCP-HUB/tests/verify-native-hardening.mjs` keeps `HubLifecycle.cs` the only C# file that names `powershell.exe`.
