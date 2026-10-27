# ChatMCP Studio 2.2.0 — Coding agent local, giao diện sáng/tối và công cụ kiểm soát

**Hub:** 2.2.0 · **UI build:** `2.2.0-react-offline` · **Companion:** 1.4.0 (không đổi)

Ứng dụng này **không phải bản sao tương đương toàn bộ Codex Desktop, Antigravity hay Claude Code**. Đây là phần mềm local lấy cảm hứng từ trải nghiệm coding agent: danh sách cuộc hội thoại bên trái, hội thoại và lệnh cho agent ở giữa, công cụ lập trình (Files/Git/Terminal/Code-LSP/Preview/Plan/Skills/Settings) bên phải. Mã nguồn, tên, giao diện và icon thuộc ChatMCP; không sao chép tài sản hay nhãn hiệu của phần mềm khác.

## Sử dụng giao diện

1. Vào `http://127.0.0.1:3007`, chọn workspace một lần, giữ nguyên cho phiên liên quan.
2. Chọn chế độ **ChatGPT Web** (yêu cầu Companion và tài khoản web) hoặc **API Gateway** (yêu cầu key riêng và gateway hỗ trợ function calling). Cấu hình API ở Settings; không nhập key vào chat.
3. Chọn một cuộc hội thoại cũ ở cột trái để tiếp tục, hoặc **Hội thoại mới** nếu muốn tạo cuộc chat riêng. Cùng một session giữ lịch sử/plan/checkpoint; không tự lập chat mới để thay thế chat bị mất.
4. Nhập yêu cầu ở giữa, quan sát timeline và lời gọi MCP, xem Git diff và bằng chứng kiểm thử. Nút **Sáng/Tối** ở header đổi theme, lưu lựa chọn trong trình duyệt. Có thể ẩn panel công cụ khi muốn đọc chat, bấm `Ctrl+K` để tìm lệnh nhanh.
5. Trong Files, chọn file để đọc/sửa, thao tác Save kiểm tra SHA-256 trước khi ghi và tạo checkpoint giới hạn. Các nút Edit/Git/Terminal phản ánh dữ liệu/API thật, không phải video mô phỏng. 

## Hai chính sách thực thi — khác biệt quan trọng

| Chính sách | Hoạt động | Khả năng sửa dự án | Giới hạn an toàn |
|---|---|---|---|
| **Sandbox-only** | Chặn MCP ngoài Hub; chặn terminal trên Windows host; lệnh kiểm thử chỉ chạy trong Docker restricted Linux container; chặn Editor Save/Restore và host LSP | **Không** sửa được file dự án qua các công cụ MCP thông thường; chỉ đọc/đánh giá và chạy test read-only | Container cô lập cho lệnh Docker, **không phải** cô lập OS cho toàn ứng dụng |
| **Host-review** | Cho phép host MCP/Desktop Commander sau khi qua gate phân quyền; terminal host thủ công và LSP cần lựa chọn rõ | **Có**, theo quyền mà người dùng Windows đã cấp | Windows workspace selection + phê duyệt **không phải OS sandbox**. Lệnh shell/công cụ Desktop Commander có thể vượt workspace |

Các cấp approval **Review / Manual / Autonomous** hoạt động bên cạnh chính sách thực thi. Chế độ Autonomous không tạo sandbox; chỉ thay đổi quyết định phê duyệt. Nếu cần sửa bài lab trên Windows bằng Desktop Commander, hãy chọn **Host-review**, đọc kỹ lệnh và backup Git trước.

### Docker sandbox

- Sử dụng Docker Desktop Linux containers, mặc định `python:3.11-slim`, chạy `/bin/sh -lc ...`, `--network none`, workspace bind **read-only**, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, giới hạn CPU/memory/PID và UID không đặc quyền.
- Chạy lệnh kiểm thử/đánh giá, **không thể sửa code vào workspace trong sandbox**. Ghi tạm vào `/tmp`, không truy cập Internet, không tự cài dependency trong quá trình chạy. Docker Desktop phải hoạt động và image phải được tải trước. Lệnh đầu tiên có thể thất bại nếu image chưa có hoặc môi trường dự án cần thư viện khác.
- Docker Desktop và Linux VM vẫn có quyền truy cập host mà người dùng cấp; đây là cô lập của **container dành riêng cho lệnh sandboxed**, không bảo đảm chống mọi lỗ hổng kernel/container. Không mount Docker socket hoặc thư mục nhạy cảm vào container.
- Nếu bật Sandbox-only, external MCP không được chạy trong container theo cách tự động; chúng bị **chặn**, không được âm thầm chạy trên host. Việc chạy các process nền để quản trị dịch vụ Hub và sự lựa chọn mở VS Code trên Windows không cấu thành một OS sandbox toàn diện.

### Code intelligence và LSP

- File index: quét source trong workspace (bỏ qua .git/node_modules/secrets/symlink), phân tích Python bằng Python `ast`, giữ cache có checksum/mtime; JS/TS dùng regex heuristic; giới hạn số file, dung lượng. Không chạy/import code dự án khi index Python.
- Language Server Protocol qua stdio JSON-RPC; hỗ trợ **Pyright** (`pyright-langserver --stdio`) hoặc **TypeScript Language Server** (`typescript-language-server --stdio`) nếu executable hiện diện trong PATH Windows. Giao diện hỗ trợ definition, references, hover, document symbols, diagnostics theo khả năng server. LSP chạy **trên Windows host**, chỉ cho khởi động trong Host-review.
- LSP cần dependency bên ngoài, chưa có semantic graph cross-language, rename/refactor chính xác trên toàn repository hoặc index tất cả ngôn ngữ như IDE thương mại. Python AST index vẫn hoạt động khi chưa cài language server, nhưng không type-resolve references.

### Terminal

- Terminal tương tác có state, gửi stdin, dừng phiên, lấy output theo SSE. Khi có `node-pty` native tương thích với Windows+Node hiện tại, dùng Windows ConPTY; nếu chưa cài, fallback chạy PowerShell qua pipes, thiếu TTY semantics.
- Panel không có **ANSI/xterm.js renderer hoàn chỉnh**: full-screen CLI, vim/ncurses, prompt dựa trên TTY có thể không hiển thị đúng. Docker sandbox chỉ hỗ trợ lệnh không tương tác. Terminal host vẫn có cùng quyền OS với tài khoản Windows.

### Preview ứng dụng

- Người dùng khởi động server app của dự án trước (ví dụ `npm run dev` hoặc `python -m http.server 8000`), sau đó nhập **port localhost** vào panel Preview. Hub chỉ xác nhận TCP 127.0.0.1 và hiển thị iframe có `sandbox=allow-scripts allow-forms` hoặc mở browser tab.
- Không tự chạy dự án, không reverse-proxy/port-forward tự động, không hỗ trợ xem app chỉ bind sang network interface khác, không debug DOM/chụp screenshot tự động như browser agent.

### Session, checkpoint và reliability

- Lịch sử chat và journal được ghi trên ổ, có lựa chọn tiếp tục phiên cũ sau restart. Với ChatGPT Web, cần URL chat gốc và Companion hoạt động; mất xác nhận gửi hoặc lệnh MCP mutation chưa rõ kết quả sẽ được giữ `uncertain`, **không tự phát lại**. Với API, xây lại ngữ cảnh từ checkpoint đã xác nhận, không giữ mọi trạng thái ẩn của provider.
- Git diff/checkpoint/review hỗ trợ kiểm tra thay đổi. Checkpoint **chỉ là bản snapshot có giới hạn file và dung lượng**, không thay thế commit Git, backup project hoặc transaction filesystem hoàn chỉnh.
- Có bộ smoke/soak test Windows và watchdog **tùy chọn**, nhưng chưa chạy soak nhiều giờ trên máy Windows của bạn. Watchdog quan sát Hub localhost và thử gọi launcher sau 3 lần lỗi; không cam kết giữ Web/Companion/terminal qua reboot hay tự xử lý mọi kiểu crash.

## Nên cài gì trên Windows để dùng nhiều tính năng nhất?

- **Bắt buộc:** Windows 11, PowerShell 5.1, Node >= 22.12, Docker Desktop, Hub/Cloud Harness cấu hình sẵn, Edge/Chrome khi dùng Web mode.
- **LSP Python** (tùy chọn): `npm install -g pyright` rồi kiểm tra `pyright-langserver --version` hoặc `where.exe pyright-langserver`.
- **LSP JS/TS** (tùy chọn): `npm install -g typescript typescript-language-server`; kiểm tra `where.exe typescript-language-server`.
- **ConPTY** (tùy chọn): chạy `windows\Install-OptionalConPTY.ps1 -Install`; có thể cần internet, MSVC build tools và dependency native tương thích Node. Sau đó restart Hub và xem Terminal capabilities.
- **Docker test image**: chạy `docker pull python:3.11-slim` khi có mạng rồi dùng Docker sandbox trong Studio. Điều kiện network none áp dụng cho container lúc thực thi.

## Những gì hiện vẫn CHƯA có hoặc CHƯA chứng minh được

- Full Windows low-privilege sandbox cho **toàn bộ** agent và mọi Desktop Commander/MCP call: **chưa có**.
- Tự động sửa mã nguồn trong Docker read-only sandbox rồi đồng bộ/merge thay đổi có review: **chưa có**.
- Terminal xterm.js đầy đủ mặc định không cần cài gói: **chưa có**.
- Deep type-aware code navigation/rename cho mọi ngôn ngữ, kể cả khi chưa cài language server: **chưa có**.
- Preview app tự động mở server, VS Code debug/DevTools/browser automation tích hợp đầy đủ: **chưa có**.
- Thử nghiệm End-to-End nhiều giờ trên **Windows/Edge/Cloudflare/switch/Realtek của bạn**: **chưa kiểm chứng**.
- Bảo đảm kết quả bằng Codex Desktop/Antigravity hoặc sao chép UI 100%: **không**.
- Các bước UI mô phỏng trong screenshot là **dữ liệu giả lập**, không phải kết quả chạy bài lab trên PC người dùng.

Xem [UPGRADE-2.2.0.md](UPGRADE-2.2.0.md), [TEST-RESULTS-2.2.0.txt](TEST-RESULTS-2.2.0.txt).
