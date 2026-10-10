# Phase 2 — Báo cáo: máy chủ tin cậy một chủ sở hữu trên Render (gói free)

> Tài liệu **sống**: được cập nhật theo từng mốc. Thiết kế nằm ở [PHASE2-DESIGN.md](PHASE2-DESIGN.md); hướng dẫn triển khai ở [DEPLOYMENT.md](DEPLOYMENT.md). Nếu hai nơi khác nhau thì báo cáo này là đúng.

**PHASE:** 2 — Trusted self-host (Render free)
**STATUS:** IN PROGRESS (chưa có gì ở đây được tuyên bố là đã xong cho tới khi mục tương ứng ghi *tested* hoặc *verified-live*)

Nhãn: *implemented* (có mã) · *tested* (có test chạy thật, nêu mã thoát) · *verified-live* (đã thử trên dịch vụ thật) · *blocked* (cần thứ tôi không có) · *unverified* (chưa có bằng chứng).

## Trạng thái từng hạng mục

| # | Hạng mục | Nhãn | Bằng chứng |
|---|---|---|---|
| D1 | Chế độ công khai phải bật rõ ràng; cấu hình yếu/thiếu → Hub từ chối khởi động | tested | `verify-public-config.mjs` (10 nhóm kiểm tra), `verify-public-http.mjs` phần "refuses to start" (12 tình huống + 2 tình huống bind), mã thoát ≠ 0, token không bị in ra |
| D2 | Đăng nhập bằng token chủ sở hữu → phiên (cookie `__Host-`, HttpOnly, Secure, SameSite=Strict), CSRF theo phiên, hết hạn rảnh/tuyệt đối | tested | `verify-auth.mjs` (đồng hồ giả), `verify-public-http.mjs` |
| D3 | Từ chối mặc định trước bộ định tuyến | tested | `verify-public-http.mjs`: duyệt ~55 đường GET, mọi `POST_ROUTES`, các phương thức lạ → 401 khi chưa đăng nhập |
| D4 | Host / Origin / HTTPS / tiêu đề an ninh | tested | `verify-public-http.mjs` (Host giả, Origin lạ, `null`, `X-Forwarded-Proto` giả) |
| D5 | Chống dò token (theo địa chỉ + toàn cục) | tested | `verify-auth.mjs`, `verify-public-http.mjs` (X-Forwarded-For giả không đổi được địa chỉ tính hạn mức) |
| D6 | Tách quyền lệnh agent (supervisor + môi giới) | *chưa làm* | — |
| D7 | Bí mật chỉ qua biến môi trường, được che trong log | implemented (phần đăng ký bí mật ở `main()`); test e2e chưa có | — |
| D8–D9 | Workspace (clone/xóa/xuất/push) | *chưa làm* | — |
| D10 | Tắt tính năng không phù hợp khi công khai | tested | `verify-public-http.mjs` (mọi route bị tắt → 403 `public_mode_disabled` kể cả với chủ sở hữu) |
| D11 | Áp dụng cấu hình model từ môi trường | implemented, chưa test | — |
| D12 | Giới hạn tài nguyên | *chưa làm* | — |
| Render | `Dockerfile`, `render.yaml`, triển khai thật | *chưa làm* | — |

Các mục còn lại sẽ được điền ở các mốc sau.
