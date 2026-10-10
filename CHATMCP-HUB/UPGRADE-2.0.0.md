# Nâng cấp ChatMCP Studio 1.3.0 -> 2.0.0 trên Windows 11

1. **Đóng và dừng Hub cũ** (không chỉ đóng tab trình duyệt):

   ```powershell
   & 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd'
   ```

2. **Sao lưu trạng thái và cấu hình bí mật** (không đăng tải sao lưu này). Ví dụ chạy dưới PowerShell:

   ```powershell
   Copy-Item -LiteralPath 'F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp\deploy\.generated\chatmcp-hub' -Destination 'F:\Personal_Project\Vin\ChatMCP\chatmcp-hub-before-v2-backup' -Recurse -Force
   ```

   Nếu đường dẫn không tồn tại, kiểm tra đúng thư mục Cloud Harness đang sử dụng. Không xóa `.generated` và không làm mất mã nguồn workspace.

3. Giải nén `CHATMCP-STUDIO-2.0.0.zip` vào `F:\Personal_Project\Vin\ChatMCP`. ZIP có **một thư mục gốc `CHATMCP-HUB/`**, chọn ghi đè file cũ trong thư mục cùng tên, **không** giải nén thành `CHATMCP-HUB\CHATMCP-HUB`.
4. Trong `edge://extensions` hoặc `chrome://extensions`, Reload **ChatMCP Hub Companion 1.4.0**. Bản này giữ nguyên phiên bản Companion từ 1.3.0; chỉ mã Hub và dashboard được nâng cấp. Không chạy song song hai tiện ích Companion.
5. Khởi động lại:

   ```powershell
   & 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd'
   ```

6. Vào `http://127.0.0.1:3007`, xác minh phiên bản Hub `2.0.0`, workspace đúng và lịch sử cũ vẫn còn. Chọn đúng hội thoại ở sidebar thay vì tạo hội thoại mới, thử đọc file trong Explorer và kiểm tra Git Status.
7. Để tự tiếp tục khi Hub bị crash/restart, chọn hội thoại → **Plan & Verify → Tự tiếp tục ...** và bật. **Không tự khôi phục** với lệnh đã gửi mà chưa biết kết quả, nhiệm vụ đã hoàn tất, hủy hoặc sai model/workspace.

**Không thay API key/secret nếu không cần.** Nếu key bị lộ trước đây, hãy thu hồi và tạo key mới; không paste vào log, Markdown hoặc Git. `localhost` chỉ mở 127.0.0.1; không public dashboard ra Internet nếu chưa thêm xác thực/TLS phù hợp.
