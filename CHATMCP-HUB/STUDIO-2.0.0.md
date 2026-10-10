# ChatMCP Studio 2.0.0 — Hướng dẫn Coding Agent

**Phiên bản Hub 2.0.0 · Companion 1.4.0** (Companion không đổi so với Hub 1.3.0). Hai chế độ: ChatGPT Web qua tiện ích ghép với tài khoản ChatGPT web và API Gateway (Gemini generateContent hoặc OpenAI-compatible Chat Completions). Dashboard tại `http://127.0.0.1:3007`.

## Bắt đầu và không làm mất hội thoại

1. Chọn đúng thư mục dự án Windows trong phần Workspace, khởi động MCP. Đường dẫn này áp dụng cho Studio Explorer và các công cụ quản lý mã nguồn có kiểm tra đường dẫn, **không phải OS sandbox cho mọi MCP/terminal**.
2. Chọn ChatGPT Web hoặc API Gateway và kiểm tra kết nối. Nếu dùng Web cần bật/Reload Companion **1.4.0** trong `edge://extensions` và ghép trình duyệt khi cần.
3. Nhập nhiệm vụ. Trong từng hội thoại, các prompt, lượt xử lý, dữ liệu công cụ được Hub ghi xuống thư mục runtime `.generated/chatmcp-hub`. Nếu muốn tiếp tục hãy chọn phiên cũ ở thanh bên trái và nhập prompt mới; **không bấm + cuộc chat mới**.
4. Chuyển sang mục **Plan & Verify**, tạo checklist. Bật tùy chọn **Tự tiếp tục sau khi Hub khởi động lại** nếu muốn. Bật theo từng hội thoại, mặc định tắt. Khi Hub khởi động lại, chỉ những phiên bị gián đoạn có **không có kết quả công cụ/gửi ChatGPT chưa xác minh** và có đúng workspace, chế độ AI, kết nối sẵn sàng mới được tự nối tiếp; hệ thống vô hiệu hóa cờ auto trước lúc tiếp tục, để một crash thứ hai không gây gửi lặp.
5. Nếu một thao tác ghi file hoặc một lượt gửi chưa chắc chắn đã hoàn tất, hệ thống giữ lại phiên cho bạn **tiếp tục thủ công trong cùng ID** sau khi đối chiếu trạng thái thật. Nó không tự tái thực thi một thao tác có thể gây tác dụng phụ.

## Studio IDE

- **Explorer**: duyệt thư mục tương đối workspace, mở mã nguồn text giới hạn dung lượng, sửa trực tiếp rồi bấm **Lưu + checkpoint**. Có kiểm tra SHA-256 để từ chối ghi đè khi file đã được tác nhân khác chỉnh sửa.
- **Search**: tìm theo tên file, text hoặc symbol bằng chỉ mục cache mtime/size ở workspace. Không phải language server đầy đủ, không semantic embeddings, có giới hạn quét 5.000 file/16.000 dòng mỗi file. `.env`, khoá, thư mục Git nội bộ và nhiều thư mục build bị bỏ qua.
- **Git & Review**: `git status`, `git diff`, `git diff --check`; tạo checkpoint văn bản có giới hạn, xem diff với checkpoint, đánh dấu Accept sau khi review hoặc Restore **từng file** khi SHA hiện tại còn khớp. Accept **không phải git add/commit**. Restore ghi lại bản trước thao tác vào thư mục undo; không hoàn tác thay đổi của file khác. File mới hoặc file ngoài checkpoint sẽ không bị xóa. Các snapshot chỉ là **partial**, không phải backup toàn bộ repo, file nhị phân, `.git`, `.env`, hay cả đĩa.
- **Terminal**: chạy PowerShell trên Windows/`sh` ở hệ điều hành khác sau hộp thoại xác nhận; xem luồng stdout/stderr (dashboard thăm dò), dừng tiến trình. Terminal chạy với quyền hệ điều hành của tài khoản, **KHÔNG cách ly bằng sandbox**. Không dán lệnh không tin cậy/secret vào ô terminal.
- **Plan & Verify**: plan được lưu theo hội thoại, gợi ý lệnh kiểm thử từ cấu hình dự án, timeline checkpoint/tool calls. Lệnh kiểm thử gợi ý **không tự chạy**: yêu cầu agent thực thi công cụ được duyệt hoặc tự bấm Terminal.
- **Skills**: hiển thị `AGENTS.md`, `SKILL.md`, `CLAUDE.md` và chỉ dẫn dự án dưới dạng dữ liệu không tin cậy.
- **Subagents**: tối đa 3 nghiên cứu chỉ đọc qua API Gateway, chạy song song, đưa ra tóm tắt và tham chiếu tìm kiếm code. Chúng không tự sửa file, không chạy shell, không phải worker coding song song đa repo.
- **Preview**: hiện mã/đánh dấu của file text như HTML/Markdown/CSS/JSON dưới dạng text an toàn. Không chạy script user và chưa có live web preview/port forwarding tương đương IDE hoàn chỉnh.

## Quyền thực thi

Trong menu **Chế độ quyền MCP**:

- **Review** (mặc định): đọc có thể tự động; lệnh shell, ghi/xóa file và công cụ không rõ đợi **Cho phép lần này** hoặc **Từ chối**.
- **Manual**: yêu cầu duyệt cho các thao tác có tác dụng phụ tương tự Review, chỉ dùng chế độ này khi muốn giám sát kỹ.
- **Autonomous workspace edits**: cho phép một số công cụ ghi file được phân loại trong workspace; lệnh shell, tool không biết tác dụng, thao tác nguy hiểm vẫn phải duyệt. Công cụ MCP và Terminal vẫn dùng quyền OS, đường dẫn trong đoạn lệnh shell có thể vượt workspace. Đây là kiểm soát ứng dụng, **không phải cách ly hệ điều hành**.

Không có hệ thống phê duyệt nào thay thế được quyền file của Windows, tài khoản hệ điều hành riêng hoặc VM/container cách ly nếu chạy mã không tin cậy. Không tự nâng quyền admin, không bỏ xác nhận, không tự `git push`.

## Lưu và khôi phục

- Journal từng task và bản ghi MCP được lưu vào thư mục `cloud-harness-mcp/deploy/.generated/chatmcp-hub` của Cloud Harness repo; **sao lưu thư mục này trước khi nâng cấp**. Workspace code bản thân vẫn ở đường dẫn Windows bạn chọn.
- Sau mất mạng ngắn khi Hub còn chạy: Companion chờ, đối chiếu đúng mã tác vụ/số lượt/nonce và không gửi trùng; API Gateway retry có giới hạn cho model call. Không replay lệnh MCP đã bắt đầu mà mất phản hồi.
- Sau Hub crash/restart: phiên chạy dở hiện `paused`; tự tiếp tục là **opt-in an toàn** và chỉ trong các trường hợp đủ bằng chứng. Nếu lỗi/hủy chủ động hoặc thao tác chưa xác minh, chọn cùng phiên cũ rồi nhập “Tiếp tục từ phần dang dở; trước hết kiểm tra file/test hiện tại; không lặp thao tác chưa chắc chắn”. Web giữ đúng ChatGPT URL chính thức cũ; nếu đã xóa chat hoặc URL không có, Hub sẽ báo chặn.
- Dashboard hiển thị nhật ký tiến độ/nhận định công khai, **không hiển thị chain-of-thought nội bộ của model**.

## Kiểm thử / hạn chế đã biết

Kiểm thử Linux/mock Node.js bao gồm: quyền/phân loại công cụ, path & symlink, code search, checkpoint SHA, Git review/restore, terminal test, test bảo vệ state HTTP CSRF, API Gateway hai lượt gọi MCP mô phỏng, Companion DOM mô phỏng, khôi phục hội thoại trên đĩa, mạng mất/mất xác nhận, opt-in restart resumer. Giao diện kiểm tra với headless Chromium mock API. **Chưa kiểm thử end-to-end trên Windows/Edge hoặc gateway riêng của bạn.** Không tuyên bố ngang bằng đầy đủ Codex Desktop, Antigravity hay Claude Code. Xem `TEST-RESULTS-2.0.0.txt`.

## Lệnh chạy / dừng

```powershell
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd'
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd'
```
