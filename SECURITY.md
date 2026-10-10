# Bảo mật (SECURITY)

Tài liệu này mô tả mô hình đe dọa **hiện tại** của ChatMCP, sự cố đã biết và cách xử lý. Nó không hứa nhiều hơn những gì đã được kiểm chứng.

## Báo lỗi bảo mật

Dùng **GitHub Security Advisories** của repository (Security → Report a vulnerability). Không đăng chi tiết khai thác, token hay dữ liệu cá nhân trong issue công khai.

## Phạm vi được hỗ trợ

| Kịch bản | Hỗ trợ? |
|---|---|
| Một người dùng, máy Windows của chính họ, Hub chỉ nghe trên `127.0.0.1` | **Có** (mục tiêu chính) |
| Tự host trên VPS Linux cho một người/nhóm tin cậy | Chưa — kế hoạch Phase 2, cần xác thực + HTTPS + hardening |
| Dịch vụ nhiều người dùng / công cộng | **Không.** Cần cô lập cấp VM/microVM và kiểm chứng riêng; chưa có |

## Ranh giới tin cậy và biện pháp hiện có

1. **Dashboard ↔ Hub.** Máy chủ HTTP bind `127.0.0.1:3007`; kiểm tra allowlist `Host`/`Origin`; mọi thao tác ghi cần header `X-ChatMCP-Request` + token CSRF. Không có tài khoản người dùng → **không được** mở cổng này ra mạng, port-forward hay tunnel.
2. **Hub ↔ nhà cung cấp mô hình.** HTTPS. Khóa API nhập trên dashboard có thể lưu mã hóa bằng Windows DPAPI (`windows/Protect-ApiKey.ps1`); không đưa khóa vào mã nguồn, URL hay báo cáo.
3. **Hub ↔ công cụ MCP.** Cloud Harness, Desktop Commander và proxy chạy trên loopback. Bearer token của Cloud Harness tương đương **quyền điều khiển 92 công cụ** (gồm chạy lệnh trong Docker; runner mount Docker socket). Hãy coi nó như mật khẩu quản trị.
4. **Agent ↔ workspace.** `PermissionGate` có các chế độ phê duyệt; `StudioWorkspace` chặn thoát khỏi thư mục dự án (realpath), chặn đọc `.env`; lệnh kiểm thử có thể chạy trong container Docker chỉ-đọc không mạng. **Đây không phải sandbox cấp hệ điều hành**: lệnh shell trên host chạy với quyền của bạn khi được duyệt.
5. **Chế độ ChatGPT Web (legacy, thử nghiệm).** Chỉ dành cho máy của chính bạn, bạn tự đăng nhập. Tiện ích xin quyền `storage`, `alarms` và host `chatgpt.com`/`127.0.0.1:3007`; không có quyền `cookies`. Không dùng cho dịch vụ công cộng, không để vượt hạn mức hay điều khoản của nhà cung cấp.
6. **Mã OAuth ChatGPT (`lib/chatgpt-auth.mjs`, `lib/provider.mjs`).** Không được nối vào Hub; các route tương ứng trả HTTP 410. Là mã chết, sẽ xem xét xóa. Không bật.

## Sự cố đã biết (Phase 0, 2026-10-10)

**S1 — Bearer token Cloud Harness nằm trong lịch sử Git công khai. Mức độ: Cao.**
- 92 file cấu hình MCP client (3 file `mcp-client.hub.json` và 89 bản sao lưu `mcp-client.hub.json.before-*.bak`) trong hai thư mục sao lưu trạng thái được commit ở revision `fdb7653` có chứa header `Authorization: Bearer …`.
- Đã xác minh (so sánh hash, không in giá trị) rằng token này **trùng token đang chạy** của bản Cloud Harness cục bộ. Repository hiện công khai.
- Yếu tố làm tăng rủi ro: một **Cloudflare quick tunnel** (`cloudflared tunnel --url http://127.0.0.1:3100`, do launcher của Cloud Harness khởi động) đã được quan sát **đang chạy** khi audit, đưa `/mcp` ra Internet. Còn một dịch vụ Windows `Cloudflared` tự khởi động mà audit không kiểm tra cấu hình. Yếu tố giảm rủi ro: tên miền tunnel ngẫu nhiên **không xuất hiện** trong bất kỳ revision nào của repository, và workspace của Cloud Harness chạy với `network-none`.
- Đã làm: gỡ các file này khỏi index và chặn bằng `.gitignore` (commit `3571def`). Lịch sử cũ **chưa bị viết lại** — token vẫn truy cập được từ các commit cũ cho tới khi được xoay.
- Cần chủ sở hữu thực hiện: xem **Xoay token** bên dưới, sau đó quyết định cách xử lý lịch sử (giữ nguyên sau khi xoay / viết lại bằng `git filter-repo` + force-push có sự đồng ý / chuyển repo sang private).

**S2 — Dữ liệu trạng thái và nhật ký tác vụ trong lịch sử công khai. Mức độ: Trung bình (riêng tư).**
Các thư mục sao lưu chứa `transcript.jsonl` của các tác vụ trước, `hub.log`, `hub-state.json`, cấu hình MCP và một blob khóa DPAPI (`gateway-key.dpapi`, chỉ giải mã được trên tài khoản Windows gốc). Nội dung này có thể chứa đường dẫn máy, nội dung trao đổi và đầu ra công cụ. Xử lý cùng quyết định lịch sử ở S1.

**S3 — Tài liệu có định danh cá nhân.** `CHATMCP-HUB/README.md` nhắc tên thư mục bài lab của chủ sở hữu. Fixture kiểm thử đã được thay bằng giá trị trung tính. Việc giữ hay sửa tài liệu là quyết định của chủ sở hữu.

**S4 — Desktop Commander có telemetry** (ghi rõ trong `CHATMCP-HUB/THIRD-PARTY-NOTICES.txt`). Chế độ local ở Phase 1 sẽ không phụ thuộc vào nó.

## Xoay token Cloud Harness

Script `scripts/Rotate-CloudHarnessToken.ps1` (Windows PowerShell 5.1). Mặc định là **dry run**.

```powershell
# 1) Xem sẽ đổi gì (không thay đổi, không in token)
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Rotate-CloudHarnessToken.ps1

# 2) Thực hiện: sao lưu, đổi MCP_BEARER_TOKEN trong .env và các mcp-client*.json,
#    tạo lại container Docker, kiểm tra token mới được chấp nhận và token cũ bị từ chối
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Rotate-CloudHarnessToken.ps1 -Apply
```

Lưu ý: bước 2 **khởi động lại các container Cloud Harness** (runner cũng đọc `.env`) — làm khi không có job quan trọng đang chạy. Sau đó: khởi động lại Hub và proxy trình duyệt; cập nhật mọi client ngoài lưu token cũ (cấu hình Claude Code/Codex, biến `CLOUD_HARNESS_MCP_TOKEN`, connector ChatGPT); dừng quick tunnel khi không cần (`cloud-harness-mcp\deploy\.generated\stop-quick-tunnel.ps1`); xóa `rotation-backup-*` và các file `mcp-client*.bak` chứa token cũ khi đã hài lòng.

Script đã được kiểm thử trên PowerShell 5.1 bằng dữ liệu giả (`scripts/tests/Test-RotateToken.ps1`). Dry run trên bản cài thật liệt kê 4 file client + 58 bản sao cũ chứa token. **Chưa chạy `-Apply` trên hệ thống thật.**

## Quy tắc cho người đóng góp

- Không commit: `.env*`, khóa, token, `transcript.jsonl`, `hub-state.json`, log, bản sao lưu, ZIP phát hành, `node_modules`. `.gitignore` đã chặn các mẫu này.
- Trước khi push: `git ls-files -ci --exclude-standard` phải rỗng; nên chạy một công cụ quét bí mật (ví dụ gitleaks) trên diff.
- Không đưa token/khóa vào log, transcript, báo cáo kiểm thử hay thông báo lỗi. Dữ liệu kiểm thử dùng giá trị giả có tiền tố rõ ràng.
- Không sửa mã của Cloud Harness hay gói bên thứ ba tại chỗ; xem [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#chiến-lược-phụ-thuộc).
