# ChatMCP — AI Coding Agent

ChatMCP là một **AI Coding Agent chạy cục bộ**, thiết kế tối ưu cho Windows 11 và môi trường tự host: bạn chọn một thư mục dự án, kết nối nhà cung cấp mô hình (Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek, Ollama…), giao việc bằng tiếng Việt hoặc tiếng Anh; agent tự động đọc mã, lập kế hoạch đa bước, sửa file nguyên tử, chạy kiểm thử, dùng Git và báo cáo kết quả **dựa trên đầu ra thực tế**.

Mọi thao tác ghi file hay chạy lệnh đều đi qua cổng phê duyệt minh bạch, mọi thay đổi đều có checkpoint để xem diff và hoàn tác tức thì.

> **Trạng thái dự án** (Phiên bản `2.3.0` · Phase 4 Hoàn thiện)
> - **CI/CD GitHub Actions:** **100% XANH (7/7 jobs PASSED)** trên cả Ubuntu và Windows (Node 22, Node 24, PowerShell 5.1).
> - **Skills Marketplace & Plugin System:** Hoàn thiện catalog plugin chọn lọc, quản lý vòng đời và tiêm kỹ năng động vào Agent.
> - **Multi-User RBAC & Tenant Workspace Isolation:** Phân quyền 3 cấp (`viewer`, `developer`, `admin`), cách ly ranh giới thư mục làm việc và lưu vết kiểm toán doanh nghiệp (`enterprise-audit.jsonl`).
> - **Desktop Native App & Commercial Installer:** Bộ cài đặt thương mại độc lập `ChatMCPSetup.exe` (2 MB, tự trích xuất, đăng ký Windows Apps), ứng dụng native `ChatMCP.exe` (C# / WebView2 với icon chính thức, không thanh địa chỉ/tabs) và phím tắt 1-click.
> - Báo cáo chi tiết và bằng chứng kiểm thử: [docs/PHASE1-REPORT.md](docs/PHASE1-REPORT.md), [docs/PHASE2-REPORT.md](docs/PHASE2-REPORT.md), [docs/PHASE3-REPORT.md](docs/PHASE3-REPORT.md) và [docs/PHASE4-REPORT.md](docs/PHASE4-REPORT.md).

---

## Tính năng nổi bật

- **Bộ cài đặt Thương mại & Desktop Native App (Windows 11):** Phân phối qua file cài đặt độc lập `dist/ChatMCPSetup.exe` như các phần mềm thương mại tiêu chuẩn (VS Code, Cursor). Tự động tạo shortcut với icon chính thức, đăng ký vào Windows Apps (`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatMCP`) và tạo sẵn bộ gỡ cài đặt `Uninstall.exe`. Ứng dụng chạy qua `ChatMCP.exe` trong cửa sổ native độc lập, không thanh URL, không tabs. Chi tiết: [docs/DESKTOP-APP.md](docs/DESKTOP-APP.md).
- **Skills Marketplace & Plugin System:** Chợ kỹ năng chọn lọc (`git-workflow-pro`, `python-architect`, `docker-devops`, `sqlite-explorer`, `web-researcher`, `security-compliance-guard`), hỗ trợ cài đặt, cấu hình, bật/tắt và tự động tiêm ngữ cảnh vào Agent qua Command Palette (`Ctrl+K`).
- **Phân quyền Multi-User RBAC & Cách ly Workspace:** Kiểm soát truy cập theo vai trò (`viewer`, `developer`, `admin`), đảm bảo an toàn biên giới thư mục giữa các workspace và ghi nhật ký kiểm toán bất biến vào `enterprise-audit.jsonl`.
- **Bốn chế độ phê duyệt quyền linh hoạt:**
  1. *Chỉ đọc*: Agent chỉ phân tích, tìm kiếm mã nguồn và Git.
  2. *Review* (mặc định): Phê duyệt từng thay đổi file và lệnh thực thi kèm diff chi tiết.
  3. *Tự động*: Tự động chạy lệnh kiểm thử đã biết (`npm test`, `pytest`) và sửa file an toàn.
  4. *FULL ACCESS*: Chế độ tốc độ cao cho lập trình viên chuyên nghiệp, bắt buộc gõ xác nhận 'FULL ACCESS' kèm bảo vệ CSRF.
- **Terminal tương tác ConPTY & AST Code Index:** Console thời gian thực tương tác trực tiếp với tiến trình hệ thống, kết hợp bộ phân tích cú pháp AST lập chỉ mục ký hiệu và tra cứu tham chiếu nhanh.
- **Quản lý đa cấu hình AI (Multi-Profile):** Quản lý đồng thời nhiều tài khoản, mô hình và nhà cung cấp AI khác nhau (OpenAI, Anthropic, Gemini, OpenRouter, Ollama...) với cơ chế test kết nối trước khi áp dụng.
- **Tự host & Triển khai đám mây tin cậy:** Hỗ trợ Docker Compose, Render free tier và máy chủ Linux VPS với cơ chế tách quyền người dùng Unix `hub`/`agent` và cổng kiểm tra bảo mật mặc định từ chối. Chi tiết: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Bắt đầu nhanh

### Cách 1: Cài đặt bằng bộ cài thương mại ChatMCPSetup.exe (Khuyên dùng)

1. Đóng gói bộ cài đặt standalone:
   ```powershell
   .\scripts\Build-Installer.ps1
   ```
   File cài đặt duy nhất **`dist\ChatMCPSetup.exe`** (~2 MB) sẽ được tạo ra.
2. Nhấp đúp chuột vào file **`ChatMCPSetup.exe`** để mở trình cài đặt thương mại:
   - Chọn thư mục cài đặt (mặc định `%LOCALAPPDATA%\Programs\ChatMCP`).
   - Tự động tạo Desktop & Start Menu shortcut với icon chính thức.
   - Đăng ký vào Windows Settings -> Apps -> Installed apps.
3. Bấm **Install** -> Hoàn tất trong 2 giây! Bạn có thể khởi chạy ngay từ Desktop hoặc Start Menu.

### Cách 2: Khởi chạy Hub qua dòng lệnh

Yêu cầu: **Node.js ≥ 22.12** và **Git for Windows**. Không cần cài đặt thêm gói npm hay build. Chi tiết: [docs/WINDOWS-SETUP.md](docs/WINDOWS-SETUP.md).

```powershell
# Từ thư mục ChatMCP
.\CHATMCP-HUB\START-CHATMCP-HUB.cmd -ProjectPath C:\duong\dan\du-an
```

Trình duyệt sẽ tự động mở tại `http://127.0.0.1:3007`. Để dừng Hub: `.\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd`.

---

## Trạng thái năng lực & Kiểm chứng

Nhãn: `implemented` · `unit-tested` · `integration-tested` · `e2e-verified` · `production-verified`. Toàn bộ 55 test suites Node.js đều chạy kiểm tra thực tế:

| Năng lực | Trạng thái | Minh chứng kiểm thử |
|---|---|---|
| **Đóng gói Desktop Native App** | `implemented` · `e2e-verified` | `START-CHATMCP-DESKTOP.cmd`, `scripts/Start-DesktopApp.ps1`, [docs/DESKTOP-APP.md](docs/DESKTOP-APP.md) |
| **Skills Marketplace & Plugin System** | `implemented` · `integration-tested` | `verify-phase4-features.mjs`, `/api/plugins/*` |
| **Multi-User RBAC & Audit Trail** | `implemented` · `integration-tested` | `verify-phase4-features.mjs`, `/api/governance/*` |
| **Hub độc lập & Local Tools** | `implemented` · `e2e-verified` | `verify-local-backend.mjs`, `verify-local-tools.mjs` |
| **Quyền Review & FULL ACCESS** | `implemented` · `e2e-verified` | `verify-full-access.mjs`, `verify-permissions-modes.mjs` |
| **ConPTY Terminal & AST Index** | `implemented` · `integration-tested` | `verify-v2-http.mjs`, `verify-v2-runtime.mjs` |
| **Multi-Profile AI Manager** | `implemented` · `integration-tested` | `verify-phase3-features.mjs`, `/api/ai/profiles/*` |
| **GitHub Actions CI/CD Matrix** | `implemented` · `production-verified` | **7/7 jobs XANH (PASSED)** trên cả Ubuntu và Windows |
| **Tự host Docker & Render** | `implemented` · `e2e-verified` | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), `verify-e2e-public.mjs` |

---

## Chế độ quyền của Agent

| Chế độ | Hành vi của Agent | Mức độ an toàn |
|---|---|---|
| **Chỉ đọc** | Đọc file, tìm kiếm cú pháp, xem git log/diff. Mọi yêu cầu ghi bị từ chối ngay lập tức. | Cao nhất |
| **Review** (mặc định) | Đọc file tự do; mỗi thao tác ghi/sửa file hoặc chạy lệnh đều hiện popup phê duyệt có diff trực quan. | Khuyên dùng |
| **Tự động** | Tự động sửa file (có checkpoint) và chạy lệnh test đã biết; lệnh mạng, xóa file, git push vẫn hỏi. | Dự án quen thuộc |
| **FULL ACCESS** | Thực hiện toàn bộ quyền tự trị không cần phê duyệt; bắt buộc gõ xác nhận 'FULL ACCESS' và CSRF. | Dành cho chuyên gia |

Các file nhạy cảm (`.env`, private keys, `.git/`) luôn được bảo vệ tuyệt đối ở **tất cả các chế độ**. Xem chi tiết tại [SECURITY.md](SECURITY.md).

---

## Cấu trúc Repository

| Thư mục / Tệp | Vai trò | Trạng thái |
|---|---|---|
| `CHATMCP-HUB/` | Mã nguồn cốt lõi: Hub server, Agent loop, Plugin Manager, Governance, API routes | Hoàn thiện (v2.3.0) |
| `START-CHATMCP-DESKTOP.cmd` | Bộ khởi chạy Desktop Native App 1-click cho Windows | Mới |
| `scripts/` | Bộ công cụ cài đặt Desktop, bootstrap Cloud Harness và xoay khóa bảo mật | Hoàn thiện |
| `docs/` | Toàn bộ 17 tài liệu kiến trúc, hướng dẫn sử dụng, triển khai và báo cáo kỹ thuật | Hoàn thiện |
| `deploy/` | Cấu hình Docker, supervisor tách quyền Linux và các kịch bản kiểm thử E2E | Hoàn thiện |
| `Dockerfile`, `render.yaml` | Cấu hình triển khai container cho Render và các nền tảng đám mây | Hoàn thiện |

---

## Kiểm thử tự động

```powershell
cd CHATMCP-HUB
npm test            # Chạy toàn bộ 55 test suites Node.js
npm run test:ui     # Chạy bộ test giao diện người dùng
```

Tất cả các bài kiểm tra được thiết kế không phụ thuộc mock giả rỗng: mỗi bộ test kiểm tra trực tiếp hành vi file system, tiến trình terminal, HTTP server và API logic thực tế.

---

## Danh mục Tài liệu Kỹ thuật

- [docs/USER-GUIDE.md](docs/USER-GUIDE.md) — Hướng dẫn sử dụng chi tiết cho người dùng
- [docs/DESKTOP-APP.md](docs/DESKTOP-APP.md) — Hướng dẫn cài đặt và đóng gói ứng dụng Desktop Native
- [docs/WINDOWS-SETUP.md](docs/WINDOWS-SETUP.md) — Hướng dẫn thiết lập môi trường Windows 11
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Khắc phục sự cố thường gặp
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Kiến trúc tổng thể và ranh giới bảo mật
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — Hướng dẫn phát triển và quy chuẩn kiểm thử
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Hướng dẫn tự host (Docker, Render, VPS)
- [docs/TESTING-WITH-REAL-MODELS.md](docs/TESTING-WITH-REAL-MODELS.md) — Hướng dẫn thử nghiệm với mô hình AI thực tế
- [SECURITY.md](SECURITY.md) — Chính sách bảo mật, mô hình đe dọa và thu hồi token
- [CHANGELOG.md](CHANGELOG.md) — Lịch sử thay đổi và cập nhật phiên bản
- [docs/PHASE0-AUDIT.md](docs/PHASE0-AUDIT.md) · [docs/PHASE1-DESIGN.md](docs/PHASE1-DESIGN.md) · [docs/PHASE1-REPORT.md](docs/PHASE1-REPORT.md) · [docs/PHASE2-DESIGN.md](docs/PHASE2-DESIGN.md) · [docs/PHASE2-REPORT.md](docs/PHASE2-REPORT.md) · [docs/PHASE3-DESIGN.md](docs/PHASE3-DESIGN.md) · [docs/PHASE3-REPORT.md](docs/PHASE3-REPORT.md) · [docs/PHASE4-DESIGN.md](docs/PHASE4-DESIGN.md) · [docs/PHASE4-REPORT.md](docs/PHASE4-REPORT.md) — Báo cáo kiểm toán, thiết kế và kết quả 4 phase
- [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — Giấy phép các thành phần bên thứ ba
- [CHATMCP-HUB/README.md](CHATMCP-HUB/README.md) — Lịch sử phát hành của Hub

---

## Giấy phép & Đóng góp

Repository được phát triển độc lập cho ChatMCP. Phụ thuộc bên thứ ba [Cloud Harness MCP](https://github.com/bestagentkits/cloud-harness-mcp) (MIT License) được clone để sử dụng và tích hợp, không sao chép nguyên bản nhãn hiệu hay phân phối lại.
