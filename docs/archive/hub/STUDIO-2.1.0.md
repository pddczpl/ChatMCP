# ChatMCP Studio 2.1.0 — React IDE & Agent Reliability

**Hub:** 2.1.0. **React frontend build:** `2.1.0-react-offline`. **Browser Companion:** 1.4.0 (không đổi). Dashboard `http://127.0.0.1:3007`.

## Thay đổi đã triển khai

1. **Dashboard dùng React thật** (`web/react-app.js`, ReactDOM; React và CSS đóng gói cục bộ, không cần CDN). Bố cục tối 3 cột: phiên làm việc và tìm kiếm bên trái, lịch sử AI/agent và composer ở giữa, công cụ bên phải. Các tab Files, Git, Terminal, Plan, Skills, Settings đều gọi endpoint Hub thực. Giao diện cũ vẫn ở `/legacy` làm dự phòng.
2. **Sửa lỗi “Không tìm thấy thao tác”** khi đổi chế độ và xóa phiên: client gọi đúng `/api/agent/mode` và `/api/tasks/delete`; backend trả lỗi 404 có tên endpoint/version, chống sai build qua header `X-ChatMCP-UI-Build`. Nếu bản cũ chiếm cổng 3007, lệnh START từ chối mở nhầm Hub cũ và hướng dẫn STOP/START. GET `/api/health` và `/api/capabilities` trả số phiên bản/chức năng thật.
3. **Hội thoại nhiều yêu cầu không mất lịch sử:** dữ liệu từ 2.0.0 được giữ nguyên trong thư mục state cũ. Chọn một hội thoại cũ rồi nhập prompt để tiếp tục trong cùng ID. Ở Web mode, phải sử dụng đúng URL chat đã lưu; nếu mất bằng chứng yêu cầu cũ, agent không tự gửi trùng.
4. **Explorer và editor an toàn:** đọc các file bên trong workspace, tìm text/symbol, sửa thủ công với SHA-256 trước khi ghi; tạo checkpoint giới hạn dung lượng, từ chối ghi khi có thay đổi bên ngoài.
5. **Git review:** status, diff, diff --check, checkpoint, so sánh và accept/restore từng file khi SHA của file hiện tại vẫn khớp. Checkpoint **KHÔNG** phải bản sao lưu đầy đủ và không thay thế git commit.
6. **Project Verification (mới):** `lib/studio-verification.mjs` nhận lệnh được phát hiện qua `studio.checks()`, yêu cầu người dùng xác nhận, ghi ý định chạy kiểm thử xuống ổ đĩa *trước khi* khởi chạy terminal; ghi exit code, trạng thái và trích đoạn output đã giới hạn/ẩn thông tin bí mật. GET `/api/studio/verifications`, POST `/api/studio/verify/run`. Sau crash, tác vụ không thể kiểm chứng được ghi là `interrupted` và **không tự chạy lại**.
7. **Command Palette:** Ctrl+K, tìm lệnh/điều hướng, Enter chạy lệnh, Esc đóng. Mọi chức năng là nút UI thực, không phải placeholder. Việc gửi prompt vẫn sử dụng Enter; Shift+Enter xuống dòng.
8. **Permissions:** review/manual/autonomous có kiểm tra tác dụng phụ, bảo vệ CSRF/Origin cho các POST; terminal thủ công luôn phải xác nhận trước khi thực thi. MCP/PowerShell vẫn chạy với quyền Windows người dùng, chưa có sandbox OS.

## Phân biệt chế độ Web và API

- **ChatGPT Web:** mở và tiếp tục đúng chat thông qua Companion 1.4.0. Không cần key. DOM của chatgpt.com có thể thay đổi, việc tiếp tục vẫn phụ thuộc vào có thể xác minh đúng tin nhắn/URL và trạng thái Chrome/Edge.
- **API:** Gemini generateContent và OpenAI-compatible gateway. Model gọi công cụ qua Hub, có thể lưu khóa bằng Windows DPAPI (tuỳ chọn). Không có bằng chứng hỗ trợ giao thức của một gateway bên thứ ba cụ thể trước khi kiểm tra trên máy người dùng.

## Trạng thái thực tế so với Codex / Antigravity / Claude Code

Tính năng tương tự ở mức nhiệm vụ/code: API/Web agent, checkpoint, Git diff/review, code search, terminal, permission review, lịch sử phiên, công cụ MCP, task timeline, plan, test verification. **Chưa tương đương** các sản phẩm IDE/agent thương mại: chưa có native OS sandbox, chưa có LSP/semantic index và cross-file refactor chuyên sâu, terminal không phải pseudo-terminal tương tác, preview ứng dụng chưa tích hợp điều khiển/cổng forward, chưa có multi-agent write orchestration, chưa có telemetry/reliability SLO cấp production, chưa kiểm thử đầy đủ trên Windows/Edge và gateway thật. API mode phù hợp xử lý nhiều lượt dài hơn Web mode do có tool-call protocol trực tiếp.

**React offline dùng phiên bản 16.0.0 / ReactDOM 16.0.1 có sẵn trong môi trường đóng gói** và có giấy phép MIT. Đây là phiên bản cũ, nên ưu tiên nâng frontend sang React LTS hiện hành và bundler có lockfile khi xây dựng bản phát hành production có internet; không dùng CDN để tránh hỏng khi mất mạng.

## Kiểm thử

Từ thư mục Hub:

```powershell
node tests/verify-agent-http.mjs
node tests/verify-studio-http.mjs
node tests/verify-studio-verifications.mjs
node tests/verify-persistent-sessions.mjs
```

Các bài test Node còn lại chạy theo `tests/verify-*.mjs`. `python tests/verify-react-ui.py` cần Playwright và Chromium; file này sử dụng mock fetch do Chromium trong môi trường dựng **chặn HTTP ngay cả localhost**. Các endpoint HTTP được kiểm thử bằng Node thực, không phải Chrome-HTTP tích hợp thật.

Xem `TEST-RESULTS-2.1.0.txt`, `UPGRADE-2.1.0.md`.
