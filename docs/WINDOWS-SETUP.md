# Cài đặt ChatMCP trên Windows 10/11 (local-only)

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
- Git coding workers: mỗi worker trên worktree riêng, bắt buộc xem diff trước khi integrate/publish Draft PR.
- Docker test sandbox là tính năng **cục bộ tùy chọn**, không phải Docker hosting.

## 7. Kiểm thử trước khi phát hành

~~~powershell
node .\CHATMCP-HUB\tests\run-all.mjs
.\scripts\Build-Installer.ps1
Get-FileHash .\dist\ChatMCPSetup.exe -Algorithm SHA256
~~~

Test bản cài trên Windows sạch, đặc biệt WebView2, giữ lại dữ liệu sau nâng cấp, và việc gỡ cài đặt. Xem [Desktop Release Guide](DESKTOP-APP.md) và [Security](../SECURITY.md).
