# Triển khai — Cloud Hosting Retired

**ChatMCP từ nhánh local-only không còn hỗ trợ Render, Docker/VPS server, public login, public workspace REST API, Cloud Harness MCP backend hay shared multi-tenant execution.** Những phần mã và cấu hình tương ứng đã được loại khỏi runtime. Tài liệu này giữ tên/heading cũ để những liên kết lịch sử không bị hỏng; các lệnh cloud trước đây **không còn được sử dụng**.

## 1. Chạy trên máy cá nhân (chế độ cục bộ)

Dùng [Windows Setup](WINDOWS-SETUP.md). Hub chỉ listen 127.0.0.1 (mặc định cổng 3007). Không cần Docker, Render, Cloud Harness. Với API model và GitHub Skills Hub, Internet chỉ được sử dụng khi cần.

### Cập nhật

Tải bản cài chính thức từ [GitHub Releases](https://github.com/pddczpl/ChatMCP/releases) hoặc cập nhật mã nguồn trong bản sao Git đã được kiểm tra, build lại UI rồi khởi động lại Hub.

## 2. Tự host bằng Docker Compose (VPS Linux)

**Removed.** Không còn Compose/server image hay cấu hình public auth. Không chạy các hướng dẫn từ các bản cũ.

### Yêu cầu

Không áp dụng.

### Các bước thiết lập

Không áp dụng.

## 3. Triển khai 0 đồng trên Render (PaaS)

**Removed.** Không còn render.yaml và không có endpoint public.

### Đặc điểm gói miễn phí của Render:

Thông tin này chỉ là lưu trữ lịch sử, không còn liên quan ChatMCP local-only.

### Các bước triển khai Render:

Không áp dụng.

## 4. Kiến trúc bảo vệ trong chế độ công khai (CHATMCP_PUBLIC=1)

**Removed.** Hub hiện từ chối bật CHATMCP_PUBLIC. Tuyệt đối không gỡ kiểm tra Host/Origin/CSRF để mở ra mạng công cộng.

## 5. Quản lý Workspace từ xa và Git Integration

Các thao tác clone/workspace tạm của server đã gỡ. Git worktrees và Draft PR cục bộ vẫn hoạt động trên repo do bạn chọn.

## 6. Truy cập từ xa bằng SSH tunnel (Tùy chọn không mở cổng)

Không còn là đường triển khai sản phẩm được hỗ trợ. Hub thiết kế cho người sử dụng ngay trên máy đang chạy.

## 7. Nhiều người dùng — BỊ CHẶN (Blocked)

Không hỗ trợ. Worktrees không phải tenant sandbox.

## 8. Danh sách kiểm tra trước khi đưa vào sử dụng

Dùng [Windows Desktop Release Guide](DESKTOP-APP.md) và [SECURITY.md](../SECURITY.md) để kiểm thử build, checksum, installer và giới hạn bảo mật.
