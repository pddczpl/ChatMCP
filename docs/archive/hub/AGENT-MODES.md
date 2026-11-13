> **LƯU TRỮ LỊCH SỬ:** Mô tả Hub 1.x bên dưới thuộc luồng Cloud Harness/MCP đã được gỡ. Chế độ local-only mới chỉ dùng local tools, Git worktrees và Skills Hub. Xem README.md ở repository gốc để biết hướng dẫn hiện hành.

# ChatMCP Studio 1.3.0 — Ghi chú phiên lâu dài

Cả hai chế độ cùng dùng danh sách **phiên hội thoại** ở thanh bên trái. Chọn phiên cũ, nhập prompt rồi dùng `Tiếp tục trong chat này` để nối đúng ID lịch sử. Web mode mở lại URL chat cũ; API mode tái tạo ngữ cảnh từ checkpoints và báo cáo đã lưu (không phải native conversation ID của bên cung cấp model). Sau sự cố mất mạng/Hub restart, trạng thái được đánh dấu `paused` thay vì xóa. Không tự thực thi lại các thao tác MCP có kết quả chưa rõ. Đọc [SESSION-RECOVERY.md](SESSION-RECOVERY.md) để biết chi tiết an toàn, sao lưu và giới hạn.

---

# ChatMCP Agent — hai chế độ (Hub 1.2.0)

## Mục tiêu

Từ dashboard `http://127.0.0.1:3007`, chọn **ChatGPT Web** hoặc **API Gateway** rồi giao tác vụ tới các công cụ MCP thực tế đang kết nối vào workspace Windows. Hub hiển thị tiến độ theo từng lượt, tên và tham số công cụ (bản xem trước), kết quả/lỗi MCP, số lượt và báo cáo cuối; cập nhật khoảng 2 giây. Trường **progress** (Web) hoặc lời ghi chú ngắn do model cung cấp (API) là **tóm tắt hành động cho người dùng**, KHÔNG phải chuỗi suy luận nội bộ của mô hình.

| | ChatGPT Web | API Gateway |
| --- | --- | --- |
| Nguồn model | ChatGPT web đang đăng nhập | Gateway do người dùng cấu hình |
| API key | Không cần | Cần key riêng |
| Companion | Cần, phiên bản 1.3.7 | Không cần |
| Điểm thực thi công cụ | Hub + Desktop Commander/Cloud Harness MCP | Cùng Hub + MCP |
| Giám sát | Lượt chat/đang chờ xác minh, MCP, kết quả | Ghi chú model, lượt API, MCP, kết quả, token API nếu endpoint trả |
| Chi phí | Hạn mức gói ChatGPT web | Phí/hạn mức của gateway, tách biệt khỏi ChatGPT web |

## Cài bản cập nhật trên Windows

1. Chạy `STOP-CHATMCP-HUB.cmd`, chờ dừng.
2. Giải nén ZIP vào thư mục cha `F:\Personal_Project\Vin\ChatMCP`, chọn **ghi đè file** trong `CHATMCP-HUB`; không xóa các thư mục `.generated`, workspace, hoặc nguồn dự án.
3. Trong `edge://extensions` hoặc `chrome://extensions`, **Reload ChatMCP Hub Companion 1.3.7**. Tắt bản Companion trùng lặp nếu có.
4. Chạy `START-CHATMCP-HUB.cmd`, mở `http://127.0.0.1:3007`.
5. Chọn workspace và chờ dịch vụ MCP sẵn sàng.

## Chế độ 1 — ChatGPT Web

Chọn `ChatGPT Web · Browser Companion`. Ghép Companion bằng mã 8 chữ số một lần nếu chưa ghép. Đăng nhập ChatGPT trên Edge/Chrome, chọn model như bình thường. Nhập yêu cầu trên dashboard, giữ tab riêng của tác vụ và trình duyệt mở. Đây là luồng trước đây với cơ chế chờ mạng và tự đối chiếu lượt khi có thể; không lấy reasoning nội bộ từ ChatGPT.

## Chế độ 2 — API Gateway

Chọn `API Gateway · Trực tiếp`. Mở `Thiết lập API Gateway`, nhập:

- **Giao thức** `Google Gemini generateContent` hoặc `OpenAI-compatible Chat Completions`.
- **API Base URL** của gateway. Ví dụ minh họa cho Gemini chính thức: `https://generativelanguage.googleapis.com`. Gateway riêng: `https://your-gateway.example`.
- **Model** mà *gateway* thực sự cung cấp, ví dụ `gemini-3.8-flash` nếu có quyền dùng model đó.
- **API Key** của bạn (ô password). KHÔNG ghi key vào URL, prompt, mã nguồn, README, lệnh terminal, log hoặc tin nhắn.
- Tùy chọn **Windows DPAPI**: nếu bật, key lưu ở `cloud-harness-mcp\deploy\.generated\chatmcp-hub\gateway\gateway-key.dpapi`, mã hóa ràng buộc tài khoản Windows hiện tại. Nếu không bật, key chỉ nằm trong bộ nhớ tiến trình; thoát Hub phải nhập lại (hoặc cấu hình lại qua env).

Nhấn **Lưu kết nối API**, sau đó (nếu muốn) **Test API (có thể tính phí)**. Chỉ khi chọn chế độ API thì Hub mới gọi gateway bằng key. Đổi chế độ/kết nối bị khóa trong lúc tác vụ đang chạy. **Xóa API key** xóa bản đã lưu và key trong phiên, không thể xóa biến môi trường Windows do người dùng tự đặt.

Mặc định, Gemini gọi `BASE/v1beta/models/MODEL:generateContent` với `x-goog-api-key`; OpenAI-compatible gọi `BASE/v1/chat/completions` với `Authorization: Bearer`. Nếu gateway riêng có đường dẫn/header khác, mở **Gateway tùy chỉnh** và điền **Endpoint path** như `/v1beta/models/{model}:generateContent` và chọn kiểu header. Đường dẫn này là absolute path tính từ root hostname, không phải URL bên ngoài. Hub không tự dò đoán chuẩn của gateway.

Nếu sử dụng biến môi trường, Hub có thể đọc `GOOGLE_API_BASE_URL`, `GOOGLE_API_KEY`, `GEMINI_MODEL`. Không để key trong lệnh PowerShell hiển thị ở lịch sử. Key đã chia sẻ công khai cần được **thu hồi/rotate** trước khi sử dụng.

API mode cần một gateway hỗ trợ **tool/function calling**, không chỉ trả lời văn bản. Model dùng bốn công cụ router (`mcp_catalog`, `mcp_describe`, `mcp_call`, `mcp_capabilities`) để gọi đầy đủ công cụ MCP từ danh mục hiện có. Gemini 3.x: adapter giữ nguyên `thoughtSignature` trong lịch sử đang chạy để xử lý các lượt tool. Các phần suy luận bí mật không được trình bày trong dashboard hay bản báo cáo. Hiện API adapter chủ yếu hỗ trợ văn bản và tool calling; không hứa xử lý hình/âm thanh từ mọi MCP tool.

**Cảnh báo dữ liệu:** API mode gửi yêu cầu, một phần nội dung file/kết quả công cụ trong task cho **gateway do bạn chọn** để model xử lý. Chỉ dùng gateway mà bạn tin cậy. Các thao tác local và Cloud Harness chạy dưới quyền kết nối MCP; thư mục chọn trong UI **không phải sandbox hệ điều hành**. Công cụ có khả năng sửa/xóa file thật, kiểm tra lệnh trước các bước nhạy cảm.

## Theo dõi tác vụ

- **Đang làm gì**: trạng thái công việc mới nhất, model/công cụ đang xử lý.
- **Luồng Agent**: danh sách sự kiện theo thời gian (mục tiêu/ghi chú công khai → gọi MCP → kết quả/ lỗi → tiếp tục → báo cáo).
- **Lượt model, số MCP, usage**: giữ đầy đủ bản ghi trong thư mục task của Hub. Dashboard hiển thị thống kê và các sự kiện gần nhất.
- **Báo cáo**: file tải xuống chứa kết quả thực được ghi lại. Trạng thái `completed` nghĩa là model đã gửi câu trả lời kết thúc; KHÔNG bảo đảm code đúng nếu chưa có kết quả chạy test.

Chế độ API có ngân sách mặc định **300 lượt / 120 phút** trong dashboard, điều chỉnh từ 1–1000 lượt và 1–240 phút. Đây là giới hạn an toàn nhằm tránh API tính phí không giới hạn hoặc vòng lặp vô hạn, không phải hạn mức tài khoản.

**Mạng LAN chập chờn:** Web mode tiếp tục dùng cơ chế xác minh/khôi phục an toàn cũ. API mode chờ mạng rồi thử lại **yêu cầu model** nếu mất kết nối transport; yêu cầu cũ có thể vẫn bị tính phí. Hub không tự thực hiện lại MCP mutation đã gửi mà chưa có kết quả chắc chắn. Cần giữ tiến trình Hub chạy; sau khi đóng/restart giữa nhiệm vụ, phần công việc đang dở không được tự replay.

## Giới hạn của bản này

Đây là bản **agent task/workflow dashboard**, chưa phải bản sao đầy đủ của Codex Desktop, Antigravity hoặc Claude Desktop: chưa có thread chat follow-up tự động nhiều lần vào cùng phiên, bảng diff editor hay bộ phân quyền/approval nâng cao trong UI. Không thể truy xuất `chain-of-thought` nội bộ của ChatGPT Web hoặc các model API; chỉ hiển thị các bản tóm tắt tiến độ được phép hiển thị và thao tác có bằng chứng.

## Lệnh kiểm thử phát triển

Từ thư mục gốc của Hub, cần Node 22+:

```
node tests/verify-dual-mode.mjs
node tests/verify-agent-http.mjs
node tests/verify-network-recovery.mjs
node tests/verify-send-cycle.mjs
```

Các test mới dùng gateway và MCP giả lập; **không dùng API key thật, không tốn API và không sửa workspace Windows**. Cần chạy test tích hợp Windows/Edge/gateway thật riêng trên máy của người dùng trước khi tuyên bố tương thích với một custom gateway.
