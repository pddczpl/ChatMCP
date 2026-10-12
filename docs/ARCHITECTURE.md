# Kiến trúc ChatMCP

Tài liệu mô tả kiến trúc **như đang có trong mã** (Hub `2.3.0`, giao diện `2.3.0-react-agent`, nhánh `dev/chatmcp-agent`). Phần nào là kế hoạch được ghi rõ là *kế hoạch*. Thiết kế gốc của Phase 1 nằm ở [PHASE1-DESIGN.md](PHASE1-DESIGN.md); mục cuối của tài liệu đó liệt kê chỗ mã **khác** thiết kế.

## 1. Sơ đồ

```mermaid
flowchart LR
  subgraph Browser["Trình duyệt của bạn"]
    UI["Dashboard React<br/>127.0.0.1:3007"]
    EXT["Companion MV3<br/>(ChatGPT Web, legacy)"]
  end
  subgraph Hub["ChatMCP Hub — một tiến trình Node (hub.mjs)"]
    HTTP["HTTP server<br/>Host/Origin + CSRF + CSP"]
    DUAL["DualAgent"]
    RUN["AgentRunner (API)<br/>vòng lặp, transcript, trạng thái"]
    WEB["BrowserRunner<br/>(ChatGPT Web, legacy)"]
    PROV["GatewayProvider<br/>adapter + thử lại + nén ngữ cảnh"]
    CALL["session.callTool<br/>kiểm tra → quyền → checkpoint → chạy"]
    GATE["PermissionGate<br/>chỉ đọc · review · tự động"]
    LOCAL["LocalTools (36 công cụ)<br/>file · tìm kiếm · git · plan"]
    SHELL["ShellRunner + phân tích lệnh<br/>+ theo dõi đường dẫn thật + tin cậy cấu hình Git"]
    STUDIO["StudioTools (10)<br/>checkpoint · review · chỉ mục mã · kiểm tra"]
    STATE[("Thư mục dữ liệu<br/>nhiệm vụ · checkpoint · khóa API")]
  end
  MCP["MCP ngoài (tùy chọn, backend mcp)<br/>Cloud Harness · Desktop Commander"]
  LLM[("Nhà cung cấp mô hình<br/>Anthropic · OpenAI · Gemini · tương thích OpenAI · Ollama")]
  UI --> HTTP
  EXT --> HTTP
  HTTP --> DUAL
  DUAL --> RUN
  DUAL --> WEB
  RUN --> PROV --> LLM
  RUN --> CALL --> GATE
  CALL --> LOCAL --> SHELL
  CALL --> STUDIO
  CALL -. "chỉ khi --backend mcp" .-> MCP
  RUN --> STATE
  STUDIO --> STATE
```

Hub là **một tiến trình Node duy nhất, không có bước build**, nghe trên `127.0.0.1`. Giao diện là React 16 nhúng offline (`CHATMCP-HUB/web/vendor`) cộng các tệp tĩnh; trình duyệt không tải gì từ CDN.

## 2. Hai backend

| Backend | Khi nào | Công cụ của agent | Cần |
|---|---|---|---|
| `local` (mặc định khi không có `--repo-root`) | Dùng hằng ngày | `local.*` (trong tiến trình) + `studio.*` | chỉ Node.js ≥ 22.12 và Git (cho công cụ Git) |
| `mcp` (legacy, cần `--repo-root`) | Luồng cũ | `local.*` + `studio.*` + công cụ MCP ngoài qua `mcp_call` | Docker, Cloud Harness MCP, Desktop Commander, proxy |

Ở backend `local` các dịch vụ ngoài **không được khởi động và không được yêu cầu**; nhật ký khởi động ghi `Chế độ cục bộ (không cần Docker/Cloud Harness)`. Cloud Harness chỉ là phụ thuộc tùy chọn của backend `mcp` (ghim phiên bản ở `deps/cloud-harness.lock.json`, MIT, không fork, không sửa) và **không phải ranh giới cô lập** (xem [SECURITY.md](../SECURITY.md)).

## 3. Vòng lặp agent

`AgentRunner` (`lib/agent.mjs`) điều khiển một nhiệm vụ: gửi hội thoại cho mô hình qua `GatewayProvider`, nhận lời gọi công cụ, thực thi qua `session.callTool`, đưa kết quả trở lại, lặp tới khi mô hình trả lời kết thúc.

- **Công cụ trực tiếp.** Mô hình thấy các công cụ `local.*` với JSON Schema thật (`read_file`, `edit_file`, `run_command`, `update_plan`…) cộng bốn công cụ định tuyến `mcp_catalog`, `mcp_describe`, `mcp_call`, `mcp_capabilities` cho phần còn lại (công cụ `studio.*` và MCP ngoài). Đối số sai schema được trả về như *lỗi có cấu trúc* (`executed: false`) để mô hình tự sửa; người dùng không bao giờ bị hỏi duyệt một lời gọi không thể chạy.
- **Giao thức mô hình.** `lib/standard-adapter.mjs` dùng `lib/anthropic-api.mjs` (Messages API: `tool_use`/`tool_result`, prompt caching) hoặc `lib/openai-chat-api.mjs` (Chat Completions, gồm OpenRouter/DeepSeek/Groq/Mistral/Ollama/LM Studio và máy chủ tương thích). Gemini vẫn đi vòng lặp riêng của `lib/gateway-provider.mjs` + `lib/gemini-compat.mjs` (sửa lệnh lỗi định dạng, nén khi HTTP 413). Bảng preset ở `lib/provider-presets.mjs`.
- **Thử lại.** Chỉ **bước gọi mô hình** được thử lại (mạng, 5xx, 429/408 với `Retry-After`; tối đa 10 lần lỗi mạng, 5 lần lỗi HTTP, một nhà cung cấp đòi chờ > 120 s thì báo thay vì chờ). Một lời gọi công cụ **không bao giờ** được thử lại hay phát lại tự động.
- **Ngữ cảnh.** Khi biết cửa sổ ngữ cảnh của model (preset có sẵn hoặc bạn nhập "Ngữ cảnh model"), trước mỗi lượt `compactHistory` làm việc trên **bản sao**: thay các kết quả công cụ cũ bằng bản rút gọn có đánh dấu khi ước lượng vượt ngân sách (85% cửa sổ − token đầu ra); bản đầy đủ vẫn nằm trong `transcript.jsonl`. Không biết cửa sổ thì chưa có ngân sách chủ động (chỉ nén khi nhà cung cấp trả HTTP 413). Phiên vượt 48 MiB thì nhiệm vụ dừng (`context_limit`) thay vì lặng lẽ bỏ dữ liệu.
- **Giới hạn.** Giao diện không áp giới hạn lượt/thời gian cho phiên một người dùng; API vẫn nhận `maxSteps` và `maxMinutes` (hết giới hạn → `paused`, lý do `step_limit`/`time_limit`).
- **Phát hiện khả năng gọi công cụ.** "Lưu & kiểm tra" trong Cài đặt gửi một lượt nhỏ kèm một công cụ giả (`lib/tool-probe.mjs`) để cảnh báo sớm khi mô hình không gọi được công cụ — điều mà một agent lập trình không thể thiếu.

## 4. Đường đi của một lời gọi công cụ

Mọi lời gọi của agent đi qua cùng một cổng (`HubManager#guardCalls`, `lib/manager.mjs`), bất kể backend:

1. **Ràng buộc workspace** — phiên công cụ phải còn gắn đúng thư mục/thế hệ của nhiệm vụ.
2. **Kiểm tra đối số** theo schema (`lib/tool-schema.mjs`); sai thì trả lỗi, không hỏi người dùng.
3. **`PermissionGate.authorize`** — phân loại lời gọi (`LocalTools.assess` biết nội dung lệnh, đường dẫn, cờ nguy hiểm) rồi quyết định theo chế độ: cho chạy, từ chối, hoặc tạo yêu cầu phê duyệt và **chờ**. Hết 10 phút không trả lời → từ chối.
4. **`onDecision`** — runner ghi "lời gọi này sắp chạy" (`pendingCall`) *trước khi* nó có tác dụng. Nếu việc ghi lỗi, lời gọi không chạy.
5. **Checkpoint trước khi thay đổi** — với công cụ file, chỉ các file sắp bị đụng tới được lưu đầy đủ; với `run_command` (có thể đụng mọi thứ) lưu ảnh chụp workspace có giới hạn, tái sử dụng nếu chưa đổi. Không tạo được checkpoint → lời gọi **không chạy** (`checkpoint_failed`). Checkpoint thiếu sót được gắn nhãn, không bao giờ trình bày như bản sao lưu đầy đủ.
6. **Thực thi** (`LocalTools.call` / `StudioTools.call` / MCP ngoài).
7. **Ghi dòng thời gian** (`workflow`): có phải sửa file không, có phải lệnh kiểm tra thành công không. Chỉ một lệnh `run_command` thuộc loại `verify` thoát mã 0 mới được tính là *đã kiểm chứng*; lần chạy test **thất bại** không được tính.

Lời từ chối và lỗi checkpoint được trả cho mô hình như kết quả nói rõ "chưa thực thi", để mô hình phản ứng.

## 5. Máy trạng thái nhiệm vụ

`lib/task-state.mjs`. Trường `status` cũ được giữ để tương thích; `state` là góc nhìn đủ để người dùng không bị đánh lừa. Sơ đồ dưới đây chỉ vẽ các đường chính; bảng đầy đủ các chuyển trạng thái hợp lệ là `TRANSITIONS` trong mã (ví dụ nhiệm vụ mới tạo hoặc đang chờ có thể sang `failed`/`cancelled`, và `waiting_approval` có thể sang `paused`/`uncertain`). `verify-docs` kiểm tra rằng sơ đồ không vẽ cạnh nào mà mã cấm và nêu đủ 11 trạng thái.

```mermaid
stateDiagram-v2
  [*] --> created
  created --> queued
  queued --> planning
  planning --> running
  running --> waiting_approval
  waiting_approval --> running
  running --> verifying
  verifying --> running
  running --> completed
  running --> failed
  running --> cancelled
  running --> paused
  running --> uncertain
  completed --> queued: gửi tin nhắn tiếp
  paused --> queued
  uncertain --> queued
```

Bảo đảm (được kiểm bằng `verify-task-state.mjs`):

- Chỉ các chuyển trạng thái hợp lệ trong bảng `TRANSITIONS` được áp dụng; chuyển trạng thái sai bị từ chối và báo cáo, không bị áp lặng lẽ.
- Nhiệm vụ dừng khi một lời gọi công cụ **có thể đã có tác dụng nhưng chưa biết kết quả** là `uncertain`, không bao giờ là `failed`/`cancelled` — để không ai nhầm "đã dừng" với "chưa có gì xảy ra".
- Nhiệm vụ đã dừng (`paused`, `completed`, `failed`, `cancelled`, `uncertain`) chỉ đi tiếp bằng một lượt chạy mới (`queued`): cùng một hội thoại luôn tiếp tục được, nhưng không bao giờ "tự tiếp tục" mà không ai biết.
- Trạng thái của một nhiệm vụ lưu trên đĩa là hàm thuần của các trường đã lưu: tệp của bản cũ hay tệp bị bỏ lại giữa chừng sau sự cố được phân loại giống nhiệm vụ đang chạy. Lịch sử chuyển trạng thái (`stateHistory`) giữ tối đa 100 mục.
- Nhiệm vụ ChatGPT Web (BrowserRunner) **chưa** có `state` chuẩn; giao diện hiển thị theo `status` cũ.

## 6. Phân quyền

`PermissionGate` (`lib/permissions.mjs`) có ba **chế độ** và ba **chính sách thực thi**.

| Chế độ | Đọc / checkpoint / kế hoạch | Sửa file trong workspace | Lệnh kiểm tra đã biết (`verify`) | `execute`, `dangerous` | Công cụ chưa phân loại (`unknown`) |
|---|---|---|---|---|---|
| `readonly` (Chỉ đọc) | chạy | **từ chối ngay, không hỏi** | từ chối | từ chối | từ chối |
| `review` (mặc định; tên cũ `manual`) | chạy | hỏi từng lần | hỏi | hỏi | hỏi |
| `autonomous` (Tự động) | chạy | tự chạy (có checkpoint) | tự chạy | **vẫn hỏi** | **từ chối** (không hỏi) |

Phân loại (`category`): `read`, `checkpoint`, `workspace_edit`, `execute`, `dangerous`, `unknown`, `blocked`. `blocked` (file bí mật, metadata Git) bị từ chối thẳng ở mọi chế độ, không đưa ra hỏi. Chính sách thực thi: `host-review` (mặc định), `sandbox-only` (chặn mọi công cụ ghi/chạy trên máy chủ, chỉ cho `studio.*` và công cụ đọc), `full-access` (chỉ bật khi gõ đúng `FULL ACCESS`; bỏ mọi kiểm tra workspace và phê duyệt — **không dùng** cho dự án lạ).

Với `run_command`, chế độ không quyết định một mình: nội dung lệnh được phân loại (mục 8) và lệnh bị xếp loại `exec`/`dangerous` hỏi người dùng kể cả ở `autonomous`. Lệnh loại `read` (`cat`, `ls`, `git status`… mà mọi từ trong lệnh nằm trong workspace và không phải file bí mật) chạy ở cả ba chế độ; lệnh có từ trỏ ra ngoài workspace hoặc tới file bí mật bị nâng lên `exec` (hỏi; ở `readonly` thì từ chối). Hộp phê duyệt hiển thị **lệnh nguyên văn** hoặc **diff** của thay đổi, kèm rủi ro; kết quả quyết định được lưu trong `permission-history.json` (đã che bí mật).

## 7. Công cụ cục bộ

`lib/local-tools.mjs` — 36 công cụ, mỗi công cụ có `inputSchema` thật và tự kiểm tra giới hạn của mình (quyền không phải lớp bảo vệ duy nhất).

| Nhóm | Công cụ | Loại quyền |
|---|---|---|
| Đọc & Tìm kiếm | `read_file`, `list_directory`, `find_files`, `search_files`, `git_status`, `git_diff`, `git_log`, `get_plan` | `read` |
| Ký hiệu mã (Symbols) | `symbols_search`, `symbols_references` | `read` |
| Kế hoạch | `update_plan` | `checkpoint` |
| Ghi & Patch | `write_file`, `edit_file`, `make_directory`, `move_path`, `files_write_batch`, `files_apply_patch` | `workspace_edit` |
| Git & Worktrees | `git_add`, `git_commit`, `git_branch`, `git_checkout`, `git_merge`, `worktrees_list`, `worktrees_create`, `worktrees_remove` | `workspace_edit` / `read` |
| Tác vụ nền (Tasks) | `tasks_run`, `tasks_list`, `tasks_status`, `tasks_cancel` | `dangerous` / `read` / theo lệnh |
| Tri thức (Knowledge) | `knowledge_create`, `knowledge_search`, `knowledge_list` | `workspace_edit` / `read` |
| GitHub Integration | `github_read`, `github_action` | `read` / `execute` |
| Xóa | `delete_path` | `dangerous` (luôn hỏi) |
| Lệnh | `run_command` | theo nội dung lệnh |

Đặc điểm đáng nhớ:

- `write_file` ghi nguyên tử (tệp tạm + rename có thử lại trên Windows), tạo thư mục cha; **thay** file đã có cần `expected_sha256` (băm file như lần đọc cuối) hoặc `overwrite`. `edit_file` thay chuỗi chính xác, bắt buộc duy nhất trừ khi `replace_all`, hiểu CRLF/LF.
- `git_commit` **bỏ qua hook** (hook là mã tùy ý của kho); chỉ chạy hook khi `run_hooks: true` — khi đó được xếp loại `execute` và hỏi. Không có `git push`, `reset --hard`, `clean` trong công cụ; đi qua `run_command` và luôn hỏi.
- Giới hạn: đọc ≤ 10 MiB / 2000 dòng / 200 000 ký tự; ghi ≤ 2 MiB; sửa ≤ 4 MiB; tìm ≤ 500 file / 300 kết quả / 10 s; lệnh ≤ 8000 ký tự; checkpoint ≤ 140 file. Thư mục ồn (`node_modules`, `.venv`, `dist`, `build`, `__pycache__`…) được liệt kê nhưng không tìm trong đó trừ khi `include_ignored`.
- Công cụ `studio.*` còn lại (10): `symbols`, `references`, `definitions`, `index_status`, `checks`, `skills`, `diff_check`, `checkpoints`, `checkpoint`, `review`.

## 8. Chạy lệnh và các lớp bảo vệ quanh nó

Đây là phần có nhiều lớp nhất vì nội dung một lệnh shell không thể được "chứng minh an toàn" bằng cách đọc chữ. **Tất cả đều là heuristic bảo thủ, không phải sandbox**; xem giới hạn trong [SECURITY.md](../SECURITY.md).

1. **`ShellRunner`** (`lib/shell-runner.mjs`). Shell mặc định là **bash**: trên Windows là **Git Bash** nếu đã cài Git for Windows (mô hình quen cú pháp bash nhất; lệnh luôn được đưa vào bash dưới dạng tệp script nên tránh hẳn lỗi trích dẫn dòng lệnh Windows), không có Git Bash thì **Windows PowerShell**; trên Linux/macOS là `bash`, không có thì `sh`. Mô hình có thể chọn `shell: bash | sh | powershell`. PowerShell nhận mã qua `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <UTF-16LE base64>` nên không còn lỗi dấu nháy kép lồng nhau của PowerShell 5.1; script rất dài đi qua tệp `.ps1` tạm. stdin đóng; `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `NO_COLOR=1`, `PAGER=cat`, `PYTHONUTF8=1`. Mặc định 120 s (tối đa 900 s); đầu ra giới hạn (giữ đầu + cuối, nói rõ phần bị cắt); hủy hoặc quá hạn giết cả cây tiến trình (`taskkill /T /F` hoặc process group).
2. **Lọc môi trường.** Biến có tên chứa từ khóa thông tin xác thực (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, `*_KEY`, `AUTH`…; `PGPASSWORD`, `MYSQL_PWD`) hoặc có giá trị dạng `scheme://user:password@host` bị **xóa** khỏi môi trường của lệnh. `PWD` (thư mục hiện tại) và `LESSKEY`, `KEYBOARD_LAYOUT`… (từ nằm trong từ khác) giữ lại.
3. **Phân tích lệnh** (`lib/command-analysis.mjs`) tách lệnh theo `; && || |` và xuống dòng ngoài dấu nháy, rồi xếp loại thận trọng: `read` (chỉ xem), `verify` (test/build/chạy mã dự án quen thuộc), `edit` (git add/commit, mkdir, ghi file), `exec` (mạng, cài gói, chương trình lạ, mở rộng biến, shell lồng nhau), `dangerous` (xóa, `git push`, viết lại lịch sử, đổi hệ thống, pipe vào interpreter). **Không nhận ra → `exec` → hỏi.** Lệnh hay bị lách (`cat *`, `cat .e*`, `git show HEAD:.env`, `grep -r` quét bí mật, `env`, `printenv`, `/proc/self/environ`) được xếp để hỏi.
4. **Theo dõi đường dẫn thật** (`lib/command-paths.mjs`). Mỗi từ có thể là đường dẫn được đi theo tới nơi nó thực sự rơi vào: symlink, junction, tên rút gọn 8.3 (`ENV~1`), đích của redirect `>` qua thư mục liên kết. Rơi ra ngoài workspace hoặc vào file bí mật → lệnh "chỉ đọc" cũng phải hỏi. Riêng PowerShell, các "ổ" `Env:`, `HKCU:`, `HKLM:`, `Cert:`, `Variable:`, `FileSystem::…` (nơi chứa biến môi trường, registry, chứng chỉ) bị coi là vấn đề.
5. **Tin cậy cấu hình Git** (`lib/git-trust.mjs`). `.git/config` và hook của một thư mục tải về là của người khác và có thể chạy chương trình: `core.fsmonitor`, `core.hooksPath` và các hook, `core.pager`/`core.editor`/`diff.external`, bộ lọc `clean`/`smudge`/`process` (trừ cấu hình Git LFS chuẩn), trình điều khiển `diff`/`merge`, `gpg.program`, `include`, `credential.helper`, `core.sshCommand`… Công cụ Git của Hub tự **tắt** những gì tắt được trên dòng lệnh (fsmonitor, hook, pager) và **từ chối** phần còn lại (mã `git_config_untrusted`); `git status/commit` gõ qua shell trong kho như vậy được đưa ra hỏi, kèm tên cài đặt gây rủi ro. Chỉ đọc cấu hình của chính kho; cấu hình toàn cục/hệ thống của bạn được tin. Giá trị cấu hình không bao giờ được trả lại (có thể chứa mật khẩu).
6. **Vùng cấm** (`lib/protected-paths.mjs`): `.env*` (trừ `.example/.sample/.template/.dist/.defaults`), `id_rsa*`/`id_ed25519*`, `*.pem *.p12 *.pfx *.key *.keystore *.jks *.ppk`, `credentials(.json)`, `secrets.(json|yml|toml)`, `.npmrc .pypirc .netrc .git-credentials .htpasswd`, và các thư mục `.git .ssh .aws .gnupg .kube`. Áp dụng thống nhất cho công cụ file và cho phân tích lệnh.
7. **Che bí mật.** Ở `task.json`, `transcript.jsonl`, nhật ký và báo cáo: khóa API đã đăng ký được thay chính xác; ngoài ra che `sk-…` và `Bearer …`, và mọi giá trị nằm dưới khóa JSON tên `api_key`/`access_token`/`password`…. Bản xem trước của hộp phê duyệt và lịch sử quyền che thêm các mẫu `ghp_…`, `github_pat_…`, `AKIA…`, `AIza…`, `xox?-…`, `password=…`, `//user:pass@`. Đây là **che theo mẫu**: một bí mật dạng khác, nằm trong biến môi trường tên vô hại, hoặc đã bị commit vào lịch sử Git, không được che (xem giới hạn trong [SECURITY.md](../SECURITY.md)).

## 9. Nhà cung cấp mô hình và khóa API

- Preset: Anthropic, OpenAI, Google Gemini, OpenRouter, DeepSeek, Groq, Mistral, Ollama, LM Studio, và ba preset "khác" (tương thích OpenAI / Anthropic / Gemini). Preset chỉ chứa giá trị công khai (endpoint, giao thức, model gợi ý), không bao giờ chứa khóa.
- Khóa lưu: Windows → **DPAPI** (`windows/Protect-ApiKey.ps1`; chỉ đúng tài khoản Windows trên đúng máy đọc lại được). Linux/macOS → **AES-256-GCM** với khóa từ `CHATMCP_MASTER_KEY` hoặc tệp `master.key` quyền `0600` cạnh dữ liệu (chống lộ qua sao lưu/log/ảnh chụp màn hình, **không** chống phần mềm chạy cùng tài khoản). Có thể không lưu mà truyền qua biến môi trường của đúng nhà cung cấp (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `OPENROUTER_API_KEY`…); khóa lấy từ môi trường **không bao giờ** được gửi tới origin của nhà cung cấp khác. `redirect: 'error'` ở mọi yêu cầu có khóa. Đổi endpoint mà không nhập lại khóa → khóa đã lưu bị xóa (không mang sang origin khác).
- Chỉ HTTPS tới nhà cung cấp; HTTP thường chỉ được chấp nhận cho `localhost`/loopback (Ollama, LM Studio).
- Model nhỏ chạy cục bộ thường cắt ngữ cảnh lặng lẽ: preset Ollama/LM Studio ghi chú cách tăng ngữ cảnh.

## 10. Độ bền và phục hồi

- Mỗi nhiệm vụ có `task.json` (ghi nguyên tử) và `transcript.jsonl` (chỉ thêm vào, quyền `0600`) trong thư mục dữ liệu.
- Trước một lời gọi có tác dụng phụ, runner ghi `pendingCall`. Hub chết giữa chừng (mất điện, `SIGKILL`, `TerminateProcess`) → khi khởi động lại, `AgentRunner.load()` đánh dấu nhiệm vụ đang chạy là `paused` (`errorCode: process_interrupted`); nếu có lời gọi đang thực thi hoặc chưa rõ kết quả → `uncertain`. **Hub không phát lại lời gọi đó.**
- `RecoveryScheduler` (12 s) chỉ tự tiếp tục nhiệm vụ `paused` đã bật tự tiếp tục và không có `pendingCall`/thao tác chưa xác minh. Lời nhắc tiếp tục dặn rõ "không phát lại bất kỳ thay đổi file nào chưa rõ kết quả; đọc lại checkpoint và kiểm tra trước".
- Khóa instance (`hub-instance.lock`) theo thư mục dữ liệu: hai Hub không dùng chung một thư mục dữ liệu (thông báo "Một Hub đang giữ cấu hình này (PID …, cổng …)"). **Không có khóa chéo theo workspace**: hai Hub khác thư mục dữ liệu cùng mở một dự án không phối hợp với nhau.
- Hết thời gian chờ phê duyệt (10 phút) → từ chối, nhiệm vụ không treo mãi.

## 11. Dữ liệu trên đĩa

Mặc định: Windows `%LOCALAPPDATA%\ChatMCP\hub`; macOS `~/Library/Application Support/ChatMCP/hub`; Linux `$XDG_STATE_HOME/chatmcp` hoặc `~/.local/state/chatmcp`. Đổi bằng `--state-dir`, `CHATMCP_STATE_DIR` (hoặc `-StateDir` ở launcher).

```
hub-state.json         cài đặt (thư mục dự án, chế độ quyền, chế độ agent)
hub-instance.lock      khóa một Hub / một thư mục dữ liệu
hub.log                nhật ký (khi Hub do launcher nền khởi động)
api-tasks/<id>/        task.json + transcript.jsonl của từng nhiệm vụ (API)
gateway/               gateway-config.json (không chứa khóa) + gateway-key.dpapi + master.key (Linux/macOS)
studio/checkpoints/    ảnh chụp trước mỗi thay đổi (meta.json + file)
studio/plans/          kế hoạch của từng nhiệm vụ
studio/workflows/      dòng thời gian bằng chứng (sửa gì, kiểm gì)
studio/permission-history.json   lịch sử phê duyệt đã che bí mật
browser/               trạng thái chế độ ChatGPT Web (legacy)
```

Thư mục này chứa đoạn hội thoại và đầu ra công cụ: coi nó là **dữ liệu riêng tư**, đừng commit, đừng chia sẻ.

## 12. HTTP API (nội bộ của dashboard)

Mọi yêu cầu ghi (`POST`) cần đủ: `Origin` thuộc danh sách cho phép, header `X-ChatMCP-Request: local-dashboard`, token `X-ChatMCP-CSRF` (lấy từ `csrfToken` trong `GET /api/state`) và `Content-Type: application/json` (khác → 415). `Host` ngoài danh sách loopback → từ chối; `Origin` lạ → 403 kể cả với `GET`/`OPTIONS` (chỉ `chrome-extension://…` được gọi các route ghép cặp trình duyệt và đọc `/api/extension-state`, `/api/instructions`).

| Nhóm | Route |
|---|---|
| Trạng thái | `GET /api/health` (có `initialized`), `GET /api/state` (có `catalogReady`, `busy`, `csrfToken`), `GET /api/capabilities` |
| AI | `GET /api/ai/presets`, `GET /api/ai/models`, `POST /api/ai/config`, `/api/ai/test`, `/api/ai/clear-key` |
| Nhiệm vụ | `GET /api/tasks/<id>` (+ `/report`), `POST /api/tasks/start`, `/continue`, `/cancel`, `/delete`, `/auto-resume`, `POST /api/agent/mode` |
| Phê duyệt | `POST /api/studio/permissions/config {mode}`, `/api/studio/permissions/decide {id, approved}` |
| Workspace | `POST /api/workspace/select {path}`, `/api/workspace/browse`, `GET /api/studio/git/status`, `…/checkpoints`, `…/review`, `…/file` |
| Hoàn tác | `POST /api/studio/restore {checkpointId, file, expectedSha}` (409 `stale_review` nếu file đã đổi so với lúc bạn xem), `/api/studio/accept`, `/api/studio/checkpoint` |
| Khác | terminal, kế hoạch, chỉ mục mã/LSP, xác minh, `POST /api/hub/shutdown` |

## 13. Giao diện

- `web/index.html` nạp React nhúng + `ui-logic.js` + `onboarding.js` + `react-app.js`. `ui-logic.js` chứa toàn bộ quyết định của trang (trạng thái nhiệm vụ, chế độ quyền, điều kiện sẵn sàng, văn bản hộp phê duyệt) và có thể chạy không cần trình duyệt; `verify-ui-logic.mjs` import cả bản của máy chủ lẫn bản của trang và **fail nếu từ vựng lệch nhau**.
- Màn hình: thanh bên (hội thoại, tìm kiếm), vùng chat với ô nhập và bộ chuyển chế độ quyền, hộp **"Yêu cầu chờ bạn duyệt"** (lệnh/diff nguyên văn, rủi ro, Cho phép/Từ chối), bảng công cụ dự án (Hoạt động, Files, Git, Terminal, Code/LSP, Preview, Plan, Skills, Cài đặt) và **hướng dẫn lần đầu** 4 bước (thư mục dự án → kết nối AI kèm kiểm tra gọi công cụ → quyền của agent → tác vụ mẫu).
- Trang tin vào trạng thái từ máy chủ: nhãn "Hoàn tất" chỉ khi trạng thái thật là `completed`; "Chưa rõ kết quả" khi `uncertain`; chân trang bằng chứng nói đã *sửa* bao nhiêu file và đã có *lần kiểm tra thành công* nào chưa.

## 14. Ranh giới tin cậy

| Ranh giới | Cơ chế hiện có | Giới hạn |
|---|---|---|
| Trình duyệt ↔ Hub | bind `127.0.0.1`, allowlist Host/Origin, header + token CSRF, JSON-only, CSP, `no-store` | không có tài khoản; **không an toàn nếu mở ra mạng/tunnel** |
| Tiện ích ↔ Hub | mã ghép cặp, kiểm tra Origin `chrome-extension://…` | chỉ cho chế độ ChatGPT Web; mọi tiện ích có thể đọc đường dẫn workspace qua `/api/extension-state` |
| Hub ↔ mô hình | HTTPS, khóa DPAPI/AES, khóa chỉ gửi tới origin đã chọn | khóa nằm trong bộ nhớ Hub khi chạy |
| Agent ↔ file | quyền + `StudioWorkspace.resolve` + `LocalTools` (hai lớp) + vùng cấm + checkpoint | symlink/junction được xử lý; hardlink **không** được phát hiện |
| Agent ↔ lệnh shell | phân tích lệnh + đường dẫn thật + tin cậy Git + lọc môi trường + hỏi khi không chắc | lệnh được duyệt chạy với **quyền tài khoản của bạn**; không phải sandbox |
| Hub ↔ MCP ngoài (legacy) | loopback + bearer | bearer = quyền điều khiển toàn bộ công cụ, kể cả Docker socket |
| Người dùng A ↔ B | **không có** | Hub là ứng dụng một người dùng; mỗi người một Hub, mỗi Hub một thư mục dữ liệu |

## 15. Chiến lược phụ thuộc

- **Backend `local` không có phụ thuộc runtime bên ngoài** ngoài Node.js ≥ 22.12 và Git; không `npm install`. `node-pty` (ConPTY cho terminal tương tác) là tùy chọn; thiếu hoặc hỏng thì dùng pipe và nói rõ lý do.
- **Cloud Harness MCP** (backend `mcp`, tùy chọn): phụ thuộc bên thứ ba MIT, **không fork, không sửa, không phân phối lại**; ghim tại `deps/cloud-harness.lock.json` (tag `v0.62.8`); `scripts/bootstrap-cloud-harness.*` tải hoặc *xác minh* bản checkout và không bao giờ xóa gì.
- Gói npm chạy lúc dùng (`@wonderwhy-er/desktop-commander@0.2.52`, `@srbhptl39/mcp-superassistant-proxy@0.1.8`) chỉ dùng ở backend `mcp`, phụ thuộc bắc cầu chưa ghim bằng lockfile.
- React/ReactDOM 16.0.x nhúng sẵn (cũ; nâng cấp là hạng mục giao diện).
- Công cụ **chỉ dùng khi kiểm thử** (không phải phụ thuộc của sản phẩm): Python 3.11 + `fastapi httpx pytest uvicorn` (bộ E2E FastAPI), Python + `playwright` (bộ giao diện). Xem [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

## 16. Độ lệch so với thiết kế và hạng mục chưa làm

Chi tiết trong [PHASE1-DESIGN.md §6](PHASE1-DESIGN.md#6-đối-chiếu-thiết-kế-với-hiện-thực). Tóm tắt: **chưa có streaming** (mô hình trả lời trọn gói); **chưa có đa hồ sơ nhà cung cấp** (một cấu hình đang dùng); `executeToolCall` nằm trong `AgentRunner`/`manager` chứ không trong lớp adapter; bố cục `lib/` phẳng thay vì `lib/providers/`; nhiệm vụ ChatGPT Web chưa có trạng thái chuẩn.

Kế hoạch (chưa làm):

1. **Phase 2 — tự host đáng tin cậy:** Docker Compose, xác thực, HTTPS, health/backup, CI/CD. Xem [DEPLOYMENT.md](DEPLOYMENT.md): hiện **chưa có**.
2. **Streaming** phản hồi và sự kiện SSE.
3. **Đa người dùng** chỉ sau khi có bằng chứng cô lập cấp VM/microVM (Phase 3/4); Cloud Harness một mình **không** đủ.


## 17. Parallel Coding Workers và Skills Registry nâng cao (nhánh phát triển)

**Coding Worktree Orchestrator:** `lib/coding-orchestrator.mjs` tạo một Git worktree/branch riêng cho mỗi coding worker, có `HubManager` và `AgentRunner` độc lập. Danh mục công cụ của worker chỉ cho phép đọc/sửa file có kiểm soát, không shell hoặc công cụ Git push/merge. Hạn mức tối đa 4 workers, concurrency 1–3. Worker có thể tạo commit trên branch riêng; người dùng kiểm tra bằng chứng rồi xác nhận tích hợp vào **nhánh integration riêng**, hoặc xuất bản Draft PR riêng cho từng worker. Không tự merge `main`. Hệ thống Git worktree chỉ cách ly file/index, **không phải sandbox cấp OS** và không bảo đảm code tạo ra đạt test.

**GitHub Agent Skills Hub:** `lib/skill-registry.mjs` khám phá `SKILL.md` lồng sâu qua pinned Git tree, cho phép nguồn GitHub do người dùng phê duyệt, kiểm tra blob SHA trước khi lưu tài nguyên văn bản/nhị phân, giới hạn file/dung lượng và ghi hash nội dung. Có thể xem bản cập nhật khi revision nguồn thay đổi, thử cập nhật với cơ chế hoàn tác. LICENSE tại skill và repository được dùng để tạo **bằng chứng**, không tự động cấp quyền tái phân phối; third-party scripts được lưu nhưng **không tự chạy** và skills mới mặc định tắt.

**Bảo vệ:** Chỉ dành cho local trusted Hub. Public Hub không được gọi các API write/coding-orchestration/skills-install. Worker không có tool thực thi tùy ý, nhưng cùng tài khoản hệ điều hành trên máy cá nhân; không dùng nó để thực thi mã không tin cậy. Các chức năng mới cần test bằng model thật và chạy thử installer Windows trên máy sạch trước khi gắn nhãn stable.

## 16. Multi-Agent Orchestrator và GitHub Skills Hub (giai đoạn đầu)

- `StudioDelegates.orchestrate()` hỗ trợ DAG tối đa 8 worker, concurrency 1–3, roles planner/researcher/tester/reviewer/security/summarizer. Worker chỉ nhận excerpts và dependency summaries, `tools: []`, không sửa file hay thực thi lệnh. API local trusted Hub: `POST /api/studio/delegates/orchestrate`; giao diện `Agents` cho phép cấu hình nodes. **Chưa hỗ trợ coding agents có quyền ghi trên worktrees độc lập.**
- `GitHubSkillRegistry` khám phá `SKILL.md` từ danh sách GitHub repositories cố định, lưu commit SHA và source path, có lưu chỉ mục để tìm kiếm. API `GET /api/plugins/registry`, `POST /api/plugins/registry/refresh`, `POST /api/plugins/registry/install`. Trên public Hub, các thao tác refresh/install qua hai POST endpoints bị chặn; dữ liệu skill bên ngoài được xử lý như lower-trust instructions.
- Lần triển khai này nhập `SKILL.md` gốc và resources dạng văn bản có giới hạn từ `scripts/`, `references/`, `assets/`; **không chạy script third-party và chưa tải binary assets**, chưa có engine scheduling coding workers, không phải multi-tenant orchestration. Việc xác minh license của upstream yêu cầu kiểm toán bổ sung; không được khẳng định đã có quyền redistributing.
- Test regression về DAG, dependency, model tool isolation, cycle validation, GitHub revision pinning và registry persistence được tích hợp trong `verify-phase4-features.mjs`.

- Bản điều phối có `Coordinator synthesis`, khả năng hủy và timeout cho các model calls; không có tool call cho worker và coordinator. Kết quả được lưu trong state cục bộ để kiểm tra sau khi chạy.
