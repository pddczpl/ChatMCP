# Đóng gói Ứng dụng Desktop Native (ChatMCP Desktop Studio)

> **Cập nhật release Windows:** Mã nguồn native `desktop-shell/ChatMCP.csproj` và installer `installer/ChatMCP.Installer.csproj` hiện dùng **.NET 10**. Build từ source yêu cầu .NET SDK 10, Node.js 22+ và npm. `scripts/Build-Installer.ps1` bắt buộc biên dịch lại frontend bằng `npm ci && npm run build`, publish Windows self-contained, đóng gói portable Node và tạo file checksum `dist/ChatMCPSetup.exe.sha256`. Sử dụng `dist/ChatMCPSetup.exe` đúng revision đã vượt CI; phải test cài/gỡ trên Windows máy sạch. Windows desktop cần WebView2 Runtime; Git worktrees cần Git for Windows. Đừng công bố bản cài khi chưa test ứng dụng thực tế.

**Lệnh duy trì release** (sau khi PR đã review và merge vào main):

```powershell
git switch main
git pull --ff-only origin main
node .\CHATMCP-HUB\tests\run-all.mjs
.\scripts\Build-Installer.ps1
Get-FileHash .\dist\ChatMCPSetup.exe -Algorithm SHA256
# Test EXE trên Windows sạch; chọn phiên bản đã thống nhất trong các manifest.
# Ví dụ sau khi chọn version X.Y.Z và test build:
git tag -a vX.Y.Z -m "ChatMCP vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z .\dist\ChatMCPSetup.exe .\dist\ChatMCPSetup.exe.sha256 --draft --title "ChatMCP vX.Y.Z" --generate-notes
```


Tài liệu này hướng dẫn cách cài đặt, chạy và đóng gói **ChatMCP Studio** thành ứng dụng Desktop độc lập trên Windows 11, Windows 10 và Linux.

---

## 1. Tổng quan Kiến trúc Desktop Native

Khác với các ứng dụng web thông thường đòi hỏi người dùng phải mở trình duyệt và gõ URL `http://127.0.0.1:3007`, ChatMCP cung cấp trải nghiệm **Native Desktop Application**:

```
+-------------------------------------------------------------+
|                ChatMCP.exe (Native Desktop App)             |
|                                                             |
|  +-------------------------------------------------------+  |
|  | Native Window (WebView2 / WinForms / Fluent Design)   |  |
|  | - Biểu tượng ứng dụng ChatMCP chính thức (chatmcp.ico)|  |
|  | - Không thanh địa chỉ (no URL bar)                    |  |
|  | - Không thanh tab (no browser tabs)                   |  |
|  | - Tiêu đề: "ChatMCP Studio - AI Coding Agent"         |  |
|  | - Quản lý tiến trình trong Task Manager: ChatMCP.exe  |  |
|  | - Runtime Profile độc lập tại %LOCALAPPDATA%\ChatMCP   |  |
|  +---------------------------^---------------------------+  |
|                              | IPC / Embedded Engine        |
|  +---------------------------v---------------------------+  |
|  |               ChatMCP Hub Background Daemon           |  |
|  | - Agent Execution Engine & Cổng bảo mật Gate          |  |
|  | - Plugin Manager & Curated Skills Marketplace         |  |
|  | - Multi-User RBAC & Workspace Isolation               |  |
|  | - ConPTY Interactive Terminal & AST Code Index        |  |
|  +-------------------------------------------------------+  |
+-------------------------------------------------------------+
```

### Ưu điểm
1. **Trải nghiệm ứng dụng bản địa (Native Feel):** Chạy trực tiếp file `ChatMCP.exe` với tên tiến trình riêng trong Task Manager, có icon chính thức trên Taskbar và Alt+Tab.
2. **Bộ nhận diện thương hiệu cao cấp:** Biểu tượng `chatmcp.ico` đa độ phân giải (16x16 đến 256x256) thiết kế theo phong cách Cyber Shield AI hiện đại.
3. **Đăng ký chính thức với Windows:** Xuất hiện trực tiếp trong **Windows Settings -> Apps -> Installed apps** và Control Panel, hỗ trợ gỡ cài đặt sạch sẽ chuẩn Windows.
4. **Cách ly môi trường (Isolated Profile):** Dữ liệu phiên, cache và cookie được lưu riêng tại `%LOCALAPPDATA%\ChatMCP\webview2-data`, hoàn toàn tách biệt với trình duyệt hàng ngày.
5. **Khởi động 1-Click (Zero-Configuration):** Tự động phát hiện và khởi động Hub ở chế độ nền (hidden background process), tự động dọn dẹp khi tắt app.

---

## 2. Hướng dẫn Cài đặt & Khởi chạy (Windows 11 / Windows 10)

### Yêu cầu hệ thống
- Hệ điều hành: Windows 10 (Build 19041+) hoặc Windows 11.
- Môi trường: [Node.js 22+](https://nodejs.org/) (đã được xác thực qua CI matrix trên cả Node 22 & Node 24).
- Git: [Git for Windows](https://git-scm.com/download/win).
- (.NET SDK 9+ nếu muốn tự biên dịch lại từ mã nguồn C#).

---

### Cách 1: Sử dụng Bộ cài đặt Thương mại ChatMCPSetup.exe (Tiêu chuẩn Thương mại)

ChatMCP cung cấp bộ cài đặt dạng file EXE duy nhất `ChatMCPSetup.exe` tương tự như các ứng dụng thương mại hàng đầu (VS Code, Cursor, Discord):

1. **Đóng gói bộ cài:**
   ```powershell
   .\scripts\Build-Installer.ps1
   ```
   Lệnh trên sẽ tạo ra file cài đặt standalone tại: **`dist\ChatMCPSetup.exe`** (~35.7 MB).
2. **Cài đặt:**
   - Nhấp đúp chuột vào **`ChatMCPSetup.exe`**.
   - Giao diện cài đặt thương mại sẽ mở lên với logo chính thức và đường dẫn mặc định `%LOCALAPPDATA%\Programs\ChatMCP`.
   - Chọn tùy chọn tạo shortcut Desktop, Start Menu -> Bấm **Install**.
   - Trình cài đặt tự động trích xuất các thành phần, cấu hình `Uninstall.exe` và đăng ký vào Windows Apps trong 2 giây.

---

### Cách 2: Cài đặt phím tắt Desktop, Start Menu & Đăng ký Windows (Dành cho Developer)

Mở PowerShell tại thư mục gốc của repository và chạy:

```powershell
.\scripts\install-desktop.ps1
```

Script sẽ tự động:
1. Kiểm tra môi trường Node.js và Git.
2. Xác nhận hoặc biên dịch bộ thực thi native `desktop-shell\bin\dist\ChatMCP.exe`.
3. Tạo shortcut **ChatMCP Studio** trên màn hình Desktop của bạn với icon chính thức.
4. Tạo mục **ChatMCP Studio** trong Start Menu (`Start -> ChatMCP -> ChatMCP Studio`).
5. Đăng ký phần mềm vào **Windows Installed Apps** (`HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatMCP`).

Sau khi cài đặt, bạn chỉ cần nhấp đúp vào icon trên Desktop hoặc tìm "ChatMCP" trong Start Menu để mở ứng dụng.

---

### Cách 2: Khởi chạy nhanh 1-Click bằng file CMD hoặc EXE

Nhấp đúp chuột trực tiếp vào file:

```cmd
START-CHATMCP-DESKTOP.cmd
```

Hoặc chạy file thực thi native:

```cmd
.\desktop-shell\bin\dist\ChatMCP.exe
```

---

## 3. Khởi chạy trên Linux & macOS

Trên các hệ thống Linux hoặc macOS, bạn có thể khởi chạy ứng dụng desktop thông qua chế độ App Mode của Google Chrome hoặc Chromium:

```bash
# 1. Khởi động Hub
node CHATMCP-HUB/hub.mjs --port 3007 --no-open &

# 2. Mở cửa sổ Desktop App Mode
google-chrome --app="http://127.0.0.1:3007/" --window-size=1440,900
# Hoặc trên macOS:
# /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --app="http://127.0.0.1:3007/"
```

---

## 4. Quản lý Vòng đời & Tắt Ứng dụng

- **Đóng cửa sổ:** Khi tắt cửa sổ `ChatMCP.exe`, ứng dụng tự động đóng Hub daemon nếu do nó khởi chạy.
- **Tắt hoàn toàn tiến trình Hub thủ công:**
  - Nhấp đúp vào: `.\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd`
  - Hoặc gửi lệnh từ giao diện web / API: `POST /api/hub/shutdown`

---

## 5. Gỡ bỏ Ứng dụng (Uninstall)

Để gỡ bỏ ChatMCP Studio, bạn có thể:
1. Vào **Windows Settings -> Apps -> Installed apps -> ChatMCP Studio -> Uninstall**.
2. Hoặc chạy script từ PowerShell:

```powershell
.\scripts\uninstall-desktop.ps1
```
