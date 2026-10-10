# Phase 0 — Kiểm toán hiện trạng ChatMCP

- **Ngày:** 2026-10-10 · **Nhánh:** `dev/chatmcp-agent` · **Nền:** `fdb7653` (Initial commit)
- **Môi trường đo:** Windows 11 (10.0.26300), Node 24.19.0, npm 12.2.0, Git 2.55.0.windows.5, Python 3.11.9, Docker 29.8.1, PowerShell 5.1.26100; và một workspace Linux (Node 22.23.2) đọc cùng mã nguồn.
- **Phương pháp:** đọc cấu trúc và mã; kiểm tra Git (trạng thái, lịch sử, gitlink, file bị track); quét bí mật với đầu ra đã che (không in giá trị); đối chiếu bản Cloud Harness cục bộ với GitHub; chạy toàn bộ kiểm thử bằng một runner thống nhất và ghi mã thoát thật.
- **Chưa làm (cố ý hoặc do chặn):** không có chạy đầu-cuối với mô hình thật; không chạy bộ giao diện Python/Playwright; không triển khai; không push; không xoay token; không viết lại lịch sử Git; không dừng tiến trình đang chạy.

Nhãn trạng thái dùng trong tài liệu: `implemented` · `unit-tested` · `integration-tested` · `e2e-verified` · `production-verified` · `blocked`. Không mục nào dưới đây đạt `e2e-verified` hay `production-verified`.

## 1. Bảng hiện trạng theo module

| Module | Hiện trạng | Nhãn | Bằng chứng | Khoảng trống chính |
|---|---|---|---|---|
| **UI/UX** | Dashboard React (16.0.x nhúng offline), sáng/tối, Command Palette, cây file/editor, Git review, bảng terminal, danh sách nhiệm vụ, hộp phê duyệt | implemented · integration-tested (fixture DOM/HTTP) | `verify-v2-http`, `verify-studio-http`, `verify-recovery-dom`…; bộ Playwright chưa chạy | Không có onboarding lần đầu; chế độ mặc định là ChatGPT Web; gửi tin nhắn tự bật dịch vụ MCP; React cũ; chuỗi giao diện chỉ tiếng Việt |
| **Agent runtime** | `AgentRunner` + 4 công cụ định tuyến, transcript bền, `pendingCall`/không phát lại, tự tiếp tục, sửa lỗi Gemini, nén khi 413 | implemented · integration-tested với mô hình giả | `verify-persistent-sessions`, `verify-studio-recovery` (29), `verify-gemini-*`, `verify-gateway-*` | Chưa chạy với mô hình thật; chỉ có Gemini native và OpenAI chat-completions; không có Anthropic/streaming; không có máy trạng thái nhiệm vụ tường minh; công cụ ghi/chạy lệnh chỉ qua MCP |
| **MCP** | Danh mục/mô tả/gọi qua Cloud Harness (Docker) + Desktop Commander + proxy | implemented · integration-tested với mock | `verify-agent-autotools`, `verify-agent-http`; Docker và Cloud Harness đang chạy trên máy nhưng audit **không** gọi công cụ thật | Hub bắt buộc `--repo-root` tới Cloud Harness (thư mục trạng thái nằm trong đó); từ chối chạy nếu thiếu một trong hai server |
| **Workspace** | Cây/đọc/tìm kiếm, checkpoint → review → accept/restore, chặn thoát workspace và `.env`, chỉ mục AST, sandbox Docker chỉ-đọc | implemented · unit/integration-tested | `verify-studio-core` (40), `verify-studio-http`, `verify-v2-runtime` (25), `verify-phase0-regressions` (12) | Agent chưa có công cụ ghi/sửa file cục bộ (`studio.*` chỉ đọc + kế hoạch) |
| **Git/GitHub** | `git status/diff`, checkpoint, review, rollback; công cụ GitHub nằm trong Cloud Harness | Git cục bộ: implemented · unit-tested; GitHub: chưa kiểm chứng | `verify-studio-core`, `verify-studio-http` | Chưa có commit/branch/PR trong Hub; luồng PR chưa được thử |
| **Authentication** | Chỉ loopback + Host/Origin + CSRF + mã ghép cặp tiện ích; khóa API DPAPI tùy chọn; OAuth ChatGPT bị vô hiệu (HTTP 410) | implemented (một người dùng) · integration-tested | `verify-v2-http`, `verify-studio-verifications` (route CSRF/Origin) | Không có tài khoản/phiên; không dùng được khi mở ra mạng |
| **Deployment** | Launcher Windows (`START-CHATMCP-HUB.cmd`), Cloud Harness bằng Docker Compose của upstream | implemented (thủ công) | chạy được trên máy tác giả (theo ghi chép phát hành, không do audit này chạy) | Không có Compose cho Hub, HTTPS, health/backup, CI chạy thật; launcher cứng đường dẫn `F:\…` |
| **Security** | `PermissionGate` (3 chế độ × 3 chính sách), chặn đường dẫn, DPAPI, sandbox test | implemented · unit/integration-tested | `verify-full-access` (15), `verify-studio-core` | Xem mục 2 (token lộ, tunnel); phân quyền theo tên công cụ, không phân tích lệnh; chưa có chế độ Read Only |

## 2. Phát hiện

### Bảo mật

| ID | Mức | Phát hiện | Trạng thái |
|---|---|---|---|
| S1 | **Cao** | Bearer token Cloud Harness nằm trong 92 file cấu hình MCP client của lịch sử Git **công khai**; đã xác minh trùng token đang chạy (so hash) | **Mở** — cần chủ sở hữu xoay token (script sẵn: `scripts/Rotate-CloudHarnessToken.ps1`, đã test với dữ liệu giả, chưa chạy thật) |
| S1b | **Cao** | Một Cloudflare quick tunnel đang chạy (`cloudflared tunnel --url http://127.0.0.1:3100`, khởi động bởi launcher của Cloud Harness), đưa `/mcp` (92 công cụ, runner mount Docker socket) ra Internet, chỉ được bảo vệ bằng bearer. Tên miền tunnel (cấu hình trong `.env` của Cloud Harness) không xuất hiện trong bất kỳ revision nào của repo. Ngoài ra còn một dịch vụ Windows `Cloudflared` (tự khởi động) mà audit **không** kiểm tra cấu hình — cần xem trong Cloudflare dashboard có hostname nào trỏ tới `127.0.0.1:3100` không | **Mở** — chờ quyết định của chủ sở hữu; audit không dừng hay đổi tiến trình/dịch vụ nào |
| S2 | Trung bình | Thư mục sao lưu trạng thái có `transcript.jsonl`, `hub.log`, cấu hình, một blob DPAPI nằm trong lịch sử công khai | **Mở** — cùng quyết định lịch sử với S1 |
| S3 | Thấp | `CHATMCP-HUB/README.md` nhắc tên bài lab; fixture kiểm thử đã được trung hòa | Fixture: **đã sửa**; tài liệu: chờ chủ sở hữu |
| S4 | Thấp | Desktop Commander gửi telemetry theo upstream | Ghi nhận; Phase 1 không phụ thuộc nó |
| S5 | Thấp | Mã OAuth ChatGPT (`chatgpt-auth.mjs`, `provider.mjs`) không được nối, route trả 410 | Ghi nhận; đề xuất xóa sau khi chủ sở hữu đồng ý |

### Vệ sinh repository

| ID | Mức | Phát hiện | Trạng thái |
|---|---|---|---|
| H1 | Trung bình | 581 file bị track nhầm: `node_modules` (302), 2 thư mục sao lưu trạng thái (167), thư mục `RESCUE-…` (109), 3 ZIP | **Đã sửa** `3571def` (gỡ khỏi index, file còn nguyên trên đĩa) |
| H2 | Trung bình | 2 gitlink (`cloud-harness-mcp`, bản rescue) không có `.gitmodules` | **Đã sửa** `e9cfba4` |
| H3 | Thấp | `README.md` gốc là UTF-16 chỉ chứa một dòng | **Đã sửa** (UTF-8, trung thực) |
| H4 | Thấp | Không có `.gitignore`/`.gitattributes`/`.editorconfig` | **Đã sửa** `2089911` |

### Chất lượng và vận hành

| ID | Mức | Phát hiện | Trạng thái |
|---|---|---|---|
| R1 | Trung bình | Baseline Windows 19/25: đường dẫn `F:\F:\` (dùng `.pathname`), `symlink` EPERM, `checkpoints()` so sánh đường dẫn không chuẩn hóa, trích dẫn PowerShell, `node-pty` JS có nhưng thiếu native → terminal tương tác sập, `close()` không đợi nên `rmdir` lỗi | **Đã sửa** `d6f2817` → 26/26 |
| R2 | Trung bình | POSIX: dừng terminal chỉ giết shell, tiến trình con còn chạy ngầm | **Đã sửa** `d6f2817` (process group) |
| R3 | Trung bình | Hub bắt buộc đường dẫn Cloud Harness; không chạy cục bộ không Docker | **Mở** — Phase 1 |
| R4 | Trung bình | Mặc định ChatGPT Web; gửi tin nhắn tự bật dịch vụ MCP | **Mở** — Phase 1 |
| R5 | Trung bình | Lệnh có dấu nháy kép lồng nhau hỏng trên PowerShell 5.1 | **Mở** — ghi tài liệu; `ShellRunner` ở Phase 1 |
| R6 | Thấp | `npm test` chỉ chạy 11/25 suite | **Đã sửa** `3448b74` |
| R7 | Thấp | React 16.0.x nhúng; gói npm chạy lúc dùng chưa có lockfile | **Mở** |
| R8 | Thông tin | Phân quyền theo tên công cụ; hằng `SENSITIVE` không dùng; không có chế độ Read Only | **Mở** — Phase 1 |

## 3. Baseline kiểm thử (mã thoát thật, bằng `tests/run-all.mjs`)

| Môi trường | Trước sửa | Sau sửa |
|---|---|---|
| Windows 11 · Node 24.19.0 | **19 pass / 6 fail** (25 suite) | **26 pass / 0 fail** (26 suite, runner thoát 0) |
| Linux · Node 22.23.2 | 25 pass / 0 fail | **26 pass / 0 fail** |

6 suite fail ban đầu: `verify-first-message`, `verify-studio-core`, `verify-studio-http`, `verify-studio-verifications`, `verify-v2-http`, `verify-v2-runtime`. Suite thứ 26 (`verify-phase0-regressions`, 12 kiểm tra) fail đúng chỗ trên mã trước khi sửa. Kiểm thử script: `Test-RotateToken.ps1` (19 kiểm tra) và `Test-Bootstrap.ps1` pass trên PowerShell 5.1; `test-bootstrap.sh` pass trên Linux. Không chạy: bộ giao diện Python (4), CI trên GitHub.

## 4. Thay đổi đã thực hiện (đều trên `dev/chatmcp-agent`, chưa push)

| Commit | Nội dung |
|---|---|
| `e9cfba4` | Gỡ 2 gitlink Cloud Harness khỏi index (giữ thư mục trên đĩa) |
| `2089911` | `.gitignore`, `.gitattributes` (không ép viết lại CRLF hiện có), `.editorconfig` |
| `3571def` | Gỡ `node_modules`, backup trạng thái, `RESCUE-…`, ZIP khỏi index (581 file; còn nguyên trên đĩa) |
| `3448b74` | `tests/run-all.mjs` — `npm test` chạy mọi suite, mã thoát thật, timeout, giết cây tiến trình |
| `d6f2817` | Sửa terminal (probe PTY + fallback pipe, `close()` đợi thoát, process group), `checkpoints()` chuẩn hóa đường dẫn, tính di động của test + suite hồi quy mới |
| `873b5c4` | `deps/cloud-harness.lock.json`, bootstrap/verify Cloud Harness, script xoay token + test |
| (commit tài liệu) | README UTF-8, SECURITY, ARCHITECTURE, DEVELOPMENT, THIRD-PARTY-NOTICES, audit này, CI |

Lịch sử Git **không bị viết lại**; không có force-push; không file nào của người dùng bị xóa.

## 5. Quyết định cần chủ sở hữu

1. **Xoay token Cloud Harness** (S1) và có dừng quick tunnel (S1b) hay không. Chỉ cần trả lời "xoay token"; có thể tự chạy theo [SECURITY.md](../SECURITY.md).
2. **Lịch sử Git công khai** (S1/S2): *A* giữ nguyên sau khi đã xoay token; *B* viết lại lịch sử bằng `git filter-repo` và force-push (cần sự đồng ý rõ ràng, ảnh hưởng mọi bản clone); *C* chuyển repository sang private.
3. Quyền **push** nhánh `dev/chatmcp-agent` và mở PR; và khóa API/đồng ý chi phí nếu muốn kiểm thử đầu-cuối với mô hình thật.
4. Xóa mã OAuth ChatGPT chết, sửa tên bài lab trong tài liệu (S3, S5).

## 6. Bước tiếp theo (Phase 1)

Backend thực thi cục bộ không cần Docker/Cloud Harness · lớp adapter nhà cung cấp (OpenAI, Anthropic, Gemini, tương thích OpenAI) và kho bí mật · máy trạng thái nhiệm vụ · chế độ Read Only/Review/Autonomous có phân tích lệnh · onboarding và mặc định chế độ API · kiểm thử khói Windows với mô hình giả · thêm các kịch bản đầu-cuối.
