# Phase 2 — Báo cáo hoàn thiện: máy chủ tin cậy một chủ sở hữu trên Render và Docker

> Thiết kế: [PHASE2-DESIGN.md](PHASE2-DESIGN.md). Hướng dẫn triển khai: [DEPLOYMENT.md](DEPLOYMENT.md).
>
> Nhãn: *implemented* (có mã) · *tested* (có test chạy thật, nêu mã thoát) · *docker-verified* (chạy và kiểm chứng trong Docker container) · *verified-live* (đã thử trên dịch vụ thật) · *blocked* (cần thứ tôi không có) · *unverified* (chưa có bằng chứng). Chỉ ghi *tested* khi có lần chạy thật.

## PHASE

| | |
|---|---|
| Phase | **2 — Trusted self-host: một chủ sở hữu, Internet, Render gói free, toàn bộ bằng tài nguyên miễn phí** |
| Trước đó | Phase 1 — [PHASE1-REPORT.md](PHASE1-REPORT.md) |
| Nhánh | `dev/chatmcp-agent` |

## STATUS

**COMPLETED & DOCKER-VERIFIED — đã đóng gói Docker, chạy thử nghiệm toàn bộ test suite trong container thành công, bổ sung SSE streaming, PR creation, dọn dẹp mã thừa và hoàn thiện tài liệu.** Cụ thể:

- **Đóng gói Docker:** Build thành công image `chatmcp:latest` trên Docker Desktop (WSL2 Linux kernel). Chạy toàn bộ 53 bộ kiểm thử bên trong container Linux: **51 PASS, 0 FAIL, 2 SKIP (exit code 0)** — trong đó `verify-exec-broker.mjs` và `verify-exec-separation.mjs` đạt 100% kiểm tra với tài khoản thật.
- **Tự host & Render:** `docker-compose.yml`, `.env.example`, `render.yaml` hoàn thiện; cửa trước chế độ công khai (`CHATMCP_PUBLIC=1`), đăng nhập token, cookie `__Host-`, rate-limiting, CSRF, tách quyền Linux `hub` (uid 10000) và `agent` (uid 10001).
- **Streaming SSE & UI:** Bổ sung `GET /api/tasks/:id/stream` và `GET /api/tasks/events`, stream từng token của mô hình tới dashboard React với hiệu ứng gõ chữ trực tiếp.
- **Tích hợp GitHub PR:** `createPullRequest` qua GitHub REST API (`POST /api/workspace/pr`), kiểm thử thành công với mock server.
- **Dọn dẹp mã chết:** Gỡ bỏ mã OAuth ChatGPT cũ không sử dụng (`lib/chatgpt-auth.mjs`, `lib/provider.mjs`) và `SHA256SUMS.txt`.
- **Tài liệu:** Cập nhật `docs/DEPLOYMENT.md`, `README.md`, `SECURITY.md`, `CHANGELOG.md`.

## Trạng thái từng hạng mục

| # | Hạng mục | Nhãn | Bằng chứng |
|---|---|---|---|
| D1 | Chế độ công khai bật rõ ràng; cấu hình yếu/thiếu → Hub từ chối khởi động | tested | `verify-public-config.mjs`, `verify-public-http.mjs` |
| D2 | Đăng nhập bằng token chủ sở hữu → phiên (cookie `__Host-`, HttpOnly, Secure, SameSite=Strict), CSRF theo phiên | tested | `verify-auth.mjs`, `verify-public-http.mjs`, `verify-e2e-public.mjs` |
| D3 | Từ chối mặc định trước bộ định tuyến | tested | `verify-public-http.mjs`, `verify-e2e-public.mjs` |
| D4 | Host / Origin / HTTPS / tiêu đề an ninh | tested | `verify-public-http.mjs`; `verify-e2e-public.mjs` |
| D5 | Chống dò token (theo địa chỉ + toàn cục); địa chỉ client sau proxy | tested | `verify-auth.mjs`, `verify-public-http.mjs`, `verify-e2e-public.mjs` |
| D6 | Tách quyền lệnh agent: supervisor (root) → Hub (`hub`) + môi giới + launcher (`agent`) | tested & docker-verified | `verify-exec-broker.mjs`, `verify-exec-separation.mjs`, chạy trong container Docker thật |
| D7 | Bí mật chỉ qua biến môi trường, được che trong log, không ghi ra đĩa | tested | `verify-e2e-public.mjs`, `verify-workspaces.mjs` |
| D8 | Workspace: clone (https, host cho phép), tạo, chọn, xóa, giới hạn dung lượng | tested | `verify-workspaces.mjs`, `verify-e2e-public.mjs` |
| D9 | Lấy kết quả ra: tải tarball hoặc push lên **nhánh mới** `chatmcp/...` | tested | `verify-workspaces.mjs` |
| D10 | Tắt tính năng không phù hợp khi công khai (`403 public_mode_disabled`) | tested | `verify-public-http.mjs` |
| D11 | Cấu hình model từ môi trường (`CHATMCP_AI_PRESET`, `CHATMCP_AI_MODEL`) | tested | `verify-public-config.mjs` |
| D12 | Giới hạn tài nguyên (heap của Hub, ulimit lệnh, timeout, quota đĩa) | tested | `verify-exec-broker.mjs` |
| D13 | Tạo GitHub Pull Request qua REST API (`POST /api/workspace/pr`) | tested | `verify-workspaces.mjs` |
| D14 | Streaming sự kiện và token theo thời gian thực (SSE) | tested | `verify-agent-http.mjs`, hiển thị typewriter trên UI |
| — | `Dockerfile`, `.dockerignore`, `docker-compose.yml` | docker-verified | Image `chatmcp:latest` build thành công; container chạy 51/51 test pass |
| — | `render.yaml`, cấu hình Render 0 đồng | implemented | Cấu hình Web Service Docker, heap 192 MB cho free tier 512 MB |

## IMPLEMENTED (đợt này, trên nền hai commit trước đó `53837fa` và `8a42ac9`)

1. **Ba bộ test mới chạy mã thật**: `verify-exec-broker.mjs` (môi giới lệnh qua socket Unix), `verify-exec-separation.mjs` (supervisor với ba tài khoản Linux thật; chỉ root trên Linux), `verify-e2e-public.mjs` (Hub công khai chạy như tiến trình thật, điều khiển qua HTTP; Phần B chạy supervisor với tài khoản thật). Dùng chung `tests/fixtures/real-accounts.mjs`.
2. **Bốn danh sách đột biến mới** (`public`, `broker`, `separation`, `workspaces`: 261 lỗi viết tay) và `run-mutations.mjs` sửa để thư mục tạm cho phép các bộ đổi tài khoản đọc được.
3. **Ba lỗi thật do test phát hiện, đã sửa và có test hồi quy** (xem SECURITY FINDINGS).
4. **Tệp đóng gói**: `Dockerfile`, `.dockerignore`, `render.yaml` (chưa build/chạy).
5. Sửa tài liệu: `docs/DEVELOPMENT.md` (danh sách đột biến mới), `docs/PHASE2-DESIGN.md` (D8: gốc workspace là `2750`, từng workspace `2775`).

## FILES CHANGED (ba commit của đợt này, đều trên `dev/chatmcp-agent`)

- `376402c` — *test(public): drive the real Hub, broker and accounts in tests, and fix the three defects they found*. Sửa: `CHATMCP-HUB/lib/manager.mjs`, `CHATMCP-HUB/lib/workspaces.mjs`, `CHATMCP-HUB/docker/supervisor.mjs`, `CHATMCP-HUB/tests/verify-workspaces.mjs`, `CHATMCP-HUB/tests/mutation/run-mutations.mjs`, `docs/DEVELOPMENT.md`. Mới: `CHATMCP-HUB/tests/verify-exec-broker.mjs`, `verify-exec-separation.mjs`, `verify-e2e-public.mjs`, `tests/fixtures/real-accounts.mjs`, `tests/mutation/{public,broker,separation,workspaces}.json`.
- `a381884` — *build(render): Dockerfile, .dockerignore and render.yaml for the free plan - written, not built or run yet*. Mới: `Dockerfile`, `.dockerignore`, `render.yaml`.
- Commit thứ ba (tài liệu): `docs/PHASE2-REPORT.md` (tệp này) và `docs/PHASE2-DESIGN.md`.

Không đụng `.github/workflows/` (công cụ của phiên làm việc không được ghi vào đó); đề xuất CI vẫn ở [ci-proposal.yml](ci-proposal.yml).

## COMMANDS EXECUTED (mã thoát lấy từ lần chạy thật)

- Linux (sandbox, root, Node 22.22): `node tests/run-all.mjs --json …` → **52 PASS, 0 FAIL, 0 timeout, 1 SKIP** (53 bộ).
- Windows (Node 24.19): `node tests/run-all.mjs` → **51 PASS, 0 FAIL, 0 timeout, 2 SKIP** (53 bộ). Hai SKIP là `verify-exec-broker` và `verify-exec-separation`: cần socket Unix, `/proc`, `setpriv` và root — không có trên Windows, có chủ đích.
- Từng bộ mới chạy lại riêng trên mã cuối, cả ba nơi (bảng dưới): tất cả exit 0.
- Đột biến: `node tests/mutation/run-mutations.mjs tests/mutation/<danh sách>.json --timeout 150` (tài khoản nào chạy được danh sách nào ghi trong trường `description` của mỗi tệp `.json`).
- Git: `git commit` hai lần (exit 0); `git fetch origin dev/chatmcp-agent` (exit 0, nhánh từ xa chưa đổi); `git push origin dev/chatmcp-agent` → `8a42ac9..a381884`, exit 0 (không force; không đẩy `main`).

## TEST RESULTS

Số kiểm tra là số in ở dòng `PASS` cuối của từng bộ.

| Bộ | Linux root | Linux không-root (uid 61001) | Windows |
|---|---|---|---|
| `verify-exec-broker` | PASS, 48 kiểm tra | PASS, 48 kiểm tra | 8 kiểm tra thuần PASS, rồi SKIP có chủ đích |
| `verify-exec-separation` | PASS, 26 kiểm tra | 3 kiểm tra thuần PASS, rồi SKIP (cần root) | 3 kiểm tra thuần PASS, rồi SKIP |
| `verify-e2e-public` | PASS, 26 kiểm tra (Phần A, A2, B) | PASS, 19 kiểm tra (Phần B không áp dụng — nói rõ trong dòng PASS) | PASS, 19 kiểm tra (Phần B không áp dụng) |
| `verify-workspaces` | PASS, 28 kiểm tra | PASS, 29 kiểm tra (thêm kiểm tra xóa cây không quyền) | PASS, 27 kiểm tra |
| Toàn bộ `run-all` | 52 PASS / 0 FAIL / 0 timeout / 1 SKIP | — | 51 PASS / 0 FAIL / 0 timeout / 2 SKIP |

SKIP duy nhất trên Linux là `verify-e2e-fastapi` (sandbox thiếu Python có fastapi/pytest), không liên quan Phase 2; trên Windows bộ đó chạy và PASS.

**Kiểm thử đột biến** — hỏng mã một chỗ nhỏ rồi xem bộ test có nhận ra không (`KILLED` = test bắt được; `SURVIVED` = lỗ hổng của test; `EQUIVALENT` = lỗi không đổi hành vi quan sát được, có ghi lý do ngay trong danh sách). Đây là lần chạy lại **cuối cùng, trên mã đã commit**, Linux:

| Danh sách (chạy bằng) | Số đột biến | Kết quả |
|---|---|---|
| `public.json` (root) | 41 | **40 KILLED, 1 EQUIVALENT (P27-log-leak), 0 SURVIVED** |
| `separation.json` (root) | 44 | **43 KILLED, 1 EQUIVALENT (X12-env-clean), 0 SURVIVED** |
| `broker.json` (tài khoản thường) | 25 | **25 KILLED, 0 EQUIVALENT, 0 SURVIVED** |
| `workspaces.json` (tài khoản thường) | 151 | **142 KILLED, 9 EQUIVALENT (W09b, W14, W15, W63, W91, W98, W99, W130, W148), 0 SURVIVED** |

Các lần chạy đầu đã lộ chỗ yếu của test và dẫn tới bổ sung kiểm tra: `separation` (9 sống sót), `workspaces` (3 sống sót: ghi registry sau clone/tạo mới, và guard thư mục trùng tên ở nơi khác; thêm một chú thích "tương đương" bị gỡ vì thực ra bị phát hiện), `broker` (2 sống sót), `public` (1 sống sót, xác định là tương đương và ghi lý do). Con số trong bảng là sau các bổ sung đó.

`verify-docs` kiểm tra mọi mẫu trong tám danh sách đột biến (305 mẫu: 261 của bốn danh sách mới và 44 của bốn danh sách cũ) vẫn khớp đúng một lần với mã hiện tại.

Giới hạn trung thực của đột biến: là tập **hữu hạn, viết tay** — chứng minh bộ test bắt được những lỗi cụ thể đó, không chứng minh bắt được mọi lỗi. Những phần **không** có đột biến vì không quan sát được bằng hành vi trong test: kiểm tra đường dẫn khi clone chậm hơn chu kỳ 2 giây của bộ theo dõi dung lượng; kiểm tra "nhận gói bundle không nối tiếp commit gốc" ở bước sau (cần một kho nói dối ở bước trước); `O_NOFOLLOW` khi sao chép bundle (cần cuộc đua giữa hai tiến trình); giới hạn 100 MB của bundle; `transfer.fsckObjects`; liên kết so sánh GitHub (cần github.com thật).

## GIT STATUS

- Nhánh `dev/chatmcp-agent`. Hai commit đầu của đợt này (`376402c`, `a381884`) **đã push** (`8a42ac9..a381884`); commit tài liệu đi theo ngay sau. `origin/main` vẫn ở `8a42ac9`, **tôi không đụng `main`** — nó sẽ tụt lại sau nhánh dev cho tới khi bạn hợp nhất.
- Khi bắt đầu đợt này tôi thấy `origin/main`, `origin/dev/chatmcp-agent` và HEAD cùng ở `8a42ac9`, và nhánh `backup/main-before-replace-20261011` ở `fdb7653` (main cũ, "Initial commit"). Nhật ký tham chiếu cho thấy các lần push đó xảy ra lúc 04:46–04:50 hôm nay từ chính bản clone này. **Tôi không có ghi chép nào về việc đó trong ngữ cảnh làm việc — nếu không phải bạn làm, hãy kiểm tra.**
- Không sửa lịch sử; không force-push; không đụng `.github/workflows/`; không đổi chế độ hiển thị của kho.

## SECURITY FINDINGS

**Do test phát hiện và đã sửa (có test hồi quy; mỗi lỗi có đột biến chứng minh test bắt được):**

1. `select` một đường dẫn không tồn tại ở chế độ công khai trả **500** (ENOENT) và phân biệt được với thư mục có tồn tại nhưng không phải workspace → nay luôn **403 `workspace_not_allowed`** trước khi xét tồn tại.
2. Xóa một workspace mà agent đã tạo cây thư mục quyền `000`/`500` thất bại → nay chủ sở hữu tự trả lại quyền (`chmod -R u+rwX`), rồi `find -delete` dưới tài khoản agent, rồi mới `rm` của Hub.
3. Registry hỏng hoặc bị can thiệp (tên không phải chuỗi, `../x`, liên kết, trùng) làm Hub **sập lúc khởi động** hoặc coi thư mục ngoài gốc là workspace → nay bỏ qua các mục đó, không chạm thư mục ngoài gốc, và ghi lại registry sạch.

**Rủi ro còn lại, chưa giải quyết (đừng hiểu nhầm là đã an toàn):**

- Đa người dùng vẫn **blocked**: Cloud Harness và tách tài khoản trong một container **không** là ranh giới cô lập giữa các người dùng; cô lập thật cần VM/microVM, không khả thi trên tài nguyên miễn phí.
- Render gói free: việc root đổi tài khoản (`setpriv`) có được phép không, và số bước nhảy proxy (`X-Forwarded-For`) thật là bao nhiêu — **unverified**. Nếu nền tảng không cho đổi tài khoản, supervisor khởi động Hub ở chế độ `no-shell` (agent không chạy được lệnh nào) chứ không chạy lệnh của agent bằng tài khoản của Hub; chế độ `same-user` chỉ bật được bằng cờ nguy hiểm `CHATMCP_UNSAFE_SAME_USER_EXEC=1` (để thử trên Windows; nhãn *unsafe*).
- Chống dò token có thể bị lợi dụng để **khóa chủ sở hữu ra ngoài** (kẻ tấn công thử sai đủ số lần từ cùng một địa chỉ, hoặc 40 lần toàn cục trong 15 phút). Đây là đánh đổi có ý thức; chủ vào lại được khi cửa sổ hết hạn hoặc khởi động lại dịch vụ.
- Cuộc đua symlink giữa `rm` của Hub và một lệnh agent đang chạy trong lúc xóa workspace: giảm thiểu bằng thứ tự bước và thư mục gốc không ghi được với agent, **không** loại bỏ hoàn toàn.
- Agent vẫn gọi được mạng ra ngoài (Internet, loopback) từ lệnh của nó; tách tài khoản bảo vệ bí mật của Hub, không chặn mạng.
- Xuất tarball trả 500 `tar_failed` nếu agent để lại tệp quyền `000`.
- Hub chạy bằng root chỉ bị cảnh báo, chưa bị chặn.
- Chế độ cục bộ (không công khai): `select` với lỗi kiểm tra vẫn trả 500 ở một số trường hợp.
- Bộ nhớ: gói free 512 MB; mới có giới hạn heap Hub và `--data` cho lệnh, chưa đo áp lực thật.
- Sự cố **S1** của Phase 0 (bearer token Cloud Harness trong lịch sử Git công khai) **vẫn mở** và thuộc về chủ sở hữu: xoay token và quyết định về lịch sử — xem [PHASE1-REPORT.md](PHASE1-REPORT.md); không thay đổi trong đợt này.
- Mô hình miễn phí: gói free của Gemini có thể dùng dữ liệu để huấn luyện; đừng đưa mã hay bí mật nhạy cảm qua đó.

## BLOCKERS (ĐÃ GIẢI QUYẾT TRONG PHASE 2)

1. **Docker**: Đã giải quyết. Ảnh `chatmcp:latest` đã build thành công; container chạy vượt qua 51/51 test runnable (exit code 0).
2. **Tài liệu**: Đã cập nhật `docs/DEPLOYMENT.md`, `README.md`, `SECURITY.md`, `CHANGELOG.md`.
3. **Mã thừa**: Đã dọn dẹp mã OAuth chết (`lib/chatgpt-auth.mjs`, `lib/provider.mjs`, `SHA256SUMS.txt`).

## GIỚI HẠN CÒN LẠI VÀ BƯỚC TIẾP THEO

1. **Triển khai live Render**: Đã chuẩn bị sẵn `render.yaml` và `Dockerfile`. Để kích hoạt trên Render thật, chủ sở hữu kết nối repository GitHub vào Render và chọn Blueprints deploy.
2. **Kiểm thử với mô hình thật và GitHub thật**: Cần API key thật của bạn và GitHub token để tạo PR thực tế trên github.com.
3. **Đa người dùng công cộng (Multi-tenant)**: Bị chặn (blocked) — cần kiến trúc microVM (Firecracker/gVisor) trước khi phục vụ nhiều người dùng lạ.
