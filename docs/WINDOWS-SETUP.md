# Cài đặt và chạy trên Windows 11

Hướng dẫn này dành cho chạy ChatMCP Hub **trên máy Windows 11 của chính bạn**, cho một người dùng. Mọi lệnh dưới đây là Windows PowerShell 5.1 (có sẵn) hoặc `cmd`.

## 1. Yêu cầu

| Thành phần | Bắt buộc? | Ghi chú |
|---|---|---|
| **Node.js ≥ 22.12** | Có | `node --version`. Đã kiểm thử với 22 và 24. Tải ở <https://nodejs.org> hoặc `winget install OpenJS.NodeJS.LTS`. Mở terminal mới sau khi cài. |
| **Git for Windows** | Có (cho công cụ Git và shell) | `git --version`. Đi kèm **Git Bash**: đây là shell mặc định của agent. `winget install Git.Git`. |
| Python 3.11+ | Tùy chọn | chỉ mục ký hiệu Python của Hub (AST); chạy dự án Python của bạn; chạy bộ E2E FastAPI và bộ giao diện khi phát triển. |
| Docker Desktop | **Không** | chỉ cho backend `mcp` cũ và sandbox chạy test tùy chọn. Backend mặc định không cần. |
| Khóa API của một nhà cung cấp mô hình | Có (hoặc Ollama/LM Studio chạy cục bộ) | Anthropic, OpenAI, Gemini, OpenRouter… Xem [USER-GUIDE.md](USER-GUIDE.md). |

Hub không cần `npm install`, không có bước build.

**Về shell của agent.** Trên Windows, agent chạy lệnh bằng **Git Bash** nếu tìm thấy (`C:\Program Files\Git\bin\bash.exe` hoặc cạnh `git.exe`), vì mô hình quen cú pháp bash nhất. Không có Git Bash thì Hub dùng Windows PowerShell. Có thể chỉ định bash khác bằng biến môi trường `CHATMCP_BASH`. `C:\Windows\System32\bash.exe` (WSL) **không** được dùng.

## 2. Lấy mã nguồn

```powershell
git clone https://github.com/pddczpl/ChatMCP.git
cd ChatMCP
git switch dev/chatmcp-agent        # nhánh phát triển (khi nhánh đã được push)
```

Nếu bạn nhận mã dưới dạng ZIP, hãy bỏ chặn một lần để Windows không từ chối script:

```powershell
Get-ChildItem -Recurse -File . | Unblock-File
```

## 3. Khởi động Hub

```powershell
.\CHATMCP-HUB\START-CHATMCP-HUB.cmd -ProjectPath C:\duong\dan\toi\du-an
```

Launcher khởi động Hub **ở nền**, chờ đến khi Hub trả lời kiểm tra sức khỏe rồi trả lại cửa sổ; trình duyệt mở `http://127.0.0.1:3007`. Tham số:

| Tham số | Ý nghĩa |
|---|---|
| `-ProjectPath <thư mục>` | Thư mục dự án mở sẵn (không bắt buộc; có thể chọn trong giao diện) |
| `-Port <số>` | Cổng dashboard, mặc định 3007 (3006 thuộc proxy MCP cũ) |
| `-StateDir <thư mục>` | Nơi Hub lưu dữ liệu. Mặc định `%LOCALAPPDATA%\ChatMCP\hub` |
| `-NoOpen` | Không mở trình duyệt |
| `-Backend auto\|local\|mcp`, `-RepoRoot` | `auto` = `mcp` **chỉ khi** bạn truyền `-RepoRoot`, ngược lại `local`. `mcp` là luồng Cloud Harness cũ (cần Docker và repo Cloud Harness); bạn không cần nó |

Gọi lại launcher khi Hub đã chạy sẽ **dùng lại** Hub đó (và đổi dự án nếu bạn truyền `-ProjectPath` khác); nó không bao giờ động tới một cổng do chương trình khác sử dụng và báo lý do nếu Hub không khởi động được.

Dừng Hub:

```powershell
.\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd           # thêm -Port nếu bạn đã đổi cổng
```

Sau khi cập nhật mã nguồn, **luôn dừng Hub cũ trước** rồi khởi động lại; trang sẽ cảnh báo "Giao diện và Hub không cùng phiên bản" nếu bạn quên.

### Chạy thẳng bằng Node (không qua PowerShell)

Nếu PowerShell chặn script (xem [TROUBLESHOOTING.md](TROUBLESHOOTING.md#powershell-chặn-script-executionpolicy)) hoặc bạn muốn xem nhật ký trực tiếp:

```powershell
node .\CHATMCP-HUB\hub.mjs --backend local --project C:\duong\dan\toi\du-an --port 3007
```

Đóng cửa sổ (hoặc `Ctrl+C`) là dừng Hub. Tùy chọn khác: `--state-dir <thư mục>`, `--no-open`, `--log-file <tệp>`. Biến môi trường tương ứng: `CHATMCP_STATE_DIR`, `CHATMCP_BACKEND`, `CHATMCP_NO_OPEN`.

## 4. Lần đầu

Trình hướng dẫn mở sẵn (xem [USER-GUIDE.md](USER-GUIDE.md)): chọn thư mục dự án → nhà cung cấp + khóa API + **Lưu & kiểm tra** → quyền (nên bắt đầu bằng *Review*) → tác vụ mẫu "Tìm hiểu dự án" (chỉ đọc).

Khóa API nhập trên giao diện được bảo vệ bằng **Windows DPAPI** (chỉ tài khoản Windows này, trên máy này, đọc lại được). Bạn cũng có thể không lưu khóa và đặt biến môi trường `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`… trước khi khởi động Hub; Hub chỉ dùng biến đúng với nhà cung cấp đã chọn.

## 5. Dữ liệu nằm ở đâu

`%LOCALAPPDATA%\ChatMCP\hub` (trừ khi bạn đổi bằng `-StateDir`): cài đặt, khóa đã mã hóa, mọi hội thoại và đầu ra công cụ, checkpoint, nhật ký. Đây là **dữ liệu riêng tư**: đừng chia sẻ, đừng commit. Xem cấu trúc trong [ARCHITECTURE.md](ARCHITECTURE.md#11-dữ-liệu-trên-đĩa).

Gỡ cài đặt: dừng Hub rồi xóa thư mục mã nguồn và thư mục dữ liệu ở trên. Hub không đăng ký khởi động cùng Windows, không đổi ExecutionPolicy, không cài dịch vụ.

## 6. Tùy chọn

- **Terminal tương tác có ConPTY**: `CHATMCP-HUB\windows\Install-OptionalConPTY.ps1 -Install` (cài `node-pty@1.0.0`; cần mạng và binary tương thích hoặc MSVC Build Tools; hỏi xác nhận `YES` trước khi chạy). Không cài thì Hub dùng pipe và nói rõ lý do; agent không cần terminal tương tác để làm việc.
- **Ollama / LM Studio**: chọn preset tương ứng, không cần khóa. Model phải hỗ trợ tool calling và có ngữ cảnh đủ lớn (xem [TROUBLESHOOTING.md](TROUBLESHOOTING.md#ollama-hoặc-lm-studio-cắt-ngữ-cảnh-lặng-lẽ)).
- **Xem tính năng nào đang sẵn sàng trên máy**: Cài đặt → **Tính năng trên máy này** (nút *Kiểm tra*) cho biết Docker sandbox, ConPTY, chỉ mục AST, Language Server đang "Sẵn sàng" hay chưa. Hub chỉ ghi "Sẵn sàng" khi kiểm tra thật được; mục "Kiểm chứng Windows/Edge nhiều giờ" luôn ghi cần chạy soak test thực tế vì dự án chưa làm.

## 7. Kiểm tra cài đặt bằng bộ test (cho người phát triển)

```powershell
cd CHATMCP-HUB
npm test              # mọi bộ Node, vài phút; xem DEVELOPMENT.md
```

Symlink **file** cần bật Developer Mode (Settings → System → For developers) hoặc quyền quản trị để bộ test kiểm tra được; thiếu thì phần đó được ghi chú và bỏ qua (junction thư mục vẫn được kiểm).
