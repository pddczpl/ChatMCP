# Phase 1 — Thiết kế: Coding Agent cục bộ chạy được trên Windows

- **Trạng thái:** đã triển khai trong 2.3.0. Mục 1–5 là thiết kế *ban đầu*, được giữ nguyên để so sánh; **mục 6 ghi lại chỗ hiện thực khác thiết kế** và bằng chứng cho từng tiêu chí. Khi hai nơi mâu thuẫn, [ARCHITECTURE.md](ARCHITECTURE.md) và mục 6 là đúng.
- **Phạm vi:** một người dùng, máy cục bộ (Windows 11 trước, Linux/macOS dùng được). Không đa người dùng, không triển khai production (Phase 2+).
- **Nguyên tắc:** giữ nguyên các tính năng đang chạy (26 suite hiện có phải luôn xanh); thêm bằng cách *bổ sung*, không viết lại; mọi quyền thực thi đi qua `PermissionGate`.

## 1. Mục tiêu và tiêu chí thành công

Người dùng cài Node, chạy một file khởi động, chọn thư mục dự án, nhập API key của nhà cung cấp mô hình, rồi giao việc bằng tiếng Việt/Anh. Agent đọc, sửa file, chạy lệnh, dùng Git, và báo cáo kết quả **dựa trên đầu ra thật**. Không cần Docker, Cloud Harness hay Desktop Commander.

Tiêu chí (đều phải có bằng chứng chạy thật, không chỉ mô tả):

| # | Tiêu chí | Bằng chứng dự kiến |
|---|---|---|
| 1 | Hub khởi động không cần `--repo-root`/Docker | test khởi động + smoke test Windows |
| 2 | Agent đọc/ghi/sửa file, chạy lệnh, Git qua công cụ `local.*` | unit test + E2E mô hình giả |
| 3 | Read Only / Review / Autonomous hoạt động đúng; lệnh nguy hiểm luôn hỏi | test ma trận quyền + repo độc hại |
| 4 | Adapter OpenAI, tương thích OpenAI, Anthropic, Gemini; gọi công cụ đáng tin cậy | test với máy chủ mô hình giả (stream + không stream + lỗi) |
| 5 | Khóa API lưu an toàn, không lộ ra log/transcript/giao diện | test quét bí mật |
| 6 | Máy trạng thái nhiệm vụ + phục hồi phiên không phát lại thao tác ghi chưa xác định | test phục hồi |
| 7 | Onboarding lần đầu hoàn tất không cần sửa file cấu hình | kiểm thử DOM + chạy thử thủ công |

Ngoài phạm vi (ghi rõ để không hứa quá): chạy với mô hình thật chưa được kiểm chứng (cần khóa API và đồng ý chi phí của chủ sở hữu); cô lập đa người dùng; tiến trình nền dài hạn (dev server) do agent quản lý; sandbox thực thi lệnh ngoài Docker tùy chọn đã có.

## 2. Kiến trúc đích

```
Trình duyệt (React, 127.0.0.1:3007)
        │  HTTP + CSRF
        ▼
   hub.mjs ── DualAgent ─┬─ AgentRunner (API)  ◄── ProviderHub ── adapters: openai | anthropic | gemini | gateway(cũ)
                         └─ BrowserRunner (ChatGPT Web, thử nghiệm)         │ SecretStore (DPAPI | file mã hóa | bộ nhớ)
                              │
                    AgentSession.callTool ── PermissionGate (readonly|review|autonomous × host-review|sandbox-only|full-access)
                              │                   └─ phân tích lệnh shell, kiểm tra đường dẫn, checkpoint trước khi ghi
        ┌─────────────────────┼───────────────────────────────┐
   local.* (MỚI)         studio.* (có sẵn)             MCP ngoài (tùy chọn)
   LocalTools:           đọc/tìm/AST/plan/review        Cloud Harness + Desktop Commander
   fs · edit · search                                   chỉ khi người dùng bật backend "mcp"
   ShellRunner · git
```

Điểm then chốt: `local.*` được thêm vào danh mục công cụ giống cách `studio.*` đang được thêm (`HubManager.createAgentSession`), nên `AgentRunner`, transcript, `pendingCall`, quyền và checkpoint dùng lại nguyên vẹn.

## 3. Các thành phần

### 3.1 `lib/local-tools.mjs` — LocalTools
Máy chủ công cụ trong tiến trình. Mỗi công cụ có `inputSchema` thật; kết quả cùng dạng `StudioTools` (`{isError, content, structuredContent}`).

| Công cụ | Phân loại quyền | Ghi chú |
|---|---|---|
| `read_file`, `list_directory`, `find_files`, `search_files` | read | giới hạn kích thước/kết quả; chặn `.git/**` và file bí mật (`.env*`, khóa riêng) — `.env.example/.sample/.template` được phép |
| `git_status`, `git_diff`, `git_log` | read | `git -C <workspace>`, không bao giờ nhắc/chuyển sang thư mục cha |
| `write_file`, `edit_file`, `make_directory`, `move_path` | workspace_edit | ghi nguyên tử (tệp tạm + rename), từ chối symlink, từ chối ghi `.git/**` và file bí mật; `edit_file` thay chuỗi chính xác, bắt buộc duy nhất trừ khi `replace_all`, hiểu CRLF; `expected_sha256` chống ghi đè thay đổi mới |
| `git_add`, `git_commit`, `git_branch` | workspace_edit | không có `push`/`reset --hard`/`clean` (đi qua `run_command`, luôn hỏi) |
| `delete_path` | dangerous | luôn hỏi, kể cả Autonomous |
| `run_command` | theo nội dung lệnh (mục 3.2) | `ShellRunner` |

Mọi đường dẫn đi qua `StudioWorkspace.resolve()` (realpath, chặn symlink thoát workspace, chặn luồng dữ liệu thay thế NTFS). Quyền không phải là lớp bảo vệ duy nhất: chính công cụ cũng tự kiểm tra.

### 3.2 `ShellRunner` và phân tích lệnh
- Windows: `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <UTF-16LE base64>` — truyền mã dưới dạng base64 nên **không còn lỗi trích dẫn dấu nháy kép lồng nhau** (R5 của audit). Lệnh quá dài ghi vào tệp tạm `.ps1` trong thư mục trạng thái của Hub. POSIX: `/bin/sh -c`. Tùy chọn `shell: cmd | bash` khi có.
- stdin đóng; `GIT_TERMINAL_PROMPT=0`, `NO_COLOR=1`, `PAGER=cat`; **môi trường được lọc**: xóa biến có tên `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*PASSWORD*`… để mô hình không đọc được khóa qua `env`.
- Thời gian tối đa mặc định 120 s (tối đa 900 s); đầu ra giới hạn (giữ đầu + cuối, ghi rõ phần bị cắt); hủy/timeout giết cả cây tiến trình (`taskkill /T /F` hoặc process group) và trả `timedOut: true`.
- `PermissionGate.analyzeCommand()` tách lệnh theo `; && || | xuống-dòng` ngoài dấu nháy và xếp loại **thận trọng**: `read` (danh sách an toàn, đối số đơn giản, không đường dẫn tuyệt đối/`..`/`$`/`%`) → tự động; `verify` (test/lint/build quen thuộc) → tự động chỉ ở Autonomous; `edit` (git add/commit, mkdir…) → Autonomous tự động; `dangerous` (xóa, `git push/reset --hard/clean`, `curl|sh`, `iex`, đổi ACL/registry…) và `exec` (mạng, cài gói, chương trình lạ, chuyển hướng/lồng lệnh) → **luôn hỏi**. Đây là heuristic, **không phải sandbox**: tài liệu nói rõ điều này; lệnh được hiển thị nguyên văn trong hộp phê duyệt.

### 3.3 `PermissionGate` — chế độ mới
- `readonly` (mới): chỉ `read`/`checkpoint`; mọi thứ khác bị từ chối ngay, không hiện hộp phê duyệt. `review` (mặc định; `manual` là bí danh): ghi/chạy cần phê duyệt. `autonomous`: sửa file và lệnh `verify`/`edit` trong workspace không hỏi; `dangerous`/`exec`/`unknown` vẫn hỏi.
- Hằng `SENSITIVE` (trước đây khai báo nhưng không dùng) được thay bằng bộ nhận dạng trong `analyzeCommand`.
- `inspectPaths` kiểm tra thêm khóa `cwd`.
- `executionPolicy` (`host-review`/`sandbox-only`/`full-access`) giữ nguyên ngữ nghĩa; `sandbox-only` cho phép `studio.*` và công cụ đọc của `local.*`, từ chối ghi/lệnh trên host.

### 3.4 Hub độc lập
- `--repo-root` thành tùy chọn. Thư mục trạng thái: `--state-dir` > `CHATMCP_STATE_DIR` > (nếu có `--repo-root`) `<repo>/deploy/.generated/chatmcp-hub` (giữ nguyên lịch sử hiện có) > `%LOCALAPPDATA%\ChatMCP\hub` / `$XDG_STATE_HOME/chatmcp`.
- `backend`: `local` (mặc định; không dịch vụ ngoài) hoặc `mcp` (luồng cũ: Cloud Harness + Desktop Commander + proxy). `acquireTask` chỉ đòi các dịch vụ ngoài khi `backend === 'mcp'`. Ở `mcp`, danh mục = `local.*` + `studio.*` + MCP ngoài.
- Mặc định chế độ tác vụ chuyển sang `api`; ChatGPT Web được gắn nhãn *thử nghiệm/legacy* và không bật dịch vụ MCP ngầm khi gửi tin nhắn.
- `Start-ChatMcpHub.ps1`/`START-CHATMCP-HUB.cmd` không cứng đường dẫn `F:\…`: tìm `cloud-harness-mcp` cạnh repo nếu có (giữ nguyên trải nghiệm cũ), nếu không thì chạy độc lập.

### 3.5 Lớp adapter mô hình (`lib/providers/`)
`ModelAdapter` (lớp cơ sở) với giao diện: `validateConfiguration`, `listModels`, `streamResponse` (async generator; SSE cho OpenAI/Anthropic/Gemini, có chế độ không stream), `executeToolCall` (phân tích/sửa nhẹ JSON đối số, kiểm tra theo schema, gọi bộ thực thi, chuẩn hóa kết quả), `estimateUsage`, `normalizeError` (mã: `auth`, `rate_limit`, `quota`, `context_length`, `content_filter`, `model_not_found`, `server`, `network`, `timeout`, `bad_request`; kèm `retryable` và `retryAfterMs`). `respond()` (hợp đồng mà `AgentRunner` đang dùng) gộp các sự kiện stream thành `{status, output[], usage}` dạng Responses-API.

| Adapter | Giao thức | Mặc định |
|---|---|---|
| `openai` | Chat Completions (`max_completion_tokens`) | `https://api.openai.com/v1` |
| `openai-compatible` | Chat Completions (`max_tokens`) | URL người dùng nhập (OpenRouter, LM Studio, Ollama, vLLM…) |
| `anthropic` | Messages API, `x-api-key` + `anthropic-version`, `tool_use`/`tool_result`, prompt caching cho system+tools | `https://api.anthropic.com` |
| `gemini` | `generateContent`/`streamGenerateContent?alt=sse` (dùng lại bộ chuyển đổi hiện có) | `https://generativelanguage.googleapis.com` |
| `gateway` | `GatewayProvider` hiện có (dialect, nén 413, sửa lệnh Gemini lỗi) | giữ nguyên |

Thử lại: mạng/5xx/429/408 với backoff mũ và `Retry-After`, chỉ thử lại *bước gọi mô hình* (không bao giờ lặp lời gọi công cụ); thông báo bằng `onStatus`. `ProviderHub` giữ nhiều *hồ sơ* (không chứa bí mật) + hồ sơ đang dùng, cung cấp đúng các phương thức `GatewayProvider` đang có (`state/snapshot/ready/configure/clearKey/listModels/diagnoseConnection/respond/redact`) nên `hub.mjs` và giao diện đổi tối thiểu. "Kiểm tra kết nối" gồm: xác thực cấu hình → liệt kê model → một lượt trả lời nhỏ → *thăm dò gọi công cụ* (một công cụ giả) để cảnh báo sớm nếu mô hình không gọi được công cụ.

`SecretStore`: DPAPI trên Windows (script sẵn có), AES-256-GCM với khóa tệp `0600` ở nơi khác (chống lộ vô tình qua sao lưu/log, **không** chống phần mềm độc hại cùng tài khoản — ghi rõ), hoặc chỉ bộ nhớ khi không chọn "ghi nhớ"; có thể đọc từ biến môi trường (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`). Mọi khóa được đăng ký vào bộ che bí mật hiện có.

### 3.6 Độ tin cậy gọi công cụ và ngữ cảnh
- `AgentRunner` gửi cho mô hình **công cụ trực tiếp** (`read_file`, `edit_file`, `run_command`, `update_plan`…, schema thật) cộng bốn công cụ định tuyến (`mcp_catalog/describe/call/capabilities`) cho phần còn lại — không còn phải bọc mọi thứ trong `arguments_json`. Đối số sai schema trả về *lỗi có cấu trúc* (`executed:false`) để mô hình tự sửa, không làm hỏng phiên. Chỉ bật khi danh mục có `local`, nên các test hiện có không đổi.
- `compactHistory`: trước mỗi lượt, nếu ước lượng token vượt ngân sách (70% cửa sổ ngữ cảnh − token đầu ra), thay các kết quả công cụ cũ bằng bản rút gọn có đánh dấu; bản ghi đầy đủ vẫn nằm trong `transcript.jsonl`.

### 3.7 Máy trạng thái nhiệm vụ (`lib/task-state.mjs`)
Trạng thái chuẩn: `created → queued → planning → running ⇄ waiting_approval / verifying → completed | failed | cancelled | paused | uncertain`. Trạng thái cũ (`status`) giữ nguyên để tương thích; thêm trường `state` suy ra từ `status` + pha hiện tại + hộp phê duyệt đang chờ + `pendingCall`/`unverifiedOperations` (→ `uncertain`), cùng bảng chuyển hợp lệ và `stateHistory`. Phục hồi: tác vụ `running` khi Hub khởi động lại → `paused`/`uncertain`, không bao giờ chạy lại thao tác ghi chưa xác định (hành vi sẵn có, được bổ sung test).

### 3.8 Giao diện
Trình hướng dẫn lần đầu (thư mục dự án → nhà cung cấp → khóa → kiểm tra kết nối → chế độ quyền), màn Cài đặt model (nhiều hồ sơ), bộ chọn chế độ quyền có Read Only, hộp phê duyệt hiển thị lệnh/diff, huy hiệu trạng thái nhiệm vụ mới, nhãn *thử nghiệm* cho ChatGPT Web. Làm thành tệp riêng (`web/onboarding.js`) để không đụng thêm vào `react-app.js` dày đặc.

## 4. Chiến lược kiểm thử

| Lớp | Nội dung |
|---|---|
| Unit | `LocalTools` (đường dẫn, symlink/junction, CRLF, kích thước), `analyzeCommand` (bảng ca đúng/sai), `ShellRunner` (trích dẫn PowerShell, timeout, cây tiến trình, lọc môi trường), adapter (chuyển đổi định dạng, SSE, lỗi), `compactHistory`, máy trạng thái, `SecretStore` |
| Integration | máy chủ mô hình giả hỗ trợ OpenAI/Anthropic/Gemini (stream + không stream + lỗi 429/5xx/413); `AgentRunner` + `LocalTools` + `PermissionGate` thật |
| E2E (mô hình giả, công cụ thật) | sửa bug trong repo mẫu; tạo ứng dụng nhỏ; phục hồi phiên; repo độc hại (prompt injection); ma trận quyền; nhánh Git + commit |
| Chưa làm / bị chặn | mô hình thật (cần khóa + chi phí); PR GitHub thật (cần xác thực mạng); cô lập user A/B (Phase 3) — được ghi đúng nhãn `blocked` |
| Cổng chất lượng | `npm test` (mọi suite, chạy trên Windows + Linux), quét bí mật, không file bị track nhầm, CI |

## 5. Rủi ro đã nhận diện

| Rủi ro | Giảm thiểu |
|---|---|
| Phân tích lệnh bằng heuristic có thể bị lách | mặc định bi quan (không chắc → hỏi); hiển thị nguyên văn lệnh; tài liệu nói rõ không phải sandbox; Docker sandbox tùy chọn; khuyến nghị Review cho repo lạ |
| Prompt injection từ nội dung repo | nội dung file là dữ liệu không đáng tin trong prompt hệ thống; `.env` bị chặn; lệnh mạng/xóa luôn hỏi; môi trường shell không chứa khóa API |
| Khóa API lộ qua log/transcript/lỗi | che bí mật ở mọi đường ra; test quét bí mật; không bao giờ gửi khóa tới origin khác (giữ `redirect:'error'`) |
| Chi phí khi thử lại/nhiều lượt | chỉ thử lại bước gọi mô hình; hiển thị token; giới hạn bước/phút tùy chọn có sẵn |
| Hồi quy tính năng đang chạy | mọi thay đổi là bổ sung; chạy lại 26 suite sau từng bước, trên cả Windows và Linux |

## 6. Đối chiếu thiết kế với hiện thực

Cập nhật khi kết thúc Phase 1 (2.3.0). Nhãn theo README: `implemented` → `unit-tested` → `integration-tested` → `e2e-verified` (mô hình giả, trừ khi ghi khác) → `production-verified`; `blocked` = chưa làm được vì thiếu điều kiện bên ngoài.

### 6.1 Tiêu chí thành công (mục 1)

| # | Tiêu chí | Nhãn | Bằng chứng (bộ test; chi tiết ở [PHASE1-REPORT.md](PHASE1-REPORT.md)) |
|---|---|---|---|
| 1 | Hub khởi động không cần `--repo-root`/Docker | e2e-verified (Windows 11 + Linux) | `verify-local-backend`, `verify-launcher`; mọi bộ `verify-e2e-*` khởi động một tiến trình Hub thật |
| 2 | Agent đọc/ghi/sửa file, chạy lệnh, Git qua `local.*` | e2e-verified (mô hình giả) | `verify-local-tools`, `verify-fs-helpers`, `verify-e2e-bugfix`, `verify-e2e-git`, `verify-e2e-fastapi` (ứng dụng FastAPI + pytest thật) |
| 3 | Ba chế độ quyền hoạt động đúng; lệnh nguy hiểm luôn hỏi | e2e-verified (mô hình giả) | `verify-permissions-modes`, `verify-command-analysis`, `verify-shell-guards`, `verify-shell-runner`, `verify-full-access`, `verify-e2e-adversarial`, `verify-ui-e2e.py` (Chromium thật) |
| 4 | Adapter Anthropic / OpenAI-compatible / Gemini; gọi công cụ đáng tin | integration-tested (fetch giả). **Không streaming.** Mô hình thật: **blocked** | `verify-model-adapters` và các bộ Gemini/gateway cũ |
| 5 | Khóa API lưu an toàn, không lộ | integration-tested; DPAPI khứ hồi thật trên Windows; quét bí mật trong E2E | `verify-model-adapters`, `verify-e2e-adversarial` |
| 6 | Máy trạng thái + phục hồi không phát lại thao tác ghi chưa rõ kết quả | e2e-verified (mô hình giả; giết Hub thật giữa chừng) | `verify-task-state`, `verify-e2e-recovery`, `verify-persistent-sessions`, `verify-studio-recovery` |
| 7 | Onboarding lần đầu xong không cần sửa file cấu hình | e2e-verified bằng Chromium thật + mô hình giả; **chưa có người dùng thật** chạy thử | `verify-ui-logic`, `verify-ui-e2e.py` |

### 6.2 Điểm hiện thực khác thiết kế

| Thiết kế | Hiện thực | Lý do / hệ quả |
|---|---|---|
| Stream SSE cho mọi nhà cung cấp (3.5, mục 4) | **Không streaming**: một yêu cầu, một phản hồi cho mỗi lượt | Đơn giản và dễ kiểm thử hơn; người dùng thấy kết quả sau mỗi lượt, không thấy chữ chạy dần. Việc thêm streaming là việc sau |
| `lib/providers/` với lớp cơ sở `ModelAdapter`; adapter `openai`, `openai-compatible`, `anthropic`, `gemini`, `gateway` (3.5) | Thư mục `lib/` phẳng: `standard-adapter.mjs` (vòng gọi trung lập: thử lại, rút gọn, lỗi) + bộ mã hóa giao thức `anthropic-api.mjs`, `openai-chat-api.mjs`, `gemini-compat.mjs`; `gateway-provider.mjs` giữ cấu hình, lưu key, kiểm tra kết nối và vòng riêng của Gemini | Ít lớp hơn; giữ được các bộ test Gemini cũ |
| `ProviderHub` với nhiều hồ sơ (3.5, 3.8) | **Một** cấu hình nhà cung cấp tại một thời điểm | Đổi nhà cung cấp = sửa form; không có danh sách hồ sơ |
| `executeToolCall` trong adapter (3.5) | Nằm ở `AgentRunner` và `HubManager#guardCalls` | Một chỗ duy nhất đi qua cổng quyền, checkpoint, ghi trạng thái |
| Mã lỗi chuẩn hóa `auth`, `rate_limit`, `quota`, … (3.5) | Mã `gateway_auth`, `gateway_quota`, `gateway_rate_limit`, `gateway_overloaded`, `gateway_context_length`, `gateway_model_not_found`, `gateway_network`, `gateway_http_error`; không có `content_filter` riêng | Kèm `retryable`/`retryAfterMs`; thông báo tiếng Việt kèm hướng xử lý |
| Windows: `powershell.exe -EncodedCommand`; `shell: cmd \| bash` (3.2) | **Git Bash trước**, PowerShell 5.1 (`-EncodedCommand`) khi không có; `shell` ∈ `bash`, `sh`, `powershell`; không có `cmd`; `bash.exe` của WSL bị loại | Mô hình quen bash nhất; cú pháp `&&` không có trong PowerShell 5.1 |
| `compactHistory` khi vượt 70% cửa sổ (3.6) | Ngân sách **85%** của cửa sổ *đã biết* (ô "Context window (tokens)"); ngoài ra rút gọn rồi thử lại khi máy chủ báo vượt ngữ cảnh | Không biết cửa sổ thì không rút gọn chủ động |
| Công cụ trực tiếp + 4 công cụ định tuyến (3.6) | Đúng như thiết kế (`directToolsFor`) | — |
| Lệnh `read` tự chạy; `verify`/`edit` chỉ ở Autonomous (3.2) | Đúng; thêm: mọi từ trong lệnh được **đi theo đường thật** (symlink, junction, 8.3, ổ PowerShell) và lệnh trỏ ra ngoài workspace hoặc tới file bí mật bị nâng lên `exec` (`lib/command-paths.mjs`) | Bổ sung sau kiểm thử đối kháng; không có trong thiết kế |
| `git -C <workspace>` (3.1) | `lib/git-runner.mjs` tắt thuộc tính nguy hiểm trên dòng lệnh và từ chối cấu hình kho có chương trình (`git_config_untrusted`); `lib/git-trust.mjs` cho lệnh Git gõ trong shell | Bổ sung sau kiểm thử đối kháng |
| Autonomous: `dangerous`/`exec`/`unknown` vẫn hỏi (3.3) | `dangerous` và `exec` hỏi; **`unknown` bị từ chối, không hỏi** (an toàn hơn thiết kế). Nhãn giao diện và comment được sửa cho khớp | Với backend `local` mọi công cụ đều được phân loại, nên chỉ gặp với MCP ngoài |
| `Start-ChatMcpHub.ps1` tự tìm `cloud-harness-mcp` cạnh repo (3.4) | `-Backend auto` = `mcp` **chỉ khi** bạn truyền `-RepoRoot`, ngược lại `local`; thư mục anh em chỉ được tìm khi bạn chọn `-Backend mcp` | Không bao giờ vô tình quay về luồng cũ |
| Máy trạng thái cho mọi tác vụ (3.7) | Cho tác vụ **API**. Tác vụ chế độ ChatGPT Web (legacy) giữ `status` cũ, không có `state` chuẩn | Chế độ legacy, không đầu tư thêm |
| 26 suite phải luôn xanh (đầu tài liệu) | 46 bộ kiểm thử Node (số lúc đóng Phase 1) + 5 bộ giao diện Python; lúc đóng Phase 1 chạy xanh trên cả hai hệ điều hành (xem báo cáo) | Bộ chạy chung `npm test` thay cho chạy từng file |
| Kiểm thử E2E: "ma trận quyền" riêng (mục 4) | Ma trận quyền nằm ở `verify-permissions-modes` và `verify-ui-e2e.py`; E2E thêm: kho độc hại, hai Hub cạnh nhau (mức Hub, không phải cô lập người dùng), phục hồi sau giết Hub | Cô lập người dùng A/B **trong một deployment** vẫn là `blocked` |

### 6.3 Những gì thiết kế hứa là "ngoài phạm vi" và vẫn chưa có

Mô hình thật (cần khóa và đồng ý chi phí), Pull Request GitHub thật (cần xác thực), cô lập đa người dùng, triển khai server (Phase 2): xem [DEPLOYMENT.md](DEPLOYMENT.md), [TESTING-WITH-REAL-MODELS.md](TESTING-WITH-REAL-MODELS.md), [SECURITY.md](../SECURITY.md).
