# ChatMCP — AI Coding Agent

ChatMCP là một **AI Coding Agent chạy cục bộ**, thiết kế tối ưu cho Windows 11 và môi trường tự host: bạn chọn một thư mục dự án, kết nối nhà cung cấp mô hình (Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek, Ollama…), giao việc bằng tiếng Việt hoặc tiếng Anh; agent tự động đọc mã, lập kế hoạch đa bước, sửa file nguyên tử, chạy kiểm thử, dùng Git và báo cáo kết quả dựa trên đầu ra thực tế.

---

## Tính năng nổi bật

- **Desktop Native App (Windows 11):** Phân phối qua file cài đặt độc lập `dist/ChatMCPSetup.exe`. Tự động tạo shortcut, đăng ký vào Windows Apps (`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatMCP`) và tạo sẵn bộ gỡ cài đặt `Uninstall.exe`. Ứng dụng chạy qua `ChatMCP.exe` trong cửa sổ native độc lập, không thanh URL, không tabs. Chi tiết: [docs/DESKTOP-APP.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/DESKTOP-APP.md).
- **Multi-Agent Orchestrator (beta):** Tab Agents hỗ trợ DAG tối đa 8 read-only workers, chạy tối đa 3 worker song song, truyền kết quả giữa các bước, coordinator tổng hợp và có thể hủy tác vụ. Chưa có quyền sửa mã đồng thời hoặc triển khai subagent lên các worktree độc lập.
- **GitHub Agent Skills Hub (beta):** Tìm SKILL.md thực từ các thư mục GitHub chọn lọc, ghim SHA, cho phép cài SKILL.md và tối đa 32 resources văn bản trong references/scripts/assets với giới hạn dung lượng, lưu hash vào lockfile. Các skill bên thứ ba mặc định tắt; không thực thi scripts và chưa hỗ trợ binary assets. Tính năng refresh/import chỉ hoạt động ở local trusted Hub.
- **Skills Marketplace & Plugin System:** Chợ kỹ năng chọn lọc (`git-workflow-pro`, `python-architect`, `docker-devops`, `sqlite-explorer`, `web-researcher`, `security-compliance-guard`), hỗ trợ cài đặt, cấu hình, bật/tắt và tự động tiêm ngữ cảnh vào Agent qua Command Palette (`Ctrl+K`).
- **Phân quyền Multi-User RBAC & Cách ly Workspace:** Kiểm soát truy cập theo vai trò (`viewer`, `developer`, `admin`), đảm bảo an toàn biên giới thư mục giữa các workspace và ghi nhật ký kiểm toán bất biến vào `enterprise-audit.jsonl`.
- **Bốn chế độ phê duyệt quyền linh hoạt:**
  - *Chỉ đọc*: Agent chỉ phân tích, tìm kiếm mã nguồn và Git.
  - *Review* (mặc định): Phê duyệt từng thay đổi file và lệnh thực thi kèm diff chi tiết.
  - *Tự động*: Tự động chạy lệnh kiểm thử đã biết (`npm test`, `pytest`) và sửa file an toàn.
  - *FULL ACCESS*: Chế độ tốc độ cao cho lập trình viên chuyên nghiệp, bắt buộc gõ xác nhận 'FULL ACCESS' kèm bảo vệ CSRF.
- **Terminal tương tác ConPTY & AST Code Index:** Console thời gian thực tương tác trực tiếp với tiến trình hệ thống, kết hợp bộ phân tích cú pháp AST lập chỉ mục ký hiệu và tra cứu tham chiếu nhanh.
- **Quản lý đa cấu hình AI (Multi-Profile):** Quản lý đồng thời nhiều tài khoản, mô hình và nhà cung cấp AI khác nhau (OpenAI, Anthropic, Gemini, OpenRouter, Ollama...) với cơ chế test kết nối trước khi áp dụng.
- **Tự host & Triển khai đám mây tin cậy:** Hỗ trợ Docker Compose, Render free tier và máy chủ Linux VPS với cơ chế tách quyền người dùng Unix `hub`/`agent` và cổng kiểm tra bảo mật mặc định từ chối. Chi tiết: [docs/DEPLOYMENT.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/DEPLOYMENT.md).

---

## Hướng dẫn chi tiết cài đặt & Khởi chạy

### Cách 1: Tải bộ cài đặt chính thức ChatMCPSetup.exe (Khuyên dùng)

Dành cho người dùng cuối trên Windows 10/11. Không cần cài đặt trước Node.js, Git hay bất kỳ công cụ phát triển nào.

1. **Tải bộ cài đặt:**
   Truy cập **[GitHub Releases](https://github.com/pddczpl/ChatMCP/releases/latest)** và tải file **`ChatMCPSetup.exe`** (~35.7 MB).
2. **Cài đặt trong 2 giây:**
   - Nhấp đúp chuột vào file **`ChatMCPSetup.exe`** để mở trình cài đặt thương mại.
   - Thư mục cài đặt mặc định: `%LOCALAPPDATA%\Programs\ChatMCP`.
   - Trình cài đặt tự động tạo shortcut Desktop & Start Menu với icon chính thức, tích hợp trình gỡ cài đặt `Uninstall.exe` và đăng ký vào Windows Apps (`Installed apps`).
3. **Sử dụng:**
   - Mở **ChatMCP Studio** từ biểu tượng trên Desktop hoặc Start Menu.
   - Chọn thư mục dự án và bắt đầu làm việc với AI Agent ngay lập tức.

---

### Cách 2: Khởi chạy Native Desktop App từ mã nguồn (Dành cho Developer)

Dành cho lập trình viên muốn chạy hoặc tùy biến từ mã nguồn repository:

1. **Yêu cầu môi trường:**
   - Windows 10/11 (hỗ trợ cả PowerShell 5.1 và PowerShell 7).
   - [Node.js](https://nodejs.org/) ≥ 22.x và [Git](https://git-scm.com/).
   - (.NET SDK 9+ nếu muốn tự biên dịch lại desktop shell C#).
2. **Clone repository:**
   ```powershell
   git clone https://github.com/pddczpl/ChatMCP.git
   cd ChatMCP
   ```
3. **Khởi chạy tức thì (Không cần npm install / build frontend):**
   Mã nguồn đã tích hợp sẵn bản build tĩnh sản xuất của UI tại `CHATMCP-HUB/web/dist/`. Bạn chỉ cần chạy:
   ```powershell
   .\START-CHATMCP-DESKTOP.cmd
   ```
   *(Tùy chọn: Chạy `.\scripts\install-desktop.ps1` để tự động tạo shortcut Desktop & Start Menu trỏ vào repo).*

---

### Cách 3: Khởi chạy Hub Server qua dòng lệnh (Headless / Web Browser)

Nếu muốn khởi chạy Hub server độc lập và truy cập qua trình duyệt web:

```powershell
.\CHATMCP-HUB\START-CHATMCP-HUB.cmd -ProjectPath C:\duong\dan\du-an
```
Mở trình duyệt tại địa chỉ `http://localhost:3000` (hoặc cổng được hiển thị trong console).

---

### Cách 4: Tự đóng gói bộ cài đặt độc lập (Build Standalone Installer)

Nếu bạn muốn tự đóng gói file cài đặt `ChatMCPSetup.exe` từ mã nguồn:

```powershell
.\scripts\Build-Installer.ps1
```
Script sẽ tự động:
1. Chuẩn bị runtime Node.js portable và assets UI.
2. Biên dịch desktop shell C# WinForms / WebView2.
3. Đóng gói toàn bộ thành file duy nhất tại **`dist\ChatMCPSetup.exe`** (~35.7 MB).

---

### Cách 5: Triển khai Docker & Tự host (Linux / VPS / Render)

ChatMCP hỗ trợ chạy trên server Linux hoặc đám mây qua Docker:

```bash
docker build -t chatmcp-hub .
docker run -d -p 3000:3000 -v /path/to/project:/workspace chatmcp-hub
```
Chi tiết cấu hình biến môi trường, bảo mật đa người dùng và triển khai trên Render free tier: xem [docs/DEPLOYMENT.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/DEPLOYMENT.md).


---

## Chế độ quyền của Agent

| Chế độ | Hành vi của Agent | Mức độ an toàn |
| :--- | :--- | :--- |
| **Chỉ đọc** | Đọc file, tìm kiếm cú pháp, xem git log/diff. Mọi yêu cầu ghi bị từ chối ngay lập tức. | Cao nhất |
| **Review (mặc định)** | Đọc file tự do; mỗi thao tác ghi/sửa file hoặc chạy lệnh đều hiện popup phê duyệt có diff trực quan. | Khuyên dùng |
| **Tự động** | Tự động sửa file (có checkpoint) và chạy lệnh test đã biết; lệnh mạng, xóa file, git push vẫn hỏi. | Dự án quen thuộc |
| **FULL ACCESS** | Thực hiện toàn bộ quyền tự trị không cần phê duyệt; bắt buộc gõ xác nhận 'FULL ACCESS' và CSRF. | Dành cho chuyên gia |

Các file nhạy cảm (`.env`, private keys, `.git/`) luôn được bảo vệ tuyệt đối ở tất cả các chế độ. Xem chi tiết tại [SECURITY.md](https://github.com/pddczpl/ChatMCP/blob/main/SECURITY.md).

---

## Cấu trúc Repository

| Thư mục / Tệp | Vai trò | Trạng thái |
| :--- | :--- | :--- |
| `CHATMCP-HUB/` | Mã nguồn cốt lõi: Hub server, Agent loop, Plugin Manager, Governance, API routes | Hoàn thiện (v2.3.0) |
| `START-CHATMCP-DESKTOP.cmd` | Bộ khởi chạy Desktop Native App 1-click cho Windows | Mới |
| `scripts/` | Bộ công cụ cài đặt Desktop, bootstrap Cloud Harness và xoay khóa bảo mật | Hoàn thiện |
| `docs/` | Toàn bộ 17 tài liệu kiến trúc, hướng dẫn sử dụng, triển khai và báo cáo kỹ thuật | Hoàn thiện |
| `deploy/` | Cấu hình Docker, supervisor tách quyền Linux và các kịch bản kiểm thử E2E | Hoàn thiện |
| `Dockerfile`, `render.yaml` | Cấu hình triển khai container cho Render và các nền tảng đám mây | Hoàn thiện |

---

## Danh mục Tài liệu Kỹ thuật

- [docs/USER-GUIDE.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/USER-GUIDE.md) — Hướng dẫn sử dụng chi tiết cho người dùng
- [docs/DESKTOP-APP.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/DESKTOP-APP.md) — Hướng dẫn cài đặt và đóng gói ứng dụng Desktop Native
- [docs/WINDOWS-SETUP.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/WINDOWS-SETUP.md) — Hướng dẫn thiết lập môi trường Windows 11
- [docs/TROUBLESHOOTING.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/TROUBLESHOOTING.md) — Khắc phục sự cố thường gặp
- [docs/ARCHITECTURE.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/ARCHITECTURE.md) — Kiến trúc tổng thể và ranh giới bảo mật
- [docs/DEVELOPMENT.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/DEVELOPMENT.md) — Hướng dẫn phát triển và quy chuẩn kiểm thử
- [docs/DEPLOYMENT.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/DEPLOYMENT.md) — Hướng dẫn tự host (Docker, Render, VPS)
- [docs/TESTING-WITH-REAL-MODELS.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/TESTING-WITH-REAL-MODELS.md) — Hướng dẫn thử nghiệm với mô hình AI thực tế
- [SECURITY.md](https://github.com/pddczpl/ChatMCP/blob/main/SECURITY.md) — Chính sách bảo mật, mô hình đe dọa và thu hồi token
- [CHANGELOG.md](https://github.com/pddczpl/ChatMCP/blob/main/CHANGELOG.md) — Lịch sử thay đổi và cập nhật phiên bản
- [docs/PHASE0-AUDIT.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/PHASE0-AUDIT.md) · [docs/PHASE1-DESIGN.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/PHASE1-DESIGN.md) · [docs/PHASE1-REPORT.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/PHASE1-REPORT.md) · [docs/PHASE2-DESIGN.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/PHASE2-DESIGN.md) · [docs/PHASE2-REPORT.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/PHASE2-REPORT.md) · [docs/PHASE3-DESIGN.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/PHASE3-DESIGN.md) · [docs/PHASE3-REPORT.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/PHASE3-REPORT.md) · [docs/PHASE4-DESIGN.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/PHASE4-DESIGN.md) · [docs/PHASE4-REPORT.md](https://github.com/pddczpl/ChatMCP/blob/main/docs/PHASE4-REPORT.md) — Báo cáo kiểm toán, thiết kế và kết quả 4 phase
- [THIRD-PARTY-NOTICES.md](https://github.com/pddczpl/ChatMCP/blob/main/THIRD-PARTY-NOTICES.md) — Giấy phép các thành phần bên thứ ba
- [CHATMCP-HUB/README.md](https://github.com/pddczpl/ChatMCP/blob/main/CHATMCP-HUB/README.md) — Lịch sử phát hành của Hub

---

## Giấy phép & Đóng góp

Repository được phát triển độc lập cho ChatMCP. Phụ thuộc bên thứ ba [Cloud Harness MCP](https://github.com/bestagentkits/cloud-harness-mcp) (MIT License) được clone để sử dụng và tích hợp, không sao chép nguyên bản nhãn hiệu hay phân phối lại.
