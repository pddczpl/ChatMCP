# Lịch sử thay đổi

## [3.1.1] — 2026-10-15 — Code Intelligence and Smart Context CI repair

- Ship six Code Intelligence tools (repo map, symbols, go-to-definition, references, dependency graph and diagnostics), with the production async workspace resolver, canonical Windows/Junction path handling and protected-path containment.
- Integrate bounded, query-aware Repo Map as untrusted task context and compact a **model request copy** of older tool results while preserving call IDs, real result differences, recent evidence, multimodal data and the complete canonical transcript.
- Align version identifiers for Hub, Desktop, Installer and UI at 3.1.1; retain the previous v3.1.0 tag unchanged because it points to a commit with failed CI and its release had no Windows installer.
- Update 42-tool schemas/contracts and 78 Node regression suites. Require Windows/Ubuntu Node 22/24 tests, browser E2E and a SHA-256 verified self-contained Windows installer before publication.
- Gateway code and the existing user permission/security boundaries remain unchanged. CI uses scripted providers; long-task quality with live paid models is not established.

## [3.1.0] — 2026-10-14 — Code Intelligence & Smart Context (tagged, installer not released)

- Add the zero-dependency Code Intelligence Engine with six local read-only tools: `repo_map`, `code_symbols`, `find_definition`, `find_references`, `dependency_graph`, and `code_diagnostics`. The current LocalTools catalog has 42 tools.
- Support the actual asynchronous StudioWorkspace resolver and guard workspace boundaries and protected paths in code intelligence reads.
- Attach a bounded Repo Map as explicitly untrusted user-level task data and compact only a copy of older tool history while retaining call IDs and the canonical transcript.
- Preserve different results from identical read-only tool arguments (files and Git diffs may have changed) and preserve multimodal outputs and the latest tool receipts.
- Add Code Intelligence and Smart Context Compaction regression suites to the Hub's `verify-*.mjs` CI discovery (78 Node suites).
- The v3.1.0 tag was published with no Windows installer while CI on its commit was failing; this is a historical release entry. The tested, packaged correction is v3.1.1.

## [3.0.4] — 2026-10-14 — Goal-aware agent planning and adaptive recovery

- Propose and persist a structured multi-stage plan for clearly multipart user tasks without changing the initial user message or escalating permissions.
- Recognize repeated unchanged read/search evidence across equivalent tools and queries, while exempting legitimate process polling and distinct source ranges.
- Validate local file changes independently using fresh SHA-256 reads; record successful approved verification commands from actual exit code 0 without trusting model narration.
- Issue at most two strategic recovery prompts at repetition thresholds before safely stopping with a resumable checkpoint and specific `progress_stalled` reason.
- Persist goal-plan and host evidence summaries into durable task history and reports, adding deterministic `verify-agent-autonomy.mjs` regression coverage (76 Node suites total).
- Preserve gateway configuration and permission, Git review, Windows Sandbox, and uncertain-operation safeguards.
- Synchronize Hub, UI, Desktop, and Installer versions to 3.0.4. The unsigned Windows installer is released with a CI-verified SHA-256 checksum; full live-model coding quality has not yet been independently established.

## [3.0.3] — 2026-10-14 — Progress-aware agent loop safeguards

- Detect repeated identical tool calls and results without changing the model provider or gateway networking behavior.
- Warn after four consecutive repeated results; stop safely with `progress_stalled` after ten and retain the task checkpoint for explicit continuation.
- Persist bounded host-owned progress evidence (inspected targets, edit attempts, verification attempts and result fingerprints) in task history, reports and across Hub restarts; do not treat an edit attempt as a verified change or test pass.
- Exclude normal process-output polling from stagnation detection and add `verify-agent-progress.mjs` regression coverage.
- Retain permissions, uncertain-operation safeguards, Git review and Windows Sandbox policies. This release does not yet automatically decompose large tasks or prove long-task completion with a paid AI provider.
- Synchronize Hub, UI, Desktop and Installer to 3.0.3; release the Windows installer with a verified SHA-256 checksum (unsigned Authenticode).

## [3.0.2] — 2026-10-14 — Clearer Skills, Agents and readable output

- Improve UI typography, spacing and text contrast so navigation, chat messages and inspector panels are easier to read.
- Show installed GitHub Skills with their current state and actions to enable, disable, update or uninstall them; keep installation feedback in sync with the local library.
- Simplify the Agents workspace with plain-language guidance, clear task choices and advanced controls available when needed.
- Keep expanded tool output readable in light and dark themes and provide visible copy actions for responses and streaming text.
- Synchronize Hub, UI, Desktop and Installer versions to 3.0.2.

## [3.0.1] — 2026-10-14 — Gemini JSON and local tool routing fixes

- Gemini text-only requests use one consistent JSON action contract for progress, built-in tools, MCP routers, historical actions and bounded repair requests.
- Preserve tool-error, permission and unknown-outcome safeguards when adapting legacy agent instructions to text-only gateways.
- Resolve registered local short names such as `read_file`, `run_command` and `find_files` inside `mcp_call` and `mcp_describe`, while preserving exact catalog matches, schema validation and permission checks. Unknown names remain rejected without execution.
- Add regression coverage for Gemini direct-tool recovery and local router aliases; align the HTTP 413 fixture with the documented 32 KiB minimum request budget.
- Synchronize Hub, UI, Desktop and Installer versions to 3.0.1. Installer assets include SHA-256 checksums and are not Authenticode-signed.

## [3.0.0] — 2026-10-14 — Autonomous Coding, Native Sandbox Verification & Multi-Agent Worktrees

- **Phase 1 (Windows Sandbox Isolation & Native Black-box Verification):** Giao diện và kiến trúc thực thi kiểm thử độc lập black-box trong Windows Sandbox với `system-sealed-exit-v1`, zero-fallback privilege drop, Job Object containment, chống giả mạo HMAC-SHA256 và quy trình vòng đời cài đặt máy sạch (G6 Clean Windows).
- **Phase 2 (Reliable Coding Recovery Checkpoints):** Nhật ký khôi phục sự cố (crash recovery journal) với chuỗi băm mật mã SHA-256 tamper-evident, cơ chế cô lập trạng thái lỗi (corruption quarantine), xác nhận phục hồi bền vững (recovery acknowledgement) qua các lần restart Hub và xem trước context an toàn.
- **Phase 3 (Dependency-Aware Multi-Agent Coordination):** Điều phối đồ thị phụ thuộc tác vụ (DAG A → B → C và no-op handling), công nhân độc lập trên Git worktree thật với giới hạn đồng thời, hủy bỏ tác vụ an toàn, chặn tác vụ hạ nguồn khi phụ thuộc thất bại và phòng chống xung đột cấu trúc file-vs-directory.
- Đồng bộ hợp đồng giao diện React/Vite/Tailwind, loại bỏ các trạng thái giả định, xác thực mã băm SHA-256 của bundle cài đặt tự chứa.

- Map real AgentRunner summaries and full conversation records through a typed React adapter; use canonical task states for Stop/Resume and retain drafts after failed sends.
- Show actual PermissionGate pending requests and decision history, including structured command/content previews and expiry; no automatic approval.
- Create a blank conversation without calling a model. Replace synthetic plan/stage completion with persisted plans and actual tool evidence.
- Read task activity, Git changes/diffs and terminal output from their existing APIs; surface request failures. Mount task SSE with scoped deltas and state reconciliation after reconnect.
- Connect onboarding workspace and permission selections, reuse the actual AI configuration/test form, and stop reporting a failed browse as a selected workspace.
- Clear typed API keys after saving and on destination changes; remove stale RBAC and static health claims from local Settings.
- Serialize concurrent research snapshot writes and wait for all active workers after a persistence failure before releasing the run.
- Add regression coverage for the current React components and adapters. Release number and the published v2.6.0 tag remain unchanged.
- Add current React/real-Hub Playwright scenarios with a scripted local provider, strict no-skip CI gates, pinned Python E2E dependencies, and a native WinForms/WebView2 smoke harness.
- Package tracked runtime sources and fresh UI output only; exclude local state, imported skills and development dependencies, and validate staging cleanup paths.

## [2.6.0] — 2026-10-12 — Local-only Windows release

- Removed Render, Docker public server, public auth/workspaces/tenancy, Linux execution broker and legacy Cloud Harness MCP proxy backend.
- Removed obsolete Cloud Harness setup snapshot, bootstrap scripts, cloud-only tests and mutation fixtures.
- Hub now accepts local-only startup flags and binds to 127.0.0.1; hosted/public settings fail closed.
- Preserved desktop coding agents, Git worktrees, browser companion, AI gateway, GitHub Skills Hub and optional local test sandbox.
- Reworked README, SECURITY, Windows Setup and deployment retirement notice; retained historical notes without treating retired capabilities as supported.
- Version 2.6.0 is built from a CI-verified commit and checked with SHA-256. Authenticode signing, live-provider E2E and a clean-Windows VM installation/upgrade smoke test were not established by CI.


## [2.5.0] — 2026-10-12 — Multi-Agent coding worktrees, GitHub Skills Hub & hardening

Bản này nối tiếp bản cài đặt `v2.4.0` (giao diện React/Vite/Tailwind, đã phát hành riêng); `v2.4.0` không bị sửa hay gắn lại. Số phiên bản của Hub, Desktop, Installer và giao diện được đồng bộ về `2.5.0`.

### Bảo mật và độ tin cậy (PR #2)

- **Khôi phục checkpoint an toàn:** bắt buộc `expectedShas` cho mọi file, từ chối bản cũ bằng HTTP 409 (`stale_state`), có preview/dry-run, sao lưu hoàn tác trước khi ghi, và chặn khi agent đang chạy (`task_in_progress`). Giao diện luôn gọi preview trước khi khôi phục.
- **Skill ID và hệ thống tệp:** chuẩn hóa ID, từ chối `..`, dấu `/` `\`, đường dẫn tuyệt đối và tên thiết bị Windows (`CON`, `NUL`, `COM1`…); kiểm tra containment và symlink trước khi cài/gỡ; bỏ ID cũ không an toàn khi nạp.
- **SSRF khi cài skill từ URL:** phân giải DNS trước khi tải, chỉ chấp nhận IP công khai (chặn loopback, RFC 1918, CGNAT, link-local, metadata, IPv6 ULA và IPv4-mapped), kiểm tra lại từng bước chuyển hướng, giới hạn 512 KB và thời gian chờ.
- **Nguồn gốc và giấy phép:** bỏ nhãn `github-verified` và SHA commit giả khỏi danh mục; giấy phép tự khai không được coi là đã xác minh quyền phân phối lại (`redistributable: false`).
- **Chọn skill:** chỉ đưa vào ngữ cảnh khi đủ liên quan (ngưỡng điểm), có ngân sách ngữ cảnh; lỗi ghi lockfile không bị nuốt.

### Tính năng

- **Parallel Coding Agents (beta):** Git worktrees/branches riêng cho từng coding worker (tối đa 4, song song tối đa 3), công cụ đọc/sửa file giới hạn, không shell/network/Git push trực tiếp. Có integration branch và Draft PR theo từng worker khi người dùng xác nhận. Git worktrees không phải OS sandbox.
- **Agent Skills Hub (beta):** Tìm SKILL.md lồng nhau từ GitHub tree revision được ghim; nhập tài nguyên nhị phân và văn bản theo hạn mức và kiểm tra SHA; quản lý nguồn được phép, xem/cập nhật revision, lưu giấy phép dạng evidence (không tự suy ra quyền redistribution).
- **README & desktop documentation:** Cập nhật trải nghiệm bắt đầu (Việt/Anh), yêu cầu review Git diff gắn SHA trước khi tích hợp coding workers, điều kiện release Windows .NET 10, SHA-256 và kiểm thử installer trên máy sạch.
- **Windows packaging:** Build UI mới trước khi đóng gói, xác thực .NET SDK 10/Node.js 22+, self-contained Windows publish, tạo installer checksum và CI job build Windows installer.
- **Review & registry integrity:** Coding workers/integration branch yêu cầu diff preview có revision token trước khi merge/publish; Skills Registry giữ chỉ mục cũ khi refresh GitHub thất bại và dùng ID ổn định theo source path.
- **Validation:** Mở rộng `verify-phase4-features.mjs` để kiểm tra real Git worktrees, agent tool permissions và GitHub skill blob integrity. Phải nghiệm thu CI và thử installer trên Windows sạch trước khi phát hành.



Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/). Phiên bản Hub (`CHATMCP-HUB/package.json`) và UI_BUILD hiện tại (`2.6.0-react-agent`) được đồng bộ; bản 2.5.0 được giữ trong phần lịch sử.

Các bản trước 2.3.0 (2.0.0 … 2.2.8) có ghi chú riêng ở `CHATMCP-HUB/STUDIO-*.md`, `UPGRADE-*.md`, `TEST-RESULTS-*.txt`; chúng là tài liệu lịch sử và không được cập nhật.

## [2.3.0] — nhánh `dev/chatmcp-agent` (đã gộp vào `main`; không có tag riêng)

Mục tiêu của bản này: biến Hub thành một **AI Coding Agent chạy được trên Windows 11 cho một người dùng**, không cần Docker, Cloud Harness hay Desktop Commander. Nhãn từng tính năng nằm ở [README.md](README.md); báo cáo và bằng chứng ở [docs/PHASE1-REPORT.md](docs/PHASE1-REPORT.md).

### Thêm

- **Backend `local` (mặc định):** Hub tự chạy vòng lặp agent và các công cụ trong chính tiến trình của nó (`lib/local-tools.mjs`, 36 công cụ: đọc/liệt kê/tìm file, `git_status/diff/log/add/commit/branch`, ghi/sửa/đổi tên/xóa, `run_command`, kế hoạch). Backend `mcp` (Cloud Harness + Desktop Commander) vẫn còn, ở vai trò cũ (legacy), `--backend mcp`.
- **Ba chế độ quyền:** `Chỉ đọc` (mới), `Review`, `Tự động`; `manual` là tên cũ của `Review`. Khung duyệt hiển thị lệnh/diff nguyên văn, có đồng hồ hết hạn 10 phút (hết hạn = từ chối).
- **Phân tích lệnh shell** (`read`/`verify`/`edit`/`exec`/`dangerous`), **vùng cấm file bí mật** (`.env*`, khóa riêng, `.git`…), đi theo đường dẫn thật qua symlink/junction/tên 8.3/ổ đĩa ảo PowerShell (`lib/command-paths.mjs`), kiểm tra cấu hình Git của kho trước khi chạy `git` (`lib/git-trust.mjs`), `ShellRunner` (Git Bash trước, PowerShell sau; stdin đóng; timeout giết cả cây tiến trình; xóa biến môi trường dạng khóa).
- **Checkpoint trước mỗi thay đổi**; không tạo được thì thao tác không chạy (`checkpoint_failed`).
- **Lớp model nhiều nhà cung cấp:** Anthropic Messages, OpenAI-compatible (đã làm chắc), Gemini; 12 preset (Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek, Groq, Mistral, Ollama, LM Studio, 3 gateway tùy chọn); tải danh sách model; **thử tool calling** khi kiểm tra kết nối; thử lại có giãn cách; rút gọn ngữ cảnh có kiểm soát; che bí mật trong lỗi/nhật ký.
- **Lưu API key:** Windows DPAPI (đã thử vòng khứ hồi thật trên Windows); AES-256-GCM trên Linux/macOS; hoặc dùng biến môi trường; hoặc chỉ giữ trong bộ nhớ.
- **Máy trạng thái tác vụ chuẩn** với 11 trạng thái (`created`, `queued`, `planning`, `running`, `waiting_approval`, `verifying`, `paused`, `completed`, `failed`, `cancelled`, `uncertain`) và lịch sử chuyển trạng thái. **Phục hồi phiên không phát lại thao tác ghi chưa rõ kết quả**: tác vụ vào `uncertain`/`paused`, bạn xem Git diff rồi quyết định.
- **Bằng chứng do Hub ghi** (số thao tác sửa file thành công, lệnh kiểm tra đã chạy và thoát mã 0) hiển thị dưới kết quả; "Hoàn tất" không còn đồng nghĩa với "đạt".
- **Giao diện:** hộp thoại thiết lập 4 bước lần đầu, form nhà cung cấp, công tắc quyền cạnh ô nhập, khung duyệt phía trên ô nhập, banner cho trạng thái dừng giữa chừng, thẻ kế hoạch của agent, tiêu đề tab báo "Cần duyệt".
- **Launcher Windows độc lập** `START-CHATMCP-HUB.cmd` / `STOP-CHATMCP-HUB.cmd`: chạy Hub ở nền, chờ kiểm tra sức khỏe, dùng lại Hub đang chạy, không đụng cổng của chương trình khác, không đổi ExecutionPolicy.
- **Bộ kiểm thử:** bộ chạy chung `npm test` (46 bộ kiểm thử Node lúc phát hành 2.3.0, mỗi bộ một tiến trình, có `--json`/`--filter`/`--no-skip`; có cả bộ kiểm tra chính bộ chạy test, bộ đối chiếu tài liệu với mã và bộ kiểm tra công cụ đột biến), 5 bộ giao diện Playwright (`--python`), khung E2E với **mô hình giả có kịch bản** (6 kịch bản: FastAPI thật, sửa lỗi, Git/nhánh, phục hồi phiên, cô lập hai người dùng ở mức Hub, kho độc hại), công cụ **kiểm thử đột biến** `tests/mutation/run-mutations.mjs` (hỏng mã một chỗ nhỏ mỗi lần trong bản sao tạm, xem bộ test có nhận ra không) cùng 4 danh sách đột biến đã dùng (xem DEVELOPMENT.md). CI: `.github/workflows/ci.yml` (Linux + Windows × Node 22/24, mọi action ghim theo SHA; **chưa chạy trên GitHub**). Bản cập nhật workflow (cài Python cho bộ FastAPI, job giao diện Chromium, `--no-skip all` để một bộ bị bỏ qua không làm CI xanh giả) **chưa được áp dụng**: công cụ của phiên làm việc không được ghi vào `.github/workflows/`, nên bản đề xuất nằm ở [docs/ci-proposal.yml](docs/ci-proposal.yml) và báo cáo Phase 1 hướng dẫn cách áp dụng.
- **Tài liệu:** README, ARCHITECTURE, DEVELOPMENT, WINDOWS-SETUP, USER-GUIDE, TROUBLESHOOTING, DEPLOYMENT, SECURITY, TESTING-WITH-REAL-MODELS, THIRD-PARTY-NOTICES, PHASE0-AUDIT, PHASE1-DESIGN, PHASE1-REPORT.
- **Chế độ công khai và tự host (Phase 2):** Bật bằng `CHATMCP_PUBLIC=1`. Đăng nhập token chủ sở hữu (`CHATMCP_OWNER_TOKEN`), so sánh constant-time, cookie phiên `__Host-chatmcp_session` (`HttpOnly`, `Secure`, `SameSite=Strict`), CSRF theo phiên, chống brute-force theo IP và toàn cục. Cổng kiểm tra mặc định từ chối (`lib/public-gate.mjs`) trước mọi route nội bộ.
- **Tách quyền tiến trình Linux (Docker):** `docker/supervisor.mjs` (root, tini) khởi chạy Hub dưới quyền user không đặc quyền `hub` (uid 10000). Môi giới lệnh qua socket Unix (`lib/exec-broker.mjs`) khởi chạy lệnh workspace dưới quyền user `agent` (uid 10001) với `no_new_privs` và tước toàn bộ capabilities.
- **Đóng gói Docker và Render:** `Dockerfile` phân tầng bảo mật, `docker-compose.yml`, `.env.example`, `render.yaml` cho Render free tier (giới hạn heap Node 192 MB, tương thích 512 MB RAM). Đã build ảnh `chatmcp:latest` và vượt qua 51/51 bộ test trong container.
- **Quản lý Workspace từ xa & GitHub PR:** `lib/workspaces.mjs` hỗ trợ clone an toàn qua HTTPS, giới hạn dung lượng kho, push lên nhánh cô lập `chatmcp/...`, tạo Pull Request qua GitHub REST API (`POST /api/workspace/pr`), và tải tarball workspace.
- **Streaming thời gian thực (SSE):** `GET /api/tasks/:id/stream` và `GET /api/tasks/events` truyền sự kiện trạng thái và từng token văn bản từ mô hình; giao diện React cập nhật hiệu ứng gõ chữ trực tiếp với con trỏ nhấp nháy.
- **Công cụ xoay token Cloud Harness** (`scripts/Rotate-CloudHarnessToken.ps1`, mặc định chỉ xem trước) và khóa phiên bản phụ thuộc bên thứ ba (`deps/`).
- **Khóa đồng thời Workspace (Phase 3):** `lib/workspace-lock.mjs` bảo vệ workspace bằng khóa nguyên tử `.chatmcp-workspace.lock`, kiểm tra liveness của PID qua `process.kill(pid, 0)` và tự động giải phóng/thu hồi khóa chết (dead PID hoặc quá 30 phút).
- **Quản lý Đa cấu hình AI (Phase 3):** `lib/ai-profiles.mjs` hỗ trợ lưu trữ nhiều cấu hình mô hình (Claude 3.5 Sonnet, GPT-4o, Gemini, Ollama) trong `ai-profiles.json`, che giấu API keys trong snapshot/list, mã hóa qua KeyStore, và chuyển đổi profile mặc định linh hoạt.
- **Động cơ Sandbox hợp nhất (Phase 3):** `lib/sandbox-engine.mjs` cung cấp tầng trừu tượng thực thi linh hoạt (`host`, `broker`, `isolated`), áp dụng hạn ngạch tài nguyên (timeout, RAM, CPU, max output bytes), thu thập số liệu thời gian thực và mã thoát.
- **Chế độ Full Access 1-Click trên UI (Phase 3):** Bổ sung nút chuyển đổi Full Access trực tiếp trên thanh công cụ Composer (`react-app.js`, `react.css`) với hộp thoại xác nhận tường minh, cảnh báo viền đỏ, tự động hạ cấp chính sách khi đổi sang chế độ an toàn, và duy trì nguyên tắc fail-closed bất biến đối với các tệp nhạy cảm (`.env`, `.git/`, DPAPI keys).
- **Chợ kỹ năng & Quản lý Plugin (Phase 4):** `lib/plugins.mjs` cung cấp danh mục marketplace tuyển chọn (Git Workflow Pro, Python Architect, Docker DevOps, SQLite Explorer, Web Researcher, Security Guard), quản lý vòng đời plugin (cài đặt, gỡ bỏ, bật/tắt, manifest tùy chỉnh) và tự động hợp nhất các prompt chuyên môn cùng công cụ vào vòng lặp của Agent.
- **Phân quyền người dùng RBAC (Phase 4):** `lib/governance.mjs` triển khai ma trận kiểm soát truy cập theo 3 vai trò (`viewer`, `developer`, `admin`), chặn đứng mọi hành vi can thiệp trái phép hoặc leo thang đặc quyền.
- **Cô lập ranh giới Tenant Workspace (Phase 4):** Quản lý không gian làm việc theo tổ chức/người thuê (`tenantId`), ngăn chặn truy cập, khóa hoặc xuất dữ liệu chéo giữa các tenant.
- **Nhật ký kiểm toán Doanh nghiệp (Phase 4):** Ghi nhận có cấu trúc (append-only JSONL) mọi hành động trọng yếu vào `enterprise-audit.jsonl` và hỗ trợ truy vấn lọc theo hành động, người dùng và số lượng bản ghi.

### Thay đổi

- Backend mặc định là `local` (trước đây phải có Cloud Harness). `--backend mcp` giữ hành vi cũ.
- Lớp provider chỉ-Gemini được tổng quát hóa thành bộ chuyển đổi trung lập (`standard-adapter`); đường Gemini cũ được giữ.
- Terminal: tự lùi về pipe khi `node-pty`/ConPTY không có hoặc hỏng; đóng terminal được chờ đầy đủ; dừng bằng nhóm tiến trình; đường dẫn checkpoint chuẩn hóa (`d6f2817`).
- Chế độ "ChatGPT Web" được gắn nhãn **legacy / thử nghiệm cục bộ** (người dùng tự đăng nhập; Hub không đọc cookie/phiên).
- Giao diện báo "Tự động" đúng hành vi: công cụ chưa phân loại bị **từ chối** (trước đây nhãn ghi là "vẫn hỏi").

### Sửa

- `Stop-ChatMcpHub` và thừa kế pipe của tiến trình con làm `Start` treo.
- Bốn script `CHATMCP-HUB/windows/` (smoke, soak, watchdog, kiểm tra gateway) ghi cứng phiên bản 2.2.x nên báo sai với Hub 2.3.0; nay lấy phiên bản từ `package.json` và bản dựng giao diện từ `/api/health`. `Run-StudioSoak` trước đây thoát mã 0 dù Hub không trả lời mẫu nào; nay thoát 1 nếu có mẫu xấu.
- Các lỗ hổng do kiểm thử đối kháng tìm ra và đã đóng (mỗi mục có test hồi quy): lệnh "chỉ đọc" đi theo symlink tới file bí mật; `core.fsmonitor` và hook `pre-commit` của kho tải về chạy chương trình; ổ PowerShell (`Env:`, `HKCU:`, `FileSystem::`) và `ps e` lộ bí mật; bộ lọc môi trường bỏ sót `PGPASSWORD`, `MYSQL_PWD`, biến kết thúc bằng `_KEY` và URL có mật khẩu. Chi tiết ở [SECURITY.md](SECURITY.md).
- Lỗi flaky trong `tests/verify-task-state.mjs` do va chạm khóa file trong atomic rename trên Windows được xử lý bằng cách chờ disk write và catch transient lock.
- Lỗi biến môi trường daemon thừa kế trong `tests/run-all.mjs` khi chạy trong container Docker với `CHATMCP_PUBLIC=1` và `CHATMCP_EXEC_MODE=broker`.
- Trùng mẫu đột biến trong `verify-docs.mjs` khi triển khai `createPullRequest` (sử dụng `github_token_missing`).

### Bảo mật

- Các phát hiện Phase 0 (S1–S4, token Cloud Harness trong lịch sử Git công khai, dữ liệu trạng thái trong lịch sử, định danh cá nhân, telemetry của Desktop Commander) được **ghi lại và đang chờ chủ sở hữu quyết định**; chưa ai xoay token, chưa ai viết lại lịch sử Git. Xem [SECURITY.md](SECURITY.md).
- Giới hạn đã biết (chưa khắc phục) được liệt kê đầy đủ ở SECURITY.md, trong đó: Hub không có xác thực khi ở chế độ cục bộ nên **chỉ chạy ở loopback cho một người dùng**; đa người dùng **bị chặn**.
- Khi mở ra mạng công cộng (`CHATMCP_PUBLIC=1`), bắt buộc có token chủ sở hữu mạnh, cookie phiên an toàn và tách quyền người dùng Linux.

### Vệ sinh repository

- Thêm `.gitignore`, `.gitattributes`, `.editorconfig`; ngừng theo dõi (không xóa khỏi đĩa) các bản clone lồng nhau, thư mục phụ thuộc, bản sao lưu trạng thái, thư mục "rescue" và file ZIP (`e9cfba4`, `2089911`, `3571def`). **Không viết lại lịch sử Git, không force-push.**
- Đã gỡ bỏ mã OAuth cũ không còn sử dụng (`CHATMCP-HUB/lib/chatgpt-auth.mjs`, `CHATMCP-HUB/lib/provider.mjs`) và tệp băm lỗi thời `CHATMCP-HUB/SHA256SUMS.txt`.
- Làm sạch URL dịch vụ cá nhân trong `CHATMCP-HUB/windows/Test-Gateway-Live.ps1`.

### Chưa làm / bị chặn

- Thử với mô hình thật và tạo Pull Request GitHub thật trên github.com: **blocked** (cần khóa/xác thực của bạn; [TESTING-WITH-REAL-MODELS.md](docs/TESTING-WITH-REAL-MODELS.md)).
- Cô lập đa người dùng: **blocked** (không có bằng chứng; yêu cầu VM/microVM).
- Cập nhật workflow CI: **blocked** ở phía công cụ (file nằm trong `.github/workflows/` bị bảo vệ); bản đề xuất đã soạn và kiểm tra cú pháp, chờ bạn áp dụng.
- Chọn giấy phép cho repository: chưa có `LICENSE` (cần chủ sở hữu quyết định).
