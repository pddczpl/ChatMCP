# Thông báo về phần mềm bên thứ ba

ChatMCP không phân phối lại mã nguồn của các thành phần dưới đây trong repository (trừ khi ghi rõ). Mỗi thành phần giữ giấy phép và thông báo của riêng nó; hãy đọc tệp giấy phép gốc trước khi phân phối lại.

**Giấy phép của chính ChatMCP:** repository này hiện **chưa có tệp `LICENSE`**. Cho tới khi chủ sở hữu chọn giấy phép, mọi quyền được bảo lưu cho tác giả; việc chọn giấy phép là quyết định của chủ sở hữu (xem `docs/PHASE1-REPORT.md`, mục quyết định đang chờ). Điều này không ảnh hưởng đến giấy phép của các thành phần bên thứ ba bên dưới.

## 1. Thành phần có trong hoặc được Hub nạp khi chạy

Backend mặc định (`local`) **chỉ cần Node.js** và phần React nhúng sẵn; các thành phần còn lại chỉ dùng khi bạn chủ động chọn backend `mcp` (cũ) hoặc cài thêm tùy chọn.

| Thành phần | Phiên bản | Giấy phép | Cách dùng trong ChatMCP |
|---|---|---|---|
| React / ReactDOM (UMD, rút gọn) | `16.0.0` / `16.0.1` — nhúng ở `CHATMCP-HUB/web/vendor/` | MIT — "Copyright (c) 2013-present, Facebook, Inc." (ghi trong đầu tệp) | Giao diện dashboard, chạy offline; **nằm trong repo** |
| [node-pty](https://github.com/microsoft/node-pty) | `^1.0.0` (đã kiểm tra bản cài: `1.0.0`) | MIT | Phụ thuộc **tùy chọn** cho ConPTY (`optionalDependencies`); không được commit; cài bằng `windows/Install-OptionalConPTY.ps1` |
| [nan](https://github.com/nodejs/nan) | `2.29.0` (đã kiểm tra bản cài) | MIT | Phụ thuộc bắc cầu của node-pty; không được commit |

## 2. Chỉ dùng cho backend `mcp` (cũ, tùy chọn)

| Thành phần | Phiên bản | Giấy phép | Cách dùng trong ChatMCP |
|---|---|---|---|
| [Cloud Harness MCP](https://github.com/bestagentkits/cloud-harness-mcp) (AgentKit) | `v0.62.8` (`ad1fffc9993e83c10eb46ef7fe7db6957cb315a1`) | MIT — "Copyright (c) 2026 AgentKit" (SHA-256 của `LICENSE` được ghi trong `deps/cloud-harness.lock.json`) | Phụ thuộc bên ngoài, **không fork, không đổi tên, không nằm trong repo**; tải/xác minh bằng `scripts/bootstrap-cloud-harness.*`. Không phải ranh giới cô lập (xem `SECURITY.md`) |
| [Desktop Commander MCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) (`@wonderwhy-er/desktop-commander`) | `0.2.52` | theo gói upstream (kiểm tra trước khi phân phối lại) | Hub cài vào thư mục chạy sinh tự động; **có telemetry/kiểm tra feature-flag** theo upstream |
| [MCP SuperAssistant proxy](https://github.com/srbhptl39/MCP-SuperAssistant) (`@srbhptl39/mcp-superassistant-proxy`) | `0.1.8` | theo gói upstream | Hub cài vào thư mục chạy sinh tự động, nạp qua bộ điều hợp tương thích |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | phụ thuộc bắc cầu của Desktop Commander | theo gói upstream | Client MCP |
| MCP SuperAssistant (tiện ích trình duyệt) | không đi kèm | theo upstream | Chỉ cần cho quy trình thủ công cũ; ChatMCP không đóng gói |

## 3. Chỉ dùng khi phát triển và kiểm thử (không phân phối cùng ChatMCP)

Các công cụ này **không** nằm trong repository và **không** cần để chạy Hub. Người phát triển cài chúng riêng khi muốn chạy các bộ test tương ứng (xem `docs/DEVELOPMENT.md`).

| Thành phần | Dùng cho | Giấy phép |
|---|---|---|
| Python 3.11+ | chỉ mục ký hiệu (tùy chọn) và bộ E2E FastAPI | theo bản phân phối Python của bạn |
| `fastapi`, `uvicorn`, `httpx`, `pytest` (cài bằng `pip`) | bộ `verify-e2e-fastapi` — ứng dụng FastAPI thật mà agent làm việc trên đó | theo gói upstream (chưa đối chiếu trong audit này) |
| `playwright` (Python) + Chromium | các bộ giao diện `tests/verify-*-ui.py` và `verify-ui-e2e.py` | theo gói upstream (chưa đối chiếu trong audit này) |
| GitHub Actions: `actions/checkout`, `actions/setup-node`, `actions/upload-artifact` (ghim theo SHA; bản workflow đề xuất thêm `actions/setup-python`) | `.github/workflows/ci.yml` — chỉ chạy trên GitHub | theo repository upstream |

## Ghi chú

- Các phiên bản trên là phiên bản cấp cao nhất được ghim hoặc đã quan sát; phụ thuộc bắc cầu của gói npm chạy lúc sử dụng chưa được ghim bằng lockfile. Hãy giữ các file lock sinh ra khi cài để tái tạo cây phụ thuộc.
- Giấy phép ghi "theo gói upstream" nghĩa là chưa được đối chiếu với tệp giấy phép trong audit này; đừng suy ra giấy phép từ bảng này.
- Thông báo lịch sử của Hub 1.x nằm ở `CHATMCP-HUB/THIRD-PARTY-NOTICES.txt`.
- Tên thương hiệu (Anthropic, OpenAI, Google, Ollama, LM Studio, GitHub…) thuộc về chủ sở hữu tương ứng. ChatMCP không liên kết với họ; các preset chỉ là cấu hình địa chỉ API công khai.
