# Nâng cấp ChatMCP Studio 2.2.0 trên Windows

> Thay mã ứng dụng, **không xóa** dữ liệu, khóa cấu hình, workspace và Git. Không tự nâng cấp trực tiếp từ chatbot trong browser; tải ZIP và giải nén trên Windows của bạn.

1. Đóng những terminal tương tác còn đang chạy. Dừng Hub phiên bản cũ:

```powershell
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd'
```

2. Sao lưu thư mục dữ liệu lâu dài bằng PowerShell (nếu tồn tại):

```powershell
$src='F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp\deploy\.generated\chatmcp-hub'
$dst='F:\Personal_Project\Vin\ChatMCP\chatmcp-state-backup-before-2.2.0'
if (Test-Path -LiteralPath $src -PathType Container) { Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force }
```

3. Giải nén `CHATMCP-STUDIO-2.2.0.zip` vào **thư mục cha** `F:\Personal_Project\Vin\ChatMCP`; giữ đúng `...\ChatMCP\CHATMCP-HUB\hub.mjs`, không tạo `CHATMCP-HUB\CHATMCP-HUB`. Cho phép thay các file chương trình cũ, **không xóa toàn bộ thư mục trước**. Không xóa `.generated`, thư mục dự án, hay cấu hình API key.

4. Mở `edge://extensions` hoặc `chrome://extensions`, **Reload** ChatMCP Hub Companion **1.4.0** trong cùng thư mục `CHATMCP-HUB\extension`. Không dùng hai bản Companion đồng thời.

5. Start:

```powershell
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd'
```

6. Mở `http://127.0.0.1:3007`, nhấn **Ctrl+F5**. Kiểm tra backend:

```powershell
Invoke-RestMethod 'http://127.0.0.1:3007/api/health' | Select-Object app,version,uiBuild,initialized
```

Phải thấy `version: 2.2.0` và `uiBuild: 2.2.0-react-offline`. Nếu sai, cổng 3007 vẫn có tiến trình cũ; dùng STOP, đợi 15 giây rồi START lại, **không kill node.exe tùy tiện**.

7. Chạy smoke (chỉ đọc, không sửa dự án):

```powershell
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\windows\Run-StudioSmoke.ps1'
```

8. Muốn thử Docker sandbox: chuẩn bị trước `docker pull python:3.11-slim` **khi có mạng**. Trong Settings, chọn **Sandbox-only**. Docker chạy lệnh kiểm thử với workspace READ-ONLY. Chế độ này cố ý **không cho agent dùng Desktop Commander để sửa bài lab**; để sửa file host, chuyển sang Host-review và xét các lệnh.

9. Khi cần LSP hoặc ConPTY, cài dependency riêng theo [STUDIO-2.2.0.md](STUDIO-2.2.0.md). Nếu thiếu, dashboard hiện trạng thái `not available`, không tự giả lập là đã cài.

## Kiểm tra mất mạng/độ tin cậy

Chạy ở **PowerShell terminal riêng** khi bạn đang dùng Hub:

```powershell
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\windows\Run-StudioSoak.ps1' -DurationMinutes 240 -IntervalSeconds 5 -AdapterName Ethernet
```

Giám sát Hub/API và trạng thái Realtek Ethernet; dữ liệu CSV ghi dưới `%LOCALAPPDATA%\ChatMCPStudio\diagnostics`, chỉ số độ ổn định phải lấy từ **máy bạn**, không thể suy từ test Linux.

Tùy chọn watchdog (chỉ chạy khi bạn chủ động mở, không tự cài Windows service):

```powershell
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\windows\Watch-StudioHub.ps1'
```

Watchdog chờ 3 lần lỗi liên tiếp rồi thử START Hub, giới hạn tổng 5 lần, **không kill tiến trình khác, không replay lệnh tool đang dở**. Tắt bằng Ctrl+C. Nó không sửa lỗi card Ethernet bị mất link, không bảo đảm khôi phục ChatGPT Web đã đổi cấu trúc UI.

## Quay về bản cũ

Dừng 2.2.0, giải nén ZIP 2.1.0 vào cùng thư mục, Reload Companion nếu cần, khởi động lại. **Khôi phục thư mục dữ liệu trước 2.2.0 chỉ khi thật sự cần**: việc thay dữ liệu từ bản sao có thể làm mất lịch sử mới tạo sau lúc backup. Sao lưu hiện trạng trước khi thử rollback. Không xóa phiên hội thoại theo cách thủ công.
