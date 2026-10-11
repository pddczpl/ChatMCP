# Phase 2 — Báo cáo tạm: máy chủ tin cậy một chủ sở hữu trên Render (gói free)

> Tài liệu **sống**; đây là bản **tạm dừng giữa chừng** theo yêu cầu của chủ sở hữu (2026-10-11: lệnh dừng lúc 05:33, nhắc lại lúc 12:17, giờ Việt Nam). Thiết kế: [PHASE2-DESIGN.md](PHASE2-DESIGN.md). Hướng dẫn triển khai: [DEPLOYMENT.md](DEPLOYMENT.md) — **vẫn ghi trạng thái cũ ("Phase 2 chưa làm"), chưa được viết lại** (xem [BLOCKERS](#blockers)). Nếu hai nơi khác nhau thì báo cáo này mới đúng.
>
> Nhãn: *implemented* (có mã) · *tested* (có test chạy thật, nêu mã thoát) · *verified-live* (đã thử trên dịch vụ thật) · *blocked* (cần thứ tôi không có) · *unverified* (chưa có bằng chứng). Chỉ ghi *tested* khi có lần chạy thật; không có hạng mục nào ở đây là *verified-live*.

## PHASE

| | |
|---|---|
| Phase | **2 — Trusted self-host: một chủ sở hữu, Internet, Render gói free, toàn bộ bằng tài nguyên miễn phí** |
| Trước đó | Phase 1 — [PHASE1-REPORT.md](PHASE1-REPORT.md) |
| Nhánh | `dev/chatmcp-agent` |

## STATUS

**PAUSED — xong phần mã và kiểm thử của Hub công khai; chưa đóng gói thử, chưa triển khai.** Cụ thể:

- Có thật và đã kiểm thử (Linux sandbox với tài khoản thật, và Windows): cửa trước chế độ công khai (đăng nhập, phiên, CSRF, Host/Origin/HTTPS, mặc định từ chối), dịch vụ workspace (clone, tạo, chọn, xuất, xóa, push lên nhánh mới), tách tài khoản của lệnh agent (supervisor + môi giới + launcher) kèm bằng chứng lúc khởi động, giới hạn tài nguyên của lệnh.
- **Chưa có**: ảnh Docker chưa được build lần nào; `render.yaml` chưa được dùng; chưa có triển khai thật trên Render; tài liệu triển khai chưa viết lại; chưa dọn tệp thừa.
- **Không có hạng mục nào `verified-live`.** Mọi bằng chứng là test chạy cục bộ (máy chủ Git HTTP trên localhost, Hub thật, tài khoản Linux thật trong sandbox) — chưa phải Render, chưa phải GitHub thật.

## Trạng thái từng hạng mục

| # | Hạng mục | Nhãn | Bằng chứng |
|---|---|---|---|
| D1 | Chế độ công khai bật rõ ràng; cấu hình yếu/thiếu → Hub từ chối khởi động | tested | `verify-public-config.mjs`, `verify-public-http.mjs` (phần "the Hub refuses to start") |
| D2 | Đăng nhập bằng token chủ sở hữu → phiên (cookie `__Host-`, HttpOnly, Secure, SameSite=Strict), CSRF theo phiên | tested | `verify-auth.mjs`, `verify-public-http.mjs`, `verify-e2e-public.mjs` (Hub thật, qua HTTP) |
| D3 | Từ chối mặc định trước bộ định tuyến | tested | `verify-public-http.mjs`, `verify-e2e-public.mjs` |
| D4 | Host / Origin / HTTPS / tiêu đề an ninh | tested | `verify-public-http.mjs`; `verify-e2e-public.mjs` Phần A2 (cấu hình giống `render.yaml`: `RENDER_EXTERNAL_HOSTNAME`, `X-Forwarded-Proto`) |
| D5 | Chống dò token (theo địa chỉ + toàn cục); địa chỉ client sau proxy | tested; **số bước nhảy proxy thật của Render: unverified** | `verify-auth.mjs`, `verify-public-http.mjs`, `verify-e2e-public.mjs` Phần A2 |
| D6 | Tách quyền lệnh agent: supervisor (root) → Hub (tài khoản `hub`) + môi giới + launcher chạy lệnh dưới tài khoản `agent` | tested với tài khoản Linux thật trong sandbox (root) · **chưa chạy trong Docker/Render** | `verify-exec-broker.mjs`, `verify-exec-separation.mjs`, `verify-e2e-public.mjs` Phần B (12 kiểm tra lúc khởi động + kiểm tra lần hai với tiến trình server thật) |
| D7 | Bí mật chỉ qua biến môi trường, được che trong log, không ghi ra đĩa | tested | `verify-e2e-public.mjs` (quét đĩa sau khi chạy, có hai canary chứng minh bộ quét nhìn thấy được rò rỉ), `verify-workspaces.mjs` (token GitHub không có trên đĩa/log) |
| D8 | Workspace: clone (https, host cho phép), tạo, chọn (chỉ thư mục do Hub tạo), xóa, giới hạn số lượng và dung lượng | tested | `verify-workspaces.mjs` (máy chủ Git HTTP thật trên localhost), `verify-e2e-public.mjs` |
| D9 | Lấy kết quả ra: tải tarball (loại `.git`, `node_modules`, tệp bí mật) hoặc push lên **nhánh mới** (không force, token chỉ trong môi trường của một tiến trình Git) | tested với máy chủ Git cục bộ · **push lên GitHub thật: unverified** | `verify-workspaces.mjs` (kể cả `.git` bị can thiệp: remote, insteadOf, proxy, hook, fsmonitor, filter) |
| D10 | Tắt tính năng không phù hợp khi công khai (`403 public_mode_disabled`) | tested | `verify-public-http.mjs` |
| D11 | Cấu hình model từ môi trường (`CHATMCP_AI_PRESET`, `CHATMCP_AI_MODEL`) | implemented; đọc cấu hình tested (`verify-public-config.mjs`); **áp vào Hub đang chạy lúc khởi động (`hub.mjs`): unverified** | — |
| D12 | Giới hạn tài nguyên (heap của Hub, `--data`/nproc/nofile/fsize của lệnh, thời gian lệnh, số workspace/dung lượng) | implemented; từng giới hạn của môi giới tested; **áp lực bộ nhớ thật dưới 512 MB: unverified** | `verify-exec-broker.mjs` |
| — | `Dockerfile`, `.dockerignore` | implemented · **chưa build, chưa chạy** | — |
| — | `render.yaml`, triển khai trên Render | implemented (tệp) · **chưa triển khai** | — |

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

## BLOCKERS

1. **Docker**: ảnh chưa build; cần `docker build` trên Docker Desktop của bạn (máy Windows này đã có) rồi chạy `verify-exec-separation` và `verify-e2e-public` **bên trong container** — việc kế tiếp của tôi.
2. **Render**: cần tài khoản Render đã đăng nhập (tôi không tạo tài khoản, không vượt CAPTCHA/đăng nhập) và nhánh trên GitHub; chỉ có thể `verified-live` sau khi dịch vụ chạy thật.
3. **CI**: đề xuất workflow ở `docs/ci-proposal.yml` cần bạn áp dụng (công cụ của phiên không ghi vào `.github/workflows/`).
4. **Tài liệu chưa viết lại**: `docs/DEPLOYMENT.md`, `SECURITY.md`, `README`, `CHANGELOG` (chưa có mục chế độ công khai), `USER-GUIDE`, `TROUBLESHOOTING`, `ARCHITECTURE` còn nội dung trước Phase 2; **`DEPLOYMENT.md` đang mâu thuẫn với mã** (ghi "Phase 2 chưa làm").
5. Đa người dùng: blocked (xem trên).

## NEXT PRIORITY

1. Build và chạy ảnh Docker cục bộ (Docker Desktop) với biến môi trường giống Render: `healthz`, 401 khi chưa đăng nhập, đăng nhập, Host sai, CSRF, clone, `supervisor.mjs --self-test`; chạy `verify-exec-separation` + `verify-e2e-public` bên trong container; sửa `Dockerfile`/`render.yaml` theo kết quả thật.
2. Viết lại `DEPLOYMENT.md` (kèm hướng dẫn chạy hoàn toàn miễn phí, giới hạn của Render free có ngày tháng, cảnh báo quyền riêng tư của Gemini free) và cập nhật các tài liệu còn lại.
3. Dọn tệp thừa **đã theo dõi và khôi phục được** (mã OAuth chết sau khi chứng minh không ai import, `SHA256SUMS.txt` cũ, tên máy cá nhân trong script Windows, tên phòng lab trong `CHATMCP-HUB/README.md`…). Không đụng thư mục sao lưu/cứu hộ/ZIP/clone chưa được theo dõi.
4. Triển khai Render nếu phiên Render đã đăng nhập (nhánh triển khai là `dev/chatmcp-agent` vì `main` tụt lại); nếu không, dừng ở ranh giới đăng nhập và nêu đúng các bước thủ công tối thiểu.
5. Báo cáo cuối Phase 2 sau lần chạy lại toàn bộ.
