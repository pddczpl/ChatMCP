# Đóng gói Ứng dụng Desktop Native (ChatMCP Desktop Studio)

Tài liệu này hướng dẫn cách cài đặt, chạy và đóng gói **ChatMCP Studio** thành ứng dụng Desktop độc lập trên Windows 11, Windows 10 và Linux.

---

## 1. Tổng quan Kiến trúc Desktop Native

Khác với các ứng dụng web thông thường đòi hỏi người dùng phải mở trình duyệt và gõ URL `http://127.0.0.1:3007`, ChatMCP cung cấp chế độ **Native Desktop Window Mode**:

```
+-------------------------------------------------------------+
|                     ChatMCP Desktop App                     |
|                                                             |
|  +-------------------------------------------------------+  |
|  | Native App Container (Edge / Chrome App Mode / ConPTY)|  |
|  | - Không thanh địa chỉ (no URL bar)                    |  |
|  | - Không thanh tab (no browser tabs)                   |  |
|  | - Kích thước cửa sổ chuẩn: 1440 x 900                 |  |
|  | - Runtime Profile độc lập tại %LOCALAPPDATA%\ChatMCP   |  |
|  +---------------------------^---------------------------+  |
|                              | HTTP / SSE (127.0.0.1:3007)  |
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
1. **Trải nghiệm ứng dụng bản địa (Native Feel):** Giao diện chạy trong cửa sổ riêng biệt với icon ứng dụng, không bị lẫn với các tab duyệt web thông thường.
2. **Cách ly môi trường (Isolated Profile):** Dữ liệu phiên, cache và cookie được lưu riêng tại `%LOCALAPPDATA%\ChatMCP\desktop-runtime`, hoàn toàn tách biệt với profile trình duyệt hàng ngày.
3. **Khởi động 1-Click (Zero-Configuration):** Tự động phát hiện và khởi động Hub ở chế độ nền (hidden background process), tự động chờ sức khỏe hệ thống và mở cửa sổ Studio ngay lập tức.
4. **Không phụ thuộc runtime nặng:** Tận dụng sẵn Microsoft Edge WebView/Chromium Runtime tích hợp của Windows 11/10 mà không cần bundle thêm 150MB Electron binaries.

---

## 2. Hướng dẫn Cài đặt & Khởi chạy (Windows 11 / Windows 10)

### Yêu cầu hệ thống
- Hệ điều hành: Windows 10 (Build 19041+) hoặc Windows 11.
- Môi trường: [Node.js 22+](https://nodejs.org/) (đã được xác thực qua CI matrix trên cả Node 22 & Node 24).
- Git: [Git for Windows](https://git-scm.com/download/win).

---

### Cách 1: Cài đặt phím tắt Desktop & Start Menu (Khuyên dùng)

Mở PowerShell tại thư mục gốc của repository và chạy:

```powershell
.\scripts\install-desktop.ps1
```

Script sẽ tự động:
1. Kiểm tra môi trường Node.js và Git.
2. Tạo shortcut **ChatMCP Studio** trên màn hình Desktop của bạn.
3. Tạo mục **ChatMCP Studio** trong Start Menu (`Start -> ChatMCP -> ChatMCP Studio`).

Sau khi cài đặt, bạn chỉ cần nhấp đúp vào icon trên Desktop để mở ChatMCP như một ứng dụng native thông thường.

---

### Cách 2: Khởi chạy nhanh 1-Click bằng file CMD

Nhấp đúp chuột trực tiếp vào file:

```cmd
START-CHATMCP-DESKTOP.cmd
```

Hoặc chạy từ dòng lệnh:

```cmd
START-CHATMCP-DESKTOP.cmd -ProjectPath "D:\Du-An-Cua-Ban"
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

- **Đóng cửa sổ:** Nhấn nút `X` ở góc trên bên phải cửa sổ ứng dụng. Tiến trình Hub vẫn chạy nền để giữ trạng thái tác vụ của Agent không bị gián đoạn.
- **Tắt hoàn toàn tiến trình Hub:**
  - Nhấp đúp vào: `.\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd`
  - Hoặc gửi lệnh từ giao diện web / API: `POST /api/hub/shutdown`

---

## 5. Gỡ bỏ Phím tắt (Uninstall)

Để xóa toàn bộ shortcut Desktop và Start Menu:

```powershell
.\scripts\uninstall-desktop.ps1
```
