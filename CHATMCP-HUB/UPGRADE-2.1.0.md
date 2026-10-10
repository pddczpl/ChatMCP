# Nâng cấp ChatMCP Studio 2.0.0 → 2.1.0 trên Windows 11

Các lệnh dưới đây dùng đúng thư mục cài trên máy đã chọn. Nếu người dùng đã di chuyển thư mục, thay bằng đường dẫn thực tế.

1. **Dừng Hub 2.0.0 hoàn toàn**, không chỉ đóng trang Edge:

   ```powershell
   & 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd'
   ```

2. **Sao lưu lịch sử và khóa cấu hình ra thư mục KHÔNG đăng lên mạng/Git**:

   ```powershell
   $source = 'F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp\deploy\.generated\chatmcp-hub'
   if (Test-Path -LiteralPath $source) {
     Copy-Item -LiteralPath $source -Destination 'F:\Personal_Project\Vin\ChatMCP\chatmcp-hub-backup-before-2.1' -Recurse -Force
   }
   ```

   Nếu Hub sử dụng đường dẫn state khác, sao lưu đúng nơi đó. **Không xóa** `cloud-harness-mcp\deploy\.generated` hoặc workspace bài lab.

3. Giải nén `CHATMCP-STUDIO-2.1.0.zip` vào thư mục `F:\Personal_Project\Vin\ChatMCP`, chấp nhận thay các file cũ trong `CHATMCP-HUB`. ZIP có **thư mục gốc `CHATMCP-HUB/`**, không giải nén lồng `CHATMCP-HUB\CHATMCP-HUB`.

4. Ở `edge://extensions`, **Reload** Companion; phiên bản Companion **vẫn 1.4.0**. Không bật nhiều Companion có quyền tự động thực thi cùng lúc.

5. Khởi động lại:

   ```powershell
   & 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd'
   ```

   Nếu xuất hiện thông báo `Cổng 3007 vẫn chạy Hub ...`, **không khởi tạo task ngay**. Dừng Hub cũ cho đến khi cổng 3007 không còn LISTEN, sau đó START lại. Để tìm tiến trình chiếm cổng mà không kill nhầm:

   ```powershell
   Get-NetTCPConnection -LocalPort 3007 -State Listen -ErrorAction SilentlyContinue |
     Select-Object LocalAddress,LocalPort,OwningProcess
   ```

6. Vào `http://127.0.0.1:3007`, nhấn **Ctrl+F5**. Kiểm tra Hub thực sự đã lên v2.1.0:

   ```powershell
   Invoke-RestMethod 'http://127.0.0.1:3007/api/health' |
     Select-Object app,version,uiBuild,initialized
   ```

   Kết quả đúng phải có `version: 2.1.0` và `uiBuild: 2.1.0-react-offline`. Nếu trang vẫn là bản cũ, đừng xóa phiên; kiểm tra lại cổng và đường dẫn đã giải nén.

7. Test theo trình tự không phá dữ liệu: mở Files đọc một file → đổi `ChatGPT Web` sang `API Gateway` và đổi lại (không bắt đầu task) → thử xóa **phiên thử nghiệm không quan trọng** → nhấn Ctrl+K mở Terminal → nếu trong repo có `pytest.ini` / `pyproject.toml`, chạy Project Verification sau khi đọc trước lệnh và đồng ý.

**Không xóa phiên thật để thử trước khi backup.** Xóa phiên chỉ xóa lịch sử cục bộ trong Hub, **không xóa file dự án hoặc chat ChatGPT trên tài khoản**. Khi mất mạng: tiếp tục phiên có dữ liệu đã lưu; thao tác chưa rõ kết quả sẽ yêu cầu đối chiếu thủ công, không tự chạy lại lệnh ghi file.

### Nếu còn lỗi “Không tìm thấy thao tác”

Mở `http://127.0.0.1:3007/api/health`, xem `version` và `uiBuild`. Nếu lệch phiên bản giao diện, dùng STOP → START → Ctrl+F5. Mã mới sẽ hiển thị HTTP status, endpoint và build cụ thể thay vì thông báo chung. Có thể dùng `http://127.0.0.1:3007/legacy` để xem giao diện cũ trong lúc xử lý lỗi React.
