# Lịch sử thay đổi

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/). Phiên bản của Hub (`CHATMCP-HUB/package.json`) và bản dựng giao diện (`2.3.0-react-agent`) cùng đi theo mục dưới đây.

Các bản trước 2.3.0 (2.0.0 … 2.2.8) có ghi chú riêng ở `CHATMCP-HUB/STUDIO-*.md`, `UPGRADE-*.md`, `TEST-RESULTS-*.txt`; chúng là tài liệu lịch sử và không được cập nhật.

## [2.3.0] — nhánh `dev/chatmcp-agent` (chưa gắn tag, chưa push)

Mục tiêu của bản này: biến Hub thành một **AI Coding Agent chạy được trên Windows 11 cho một người dùng**, không cần Docker, Cloud Harness hay Desktop Commander. Nhãn từng tính năng nằm ở [README.md](README.md); báo cáo và bằng chứng ở [docs/PHASE1-REPORT.md](docs/PHASE1-REPORT.md).

### Thêm

- **Backend `local` (mặc định):** Hub tự chạy vòng lặp agent và các công cụ trong chính tiến trình của nó (`lib/local-tools.mjs`, 18 công cụ: đọc/liệt kê/tìm file, `git_status/diff/log/add/commit/branch`, ghi/sửa/đổi tên/xóa, `run_command`, kế hoạch). Backend `mcp` (Cloud Harness + Desktop Commander) vẫn còn, ở vai trò cũ (legacy), `--backend mcp`.
- **Ba chế độ quyền:** `Chỉ đọc` (mới), `Review`, `Tự động`; `manual` là tên cũ của `Review`. Khung duyệt hiển thị lệnh/diff nguyên văn, có đồng hồ hết hạn 10 phút (hết hạn = từ chối).
- **Phân tích lệnh shell** (`read`/`verify`/`edit`/`exec`/`dangerous`), **vùng cấm file bí mật** (`.env*`, khóa riêng, `.git`…), đi theo đường dẫn thật qua symlink/junction/tên 8.3/ổ đĩa ảo PowerShell (`lib/command-paths.mjs`), kiểm tra cấu hình Git của kho trước khi chạy `git` (`lib/git-trust.mjs`), `ShellRunner` (Git Bash trước, PowerShell sau; stdin đóng; timeout giết cả cây tiến trình; xóa biến môi trường dạng khóa).
- **Checkpoint trước mỗi thay đổi**; không tạo được thì thao tác không chạy (`checkpoint_failed`).
- **Lớp model nhiều nhà cung cấp:** Anthropic Messages, OpenAI-compatible (đã làm chắc), Gemini; 12 preset (Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek, Groq, Mistral, Ollama, LM Studio, 3 gateway tùy chọn); tải danh sách model; **thử tool calling** khi kiểm tra kết nối; thử lại có giãn cách; rút gọn ngữ cảnh có kiểm soát; che bí mật trong lỗi/nhật ký.
- **Lưu API key:** Windows DPAPI (đã thử vòng khứ hồi thật trên Windows); AES-256-GCM trên Linux/macOS; hoặc dùng biến môi trường; hoặc chỉ giữ trong bộ nhớ.
- **Máy trạng thái tác vụ chuẩn** với 11 trạng thái (`created`, `queued`, `planning`, `running`, `waiting_approval`, `verifying`, `paused`, `completed`, `failed`, `cancelled`, `uncertain`) và lịch sử chuyển trạng thái. **Phục hồi phiên không phát lại thao tác ghi chưa rõ kết quả**: tác vụ vào `uncertain`/`paused`, bạn xem Git diff rồi quyết định.
- **Bằng chứng do Hub ghi** (số thao tác sửa file thành công, lệnh kiểm tra đã chạy và thoát mã 0) hiển thị dưới kết quả; "Hoàn tất" không còn đồng nghĩa với "đạt".
- **Giao diện:** hộp thoại thiết lập 4 bước lần đầu, form nhà cung cấp, công tắc quyền cạnh ô nhập, khung duyệt phía trên ô nhập, banner cho trạng thái dừng giữa chừng, thẻ kế hoạch của agent, tiêu đề tab báo "Cần duyệt".
- **Launcher Windows độc lập** `START-CHATMCP-HUB.cmd` / `STOP-CHATMCP-HUB.cmd`: chạy Hub ở nền, chờ kiểm tra sức khỏe, dùng lại Hub đang chạy, không đụng cổng của chương trình khác, không đổi ExecutionPolicy.
- **Bộ kiểm thử:** bộ chạy chung `npm test` (46 bộ Node, mỗi bộ một tiến trình, có `--json`/`--filter`/`--no-skip`; có cả bộ kiểm tra chính bộ chạy test, bộ đối chiếu tài liệu với mã và bộ kiểm tra công cụ đột biến), 5 bộ giao diện Playwright (`--python`), khung E2E với **mô hình giả có kịch bản** (6 kịch bản: FastAPI thật, sửa lỗi, Git/nhánh, phục hồi phiên, cô lập hai người dùng ở mức Hub, kho độc hại), công cụ **kiểm thử đột biến** `tests/mutation/run-mutations.mjs` (hỏng mã một chỗ nhỏ mỗi lần trong bản sao tạm, xem bộ test có nhận ra không) cùng 4 danh sách đột biến đã dùng (xem DEVELOPMENT.md). CI: `.github/workflows/ci.yml` (Linux + Windows × Node 22/24, mọi action ghim theo SHA; **chưa chạy trên GitHub**). Bản cập nhật workflow (cài Python cho bộ FastAPI, job giao diện Chromium, `--no-skip all` để một bộ bị bỏ qua không làm CI xanh giả) **chưa được áp dụng**: công cụ của phiên làm việc không được ghi vào `.github/workflows/`, nên bản đề xuất nằm ở [docs/ci-proposal.yml](docs/ci-proposal.yml) và báo cáo Phase 1 hướng dẫn cách áp dụng.
- **Tài liệu:** README, ARCHITECTURE, DEVELOPMENT, WINDOWS-SETUP, USER-GUIDE, TROUBLESHOOTING, DEPLOYMENT, SECURITY, TESTING-WITH-REAL-MODELS, THIRD-PARTY-NOTICES, PHASE0-AUDIT, PHASE1-DESIGN, PHASE1-REPORT.
- **Công cụ xoay token Cloud Harness** (`scripts/Rotate-CloudHarnessToken.ps1`, mặc định chỉ xem trước) và khóa phiên bản phụ thuộc bên thứ ba (`deps/`).

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

### Bảo mật

- Các phát hiện Phase 0 (S1–S4, token Cloud Harness trong lịch sử Git công khai, dữ liệu trạng thái trong lịch sử, định danh cá nhân, telemetry của Desktop Commander) được **ghi lại và đang chờ chủ sở hữu quyết định**; chưa ai xoay token, chưa ai viết lại lịch sử Git. Xem [SECURITY.md](SECURITY.md).
- Giới hạn đã biết (chưa khắc phục) được liệt kê đầy đủ ở SECURITY.md, trong đó: Hub không có xác thực nên **chỉ chạy ở loopback cho một người dùng**; đa người dùng **bị chặn**.

### Vệ sinh repository

- Thêm `.gitignore`, `.gitattributes`, `.editorconfig`; ngừng theo dõi (không xóa khỏi đĩa) các bản clone lồng nhau, thư mục phụ thuộc, bản sao lưu trạng thái, thư mục "rescue" và file ZIP (`e9cfba4`, `2089911`, `3571def`). **Không viết lại lịch sử Git, không force-push.**
- Lưu ý: `CHATMCP-HUB/SHA256SUMS.txt` là của bản phát hành cũ và đã lỗi thời.

### Chưa làm / bị chặn

- Triển khai self-host (Phase 2), HTTPS, đăng nhập, Docker Compose, CI/CD triển khai: **chưa làm** ([DEPLOYMENT.md](docs/DEPLOYMENT.md)).
- Thử với mô hình thật và tạo Pull Request GitHub thật: **blocked** (cần khóa/xác thực của bạn; [TESTING-WITH-REAL-MODELS.md](docs/TESTING-WITH-REAL-MODELS.md)).
- Cô lập đa người dùng: **blocked** (không có bằng chứng; yêu cầu VM/microVM).
- Cập nhật workflow CI: **blocked** ở phía công cụ (file nằm trong `.github/workflows/` bị bảo vệ); bản đề xuất đã soạn và kiểm tra cú pháp, chờ bạn áp dụng.
- Chọn giấy phép cho repository: chưa có `LICENSE` (cần chủ sở hữu quyết định).
