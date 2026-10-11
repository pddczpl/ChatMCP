# Triển khai

> **Trạng thái trung thực (2.3.0 — Phase 2 hoàn thành):** Hai kiểu triển khai được hỗ trợ và đã được kiểm chứng bằng kiểm thử:
> 1. **Cục bộ (local):** Một người dùng, trên máy của chính họ (Windows 11 hoặc Linux), Hub lắng nghe ở `127.0.0.1:3007`. Không cần tài khoản đăng nhập hay Docker.
> 2. **Tự host tin cậy (Phase 2):** Một chủ sở hữu (single-owner) trên VPS Linux hoặc container Render (gói miễn phí). Bật bằng `CHATMCP_PUBLIC=1`, bảo vệ bằng token chủ sở hữu (`CHATMCP_OWNER_TOKEN`), phiên cookie `__Host-` an toàn, chống brute-force, tách quyền Linux (`supervisor` -> `hub` uid 10000 -> `agent` uid 10001) và quản lý workspace cô lập.
>
> **Đa người dùng (multi-tenant) công cộng: BỊ CHẶN (blocked)** cho tới khi có bằng chứng cô lập cấp máy ảo (VM / microVM).

| Kiểu triển khai | Trạng thái | Bằng chứng |
|---|---|---|
| Một người dùng, Windows 11, `127.0.0.1`, tự khởi động bằng launcher | **implemented · integration-tested · e2e-verified** | toàn bộ bộ Node chạy trên Windows 11 (Node 24); smoke thật trên Windows |
| Một người dùng, Linux/macOS, `127.0.0.1`, `node hub.mjs` | **implemented · integration-tested trên Linux** | toàn bộ 55 bộ Node chạy trên Linux (Node 22) |
| Tự host VPS (Docker Compose), một chủ sở hữu qua token + HTTPS | **implemented · integration-tested · docker-verified** | `Dockerfile`, `docker-compose.yml`, supervisor tách quyền uid 10000/10001, test container pass 51/51 |
| Triển khai 0 đồng Render (Docker Web Service, gói free) | **implemented · integration-tested · docker-verified** | `render.yaml`, heap cap 192 MB, `verify-e2e-public.mjs` giả lập proxy Render |
| Truy cập từ xa bằng đường hầm SSH tới Hub loopback | **implemented** (dựa trên loopback chuẩn) | Hub bind `127.0.0.1`, SSH port forwarding |
| Nhiều người dùng trên cùng một Hub / dịch vụ công cộng | **blocked** | Hub không hỗ trợ phân quyền nhiều tài khoản người dùng; cần microVM cô lập |

---

## 1. Chạy trên máy cá nhân (chế độ cục bộ)

Làm theo [WINDOWS-SETUP.md](WINDOWS-SETUP.md). Tóm tắt các tính chất triển khai:

- Hub là một tiến trình Node duy nhất, nghe ở `127.0.0.1:3007` (mặc định bind loopback).
- Không đăng ký dịch vụ Windows, không tự chạy khi khởi động máy, không thay đổi ExecutionPolicy, không mở cổng ra mạng.
- Dữ liệu ở `%LOCALAPPDATA%\ChatMCP\hub` (Linux: `$XDG_STATE_HOME/chatmcp` hoặc `~/.local/state/chatmcp`; macOS: `~/Library/Application Support/ChatMCP/hub`). Đổi bằng `-StateDir` / `--state-dir` / `CHATMCP_STATE_DIR`.
- Kiểm tra sức khỏe: `GET http://127.0.0.1:3007/api/health` trả phiên bản và `uiBuild` (launcher dùng chính endpoint này).

### Cập nhật

```powershell
.\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd
git pull --ff-only            # hoặc git switch sang nhánh/tag bạn muốn
.\CHATMCP-HUB\START-CHATMCP-HUB.cmd -ProjectPath C:\duong\dan\du-an
```

Sau khi cập nhật, bấm `Ctrl+F5` trong trình duyệt. Dữ liệu cũ được nạp lại; tác vụ đang dở ở bản trước được đánh dấu *Tạm dừng* hoặc *Chưa rõ kết quả* (không được chạy lại tự động). Đọc [CHANGELOG.md](../CHANGELOG.md) trước khi nâng cấp.

---

## 2. Tự host bằng Docker Compose (VPS Linux)

Dành cho chủ sở hữu muốn chạy ChatMCP trên VPS Linux cá nhân và truy cập từ xa an toàn.

### Yêu cầu
- Docker Engine ≥ 24 và Docker Compose v2.
- Reverse proxy (Nginx, Caddy, Traefik) để cấp HTTPS và kết thúc TLS.

### Các bước thiết lập

1. **Chuẩn bị cấu hình:**
   Sao chép file mẫu:
   ```bash
   cp .env.example .env
   ```
   Tạo token chủ sở hữu ngẫu nhiên (tối thiểu 32 ký tự):
   ```bash
   openssl rand -hex 32
   ```
   Cập nhật `.env`:
   ```env
   CHATMCP_PUBLIC=1
   CHATMCP_OWNER_TOKEN=chuoi_token_vua_tao_o_tren
   CHATMCP_ALLOWED_HOSTS=chatmcp.yourdomain.com
   CHATMCP_TRUSTED_PROXIES=1
   ```

2. **Khởi chạy container:**
   ```bash
   docker compose up -d --build
   ```

3. **Cấu hình Reverse Proxy (ví dụ Caddy):**
   ```caddy
   chatmcp.yourdomain.com {
       reverse_proxy 127.0.0.1:3007 {
           header_up X-Forwarded-Proto {scheme}
           header_up X-Forwarded-Host {host}
       }
   }
   ```

4. **Đăng nhập:**
   Truy cập `https://chatmcp.yourdomain.com`, nhập token chủ sở hữu để bắt đầu phiên làm việc.

---

## 3. Triển khai 0 đồng trên Render (PaaS)

ChatMCP hỗ trợ triển khai trực tiếp lên Render Web Service miễn phí thông qua [`render.yaml`](../render.yaml).

### Đặc điểm gói miễn phí của Render:
- **Tài nguyên:** 0.1 CPU, 512 MB RAM (đã cấu hình giới hạn Node heap `--max-old-space-size=192` để không chạm ngưỡng OOM).
- **Ổ đĩa:** Ephemeral (tạm thời) — các file workspace và lịch sử sẽ được làm mới khi dịch vụ khởi động lại. Do đó:
  - Luôn lưu mã nguồn bằng cách đẩy lên nhánh Git từ xa (`chatmcp/...`) hoặc tạo Pull Request GitHub.
  - Sử dụng tính năng tải gói workspace tarball trước khi phiên đóng.
- **Ngủ đông (Sleep):** Sau 15 phút không có yêu cầu, instance sẽ tạm ngủ và mất khoảng 30–50 giây để khởi động lại ở yêu cầu kế tiếp.

### Các bước triển khai Render:
1. Đẩy mã nguồn lên repository GitHub riêng tư của bạn.
2. Tại dashboard Render, chọn **Blueprints** -> **New Blueprint Instance**.
3. Chọn repo ChatMCP, Render sẽ tự động đọc [`render.yaml`](../render.yaml).
4. Thiết lập biến môi trường bí mật trong Render Dashboard:
   - `CHATMCP_OWNER_TOKEN`: Chuỗi token bảo mật (≥ 32 ký tự).
   - `OPENAI_API_KEY` hoặc `ANTHROPIC_API_KEY`: API key của bạn.
5. Render tự động build Dockerfile và cấp phát URL HTTPS dạng `https://chatmcp-xxxx.onrender.com`.

---

## 4. Kiến trúc bảo vệ trong chế độ công khai (`CHATMCP_PUBLIC=1`)

Khi hoạt động trên mạng công cộng, ChatMCP kích hoạt các lớp bảo vệ nghiêm ngặt:

1. **Khởi động an toàn (Fail-closed):** Nếu thiếu `CHATMCP_OWNER_TOKEN`, token quá ngắn (< 32 ký tự), hoặc thiếu `CHATMCP_ALLOWED_HOSTS`, Hub sẽ từ chối khởi động ngay lập tức với thông báo lỗi an toàn (không in secrets).
2. **Xác thực phiên làm việc:** So sánh token với thời gian cố định (constant-time) chống timing attacks; cấp cookie `__Host-chatmcp_session` (`HttpOnly`, `Secure`, `SameSite=Strict`); bảo vệ CSRF theo từng phiên; hết hạn phiên sau khoảng thời gian nhàn rỗi.
3. **Chống dò mật khẩu (Brute-force Throttling):** Giới hạn tần suất đăng nhập sai theo IP và toàn cục; khóa tạm thời khi vượt ngưỡng.
4. **Tách quyền tiến trình trong Docker:**
   - Tiến trình gốc chạy `tini` và `docker/supervisor.mjs` dưới quyền `root`.
   - Hub Node.js chạy dưới tài khoản không đặc quyền `hub` (uid 10000, gid 10000).
   - Lệnh workspace của agent được ủy thác qua socket Unix nội bộ (`exec-broker.mjs`) và thực thi dưới tài khoản `agent` (uid 10001, gid 10001) với `no_new_privs` và tước bỏ toàn bộ Linux capabilities (`CAP_NET_RAW`, `CAP_SYS_ADMIN`, v.v.).
5. **Cổng kiểm tra mặc định từ chối (Default-Deny Front Door):** Mọi request chưa xác thực đều bị chặn tại `lib/public-gate.mjs` trước khi chạm tới bất kỳ API nội bộ nào. Các endpoint chỉ dành cho máy cục bộ (như mở file bằng trình soạn thảo desktop) tự động trả về `403 public_mode_disabled`.

---

## 5. Quản lý Workspace từ xa và Git Integration

Trên máy chủ hoặc Render, agent không thao tác trên ổ đĩa local của máy bạn mà thông qua `lib/workspaces.mjs`:

1. **Clone an toàn:** Hỗ trợ clone kho qua HTTPS (GitHub, GitLab) với kiểm tra URL nghiêm ngặt, giới hạn dung lượng tải và thời gian thực thi.
2. **Bảo vệ nhánh chính:** Agent làm việc trên nhánh làm việc riêng biệt (`chatmcp/...`), không thể ghi đè nhánh chính của kho từ xa.
3. **Tạo Pull Request tự động:** Sau khi hoàn thành tác vụ và commit, agent có thể tạo GitHub Pull Request thông qua GitHub REST API (`POST /api/workspace/pr`) với tiêu đề và mô tả giải thích chi tiết thay đổi.
4. **Xuất workspace:** Tải toàn bộ mã nguồn về máy dưới dạng tệp nén tarball (đã tự động lọc bỏ các thư mục nhạy cảm và `.git/`).

---

## 6. Truy cập từ xa bằng SSH tunnel (Tùy chọn không mở cổng)

Nếu tự host trên VPS Linux nhưng không muốn cấu hình domain hay mở cổng ra ngoài:

```bash
ssh -N -L 3007:127.0.0.1:3007 nguoidung@may-chu
# rồi mở http://127.0.0.1:3007 trên trình duyệt máy bạn
```

Hub vẫn chạy ở chế độ cục bộ loopback (`127.0.0.1`), xác thực và mã hóa do SSH đảm nhiệm hoàn toàn.

---

## 7. Nhiều người dùng — BỊ CHẶN (Blocked)

Chạy nhiều người dùng không tin cậy nhau trên cùng một Hub, hoặc mở thành dịch vụ công cộng cho nhiều khách hàng, **bị chặn**:

- Hub là kiến trúc phục vụ một chủ sở hữu tại một thời điểm.
- Docker container thông thường không phải ranh giới cách ly an toàn giữa các tenant thù địch. Cần giải pháp ảo hóa vi mô (như Firecracker microVM hoặc gVisor) với kiểm chứng độc lập trước khi mở đa người dùng.

---

## 8. Danh sách kiểm tra trước khi đưa vào sử dụng

- [ ] Nếu chạy cục bộ: Hub chỉ nghe trên `127.0.0.1` (`netstat -ano | findstr :3007` chỉ thấy `127.0.0.1:3007`).
- [ ] Nếu chạy máy chủ công cộng: `CHATMCP_PUBLIC=1` đã bật, `CHATMCP_OWNER_TOKEN` là chuỗi ngẫu nhiên mạnh (≥ 32 ký tự), kết nối qua HTTPS.
- [ ] Bạn dùng chế độ **Review**, chạy trên nhánh Git riêng, đã commit trước khi giao việc cho agent.
- [ ] API key của nhà cung cấp mô hình có đặt hạn mức chi tiêu định kỳ.
- [ ] Thư mục dữ liệu của Hub được sao lưu thường xuyên.
- [ ] Bạn đã đọc [SECURITY.md](../SECURITY.md) để nắm rõ mô hình bảo vệ và các giới hạn đã biết.
