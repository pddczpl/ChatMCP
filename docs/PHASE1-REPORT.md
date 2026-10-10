# Báo cáo Phase 1 — Coding Agent cục bộ (Hub 2.3.0)

> **Ngày:** 2026-10-11 · **Nhánh:** `dev/chatmcp-agent` (chưa push) · **Nền:** `fdb7653` · **Hub:** `2.3.0`, giao diện `2.3.0-react-agent`
>
> Báo cáo theo đúng mẫu của bản yêu cầu: `PHASE · STATUS · IMPLEMENTED · FILES CHANGED · COMMANDS EXECUTED · TEST RESULTS · GIT STATUS · SECURITY FINDINGS · BLOCKERS · NEXT PRIORITY`.
>
> **Cách đọc.** Chỉ ghi *PASS* khi có mã thoát thật của lần chạy được nêu; chỗ chưa chạy thật ghi `blocked` hoặc `chưa làm`. **"E2E" ở đây là Hub thật + công cụ thật + mô hình giả có kịch bản**, không phải mô hình thật. Nhãn: `implemented` → `unit-tested` → `integration-tested` → `e2e-verified` → `production-verified`; `blocked` = thiếu điều kiện bên ngoài mà tôi không được phép hay không thể tự có (khóa API, quyền của bạn, hạ tầng).

## PHASE

| | |
|---|---|
| Phase | **1 — Local Coding Agent chạy được trên Windows 11, một người dùng** |
| Trước đó | Phase 0: kiểm toán, vệ sinh repository, baseline — [PHASE0-AUDIT.md](PHASE0-AUDIT.md) |
| Sau đó | Phase 2 (tự host tin cậy) — **chưa bắt đầu**; cần quyết định của bạn ([BLOCKERS](#blockers), [DEPLOYMENT.md](DEPLOYMENT.md)) |
| Phạm vi | một người dùng, máy cục bộ; Hub chỉ nghe `127.0.0.1`; không đa người dùng, không production |
| Máy đã đo | Windows 11 (Node 24.19.0, Git 2.55.0.windows.5, Python 3.11.9, Windows PowerShell 5.1) và Linux (Node 22.22.0) |

## STATUS

**Kết luận.** Phase 1 **xong về mặt kỹ thuật ở mức `e2e-verified` với mô hình giả**, trên Windows 11 và Linux: Hub chạy một mình, bạn nối một nhà cung cấp mô hình, giao việc, và agent đọc/sửa file, chạy lệnh, dùng Git qua cổng phê duyệt, có checkpoint, và khi Hub chết giữa chừng thì **không phát lại** thao tác chưa rõ kết quả. **Chưa có mục nào `production-verified`.** Năm điều chưa được chứng minh, đừng hiểu nhầm:

1. **Chưa chạy với mô hình thật.** Adapter Anthropic / OpenAI-chat / Gemini mới được thử với máy chủ giả (cần khóa API và đồng ý chi phí của bạn). **Không có streaming**: mỗi lượt một yêu cầu, một phản hồi.
2. **Chưa tạo Pull Request GitHub thật** (cần xác thực của bạn). Nhánh, commit và push tới *kho bare cục bộ* thì đã thử.
3. **Chưa có người dùng thật** chạy hướng dẫn lần đầu (đã chạy bằng Chromium thật + mô hình giả).
4. **CI chưa từng chạy trên GitHub**, và bản cập nhật workflow chưa được áp dụng (công cụ của phiên làm việc không được ghi vào `.github/workflows/`).
5. **Đa người dùng bị chặn**; Phase 2 chưa làm.

Và một việc **khẩn, chỉ bạn làm được**: sự cố bảo mật Phase 0 **S1** (bearer token Cloud Harness nằm trong lịch sử Git công khai) **vẫn mở** — xem [SECURITY FINDINGS](#security-findings) và [BLOCKERS](#blockers).

### Đối chiếu từng hạng mục Phase 1 của bản yêu cầu

| Hạng mục | Nhãn | Bằng chứng chính |
|---|---|---|
| Agent orchestration: vòng lặp, công cụ, kế hoạch | e2e-verified (mô hình giả) | `verify-local-backend`, các bộ `verify-e2e-*` |
| Adapter nhiều nhà cung cấp (Anthropic, OpenAI-chat/tương thích, Gemini) | integration-tested (`fetch` giả). Mô hình thật: **blocked** | `verify-model-adapters` |
| Gọi công cụ đáng tin cậy (schema thật, lỗi có cấu trúc, dò khả năng khi "Lưu & kiểm tra") | integration-tested | `verify-model-adapters`, `verify-local-backend` |
| Workspace, sửa file, terminal, Git, kế hoạch | e2e-verified | `verify-local-tools`, `verify-e2e-bugfix`, `verify-e2e-git`, `verify-e2e-fastapi` |
| Phục hồi phiên, không phát lại thao tác ghi chưa rõ kết quả | e2e-verified (giết Hub thật giữa chừng) | `verify-e2e-recovery`, `verify-task-state` |
| Phê duyệt: Chỉ đọc / Review / Tự động | e2e-verified, kể cả trong Chromium thật | `verify-permissions-modes`, `verify-ui-e2e.py` |
| 11 trạng thái nhiệm vụ | e2e-verified | `verify-task-state`; `verify-docs` đối chiếu sơ đồ trong ARCHITECTURE với mã |
| Giao diện và hướng dẫn lần đầu | browser-tested (Playwright, Hub thật, mô hình giả) | `verify-ui-e2e.py` |
| Smoke test Windows | đã chạy trên Windows PowerShell 5.1 với một Hub 2.3.0 thật | [TEST RESULTS](#test-results) |
| Tài liệu bắt buộc | 14 tài liệu (4 ở thư mục gốc, 10 trong `docs/`); liên kết, neo, phiên bản và các con số được test đối chiếu với mã | `verify-docs` |
| E2E 1 — dựng ứng dụng FastAPI test-first | e2e-verified (pytest và uvicorn thật) | `verify-e2e-fastapi` |
| E2E 2 — sửa lỗi trong dự án có sẵn | e2e-verified | `verify-e2e-bugfix` |
| E2E 3 — nhánh, commit, Pull Request | nhánh + commit + push tới kho bare cục bộ: e2e-verified. **PR GitHub thật: blocked** | `verify-e2e-git` |
| E2E 4 — phục hồi phiên | e2e-verified | `verify-e2e-recovery` |
| E2E 5 — cô lập người dùng A/B | hai Hub tách biệt: e2e-verified. **A/B trong một deployment: blocked** | `verify-e2e-isolation` |
| E2E 6 — repo độc hại | e2e-verified | `verify-e2e-adversarial` |
| Cổng chất lượng: test | PASS ([TEST RESULTS](#test-results)) | `npm test` |
| Cổng chất lượng: build / lint / typecheck | **không có trong dự án này** (Node ESM không build, không có linter hay hệ thống kiểu). Thay bằng `node --check` cho mọi nguồn JS và `py_compile` cho Python: Windows (Node 24.19.0) `node --check` 107 tệp và `py_compile` (Python 3.11.9) 6 tệp: 0 lỗi; Linux (Node 22.22.0): 107 và 6 tệp, 0 lỗi ([Kiểm tra tĩnh](#kiểm-tra-tĩnh)) | — |
| Cổng chất lượng: không lộ bí mật | e2e-verified (quét yêu cầu gửi mô hình, transcript, log, trạng thái, đĩa) + quét tĩnh trước commit: 19 phát hiện, **tất cả là giá trị giả cố ý** trong `CHATMCP-HUB/tests/`; không có phát hiện nào ở `lib/`, `web/`, script hay tài liệu ([N4](#phát-hiện-mới-khi-đóng-phase-1)) | `verify-e2e-adversarial` |
| Cổng chất lượng: CI xanh | **chưa chạy** (blocked) | — |

## IMPLEMENTED

1. **Hub chạy độc lập.** `START-CHATMCP-HUB.cmd` (hoặc `node hub.mjs`) chạy backend `local` mặc định: không `--repo-root`, không Docker, không Cloud Harness, không Desktop Commander; chỉ nghe `127.0.0.1:3007`; trạng thái ở `%LOCALAPPDATA%\ChatMCP\hub` (hoặc `--state-dir`). Backend `mcp` cũ còn nguyên (`--backend mcp`, legacy). Launcher chạy nền, chờ kiểm tra sức khỏe, dùng lại Hub đang chạy và không đổi ExecutionPolicy.
2. **18 công cụ cục bộ** (`lib/local-tools.mjs`): đọc/liệt kê/tìm file; ghi và sửa nguyên tử (chống ghi đè thay đổi mới bằng `expected_sha256`); tạo thư mục, đổi tên, xóa; `git_status/diff/log/add/commit/branch`; `run_command` (Git Bash trước, PowerShell sau); kế hoạch công việc. Hỗ trợ: `fs-safe`, `glob`, `git-runner`, `shell-runner`, `protected-paths`.
3. **Cổng quyền và an toàn thực thi.** `PermissionGate` với *Chỉ đọc / Review / Tự động*; phân tích lệnh (`read`/`verify`/`edit`/`exec`/`dangerous`) đi theo đường dẫn thật qua symlink, junction, tên 8.3 và ổ PowerShell (`command-paths`); kiểm tra cấu hình và hook của kho Git trước khi chạy `git` (`git-trust`); vùng cấm `.env*`, khóa riêng, `.git`; lọc biến môi trường dạng khóa; timeout giết cả cây tiến trình; checkpoint trước mỗi thay đổi (không tạo được thì không chạy). Hộp phê duyệt hiển thị lệnh/diff nguyên văn, 10 phút không trả lời = từ chối. **Heuristic bảo thủ, không phải sandbox.**
4. **Lớp mô hình.** Anthropic Messages, OpenAI-compatible (đã làm chắc), Gemini; 12 preset; tải danh sách model; thử lại có giãn cách; rút gọn ngữ cảnh có kiểm soát; che bí mật trong lỗi và nhật ký. Khóa API: Windows DPAPI (đã thử vòng khứ hồi thật), AES-256-GCM ở nơi khác, biến môi trường, hoặc chỉ giữ trong bộ nhớ.
5. **Tác vụ và phục hồi.** Máy trạng thái chuẩn 11 trạng thái với lịch sử chuyển; Hub chết giữa chừng thì tác vụ vào `paused`/`uncertain` và **không bao giờ** chạy lại thao tác ghi chưa rõ kết quả. Hub ghi **bằng chứng** (số lần sửa file thành công, lệnh kiểm tra đã chạy và thoát mã 0) dưới kết quả: "Hoàn tất" không còn đồng nghĩa với "đạt".
6. **Giao diện.** Hướng dẫn lần đầu 4 bước, form nhà cung cấp, công tắc quyền cạnh ô nhập, khung duyệt, banner trạng thái dừng giữa chừng, thẻ kế hoạch (`web/onboarding.js`, `web/ui-logic.js`, `web/react-app.js`).
7. **Kiểm thử.** Bộ chạy chung `npm test` (mã thoát thật, `TIMEOUT`, `SKIP` không bao giờ là PASS, `--no-skip`), 46 bộ Node và 5 bộ giao diện, khung E2E với mô hình giả có kịch bản, công cụ kiểm thử đột biến. Xem [DEVELOPMENT.md](DEVELOPMENT.md).
8. **Tài liệu và script.** README, ARCHITECTURE, DEVELOPMENT, WINDOWS-SETUP, USER-GUIDE, TROUBLESHOOTING, DEPLOYMENT, SECURITY, TESTING-WITH-REAL-MODELS, THIRD-PARTY-NOTICES, CHANGELOG, PHASE0-AUDIT, PHASE1-DESIGN và báo cáo này. Bốn script PowerShell trong `CHATMCP-HUB/windows/` (smoke, watch, soak, kiểm tra gateway qua Hub) không còn ghi cứng `2.2.x`: phiên bản mong đợi lấy từ `package.json` cạnh chúng, bản dựng giao diện lấy từ `/api/health`; mã thoát phản ánh kết quả thật (soak trước đây thoát 0 dù Hub không trả lời mẫu nào). `scripts/Rotate-CloudHarnessToken.ps1` (mặc định chỉ xem trước) và khóa phiên bản phụ thuộc ở `deps/`.

Chỗ hiện thực **khác thiết kế** (không streaming, một cấu hình nhà cung cấp tại một thời điểm, Git Bash trước PowerShell, …) nằm ở [PHASE1-DESIGN.md, mục 6.2](PHASE1-DESIGN.md#62-điểm-hiện-thực-khác-thiết-kế).

## FILES CHANGED

Phạm vi: từ `fdb7653` đến `HEAD` của `dev/chatmcp-agent`. Tái tạo bằng `git diff --stat fdb7653..HEAD`.

| Khu vực | Thay đổi | Ghi chú |
|---|---|---|
| `CHATMCP-HUB/lib/` | 32 tệp, +4727 / −282 | **Mới:** `local-tools`, `shell-runner`, `git-runner`, `git-trust`, `command-analysis`, `command-paths`, `protected-paths`, `fs-safe`, `glob`, `task-state`, `standard-adapter`, `anthropic-api`, `openai-chat-api`, `model-http`, `model-list`, `model-history`, `provider-presets`, `secret-box`, `tool-probe`, `tool-schema`, `assemble`. **Sửa:** `manager`, `permissions`, `agent`, `dual-agent`, `catalog`, `gateway-provider`, `launch`, `studio-resumer`, `studio-workflow`, `studio-workspace` |
| `CHATMCP-HUB/web/` | 5 tệp, +1052 / −99 | **Mới:** `onboarding.js`, `ui-logic.js`. **Sửa:** `react-app.js`, `index.html`, `react.css` |
| `CHATMCP-HUB/hub.mjs`, `Start/Stop-ChatMcpHub.ps1`, `package.json` | sửa | backend mặc định `local`, launcher độc lập, `test:ui` |
| `CHATMCP-HUB/tests/` | 50 tệp, +9131 / −41 | bộ chạy chung, bộ kiểm tra chính nó, khung E2E (`tests/e2e/`), 6 bộ E2E, công cụ đột biến (`tests/mutation/`), bộ đối chiếu tài liệu, `requirements-*.txt` |
| `CHATMCP-HUB/windows/` | 4 script sửa | không còn cứng phiên bản |
| `docs/`, `README.md`, `SECURITY.md`, `CHANGELOG.md`, `THIRD-PARTY-NOTICES.md` | 14 tệp, +1920 dòng (không tính chính báo cáo này) | 14 tài liệu Markdown (4 ở thư mục gốc, 10 trong `docs/`, kể cả báo cáo này) và `docs/ci-proposal.yml` |
| `scripts/`, `deps/`, `.github/`, `.gitignore`, `.gitattributes`, `.editorconfig` | mới (Phase 0) | công cụ xoay token, khóa phiên bản, CI, quy tắc Git |
| Gỡ khỏi theo dõi, **không xóa khỏi đĩa** | 581 file + 2 gitlink | `node_modules`, bản sao lưu trạng thái, thư mục `RESCUE-…`, ZIP, bản clone lồng nhau |

Không có tệp nào của người dùng bị xóa hay ghi đè; bản sao lưu, clone và ZIP vẫn nguyên trên đĩa.

## COMMANDS EXECUTED

Các lệnh dưới đây là lệnh *có thể chạy lại* (từ thư mục `CHATMCP-HUB`, Windows PowerShell hoặc PowerShell 7); kết quả ở mục sau.

```powershell
# 1. Mọi bộ Node; một bộ bị SKIP bị tính là lỗi (Windows 11, Node 24.19.0)
node tests/run-all.mjs --no-skip all --json ..\deploy\.generated\win-final.json

# 2. Bộ giao diện Chromium/Playwright (venv có playwright trên PATH; xem DEVELOPMENT.md)
node tests/run-all.mjs --python --filter ui --no-skip all

# 3. Kiểm thử đột biến (mỗi danh sách chạy vài phút; không thuộc npm test)
node tests/mutation/run-mutations.mjs tests/mutation/isolation.json
node tests/mutation/run-mutations.mjs tests/mutation/task-state.json
node tests/mutation/run-mutations.mjs tests/mutation/scrub.json
node tests/mutation/run-mutations.mjs tests/mutation/fastapi.json

# 4. Kiểm tra cú pháp (không có build/lint/typecheck trong dự án)
Get-ChildItem hub.mjs, lib\*.mjs, tests\*.mjs, tests\e2e\*.mjs, tests\mutation\*.mjs, web\*.js | ForEach-Object { node --check $_.FullName }
```

Ngoài ra trong phiên làm việc: Git chỉ-đọc (`status`, `log`, `diff`, `check-ignore`, `ls-files -ci`), `git add` với **đường dẫn tường minh** và `git commit` cục bộ trên nhánh `dev/chatmcp-agent`; đối chiếu `sha256sum` từng tệp sau mỗi lần đồng bộ sang máy Windows; tạo môi trường Python riêng `deploy\.generated\venv-e2e` (`pip install -r tests/requirements-e2e.txt`, `-r tests/requirements-ui.txt`); chạy bốn script PowerShell trong `windows/` trên Windows PowerShell 5.1 với một Hub 2.3.0 thật.

**Cố ý KHÔNG chạy** (cần bạn quyết định, hoặc nằm ngoài quyền được giao):

- `scripts\Rotate-CloudHarnessToken.ps1 -Apply` (đổi bí mật thật và khởi động lại container);
- dừng hay chỉnh `cloudflared` / dịch vụ Windows `Cloudflared`;
- `git push`, `git filter-repo`, force-push, merge vào `main`, viết lại lịch sử, xóa nhánh;
- xóa bản sao lưu, clone, ZIP, thư mục `RESCUE-…`;
- gọi nhà cung cấp mô hình thật hay GitHub API (không có khóa, không có ủy quyền);
- triển khai lên máy chủ hay mở cổng ra mạng;
- đổi ExecutionPolicy hay cấu hình toàn máy (script chạy với `-ExecutionPolicy Bypass` chỉ cho riêng tiến trình);
- ghi vào `.github/workflows/` (công cụ bị chặn, và tôi không tìm cách vòng qua).

## TEST RESULTS

### Bộ Node đầy đủ

| Môi trường | Lệnh | Kết quả | Tổng thời gian các bộ |
|---|---|---|---|
| Windows 11 · Node 24.19.0 | `node tests/run-all.mjs --no-skip all` | **46 PASS**, 0 FAIL, 0 TIMEOUT, **0 SKIP** | 243 s |
| Linux · Node 22.22.0 | `node tests/run-all.mjs` | 45 PASS, **1 SKIP** (`verify-e2e-fastapi`), 0 FAIL, 0 TIMEOUT | 180 s |

Trên Linux bộ `verify-e2e-fastapi` báo **SKIP** (không có Python với `fastapi`, `httpx`, `pytest`, `uvicorn`); đó là lý do bộ này chỉ được tính là đã chạy thật trên Windows, nơi `--no-skip all` biến một SKIP thành lỗi. Một lượt chạy đầu tiên, trước khi báo cáo này tồn tại, cho đúng một lỗi: `verify-docs` báo 6 liên kết trỏ tới tệp này — bộ test đối chiếu tài liệu làm đúng việc của nó. Cả hai lần chạy trên được thực hiện trên cây mã **đã commit** (đến `716af42`); chỉ còn tài liệu, `tests/verify-docs.mjs` (đã có mặt trong lần chạy nhưng chưa commit) và một dòng chú thích trong `tests/verify-model-adapters.mjs` được commit sau đó. Sau khi báo cáo được điền xong, `verify-docs` được chạy lại riêng trên Windows và Linux (xem [Kiểm tra tĩnh](#kiểm-tra-tĩnh)).

### Bộ giao diện (Chromium thật, Hub thật, mô hình giả)

Windows 11 · Node 24.19.0 · Python 3.11.9 (môi trường ảo có `playwright`): `node tests/run-all.mjs --python --filter ui --no-skip all` → **6 PASS**, 0 FAIL, 0 SKIP, tổng 39 giây.

| Bộ | Kết quả | Thời gian |
|---|---|---|
| `verify-ui-e2e.py`: hướng dẫn lần đầu 4 bước, duyệt và từ chối, Chỉ đọc, Tự động, trong trình duyệt thật với Hub thật và mô hình giả | PASS | 26.3 s |
| `verify-v2-ui.py` | PASS | 4.5 s |
| `verify-react-ui.py` | PASS | 4.3 s |
| `verify-auto-project-ui.py` | PASS | 2.6 s |
| `verify-studio-ui.py` | PASS | 1.2 s |
| `verify-ui-logic.mjs`: quyết định của giao diện, chạy không cần trình duyệt | PASS | 0.4 s |

Bộ giao diện **chưa chạy trên Linux** (môi trường đó không có gói Python `playwright`). Ngoài tôi ra, chưa ai dùng giao diện này.

### Kiểm thử đột biến

Mỗi lần hỏng **một chỗ** của mã trong bản sao tạm, chạy bộ test, rồi xem nó có fail không (`KILLED` = tốt). Kết quả chạy trên cây hiện tại; chi tiết công cụ ở [DEVELOPMENT.md](DEVELOPMENT.md#kiểm-thử-đột-biến).

| Danh sách (số đột biến) | Bộ test bị thử | Windows 11 · Node 24.19.0 | Linux · Node 22.22.0 |
|---|---|---|---|
| `isolation.json` (21): cửa vào của Hub, nhốt workspace, lưu và rò rỉ khóa API, trạng thái từng Hub | `verify-e2e-isolation` | 19 KILLED · 2 N/A | 20 KILLED · 1 N/A |
| `task-state.json` (17): ghi trước khi chạy công cụ, khởi động lại, luật chuyển trạng thái | `verify-task-state` | 16 KILLED · 1 EQUIVALENT | 16 KILLED · 1 EQUIVALENT |
| `scrub.json` (2): lọc biến môi trường của tiến trình con | `verify-shell-runner` | 2 KILLED | 2 KILLED |
| `fastapi.json` (4): lệnh nào được tính là bằng chứng kiểm tra | `verify-e2e-fastapi` | 4 KILLED | không chạy được: bộ test SKIP vì không có Python với `fastapi` |
| **Cộng (44)** | | **41 KILLED · 1 EQUIVALENT · 2 N/A · 0 SURVIVED** | **38 KILLED · 1 EQUIVALENT · 1 N/A · 0 SURVIVED** (4 chưa chạy) |

**0 đột biến sống sót** ở cả hai hệ điều hành; hợp hai bên, 43 trong 44 đột biến bị phát hiện ít nhất một lần và 1 là tương đương (`task-state` M15, ghi lý do trong danh sách).

**`N/A` không phải là "bỏ qua cho dễ".** Lần chạy đầu của `isolation.json` trên Windows cho 18 `KILLED` và **2 `SURVIVED`** (M06 và M13). Phân tích: cả hai nhắm vào kho khóa AES-GCM và chế độ tệp `0600` của Linux/macOS, đoạn mã mà Windows không bao giờ chạy (Windows dùng DPAPI), nên không có test nào trên Windows *có thể* phát hiện chúng; đó là đột biến không áp dụng chứ không phải lỗ hổng của bộ test. Công cụ được bổ sung trường `platforms` (đột biến chỉ chạy ở hệ điều hành nó có nghĩa, ở nơi khác báo `N/A`, không bao giờ coi là "sống sót" hay "bị giết") và thêm **M06w**, bản đột biến tương ứng cho DPAPI (lưu khóa dạng văn bản thường): trên Windows nó bị phát hiện (`KILLED`), nên lỗi "khóa nằm trơ trên đĩa" được bắt ở cả hai nền tảng bằng hai đột biến khác nhau. Chế độ tệp `0600` của M13 không có tương đương trên NTFS và **chưa được thử** ở đó.

`EQUIVALENT` là đột biến không đổi hành vi (một dòng phòng thủ thừa), có ghi lý do trong danh sách. Đây là **44 đột biến viết tay**: chúng chứng minh bốn bộ test đó bắt được những lỗi cụ thể này, không chứng minh chúng bắt được mọi lỗi.

### Script PowerShell với Hub thật (Windows PowerShell 5.1)

Trình điều khiển dùng một lần (`deploy\.generated\ps-final.ps1`, không nằm trong Git) khởi động một **Hub 2.3.0 thật** với thư mục trạng thái tạm, cổng ngẫu nhiên và một mô hình giả có kịch bản, rồi chạy từng script bằng `powershell.exe -NoProfile -ExecutionPolicy Bypass -File …` (Windows PowerShell 5.1.26100). Mã thoát dưới đây là mã thật của từng lần chạy:

| Script | Tình huống | Mã thoát | Quan sát |
|---|---|---|---|
| `Run-StudioSmoke.ps1` | Hub đúng | 0 | 6/6 kiểm tra PASS |
| | `-ExpectedVersion 0.0.1` | 1 | kiểm tra phiên bản FAIL ("Wrong version"), 5 kiểm tra còn lại PASS |
| | không có Hub (cổng 59999) | 1 | 6/6 FAIL |
| `Test-Gateway-ViaHub.ps1` | Hub đúng | 0 | `SUCCESS … toolCalling=supported` (tới mô hình giả, không phải nhà cung cấp thật) |
| | không có Hub | 1 | `Gateway test failed` |
| `Run-StudioSoak.ps1` (1 phút, 5 giây/mẫu) | Hub đúng | 0 | 12/12 mẫu tốt, p95 1 ms |
| | không có Hub | 1 | 0/9 mẫu tốt (trước khi sửa, script này thoát 0 trong đúng tình huống này) |
| `Watch-StudioHub.ps1` | Hub đúng | không tự kết thúc | vẫn chạy sau 25 giây, chỉ ghi dòng khởi động; tôi dừng nó |
| | `-ExpectedVersion 0.0.1` | 2 | `STOP: port occupied by a different service or version … No automatic restart.` |

**Chưa thử:** đường khởi động lại tự động của watchdog (khi Hub không trả lời nó chạy `START-CHATMCP-HUB.cmd`). Tôi cố ý không kích hoạt nó để không đụng tới Hub thật của bạn. Các script này chạy dưới Windows PowerShell 5.1; chưa thử dưới PowerShell 7.

### Kiểm tra tĩnh

Dự án không có bước build, linter hay hệ thống kiểu (Node ESM chạy thẳng, không biên dịch). Thay vào đó, trên cây mã cuối cùng:

| Kiểm tra | Windows (Node 24.19.0, Python 3.11.9) | Linux (Node 22.22.0, Python 3.13.16) |
|---|---|---|
| `node --check` trên `hub.mjs`, `lib\*.mjs`, `tests\*.mjs`, `tests\e2e\*.mjs`, `tests\mutation\*.mjs`, `web\*.js` | 107 tệp, 0 lỗi | 107 tệp, 0 lỗi |
| `python -m py_compile tests\*.py` | 6 tệp, 0 lỗi | 6 tệp, 0 lỗi |
| `verify-docs`: liên kết, neo, phiên bản, các con số được trích dẫn, script `.ps1`/`.cmd` chỉ có ASCII, action CI ghim theo SHA, mẫu đột biến còn khớp mã | chạy lại riêng sau khi báo cáo này được điền xong: PASS | như bên trái: PASS |

`node --check` chỉ chứng minh cú pháp hợp lệ, không chứng minh kiểu hay logic đúng; phần đó do các bộ test ở trên gánh.

### Chưa kiểm chứng

- Mọi thứ cần **mô hình thật**: chất lượng gọi công cụ của từng mô hình, độ dài ngữ cảnh thật, chi phí thật. Có hướng dẫn tự thử ở [TESTING-WITH-REAL-MODELS.md](TESTING-WITH-REAL-MODELS.md).
- **Pull Request GitHub thật**, GitHub Actions thật.
- Chạy liên tục nhiều giờ với dự án lớn (script soak mới đo 12 mẫu trong một phút).
- Máy Windows ngoài máy phát triển này (Windows 10, Home, ngôn ngữ khác, đường dẫn rất dài).

## GIT STATUS

- Nhánh `dev/chatmcp-agent`, nền `fdb7653` (`main` = `origin/main`). **Chưa push, chưa tag, chưa PR.** `origin` là `https://github.com/pddczpl/ChatMCP.git` (công khai).
- **Lịch sử không bị viết lại**, không force-push, không `reset --hard`, không xóa nhánh; mọi commit là commit thường, có tệp được chỉ đích danh.
- Không commit: `node_modules`, `deploy/.generated/` (kết quả chạy, venv, tệp tạm — nằm trong `.gitignore`), bí mật, bản sao lưu, `__pycache__`, tệp rỗng.
- Cây làm việc sau commit cuối: **sạch** — `git status --short` không in dòng nào (`deploy/.generated/`, `node_modules/`, `__pycache__/` nằm trong `.gitignore`).

Các commit trên nhánh từ nền `fdb7653` (cũ → mới). Commit cuối cùng là commit chứa chính báo cáo này nên hash của nó không thể nằm trong báo cáo; xem `git log -1`.

| # | Hash | Nội dung |
|---|---|---|
| 1 | `e9cfba4` | chore(git): stop tracking nested Cloud Harness clones |
| 2 | `2089911` | chore(git): add .gitignore, .gitattributes and .editorconfig |
| 3 | `3571def` | chore(git): untrack dependencies, state backups, rescue copies and ZIPs |
| 4 | `3448b74` | test: add unified test runner; npm test now runs every suite |
| 5 | `d6f2817` | fix: terminal PTY fallback, awaited close and process groups; canonical checkpoint path |
| 6 | `873b5c4` | feat(deps): pin Cloud Harness MCP and add token rotation tooling |
| 7 | `c59937e` | docs: Phase 0 audit, architecture, security, development guide and CI workflow |
| 8 | `8087647` | docs: Phase 1 design for the local coding agent |
| 9 | `46b557c` | feat(hub): shell command risk analysis, protected paths and ShellRunner |
| 10 | `7e87807` | feat(hub): local tool server for the coding agent (files, search, git, shell) |
| 11 | `68fe459` | feat(hub): Read Only mode and per-call permission decisions for local tools |
| 12 | `e9cb269` | feat(hub): run the coding agent without Docker, Cloud Harness or Desktop Commander |
| 13 | `f7dcf4e` | feat(launcher): standalone Windows launcher; fix Stop and pipe inheritance |
| 14 | `8c50020` | feat(models): Anthropic adapter, hardened OpenAI-compatible adapter, presets and model discovery |
| 15 | `00ecb75` | feat(models): probe tool calling in Test API |
| 16 | `9d4b314` | feat(agent): canonical task state machine, approval-aware, with honest recovery |
| 17 | `5ae7362` | feat(ui): approval dock, honest task states, first-run wizard and provider settings (2.3.0) |
| 18 | `c684de4` | fix(security): close the command-analysis bypasses found by the adversarial E2E |
| 19 | `7065ab5` | test(e2e): scripted-model end-to-end suites and a runner that cannot report a false PASS |
| 20 | `65381b6` | fix(windows): smoke, soak, watch and gateway scripts no longer hard-code an old release |
| 21 | `716af42` | test(mutation): mutation-testing runner and four lists of hand-written mutants |
| 22 | (commit này) | docs: Phase 1 documentation set, report, and the proposed CI update |

Muốn xem lại hay bỏ một phần: mỗi commit là một khối độc lập; `git revert <hash>` không động tới lịch sử đã có.

## SECURITY FINDINGS

Trạng thái hiện hành, chi tiết kỹ thuật và hướng dẫn xoay token: [SECURITY.md](../SECURITY.md).

### Đã đóng trong Phase 1 (mỗi mục có test hồi quy, fail trên mã cũ)

- Lệnh "chỉ đọc" (`cat link`) đi theo symlink tới file bí mật ngoài dự án mà vẫn chạy không hỏi.
- `core.fsmonitor` trong `.git/config` của thư mục tải về chạy chương trình ngay khi `git status`; hook `pre-commit` chạy khi `git commit` qua shell.
- Ổ PowerShell (`Env:`, `HKCU:`, `FileSystem::`) và `ps e` đọc được bí mật mà công cụ file không cho đọc.
- Bộ lọc biến môi trường bỏ sót `PGPASSWORD`, `MYSQL_PWD`, biến kết thúc bằng `_KEY` và URL có mật khẩu (`redis://:mật-khẩu@host`).
- Nhãn "Tự động" từng ghi "công cụ lạ vẫn hỏi" trong khi mã **từ chối**; nhãn đã sửa cho khớp mã.

### Vẫn mở — chờ chủ sở hữu (không phải việc "sẽ làm", mà là việc chỉ bạn quyết được)

| ID | Mức | Vấn đề | Trạng thái |
|---|---|---|---|
| S1 | **Cao** | Bearer token Cloud Harness nằm trong lịch sử Git **công khai** (92 file cấu hình), đã xác minh trùng token đang chạy | **Mở.** Đã gỡ khỏi index và chặn bằng `.gitignore`; lịch sử cũ chưa viết lại; token chưa xoay |
| S1b | **Cao** | Một Cloudflare quick tunnel từng được thấy đang đưa `/mcp` ra Internet; còn dịch vụ Windows `Cloudflared` chưa kiểm tra | **Mở.** Tôi không dừng hay đổi gì |
| S2 | Trung bình | Dữ liệu trạng thái (transcript, log, blob DPAPI) trong lịch sử công khai | **Mở**, cùng quyết định lịch sử với S1 |
| S3 | Thấp | `CHATMCP-HUB/README.md` nhắc tên bài lab của chủ sở hữu | Fixture đã trung hòa; tài liệu chờ bạn |
| S4 | Thấp | Desktop Commander có telemetry theo upstream | Ghi nhận; backend `local` không dùng nó |
| S5 | Thấp | Mã OAuth ChatGPT chết (`lib/provider.mjs`, `lib/chatgpt-auth.mjs`), route trả 410 | Đề xuất xóa, chờ bạn |

### Phát hiện mới khi đóng Phase 1

- **N1 (thấp).** `CHATMCP-HUB/windows/Test-Gateway-Live.ps1` có hostname và tên model của một gateway Cloud Run cá nhân viết cứng trong mã (không có khóa). Là định danh cá nhân trong repository công khai. **Chưa đổi** — giữ, tổng quát hóa hay xóa là quyết định của bạn.
- **N2 (thấp).** `CHATMCP-HUB/SHA256SUMS.txt` là của bản phát hành cũ và **đã lỗi thời**; đừng dùng nó để xác minh toàn vẹn.
- **N3 (trung bình, chất lượng).** Workflow CI đang commit không cài Python và không dùng `--no-skip`, nên trên GitHub bộ FastAPI sẽ SKIP thay vì chạy thật. Bản đề xuất sửa đúng điều này nhưng chưa được áp dụng ([BLOCKERS](#blockers), D8).
- **N4.** Quét bí mật tĩnh trên mọi tệp thêm/sửa trong Phase 1 trước commit: quét toàn bộ cây làm việc (tệp đã theo dõi và tệp chưa theo dõi nhưng không bị ignore) bằng 9 mẫu (Bearer, khóa riêng, `sk-`, token GitHub, AWS, Google, Slack, JWT, gán bí mật dạng `api_key = "…"`) cho **19 phát hiện, tất cả là giá trị giả cố ý** trong `CHATMCP-HUB/tests/` (mồi bí mật để chứng minh Hub che được chúng; tiền tố như `sk-adversarial-…`, `ghp_abcde…`), **0 phát hiện** ở `lib/`, `web/`, script và tài liệu. Thêm vào đó, diff đã staged của từng commit được quét tên người dùng Windows và địa chỉ email Git trước khi commit: 0 trùng khớp. Đây là quét theo mẫu, không phải bằng chứng rằng không còn bí mật nào; **lịch sử Git cũ có bí mật thật (S1)** và nằm ngoài phạm vi quét này.

### Giới hạn đã biết, chưa khắc phục (tóm tắt; danh sách đầy đủ ở SECURITY.md)

Lệnh bạn duyệt chạy với **toàn quyền tài khoản của bạn** (không sandbox cấp hệ điều hành). Bí mật *đã nằm trong lịch sử Git* đọc được bằng `git log -p`. Che bí mật theo mẫu và lọc môi trường theo tên biến, không tuyệt đối. Chế độ *Tự động* tin lệnh kiểm tra của dự án (mã test chạy với quyền của bạn). Hardlink không được phát hiện; khoảng hở TOCTOU. **Prompt injection không thể bị "ngăn" bằng bộ test.** Không có cô lập nhiều người dùng; hai Hub cùng mở một dự án không phối hợp với nhau.

## BLOCKERS

### Việc chờ bạn quyết định

Thứ tự là thứ tự nên làm. Mục nào tôi **không** tự làm đều vì động tới dữ liệu, thông tin xác thực, quyền truy cập, lịch sử Git hay hệ thống thật.

| # | Quyết định | Vì sao tôi dừng ở đây | Cách làm / mặc định nếu bạn chưa trả lời |
|---|---|---|---|
| D1 | **Xoay token Cloud Harness** (S1) | đổi bí mật thật, khởi động lại container Docker | `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Rotate-CloudHarnessToken.ps1` xem trước, rồi thêm `-Apply`. Chưa làm gì; token cũ vẫn dùng được từ lịch sử |
| D2 | **Quick tunnel và dịch vụ `Cloudflared`** (S1b) | dừng tiến trình/dịch vụ trên máy bạn | Dừng tunnel khi không dùng; xem Cloudflare dashboard có hostname nào trỏ tới `127.0.0.1:3100` không. Chưa động tới |
| D3 | **Lịch sử Git công khai** (S1/S2) | viết lại lịch sử và force-push ảnh hưởng mọi bản clone | A: giữ nguyên sau khi xoay token (đủ để vô hiệu token). B: `git filter-repo` + force-push (cần bạn đồng ý rõ). C: chuyển repository sang private. Mặc định: giữ nguyên |
| D4 | **Push nhánh `dev/chatmcp-agent` và mở PR** | chưa có phép push; nên đọc SECURITY.md trước | `git push -u origin dev/chatmcp-agent`, sau đó mở PR vào `main`. Mặc định: chỉ giữ commit cục bộ |
| D5 | **Khóa API + đồng ý chi phí** để thử mô hình thật | tôi không có khóa và không tự tiêu tiền của bạn | Làm theo [TESTING-WITH-REAL-MODELS.md](TESTING-WITH-REAL-MODELS.md); báo kết quả để chuyển nhãn `blocked` → `e2e-verified (mô hình thật)` |
| D6 | **Xóa mã OAuth chết** (`lib/provider.mjs`, `lib/chatgpt-auth.mjs`) và sửa tên bài lab trong `CHATMCP-HUB/README.md` (S3/S5) | xóa mã và sửa tài liệu của bạn | Mặc định: giữ nguyên |
| D7 | **Chọn LICENSE** | quyền sử dụng mã là quyết định của chủ sở hữu | Hiện chưa có `LICENSE`: người khác chưa được phép tái sử dụng |
| D8 | **Áp dụng workflow CI đề xuất** | công cụ của tôi không được ghi vào `.github/workflows/` | Bản đề xuất (cài Python, job Chromium, `--no-skip all`, vòng kiểm tra cú pháp mở rộng) nằm ở [`ci-proposal.yml`](ci-proposal.yml), **chưa có hiệu lực** vì GitHub chỉ chạy workflow trong `.github/workflows/`. Đọc, rồi `copy docs\ci-proposal.yml .github\workflows\ci.yml` và push. Mọi action đã ghim theo SHA; cú pháp YAML đã được kiểm tra, nhưng workflow này chưa từng chạy |
| D9 | **`windows/Test-Gateway-Live.ps1`** chứa hostname gateway cá nhân (N1) | định danh của bạn | Giữ, tổng quát hóa thành tham số bắt buộc, hoặc xóa |
| D10 | **`CHATMCP-HUB/SHA256SUMS.txt` lỗi thời** (N2) và thư mục lớn không còn được theo dõi (`RESCUE-…`, bản sao lưu, ZIP, clone lồng nhau) | xóa dữ liệu | Mặc định: không động tới; chúng chỉ chiếm chỗ trên đĩa, đã ra khỏi Git |

### Chặn về kỹ thuật (không có quyết định nào của bạn giải quyết được ngay)

- **Đa người dùng:** cần cô lập cấp VM/microVM có bằng chứng; Cloud Harness không phải ranh giới cô lập. Giữ nhãn `blocked`; chỉ nên làm self-host riêng tư cho người tin cậy (Phase 2).
- **Streaming** chưa có; Hub **không có thiết lập proxy riêng** và chưa được thử sau proxy công ty (gợi ý ở [TROUBLESHOOTING.md](TROUBLESHOOTING.md#mạng-công-ty-proxy-chứng-chỉ)); khóa API đã lưu bị xóa khi bạn đổi endpoint mà chưa nhập lại (cố ý, nhưng có thể gây bất ngờ).
- Kiểm tra symlink của *file* bị bỏ qua trên Windows không bật Developer Mode (junction thư mục vẫn được kiểm).

## NEXT PRIORITY

Theo thứ tự ưu tiên của bản yêu cầu (an toàn dữ liệu và thông tin xác thực trước, tính năng sau):

1. **D1 và D2 — 10 phút của bạn, quan trọng hơn mọi tính năng.** Xoay token và tắt tunnel đóng S1/S1b. Mọi thứ khác trong báo cáo có thể chờ; hai việc này thì không.
2. **Thử với mô hình thật (D5).** Đây là khoảng cách lớn nhất giữa "e2e-verified với mô hình giả" và "dùng được". Bắt đầu bằng chế độ *Review* trên một dự án nhỏ của bạn. Nếu bạn đưa khóa, bước tiếp theo của tôi là một bộ `verify-real-model` chạy được khi có khóa (và SKIP khi không có).
3. **Push và PR (D4), áp dụng CI (D8)** — để có lần chạy CI đầu tiên trên GitHub, Windows và Linux.
4. **Hoàn thiện Phase 1 theo phản hồi dùng thật:** streaming, hỗ trợ proxy, khóa workspace giữa các Hub, danh sách nhiều hồ sơ nhà cung cấp.
5. **Phase 2 — tự host tin cậy** (Docker Compose cho Hub, xác thực, HTTPS, health, backup, CI/CD): cần bạn cho biết **máy chủ, tên miền, cách xác thực** (ví dụ basic auth sau reverse proxy, OIDC, hay Tailscale) và có cho phép dùng Docker không. Chưa có các câu trả lời này thì chưa nên bắt đầu: [DEPLOYMENT.md](DEPLOYMENT.md) nêu rõ cái gì được hỗ trợ và cái gì chưa.

## Phụ lục A — Tự kiểm chứng bằng tay trên Windows

Mục đích: bạn không phải tin báo cáo này.

```powershell
# từ thư mục repository ChatMCP
.\CHATMCP-HUB\START-CHATMCP-HUB.cmd -ProjectPath C:\duong\dan\toi\du-an    # mở http://127.0.0.1:3007
.\CHATMCP-HUB\windows\Run-StudioSmoke.ps1            # chỉ đọc; báo sai phiên bản nếu Hub đang chạy là bản cũ
.\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd
cd CHATMCP-HUB; npm test                               # 46 bộ Node
```

Lần đầu mở giao diện, trình hướng dẫn mời chọn thư mục dự án, nhà cung cấp, khóa, quyền. Hãy bắt đầu bằng *Review* và đọc kỹ lệnh trong hộp phê duyệt. Với dự án không tin cậy dùng *Chỉ đọc*.

## Phụ lục B — Tệp tạm và dọn dẹp

Không có gì dưới đây nằm trong Git; bạn có thể xóa bất cứ lúc nào.

- `deploy\.generated\` (đã ignore): kết quả các lần chạy (`win-*.txt/json`), `venv-e2e\` (môi trường Python cho bộ FastAPI và giao diện), `ps-final\` và `ps-check\` (kết quả chạy các script PowerShell), `ps-final.ps1` và `ps-smoke-helper.mjs` (trình điều khiển dùng một lần), `full-check.*`, các `msg-*.txt` (nội dung commit).
- `%TEMP%\chatmcp-e2e-*`: thư mục tạm của một lần chạy E2E bị ngắt giữa chừng; mọi lần chạy bình thường tự dọn.
- Không có tiến trình `node`, `python` hay Hub nào do phiên làm việc này để lại đang chạy (đã đối chiếu danh sách tiến trình Windows sau lần chạy cuối). Quick tunnel `cloudflared` đang chạy trên máy bạn đã được khởi động từ 2026-10-09, trước phiên này; tôi không dừng hay đổi nó (xem S1b và D2).
