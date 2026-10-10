# Triển khai

> **Trạng thái trung thực (2.3.0):** chỉ có **một** kiểu triển khai được hỗ trợ và đã được kiểm thử: **một người dùng, trên máy của chính họ, Hub nghe ở `127.0.0.1`**. Self-host trên máy chủ (Docker Compose, đăng nhập, HTTPS, sao lưu tự động, CI/CD triển khai) là **Phase 2 và chưa được làm**. Đa người dùng (multi-tenant) là **bị chặn** cho tới khi có bằng chứng cô lập. Tài liệu này nói rõ cái gì có, cái gì không, và cái gì cần chủ sở hữu quyết định.

| Kiểu triển khai | Trạng thái | Bằng chứng |
|---|---|---|
| Một người dùng, Windows 11, `127.0.0.1`, tự khởi động bằng launcher | **implemented · integration-tested · e2e-verified** (mô hình giả; xem README) | toàn bộ bộ Node chạy trên Windows 11 (Node 24) và Linux (Node 22); smoke thật trên Windows |
| Một người dùng, Linux/macOS, `127.0.0.1`, `node hub.mjs` | **implemented · integration-tested trên Linux**; macOS chưa kiểm thử; launcher `.cmd/.ps1` chỉ cho Windows | toàn bộ bộ Node chạy trên Linux |
| Máy chủ tin cậy (VPS Linux), truy cập từ xa qua đăng nhập + HTTPS | **chưa làm** (Phase 2) | Không có Dockerfile, Compose, lớp đăng nhập, cấu hình HTTPS, hay CI triển khai trong repo |
| Truy cập từ xa bằng đường hầm SSH tới Hub loopback | **chưa kiểm chứng** (xem mục 4) | — |
| Nhiều người dùng trên cùng một Hub / dịch vụ công cộng | **blocked** | Hub không có tài khoản, không có cô lập giữa người dùng; Cloud Harness không phải ranh giới cô lập |
| Triển khai thật lên server của bạn | **chưa thực hiện, chưa được ủy quyền** | — |

## 1. Chạy trên máy cá nhân (được hỗ trợ)

Làm theo [WINDOWS-SETUP.md](WINDOWS-SETUP.md). Tóm tắt các tính chất triển khai:

- Hub là một tiến trình Node duy nhất, nghe ở `127.0.0.1:3007` (cổng và địa chỉ bind cố định ở loopback; **không có** tùy chọn bind ra ngoài).
- Không đăng ký dịch vụ Windows, không tự chạy khi khởi động máy, không thay đổi ExecutionPolicy, không mở cổng ra mạng.
- Dữ liệu ở `%LOCALAPPDATA%\ChatMCP\hub` (Linux: `$XDG_STATE_HOME/chatmcp` hoặc `~/.local/state/chatmcp`; macOS: `~/Library/Application Support/ChatMCP/hub`). Đổi bằng `-StateDir` / `--state-dir` / `CHATMCP_STATE_DIR`.
- Kiểm tra sức khỏe: `GET http://127.0.0.1:3007/api/health` trả phiên bản và `uiBuild` (launcher dùng chính endpoint này).

### Cập nhật

```powershell
.\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd
git pull --ff-only            # hoặc git switch sang nhánh/tag bạn muốn
.\CHATMCP-HUB\START-CHATMCP-HUB.cmd -ProjectPath C:\duong\dan\du-an
```

Sau khi cập nhật, bấm `Ctrl+F5` trong trình duyệt. Dữ liệu cũ được nạp lại; tác vụ đang dở ở bản trước được đánh dấu *Tạm dừng* hoặc *Chưa rõ kết quả* (không được chạy lại). Đọc [CHANGELOG.md](../CHANGELOG.md) trước khi nâng cấp.

### Sao lưu và khôi phục dữ liệu của Hub

Thủ công, vì Hub không có sao lưu tự động:

1. **Dừng Hub** (`STOP-CHATMCP-HUB.cmd`) để không sao chép giữa lúc đang ghi.
2. Sao chép nguyên thư mục dữ liệu sang nơi an toàn của bạn (ổ khác, ổ mã hóa).
3. Khôi phục = dừng Hub, đưa thư mục về chỗ cũ, khởi động lại.

Lưu ý quan trọng:

- Thư mục chứa **toàn bộ lịch sử và đầu ra công cụ** (có thể có nội dung nhạy cảm của dự án): bản sao lưu phải được bảo vệ như chính dự án.
- API key lưu bằng **Windows DPAPI** chỉ giải mã được bởi *cùng tài khoản Windows trên cùng máy*. Khôi phục sang máy/tài khoản khác thì key không dùng được; nhập lại key. (Trên Linux/macOS key mã hóa bằng AES-256-GCM với `master.key` trong thư mục dữ liệu hoặc `CHATMCP_MASTER_KEY`; sao lưu `master.key` cùng thư mục thì ai có bản sao đều mở được key, nên bảo vệ bản sao.)
- Mã nguồn dự án của bạn được sao lưu bằng Git, không bằng Hub. Checkpoint của Hub **không** thay thế Git.

## 2. Vì sao không được mở Hub ra mạng

Hub cho phép (khi bạn duyệt, hoặc ngay lập tức ở chế độ Tự động/Full Access) đọc, sửa file và **chạy lệnh bằng quyền của người chạy Hub**. Các lớp bảo vệ hiện có (kiểm tra `Origin`, `Host` allow-list, token CSRF, từ chối POST không phải JSON) chống lại *trang web độc hại mở trong trình duyệt của chính bạn*. Chúng **không phải xác thực**: Hub không có tài khoản, mật khẩu hay phiên đăng nhập. Ai kết nối được tới cổng và gửi đúng tiêu đề đều điều khiển được agent.

Do đó:

- Đừng đặt Hub sau cổng chuyển tiếp, ngrok/Cloudflare Tunnel, reverse proxy công khai, hay `netsh portproxy`.
- Đừng chạy Hub trên máy dùng chung với người khác mà không tin họ: mọi người dùng cục bộ cùng máy đều kết nối được tới `127.0.0.1`.
- Nếu bạn đang chạy đường hầm công khai cho Cloud Harness (backend cũ), đó là rủi ro riêng — xem [SECURITY.md](../SECURITY.md), mục "Sự cố đã biết từ Phase 0".

## 3. Self-host trên máy chủ tin cậy — Phase 2 (chưa làm)

Mục tiêu: một người (hoặc nhóm nhỏ tin nhau) chạy Hub trên VPS Linux của mình và dùng từ trình duyệt qua HTTPS.

**Chưa có trong repo** và phải làm trước khi gọi là "triển khai được":

| Hạng mục | Tình trạng | Ghi chú thiết kế |
|---|---|---|
| Tùy chọn bind (`--host`) và danh sách `Host` cho phép cấu hình được | chưa có | Hiện cứng `127.0.0.1` và `127.0.0.1:<cổng>`, `localhost:<cổng>` |
| **Lớp đăng nhập** cho toàn bộ giao diện và API | chưa có | Bắt buộc trước khi bind ra ngoài loopback; phải chống brute force, đặt cookie `Secure; HttpOnly; SameSite=Strict`, tách khỏi token CSRF |
| HTTPS | chưa có | Dự kiến kết thúc TLS ở reverse proxy (ví dụ Caddy); cần tên miền (**quyết định của chủ sở hữu**) |
| Đóng gói (Dockerfile, Compose) | chưa có | Người dùng không phải root, hệ thống file chỉ đọc, **không** mount `docker.sock`, volume riêng cho dữ liệu và cho thư mục dự án, `HEALTHCHECK` trên `/api/health` |
| Giới hạn tài nguyên và mạng của tiến trình chạy lệnh | chưa có | Hiện lệnh chạy cùng quyền với Hub; trên máy chủ cần cô lập (container/VM) |
| Sao lưu tự động, xoay vòng nhật ký, giám sát | chưa có | Hiện chỉ sao lưu thủ công (mục 1) |
| CI/CD (build, quét, đẩy ảnh, triển khai) | chưa có | `ci.yml` hiện chỉ chạy test; **chưa từng chạy trên GitHub** |
| Kịch bản kiểm thử triển khai (đăng nhập sai, tấn công vượt Host, chạy lại sau khi khởi động lại container) | chưa có | Phải có trước khi tuyên bố "đã triển khai" |

**Điều kiện để bắt đầu Phase 2** (cần bạn quyết định, tôi không tự giả định):

1. Máy chủ nào, hệ điều hành nào, ai là người dùng (một hay nhiều).
2. Tên miền và cách cấp chứng chỉ.
3. Cách đăng nhập (mật khẩu duy nhất cho một người dùng? OIDC? chỉ qua VPN/Tailscale?).
4. Cho phép xây dựng và thử Docker trên máy Windows của bạn (Docker Desktop) hay chỉ viết cấu hình.
5. Không có thao tác nào trên server thật cho tới khi bạn cho phép bằng văn bản và đưa thông tin truy cập theo cách an toàn.

## 4. Truy cập từ xa bằng SSH tunnel — chưa kiểm chứng

Có một cách không cần thêm mã: chạy Hub trên VPS bằng một tài khoản Linux **không có đặc quyền** (loopback), rồi từ máy của bạn mở đường hầm:

```bash
ssh -N -L 3007:127.0.0.1:3007 nguoidung@may-chu
# rồi mở http://127.0.0.1:3007 trên máy của bạn
```

Vì trình duyệt thấy `127.0.0.1:3007`, kiểm tra `Host` và `Origin` của Hub đều đạt. Xác thực và mã hóa do SSH đảm nhiệm.

**Nhãn: chưa kiểm chứng.** Dự án này chưa chạy Hub trên máy chủ từ xa. Khi dùng cách này, hãy hiểu rằng: tệp và lệnh của agent nằm trên *máy chủ*, dưới quyền tài khoản Linux đó; ai đăng nhập được vào tài khoản đó đều điều khiển được agent; Hub vẫn chỉ phục vụ một người; Docker socket không bao giờ nên cho tài khoản này. Launcher `.cmd/.ps1` không dùng được trên Linux — dùng `node hub.mjs --backend local --project <thư mục> --no-open`.

## 5. Nhiều người dùng — bị chặn

Chạy nhiều người dùng trên một Hub, hoặc làm dịch vụ cho người ngoài, đòi hỏi các điều dưới đây; **không điều nào có sẵn hoặc đã được chứng minh**:

- Tài khoản, phiên đăng nhập, phân quyền theo người dùng.
- Mỗi người dùng/dự án chạy trong một **VM hoặc microVM** riêng (không chỉ là container chia sẻ nhân), với giới hạn CPU/bộ nhớ/đĩa/mạng và không có đường đi sang dữ liệu của người khác.
- Bằng chứng kiểm thử cô lập (người dùng A không đọc/ghi/liệt kê/suy ra dữ liệu của B; kể cả qua symlink, đường dẫn, biến môi trường, nhật ký, cổng cục bộ).
- Chính sách dữ liệu, xóa dữ liệu, kiểm toán, giới hạn lạm dụng.

Cloud Harness (phụ thuộc cũ) **không** cung cấp ranh giới cô lập: nó chạy công cụ trong Docker với socket được mount và một bearer token duy nhất. Không được dùng nó để tuyên bố đa người dùng an toàn. Chế độ "ChatGPT Web" là đường cũ, chỉ thử nghiệm cục bộ, bạn tự đăng nhập; nó không được dùng cho dịch vụ công cộng.

## 6. Danh sách kiểm tra trước khi bạn tin một triển khai

- [ ] Hub chỉ nghe trên `127.0.0.1` (`netstat -ano | findstr :3007` chỉ thấy `127.0.0.1:3007`).
- [ ] Không có tunnel, port-forward hay proxy công khai nào trỏ tới cổng Hub.
- [ ] Bạn dùng chế độ **Review**, chạy trên nhánh Git riêng, đã commit trước khi giao việc.
- [ ] Key API có hạn mức chi tiêu thấp ở nhà cung cấp.
- [ ] Thư mục dữ liệu của Hub được sao lưu và nằm trên ổ bạn kiểm soát.
- [ ] Bạn đã đọc [SECURITY.md](../SECURITY.md), đặc biệt phần giới hạn đã biết và phần quyết định đang chờ.
