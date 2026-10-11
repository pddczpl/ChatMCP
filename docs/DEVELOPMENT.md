# Hướng dẫn phát triển

## Môi trường

| Công cụ | Yêu cầu | Dùng cho |
|---|---|---|
| Node.js | ≥ 22.12 (launcher kiểm tra); đã chạy toàn bộ test với 22.22 (Linux) và 24.19 (Windows) | Hub và toàn bộ kiểm thử Node |
| Git | 2.4x trở lên (đã chạy với 2.55 trên Windows) | quy trình phát triển; công cụ Git của agent; nhiều bộ test tạo kho thật |
| Git Bash | đi kèm Git for Windows | shell mặc định của agent trên Windows (không có thì dùng PowerShell) |
| PowerShell | Windows PowerShell 5.1 (có sẵn trên Windows 11) | launcher, script, kiểm thử script |
| Python 3.11+ | tùy chọn | (a) chỉ mục ký hiệu Python của Hub (`py -3.11` trên Windows); (b) bộ E2E FastAPI; (c) bộ giao diện Playwright |
| Docker Desktop | tùy chọn | chỉ cho backend `mcp` (Cloud Harness) và sandbox chạy test |

Hub **không có bước build** và không có dependency bắt buộc để `npm install`. `node-pty` (ConPTY) là tùy chọn: `CHATMCP-HUB\windows\Install-OptionalConPTY.ps1`; khi thiếu hoặc hỏng, terminal tương tác tự dùng pipe.

## Chạy kiểm thử

```powershell
cd CHATMCP-HUB
npm test                                         # mọi bộ Node, mỗi bộ một tiến trình riêng
node tests/run-all.mjs --list                    # liệt kê
node tests/run-all.mjs --filter e2e --verbose    # lọc theo tên, in toàn bộ đầu ra
node tests/run-all.mjs --json test-results/summary.json
node tests/run-all.mjs --no-skip all             # một bộ bị SKIP bị tính là FAIL (dùng cho CI)
npm run test:ui                                  # bộ giao diện Python/Playwright (tùy chọn)
```

Hiện có **55 bộ Node** (`tests/verify-*.mjs`) và **5 bộ giao diện** (`tests/verify-*.py`, cần Python + Playwright). Hai con số này được bộ `verify-docs` đối chiếu với thư mục `tests/`, nên không thể lỗi thời mà không bị phát hiện.

Runner in một dòng cho mỗi bộ (`PASS`/`FAIL`/`TIMEOUT`/`SKIP`, thời gian, mã thoát thật) và thoát khác 0 nếu có bộ nào fail hoặc quá hạn (mặc định 180 giây/bộ, đổi bằng `--timeout`). Bộ kiểm thử in một dòng `CHATMCP_TEST_SKIP: <lý do>` rồi thoát 0 để được báo là **SKIP — không bao giờ được tính là PASS**. `--no-skip all` (hoặc `--no-skip tên1,tên2`) biến SKIP thành FAIL. Hãy dùng nó ở nơi môi trường đã cài đủ Git, shell và Python (CI): một bộ bị bỏ qua khi đó nghĩa là môi trường hỏng chứ không phải "không áp dụng". Workflow hiện có trong repo **chưa** dùng `--no-skip` (xem mục "Giới hạn đã biết" bên dưới). Một phần không thể kiểm chứng trong bản này được in `BLOCKED: <gì> - <vì sao>`.

Tổng thời gian cả bộ Node: khoảng 3 phút (Linux, 180 s đã đo) đến 4 phút (Windows, 243 s đã đo); bộ lâu nhất là `verify-e2e-recovery` (~57 s, vì phải giết và khởi động lại Hub nhiều lần).

### Các bộ kiểm thử

| Nhóm | Bộ | Chứng minh gì |
|---|---|---|
| **Chính bộ test** | `verify-test-runner` (12) | `tests/run-all.mjs`: mã thoát thật quyết định PASS/FAIL, bộ treo bị giết và báo `TIMEOUT`, dòng `CHATMCP_TEST_SKIP` không che được lỗi, `--no-skip`, lỗi cú pháp lệnh |
| | `verify-mutation-runner` (11) | `tests/mutation/run-mutations.mjs`: đột biến bị nhận ra → `KILLED`, không bị nhận ra → `SURVIVED`, mẫu không khớp → `ERROR` (không bao giờ là "giết miễn phí"), đột biến của hệ điều hành khác → `N/A`, bộ test không chạy được thì không bị phán xét, tệp thật không bị đụng |
| | `verify-docs` | tài liệu khớp với mã: liên kết và neo, phiên bản (`package.json` = mã = giao diện = CHANGELOG), các con số được trích dẫn (số bộ test, công cụ, preset, trạng thái), script `.ps1/.cmd` chỉ có ASCII, phụ thuộc test và action CI được ghim, mọi mẫu trong danh sách đột biến còn khớp mã (phần cần cả repository thì SKIP khi thiếu) |
| **Lõi an toàn** | `verify-command-analysis` | bảng ca của bộ phân loại lệnh và vùng cấm, kể cả các cách lách (mở rộng, lồng nhau, pipe) |
| | `verify-shell-guards` (14) | cấu hình/hook Git của kho, theo dõi symlink/junction/bí danh tới nơi thật, ổ PowerShell (`Env:`, registry), phân loại quyền và công cụ Git |
| | `verify-shell-runner` (44) | `ShellRunner` với shell thật: trích dẫn, mã thoát, timeout giết cả cây tiến trình, hủy, giới hạn đầu ra, **lọc biến môi trường** |
| | `verify-fs-helpers` | kiểm tra đối số, ghi nguyên tử, glob, Git runner |
| | `verify-local-tools` | các công cụ cục bộ trên workspace và kho Git thật; nhấn vào điều *không bao giờ* được xảy ra |
| | `verify-permissions-modes`, `verify-full-access` | `PermissionGate`: ba chế độ, đường dẫn bị chặn, `sandbox-only`, Full Access, lịch sử phê duyệt |
| **Tích hợp** | `verify-local-backend` | `HubManager` (backend `local`) + gate + công cụ + `AgentRunner` với mô hình giả; không cần Docker, mạng hay khóa |
| | `verify-task-state` | máy trạng thái nhiệm vụ: luật thuần, cách `AgentRunner` áp dụng, kết luận về nhiệm vụ tìm thấy sau khi Hub chết |
| | `verify-launcher` | launcher nền (`lib/launch.mjs`, và `Start/Stop-ChatMcpHub.ps1` trên Windows) |
| | `verify-phase0-regressions` | các lỗi do audit Phase 0 tìm ra (checkpoint qua đường dẫn 8.3, PTY, `close()`) |
| **Mô hình** | `verify-model-adapters` | Anthropic, OpenAI-chat, preset, liệt kê model, lưu khóa — toàn bộ bằng `fetch` giả |
| | `verify-dual-mode`, `verify-gateway-*`, `verify-gemini-*` | gateway Gemini/OpenAI: dialect, nén khi 413, sửa lệnh lỗi, bị cắt |
| **Phiên & HTTP** | `verify-persistent-sessions`, `verify-studio-recovery`, `verify-hub-claim-recovery`, `verify-network-recovery` | phục hồi phiên, tự tiếp tục, mất mạng |
| | `verify-studio-core`, `verify-studio-http`, `verify-studio-verifications`, `verify-v2-http`, `verify-v2-runtime`, `verify-agent-http`, `verify-agent-autotools` | workspace/checkpoint/review, route HTTP, CSRF/Origin, sandbox |
| **ChatGPT Web (legacy)** | `verify-browser-continuation`, `verify-first-message`, `verify-recovery-dom`, `verify-reply-witness`, `verify-result-paging`, `verify-send-cycle` | tiện ích trình duyệt và `BrowserRunner` (giữ để không hồi quy) |
| **Giao diện** | `verify-ui-logic` | quyết định của dashboard (`web/ui-logic.js`) chạy không cần trình duyệt, đối chiếu với từ vựng của máy chủ thật |
| **E2E** | `verify-e2e-bugfix` (34) | sửa một lỗi trong dự án có sẵn và chứng minh bằng test của dự án |
| | `verify-e2e-fastapi` (24) | dựng dịch vụ FastAPI test-first, rồi tác vụ thứ hai ở chế độ Tự động |
| | `verify-e2e-git` (25) | nhánh, commit, và chỉ push khi bạn đồng ý (remote là kho bare cục bộ) |
| | `verify-e2e-recovery` (30) | giết Hub giữa nhiệm vụ; lần khởi động sau không phát lại thao tác chưa rõ kết quả |
| | `verify-e2e-isolation` (52) | hai Hub cạnh nhau không thấy dữ liệu của nhau; cửa vào của Hub |
| | `verify-e2e-adversarial` (74) | repo độc hại + mô hình "ngoan ngoãn" làm mọi thứ README bảo; kiểm tra điều gì **đúng** sau đó |

Bộ giao diện (cần Python + Playwright; xem bên dưới): `verify-ui-e2e.py` (trình duyệt thật + Hub thật + mô hình giả: hướng dẫn lần đầu, duyệt/từ chối, Chỉ đọc, Tự động), `verify-react-ui.py`, `verify-v2-ui.py`, `verify-studio-ui.py`, `verify-auto-project-ui.py`.

### Bộ cần Python

```powershell
# E2E FastAPI: cần một Python có các gói ghim trong CHATMCP-HUB\tests\requirements-e2e.txt (fastapi, uvicorn, httpx, pytest)
py -3.11 -m venv deploy\.generated\venv-e2e
deploy\.generated\venv-e2e\Scripts\pip install -r CHATMCP-HUB\tests\requirements-e2e.txt
# hoặc trỏ tới interpreter có sẵn các gói đó:
$env:CHATMCP_E2E_PYTHON = 'C:\...\python.exe'

# Giao diện: Playwright + Chromium/Edge/Chrome
deploy\.generated\venv-e2e\Scripts\pip install -r CHATMCP-HUB\tests\requirements-ui.txt   # playwright (ghim)
$env:PATH = "$PWD\deploy\.generated\venv-e2e\Scripts;$env:PATH"   # để runner thấy `python` có Playwright
cd CHATMCP-HUB; npm run test:ui
```

Thiếu gói hoặc trình duyệt → bộ **SKIP** (có lý do), không giả vờ PASS. Trình duyệt được tìm theo thứ tự: `$CHATMCP_CHROMIUM`, các đường dẫn Linux quen thuộc, Chromium của Playwright, Edge hoặc Chrome đã cài. `CHATMCP_E2E_SHOTS=<thư mục>` bật lưu ảnh chụp màn hình.

Script ở thư mục gốc có kiểm thử riêng, chạy bằng dữ liệu giả trong thư mục tạm:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tests\Test-RotateToken.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tests\Test-Bootstrap.ps1
bash scripts/tests/test-bootstrap.sh              # Linux/macOS/Git Bash
```

## Bộ E2E: thật ở đâu, giả ở đâu

`tests/e2e/` là một khung nhỏ dùng chung:

- **Thật:** `hub.mjs` chạy như tiến trình con (`hub-process.mjs`), công cụ cục bộ, cổng phê duyệt, máy trạng thái, tệp trên đĩa, Git, pytest/uvicorn (bộ FastAPI), trình duyệt (bộ giao diện).
- **Giả:** *mô hình*. `mock-model-server.mjs` là một máy chủ tương thích OpenAI `/v1/chat/completions` nói theo kịch bản (`scenarios.mjs`: `call(tool, args)`, `say(text)`, `sequence(steps)`).
- Vì vậy các bộ E2E chứng minh **Hub, công cụ và cổng quyền hoạt động cùng nhau**, *không* chứng minh một mô hình thật lập kế hoạch tốt. Điều đó cần khóa API: xem [TESTING-WITH-REAL-MODELS.md](TESTING-WITH-REAL-MODELS.md).
- Mọi bộ E2E kiểm tra **trạng thái cuối** (tệp trên đĩa, lần chạy test do chính bộ test thực hiện, các lần hỏi duyệt, checkpoint, nhật ký của nhà cung cấp), không tin lời mô hình hay giao diện.

Viết một bộ E2E mới:

```js
import { runScenario } from './e2e/harness.mjs';
import { answerApprovals, connectModel, setMode, startTask } from './e2e/hub-process.mjs';
import { call, say, sequence } from './e2e/scenarios.mjs';
import { gitInit, makeCalcProject } from './e2e/fixtures.mjs';

await runScenario({ name: 'mine', summary: 'what it proves', budgetMs: 120_000 }, async (t) => {
  const project = t.dir('app');
  makeCalcProject(project);
  gitInit(project, t.scratch);
  // Một kịch bản có sẵn ('repair-add', 'explore') hoặc tự viết bằng sequence():
  const mock = await t.mock({ scenarios: { mine: sequence([call('read_file', { path: 'calc.js' })], { final: 'Xong.' }) }, scenario: 'mine' });
  const hub = await t.hub({ project });          // một Hub thật (backend local) trên thư mục dữ liệu riêng
  await connectModel(hub, mock);                 // "Lưu & kiểm tra" như người dùng làm trong Cài đặt
  await setMode(hub, 'review');
  const task = await startTask(hub, 'Đọc calc.js rồi trả lời.');
  const { task: settled, answered } = await answerApprovals(hub, task.id, () => true);   // trả lời mọi yêu cầu duyệt
  t.equal(settled.state, 'completed', 'the task ends completed');
  t.equal(answered.length, 0, 'reading is never put to the person');
  // t.check(cond, label, detail) · t.equal(a, b, label) · t.must(cond, label) · t.note(text) · t.blocked(what, why) · t.skip(reason)
});
```

`runScenario` tạo thư mục tạm (đường dẫn dài, không phải 8.3), dọn Hub và thư mục tạm kể cả khi thất bại, đặt đồng hồ chống treo, in `ok`/`not ok` và `PASS:`/`FAIL:`, và đặt mã thoát. `t.hub({ stateDir })` với cùng `stateDir` mô phỏng khởi động lại. Một kịch bản là hàm chỉ nhìn thấy điều một mô hình thật nhìn thấy (yêu cầu của người dùng và kết quả công cụ đã gọi) và trả về bước kế tiếp; không có ngẫu nhiên, không có mạng.

## Kiểm thử đột biến

`tests/mutation/run-mutations.mjs` trả lời câu hỏi "bộ test này có **thật sự fail được** không?". Nó sao chép Hub vào thư mục tạm, hỏng mã **một chỗ nhỏ mỗi lần** (thay đúng một đoạn văn bản bằng đoạn khác: đổi điều kiện, xóa một lời gọi, tắt một lớp bảo vệ), chạy bộ test trên bản đã hỏng và báo bộ test có nhận ra không.

```powershell
cd CHATMCP-HUB
node tests/mutation/run-mutations.mjs tests/mutation/isolation.json
node tests/mutation/run-mutations.mjs tests/mutation/task-state.json --only M3,M4 --json out.json
node tests/mutation/run-mutations.mjs tests/mutation/fastapi.json     # cần Python như bộ FastAPI
```

| Kết quả | Nghĩa là |
|---|---|
| `KILLED` | bộ test fail trên mã đã hỏng — đúng như mong muốn (kèm tên các kiểm tra đã fail) |
| `SURVIVED` | bộ test vẫn xanh trên mã đã hỏng: lỗ hổng của test, hoặc dòng mã thừa. Công cụ thoát mã 1 |
| `EQUIVALENT` | đột biến không đổi hành vi (dòng phòng thủ thừa); danh sách ghi lý do bằng trường `equivalent`. Nếu nó lại bị `KILLED`, ghi chú báo "annotation is stale" |
| `ERROR` | đoạn văn bản cần thay không còn khớp **đúng một lần** (danh sách đã cũ hoặc mẫu mơ hồ) — không bao giờ coi là "đã giết" |
| `SKIP` | bộ test không chạy được trên máy này (ví dụ thiếu Python) nên không phán xét được; `--allow-skip` để chấp nhận |
| `N/A` | đột biến chỉ áp dụng cho hệ điều hành khác (trường `platforms`, tên theo `process.platform`): không chạy, không tính là sống sót, không đổi mã thoát |

Công cụ chạy bộ test trên bản **chưa hỏng** trước; nếu nó không PASS thì dừng (mã 2) vì mọi "KILLED" sau đó đều vô nghĩa. Tệp thật không bao giờ bị sửa — chỉ bản sao tạm. Mỗi danh sách chạy vài phút nên công cụ **không** thuộc `npm test`.

Các danh sách hiện có: `isolation.json` (cửa vào của Hub: Host/Origin/CSRF/CORS/CSP/địa chỉ nghe, nhốt workspace và symlink, lưu và rò rỉ khóa API, khóa phiên bản, trạng thái từng Hub) → `verify-e2e-isolation`; `task-state.json` (ghi trước khi chạy công cụ, lời gọi đang chờ khi khởi động lại, luật chuyển trạng thái) → `verify-task-state`; `fastapi.json` (phân loại lệnh kiểm tra, cái gì được tính là bằng chứng) → `verify-e2e-fastapi`; `scrub.json` (lọc biến môi trường của tiến trình con) → `verify-shell-runner`; `public.json` (cửa trước của chế độ công khai: Host/HTTPS/Origin/CSRF, đăng nhập, giới hạn thử sai, địa chỉ client sau proxy, các route workspace, tách tài khoản của agent) → `verify-e2e-public` (Phần B chỉ chạy khi là root trên Linux); `broker.json` (kiểm tra yêu cầu gửi tới broker, giới hạn, dọn dẹp sau lệnh, trạng thái kẹt, quyền của socket) → `verify-exec-broker` — **chạy bằng người dùng thường**, vì root không phân biệt được đột biến K25; `separation.json` (từng cờ của launcher, reaper, chủ sở hữu và quyền của từng thư mục supervisor chuẩn bị, 12 kiểm tra của bằng chứng lúc khởi động) → `verify-exec-separation` (chỉ root trên Linux); `workspaces.json` (địa chỉ kho và tham số clone, giới hạn, registry và guard, môi trường cùng cờ cứng hóa của mọi tiến trình Git do Hub chạy, token chỉ đi tới máy chủ tin cậy, che bí mật khỏi thông báo lỗi, loại trừ khi xuất, luật của push) → `verify-workspaces` — **chạy bằng người dùng thường**, vì root bỏ qua quyền tệp nên không phân biệt được W106 và W107. Vài đột biến chỉ có nghĩa trên một hệ điều hành — khóa AES của Linux/macOS, kho DPAPI của Windows, chế độ tệp Unix mà NTFS không có — nên mang trường `platforms`; **hãy chạy mỗi danh sách trên cả hai hệ điều hành** để phủ cả hai nhánh. `verify-docs` kiểm tra mọi mẫu trong các danh sách vẫn khớp mã hiện tại (kể cả mẫu của hệ điều hành khác). Kết quả các lần chạy có ngày tháng nằm trong báo cáo Phase 1, không nằm ở đây (để không lỗi thời).

Giới hạn trung thực: đây là một tập đột biến **nhỏ, viết tay** — chứng minh các bộ test đó bắt được những lỗi cụ thể này, không chứng minh chúng bắt được mọi lỗi. Các đợt đột biến thủ công khác trong quá trình phát triển (cho bộ sửa lỗi, Git, phục hồi phiên, kho độc hại) **chưa được lưu thành danh sách**. Để thêm đột biến: viết mẫu `old` (đúng một lần trong file), `new`, và `what`; chạy; nếu `SURVIVED`, hoặc sửa test, hoặc giải thích vì sao tương đương.

## Viết kiểm thử mới

- Tạo thư mục tạm bằng `fs.mkdtemp(path.join(os.tmpdir(), …))`; không bao giờ đọc/ghi thư mục trạng thái thật của Hub.
- Dùng `fileURLToPath(new URL(…, import.meta.url))`, **không** dùng `URL.pathname` (trên Windows cho `/F:/…`).
- Dọn dẹp bằng `await terminal.close()` *trước* `fs.rm(…)`; trên Windows tiến trình con giữ cwd sẽ gây `EBUSY`.
- Symlink file cần Developer Mode/quyền quản trị trên Windows (`EPERM`). Hãy thử symlink, nếu bị từ chối thì dùng junction thư mục và ghi rõ trong đầu ra (`note - … skipped`). Kiểm tra liên kết **file** vì thế chỉ chạy được trên Linux/macOS hoặc Windows có Developer Mode.
- Đừng giả định hành vi của tên file: trên Windows `.env ` (dấu cách cuối) không tồn tại được và bị từ chối bằng `bad_name`; `ENV~1` có thể là bí danh của `.env` (bị chặn bằng `protected_path`); `a:b` là đường dẫn theo ổ đĩa. Test phải chấp nhận *mọi cách từ chối an toàn* chứ không bám vào một mã lỗi của một hệ điều hành.
- Bí mật trong dữ liệu kiểm thử là giá trị giả có tiền tố rõ ràng (`FAKE-…`, `sk-adversarial-…`). Một test "không lộ bí mật" phải quét **tất cả** nơi bí mật có thể rơi vào (thư mục dữ liệu, nhật ký, transcript, yêu cầu mà mô hình giả nhận được) và nói số tệp đã quét, để "không tìm thấy" không phải lời hứa suông.
- Test hồi quy cho lỗi đã sửa phải **fail trên mã cũ**. Cách đã dùng cho các bộ E2E: *đột biến thủ công* — hỏng đúng dòng mã bảo vệ (đổi điều kiện, xóa một lời gọi), chạy bộ test, xác nhận nó **FAIL vì đúng lý do**, rồi hoàn lại. Một bộ test không thể fail là một bộ test không nói gì. Công cụ và các danh sách đột biến có sẵn: xem mục "Kiểm thử đột biến" ở trên.
- Một test không nên phụ thuộc đồng hồ: dùng `eventually(check, {timeoutMs})` thay cho `sleep` cố định.

## Quy ước Git

- Làm việc trên nhánh riêng (`dev/chatmcp-agent`), không push thẳng `main`, không force-push, không viết lại lịch sử khi chưa có sự đồng ý của chủ sở hữu.
- Commit nhỏ, một mục đích, kiểu Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`); thân commit nêu nguyên nhân, bằng chứng và điều *chưa* được kiểm chứng.
- Không commit: `node_modules`, state/transcript/log, bản sao lưu, ZIP, `.env*`, khóa, `deploy/.generated/`. Trước khi push: `git ls-files -ci --exclude-standard` phải rỗng.
- Cuối dòng: `.gitattributes` dùng `text=auto` — file đã commit với CRLF không bị viết lại; `.sh` luôn LF, `.ps1/.cmd/.bat` luôn CRLF khi checkout. Giữ script `.ps1` ở ASCII (Windows PowerShell 5.1 đọc file không BOM theo ANSI). Cảnh báo `LF will be replaced by CRLF` khi `git add` trên Windows là vô hại.
- Chạy `git diff --cached --check` trước khi commit.

## Đặc thù Windows cần nhớ

- Đường dẫn người dùng có thể chứa dấu cách và dạng ngắn 8.3 (`C:\Users\TENDAI~1\…`): so sánh đường dẫn luôn qua `fs.realpath`.
- Dừng cây tiến trình bằng `taskkill /PID <pid> /T /F`; trên POSIX gửi tín hiệu tới process group. Giết Hub bằng `TerminateProcess` không chạy handler nào: bộ `verify-e2e-recovery` mô phỏng đúng điều này.
- `$PSScriptRoot` dùng trong giá trị mặc định của `param()` trả về rỗng khi chạy `powershell -File` trên PS 5.1 — hãy tính trong thân script.
- Hàm PowerShell tên `Git` sẽ che `git.exe` và gây đệ quy vô hạn; đặt tên hàm có tiền tố.
- Pipe được thừa kế bởi tiến trình con: một dịch vụ nền khởi động từ Hub phải đóng stdio kế thừa, nếu không `Start` treo (đã sửa trong launcher).
- Đổi tên file đang bị chương trình diệt virus/trình lập chỉ mục giữ có thể báo `EBUSY/EPERM`: `lib/fs-safe.mjs` thử lại vài lần.
- Tiếng Việt trong đầu ra của bộ test có thể hiện thành `?` hoặc ký tự lạ khi console (hoặc công cụ điều khiển từ xa) dùng trang mã cũ như cp437/cp1252. Đó chỉ là hiển thị: mã thoát và PASS/FAIL không đổi, và tệp do `--json` ghi ra là UTF-8 nguyên vẹn. Dùng Windows Terminal hoặc `chcp 65001` để đọc. Chuyển hướng bằng `>` trong Windows PowerShell 5.1 sẽ ghi tệp UTF-16 và có thể làm méo chữ; dùng `--json` hoặc `cmd /c "node … > tệp.txt"`.

## Cấu trúc thư mục

```
CHATMCP-HUB/       Hub (hub.mjs, lib/, web/, extension/, tests/, windows/, workers/)
  lib/             mã máy chủ (xem ARCHITECTURE.md); *.mjs, không cần build
  web/             giao diện: index.html, react-app.js, ui-logic.js, onboarding.js, vendor/
  tests/           verify-*.mjs (Node), verify-*.py (Playwright), e2e/ (khung E2E)
deps/              khóa phiên bản phụ thuộc bên thứ ba
scripts/           bootstrap Cloud Harness, xoay token, kiểm thử script
docs/              kiến trúc, thiết kế, audit, hướng dẫn
CHATMCP-LOCAL-SETUP/, START-*.{cmd,ps1}, install.sh, manifest.json, bridge.js …   legacy
```

## Giới hạn đã biết của quy trình

- Workflow CI (`.github/workflows/ci.yml`) đã được viết nhưng **chưa từng chạy trên GitHub** — chỉ chạy sau khi nhánh được push; đừng coi CI là xanh cho tới khi thấy kết quả thật. Bản đang có trong repo gồm `hub-tests` (Linux + Windows × Node 22 + 24, `run-all.mjs --json`), `script-tests` (script bootstrap/xoay token trên Linux và Windows PowerShell 5.1) và `hygiene` (không file nào bị `.gitignore` loại, không có bearer token/khóa riêng). Mọi action được ghim theo SHA commit — `verify-docs` kiểm tra điều đó. **Chưa có** trong bản này: Python cho bộ E2E FastAPI, job giao diện Chromium và `--no-skip all`, nên trên CI hai nhóm đó sẽ SKIP chứ không được chạy. Một bản workflow đã bổ sung đủ ba thứ đó được soạn sẵn ở [`ci-proposal.yml`](ci-proposal.yml) nhưng chưa áp dụng (công cụ của phiên làm việc không được phép ghi vào `.github/workflows/`); cách áp dụng ở [báo cáo Phase 1](PHASE1-REPORT.md#blockers).
- `CHATMCP-HUB/SHA256SUMS.txt` là của bản phát hành cũ, đã lỗi thời; không dùng để xác minh bản này.
- Các script `windows/Run-StudioSmoke.ps1`, `windows/Test-Gateway-ViaHub.ps1`, `windows/Watch-StudioHub.ps1`, `windows/Run-StudioSoak.ps1`, `windows/Test-Gateway-Live.ps1` là công cụ thủ công, không nằm trong `npm test`. `Run-StudioSmoke`, `Watch-StudioHub` và `Run-StudioSoak` so phiên bản của Hub đang chạy (lấy từ `/api/health`) với `version` trong `package.json` cạnh chúng (tham số `-ExpectedVersion` để ghi đè); `Test-Gateway-ViaHub` dùng đúng bản dựng giao diện mà Hub báo. Không script nào ghi cứng số phiên bản, nên không phải sửa mỗi lần phát hành. Mã thoát phản ánh kết quả thật: `Run-StudioSmoke` thoát 1 nếu có kiểm tra fail (kể cả sai phiên bản hay không có Hub), `Run-StudioSoak` thoát 1 nếu có mẫu nào xấu (kể cả khi Hub không trả lời mẫu nào), `Test-Gateway-ViaHub` thoát 1 nếu kết nối thử lỗi, `Watch-StudioHub` thoát 2 khi cổng đang bị một dịch vụ hay phiên bản khác chiếm (và không khởi động lại gì). Cả bốn đã được chạy thật dưới Windows PowerShell 5.1 với một Hub tạm và mô hình giả (xem báo cáo Phase 1). `Test-Gateway-Live.ps1` chỉ nói chuyện với một gateway Cloud Run có tên máy chủ ghi cứng trong script và không dùng cho việc khác — xem mục quyết định của chủ sở hữu trong báo cáo.
