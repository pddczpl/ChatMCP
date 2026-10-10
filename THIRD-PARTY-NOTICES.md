# Thông báo về phần mềm bên thứ ba

ChatMCP không phân phối lại mã nguồn của các thành phần dưới đây trong repository (trừ khi ghi rõ). Mỗi thành phần giữ giấy phép và thông báo của riêng nó; hãy đọc tệp giấy phép gốc trước khi phân phối lại.

| Thành phần | Phiên bản | Giấy phép | Cách dùng trong ChatMCP |
|---|---|---|---|
| [Cloud Harness MCP](https://github.com/bestagentkits/cloud-harness-mcp) (AgentKit) | `v0.62.8` (`ad1fffc9993e83c10eb46ef7fe7db6957cb315a1`) | MIT — "Copyright (c) 2026 AgentKit" (SHA-256 của `LICENSE` được ghi trong `deps/cloud-harness.lock.json`) | Phụ thuộc bên ngoài, không fork, không nằm trong repo; tải/xác minh bằng `scripts/bootstrap-cloud-harness.*` |
| [Desktop Commander MCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) (`@wonderwhy-er/desktop-commander`) | `0.2.52` | theo gói upstream (kiểm tra trước khi phân phối lại) | Hub cài vào thư mục chạy sinh tự động; **có telemetry/kiểm tra feature-flag** theo upstream |
| [MCP SuperAssistant proxy](https://github.com/srbhptl39/MCP-SuperAssistant) (`@srbhptl39/mcp-superassistant-proxy`) | `0.1.8` | theo gói upstream | Hub cài vào thư mục chạy sinh tự động, nạp qua bộ điều hợp tương thích |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | phụ thuộc bắc cầu của Desktop Commander | theo gói upstream | Client MCP |
| React / ReactDOM (UMD, rút gọn) | `16.0.0` / `16.0.1` — nhúng ở `CHATMCP-HUB/web/vendor/` | MIT — "Copyright (c) 2013-present, Facebook, Inc." (ghi trong đầu tệp) | Giao diện dashboard, chạy offline |
| [node-pty](https://github.com/microsoft/node-pty) | `^1.0.0` (đã kiểm tra bản cài: `1.0.0`) | MIT | Phụ thuộc tùy chọn cho ConPTY; không còn được commit |
| [nan](https://github.com/nodejs/nan) | `2.29.0` (đã kiểm tra bản cài) | MIT | Phụ thuộc bắc cầu của node-pty; không còn được commit |
| MCP SuperAssistant (tiện ích trình duyệt) | không đi kèm | theo upstream | Chỉ cần cho quy trình thủ công cũ; ChatMCP không đóng gói |

Ghi chú:

- Các phiên bản trên là phiên bản cấp cao nhất được ghim hoặc đã quan sát; phụ thuộc bắc cầu của gói npm chạy lúc sử dụng chưa được ghim bằng lockfile. Hãy giữ các file lock sinh ra khi cài để tái tạo cây phụ thuộc.
- Giấy phép của Desktop Commander, proxy, SDK được ghi "theo gói upstream" vì chưa được đối chiếu với tệp giấy phép trong audit này; đừng suy ra giấy phép từ bảng này.
- Thông báo lịch sử của Hub 1.x nằm ở `CHATMCP-HUB/THIRD-PARTY-NOTICES.txt`.
