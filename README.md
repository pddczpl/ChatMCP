# ChatMCP

ChatMCP là một **Coding Agent chạy cục bộ**, ưu tiên Windows 11: bạn chọn một thư mục dự án, nhập khóa API của nhà cung cấp mô hình (Anthropic, OpenAI, Gemini, OpenRouter, Ollama…), giao việc bằng tiếng Việt hoặc tiếng Anh; agent đọc mã, đề xuất và thực hiện thay đổi, chạy kiểm thử, dùng Git và báo lại kết quả **dựa trên đầu ra thật**. Mọi thao tác ghi file hay chạy lệnh đều đi qua cổng phê duyệt, mọi thay đổi có checkpoint để xem diff và hoàn tác.

> **Trạng thái trung thực** (nhánh `dev/chatmcp-agent`, Hub `2.3.0`)
> Đây là bản đang hoàn thiện, **chưa phải bản phát hành ổn định** và chưa được merge vào `main`.
> Toàn bộ kiểm thử tự động chạy với **mô hình giả có kịch bản**; **chưa có chạy đầu-cuối nào với mô hình thật** (cần khóa API của bạn). Tự host trên máy chủ (Phase 2) **đã hoàn thành và được kiểm chứng trong container Docker** (Docker Compose, Render free tier, tách quyền Linux `hub`/`agent`, bảo vệ token/cookie); dịch vụ nhiều người dùng bị **chặn** (xem bảng dưới).
> Bằng chứng và cách tái chạy: [docs/PHASE1-REPORT.md](docs/PHASE1-REPORT.md) và [docs/PHASE2-REPORT.md](docs/PHASE2-REPORT.md).

## Nó làm được gì

- **Hub độc lập**: một tiến trình Node, không build, không Docker, không Cloud Harness, không Desktop Commander. Giao diện tại `http://127.0.0.1:3007`.
- **Công cụ lập trình thật**: đọc/tìm file, ghi/sửa nguyên tử (chống ghi đè thay đổi mới), tạo/di chuyển/xóa, Git (`status/diff/log/add/commit/branch`), chạy lệnh (Git Bash hoặc PowerShell), kế hoạch công việc, checkpoint và hoàn tác.
- **Ba chế độ quyền**: *Chỉ đọc*, *Review* (mặc định, hỏi trước mỗi thay đổi), *Tự động* (sửa file và chạy lệnh kiểm tra đã biết; lệnh khác vẫn hỏi).
- **Nhiều nhà cung cấp mô hình**: Anthropic, OpenAI, Google Gemini, OpenRouter, DeepSeek, Groq, Mistral, Ollama, LM Studio và máy chủ tương thích; "Lưu & kiểm tra" thử luôn khả năng gọi công cụ của model.
- **Trung thực về trạng thái**: *Hoàn tất* chỉ khi agent thực sự kết thúc; *Chưa rõ kết quả* khi Hub chết giữa lúc một thao tác đang chạy — và Hub **không phát lại** thao tác đó.
- **Hướng dẫn lần đầu** 4 bước: thư mục dự án → kết nối AI → quyền của agent → tác vụ mẫu.

## Trạng thái từng năng lực

Nhãn: `implemented` · `unit-tested` · `integration-tested` · `e2e-verified` · `production-verified` · `blocked`. Chưa có mục nào đạt `production-verified`. "E2E" ở đây nghĩa là **Hub thật + công cụ thật + mô hình giả**.

| Năng lực | Nhãn | Ghi chú |
|---|---|---|
| Hub chạy độc lập, backend `local` | implemented · integration-tested · e2e-verified (Windows 11 + Linux) | `verify-local-backend`, `verify-launcher` |
| Công cụ file/Git/lệnh | implemented · unit-tested · integration-tested · e2e-verified | `verify-local-tools`, `verify-shell-runner`, các bộ E2E |
| Cổng phê duyệt (Chỉ đọc / Review / Tự động) | implemented · integration-tested · e2e-verified | gồm trình duyệt thật (`verify-ui-e2e.py`) |
| Phân tích lệnh, đi theo đường dẫn thật, tin cậy cấu hình Git, lọc môi trường | implemented · unit-tested · e2e-verified với repo độc hại | `verify-e2e-adversarial` (74 kiểm tra). Heuristic, **không phải sandbox** |
| Adapter Anthropic / OpenAI-chat / Gemini + dò gọi công cụ | implemented · integration-tested (máy chủ giả) | **blocked**: chưa thử với nhà cung cấp thật (cần khóa API) |
| Lưu khóa API (DPAPI / AES-256-GCM) | implemented · unit-tested | DPAPI thử trên Windows 11 thật |
| Máy trạng thái nhiệm vụ | implemented · unit-tested · integration-tested · e2e-verified | 11 trạng thái |
| Khôi phục phiên (không phát lại thao tác chưa rõ) | implemented · e2e-verified | Hub bị giết bằng `SIGKILL`/`TerminateProcess` |
| Giao diện + hướng dẫn lần đầu | implemented · browser-tested (Playwright, Hub thật, mô hình giả) | Chromium hoặc Edge/Chrome có sẵn trên máy; cần Python + Playwright |
| Sửa lỗi dự án có sẵn / dựng FastAPI test-first | e2e-verified | FastAPI: pytest và uvicorn thật; bộ này **SKIP** nếu máy thiếu gói Python |
| Git cục bộ: nhánh, commit, push tới remote | e2e-verified (remote là kho bare cục bộ) | |
| Tạo Pull Request GitHub (REST API) | implemented · integration-tested | `createPullRequest` qua GitHub API, đã test với mock server; chạy với github.com thật cần token của bạn |
| Streaming phản hồi thời gian thực (SSE) | implemented · integration-tested · browser-verified | `/api/tasks/:id/stream`, token stream thời gian thực trên UI |
| Hai Hub tách biệt, mỗi Hub một dữ liệu | e2e-verified | |
| Cô lập người dùng A/B **trong một deployment** | **blocked** | Hub là ứng dụng một người dùng |
| Tự host tin cậy (Docker Compose, Render free tier, tách quyền Linux) | implemented · integration-tested · docker-verified | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), 51/51 suites pass trong container |
| CI GitHub Actions | implemented (workflow) | **chưa từng chạy trên GitHub** |
| Dịch vụ nhiều người dùng / công cộng | **blocked** | cần cô lập VM/microVM có bằng chứng |
| Chế độ ChatGPT Web (tiện ích trình duyệt) | legacy, thử nghiệm cục bộ | bạn tự đăng nhập; không dùng cho dịch vụ công cộng |

## Bắt đầu nhanh (Windows 11)

Yêu cầu: **Node.js ≥ 22.12** (đã kiểm thử 22 và 24) và **Git for Windows** (kèm Git Bash — shell mặc định của agent). Không cần `npm install`, Docker hay build. Chi tiết: [docs/WINDOWS-SETUP.md](docs/WINDOWS-SETUP.md).

```powershell
# từ thư mục repository ChatMCP
.\CHATMCP-HUB\START-CHATMCP-HUB.cmd -ProjectPath C:\duong\dan\toi\du-an
```

Trình duyệt mở `http://127.0.0.1:3007`. Lần đầu, trình hướng dẫn sẽ mời bạn: chọn thư mục dự án → chọn nhà cung cấp, dán khóa API, bấm **Lưu & kiểm tra** → chọn quyền (nên bắt đầu bằng *Review*) → gửi tác vụ mẫu. Dừng Hub: `.\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd`.

Hub **chỉ lắng nghe trên 127.0.0.1**; đừng mở cổng này ra mạng hoặc qua tunnel. Hướng dẫn sử dụng: [docs/USER-GUIDE.md](docs/USER-GUIDE.md). Gặp lỗi: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Ba chế độ quyền

| Chế độ | Agent được làm gì không cần hỏi |
|---|---|
| **Chỉ đọc** | đọc, tìm, xem Git; mọi thay đổi bị từ chối (không hỏi) |
| **Review** (mặc định) | đọc; mỗi lần sửa file hoặc chạy lệnh đều hiện hộp phê duyệt với lệnh/diff nguyên văn |
| **Tự động** | đọc, sửa file (có checkpoint), `git add/commit`, lệnh kiểm tra đã biết (`npm test`, `pytest`…); lệnh mạng, cài gói, xóa, `git push`, chương trình lạ vẫn hỏi |

`.env`, khóa riêng, `.git/` luôn bị chặn với công cụ file ở **cả ba chế độ**. Chế độ *Tự động* chạy mã kiểm thử của dự án với quyền tài khoản của bạn — chỉ dùng cho dự án bạn tin. Xem [SECURITY.md](SECURITY.md).

## Thành phần trong repository

| Thành phần | Thư mục | Vai trò | Trạng thái |
|---|---|---|---|
| **ChatMCP Hub** (Node.js ESM, không build) | `CHATMCP-HUB/` | máy chủ dashboard, agent runtime, cổng quyền, công cụ cục bộ, checkpoint | đang phát triển — v2.3.0 |
| Companion cho ChatGPT Web (MV3) | `CHATMCP-HUB/extension/` | chế độ **legacy/thử nghiệm cục bộ**: bạn tự đăng nhập ChatGPT, tiện ích chỉ thao tác giao diện web | legacy |
| ChatMCP Button Fix (MV3) | `manifest.json`, `bridge.js`, `compat.js`, `popup.*` ở thư mục gốc | hỗ trợ nút MCP của MCP SuperAssistant trên chatgpt.com | legacy |
| Bộ cài cũ | `CHATMCP-LOCAL-SETUP/`, `START-*.cmd|ps1`, `install.sh` | bản cài của các phiên bản trước | legacy — sẽ xem xét dọn |
| Cloud Harness MCP | *không nằm trong repo* | phụ thuộc bên thứ ba (MIT) cho backend `mcp` cũ; ghim ở [`deps/cloud-harness.lock.json`](deps/cloud-harness.lock.json) | tùy chọn, không cần cho backend `local` |

## Kiểm thử

```powershell
cd CHATMCP-HUB
npm test            # mọi bộ Node, mỗi bộ một tiến trình riêng, in PASS/FAIL/TIMEOUT/SKIP
npm run test:ui     # bộ giao diện Python/Playwright (tùy chọn)
```

Một bộ chỉ được báo PASS khi chạy thật; thiếu Python/gói/trình duyệt thì báo **SKIP** kèm lý do. Chi tiết, cách viết test E2E và cách cài môi trường Python: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Kết quả đã đo và lệnh đã chạy: [docs/PHASE1-REPORT.md](docs/PHASE1-REPORT.md).

## Tài liệu

- [docs/USER-GUIDE.md](docs/USER-GUIDE.md) — dùng ChatMCP hằng ngày
- [docs/WINDOWS-SETUP.md](docs/WINDOWS-SETUP.md) — cài đặt và chạy trên Windows 11
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — lỗi thường gặp
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — kiến trúc, ranh giới tin cậy, chiến lược phụ thuộc
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — môi trường phát triển, chạy test, quy ước commit
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — triển khai: cái gì được hỗ trợ, cái gì chưa
- [docs/TESTING-WITH-REAL-MODELS.md](docs/TESTING-WITH-REAL-MODELS.md) — cách tự thử với mô hình thật
- [SECURITY.md](SECURITY.md) — mô hình đe dọa, giới hạn đã biết, sự cố cần quyết định, xoay token
- [CHANGELOG.md](CHANGELOG.md) — thay đổi theo phiên bản
- [docs/PHASE0-AUDIT.md](docs/PHASE0-AUDIT.md) · [docs/PHASE1-DESIGN.md](docs/PHASE1-DESIGN.md) · [docs/PHASE1-REPORT.md](docs/PHASE1-REPORT.md) · [docs/PHASE2-DESIGN.md](docs/PHASE2-DESIGN.md) · [docs/PHASE2-REPORT.md](docs/PHASE2-REPORT.md) · [docs/PHASE3-DESIGN.md](docs/PHASE3-DESIGN.md) · [docs/PHASE3-REPORT.md](docs/PHASE3-REPORT.md) — kiểm toán, thiết kế và báo cáo các phase
- [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — giấy phép bên thứ ba
- [CHATMCP-HUB/README.md](CHATMCP-HUB/README.md) — lịch sử phát hành của Hub (2.x), giữ nguyên

## Ranh giới an toàn (tóm tắt)

- **Chỉ dùng cục bộ.** Hub không có tài khoản người dùng; không mở ra mạng. Không hỗ trợ đa người dùng hay dịch vụ công cộng: chưa có cô lập cấp VM/microVM, và Cloud Harness không được thiết kế cho đa tenant thù địch.
- Lệnh bạn duyệt chạy với **quyền tài khoản của bạn**; phân tích lệnh là heuristic bảo thủ, không phải sandbox. Với dự án lạ, dùng *Chỉ đọc* hoặc *Review*, hoặc chạy trong máy ảo.
- Chế độ ChatGPT Web chỉ dành cho máy của chính bạn. Rà soát mã của tiện ích (v1.4.2): chỉ xin quyền `storage` và `alarms`, không có quyền `cookies`, không gọi endpoint nội bộ của ChatGPT.
- Không đưa API key/token vào repository. **Có sự cố bảo mật Phase 0 chờ bạn quyết định** (token trong lịch sử Git công khai): đọc [SECURITY.md](SECURITY.md) trước khi push bất cứ gì.

## Giấy phép

Repository này **chưa có tệp LICENSE**: chủ sở hữu cần chọn giấy phép trước khi người khác có thể tái sử dụng mã. Các thành phần bên thứ ba giữ giấy phép riêng của chúng; xem [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Cloud Harness MCP (MIT, © AgentKit) là phụ thuộc bên ngoài, không được fork hay phân phối lại ở đây.
