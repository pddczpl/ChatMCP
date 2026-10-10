# ChatMCP Studio 1.3.0 — Phiên làm việc lâu dài

## Cách sử dụng

1. Chạy `START-CHATMCP-HUB.cmd`; mở `http://127.0.0.1:3007` trên Windows. Đảm bảo MCP chạy và ChatGPT Companion **1.4.0** được Reload nếu chọn chế độ Web.
2. Chọn workspace, chế độ `ChatGPT Web` hoặc `API Gateway`, nhập yêu cầu đầu tiên. Hub cấp một ID phiên hội thoại. Mọi phản hồi, công cụ, tiến độ và lỗi được lưu vào thư mục riêng của phiên, kèm số lượt chạy.
3. Khi hoàn tất một phần, bị lỗi hoặc bấm **Dừng tác vụ**, đừng nhấn `+ Cuộc chat mới`. Trong thanh **AGENT SESSIONS** bên trái, chọn hội thoại đã làm trước đó, nhập: `Tiếp tục hoàn thành bài lab từ phần đang dở, kiểm tra những file đã sửa và chạy test còn thiếu.` Sau đó bấm **Tiếp tục trong chat này**.
4. Sau khi khởi động lại Hub vì mất mạng hay restart Windows, vào lại thanh lịch sử. Phiên chưa hoàn tất được đánh dấu **Chờ tiếp tục**. Chọn phiên đó rồi gửi yêu cầu tiếp nối, thay vì làm lại từ đầu.
5. Nếu thực sự muốn tạo phiên khác, bấm `+ Cuộc chat mới`. Nút **Xóa phiên** yêu cầu xác nhận và **chỉ xóa lịch sử lưu trên Hub**, không xóa file workspace hay cuộc chat trên chatgpt.com.

## Web mode và API mode khác nhau thế nào?

- **ChatGPT Web**: Tiếp tục với **cùng mã phiên Hub và URL `/c/...` chính thức** đã được ghi nhận. Khi tab cũ đã đóng, Companion mở lại đúng URL đó; nếu không xác minh được chat gốc, nó chặn an toàn và **không tạo cuộc chat mới**. Không thể tự khôi phục cuộc chat đã bị xóa hoặc bị ChatGPT từ chối truy cập.
- **API Gateway**: Giữ cùng mã phiên Hub, lịch sử người dùng/agent và checkpoint công cụ. Mỗi lần tiếp tục dựng lại **ngữ cảnh lịch sử công khai** từ transcript, kết quả đã xác minh và các prompt cũ; không phụ thuộc vào phiên chat trên website nhà cung cấp. Đây **không phải** server-side conversation ID của Gemini/OpenAI và không lưu/hiển thị suy luận nội bộ ẩn.
- Nếu bạn chuyển sang chế độ khác, phải chuyển lại đúng chế độ đã tạo phiên trước khi nhấn Tiếp tục. Không tự dùng mode khác rồi coi đó là cùng cuộc chat.

## Checkpoints và dữ liệu được lưu

Tất cả nhật ký nằm trong cấu hình Cloud Harness hiện có:

`<repo cloud-harness-mcp>\deploy\.generated\chatmcp-hub\`

- `browser\tasks\<session-uuid>\task.json`, `transcript.jsonl`, `report.txt`: dữ liệu Web.
- `api-tasks\<session-uuid>\task.json`, `transcript.jsonl`, `report.txt`: dữ liệu API.
- `agent-mode.json`: chế độ đang dùng; `gateway` chứa cấu hình nhà cung cấp/API đã được bảo vệ theo lựa chọn người dùng.

**Không xóa thư mục `.generated` khi nâng cấp Hub.** Checkpoint ghi sau khi trạng thái/sự kiện đã được Hub xác nhận. Bản ghi transcript có thể chứa prompt, đường dẫn và kết quả công cụ mang thông tin riêng tư: sao lưu cẩn thận và không chia sẻ công khai. File trong workspace của bạn vẫn do chính MCP ghi trực tiếp, không phải bản snapshot sao lưu tự động của toàn bộ project; dùng Git để lưu phiên bản nếu muốn undo/diff.

## Lúc mạng mất hoặc Hub bị tắt bất ngờ

- Khi **chỉ mất mạng ngắn** và Hub+Companion còn chạy, cơ chế chờ mạng vẫn tiếp tục hoạt động như v1.2.0, không tạo nhiệm vụ mới.
- Khi **Hub/Windows bị khởi động lại**, phiên đang chạy được đánh dấu `paused`, giữ lại sự kiện và metadata của lượt đã gửi/công cụ chưa xác minh. Trên dashboard chọn phiên cũ và nhập prompt tiếp tục. Không có bảo đảm tự phát lại một thao tác ghi/xóa trên MCP, vì lệnh có thể đã thực thi trước lúc ngắt.
- **Companion sau restart** giữ journal của lượt cuối. Một lượt Tiếp tục **được người dùng chủ động tạo** có `resumeStart=true` cho gói đầu; Companion hủy *quyền sở hữu lượt cũ* chứ không bấm lại nút Gửi cũ, rồi tiếp tục trong đúng chat URL. Từng gói mới tiếp theo tuân thủ kiểm tra lượt trước như bình thường.
- Nếu chat gốc không còn truy cập được, workspace đã đổi hoặc không thể xác minh trạng thái gửi, hệ thống sẽ yêu cầu người dùng can thiệp thay vì im lặng tạo chat mới.

## Phân biệt số lượt

- **Phản hồi AI**: số phản hồi hợp lệ đã nhận và xử lý (bao gồm bước catalog, describe, tool, final); **không** phải số file đã sửa.
- **Gói hội thoại #N**: số thứ tự gói gửi/nhận giữa Hub và ChatGPT. Ví dụ `#73` chỉ là thứ tự giao thức, không phải 73 lần gọi MCP hay 73 công việc khác nhau.
- **Lần gọi công cụ**: số MCP call được ghi nhận; đây mới là chỉ số công cụ. Các thay đổi file thực tế phải được kiểm chứng qua `git diff`, file trên đĩa và kết quả test.

## Giới hạn và quyền riêng tư

- Bản này không hứa khôi phục 100% mọi thao tác chưa được xác nhận sau mất điện; cố tình **không replay** các thao tác có thể ghi/xóa file nếu chưa rõ kết quả.
- ChatGPT Web phụ thuộc vào DOM, đăng nhập, tình trạng chat và giới hạn sử dụng của ChatGPT, có thể thay đổi. Không có cách an toàn để tự động khôi phục cuộc chat đã bị xóa từ ChatGPT.
- Không lưu chuỗi suy luận nội bộ ẩn. Dashboard hiển thị kế hoạch, lời giải thích tiến độ do model công khai, lệnh MCP và báo cáo.
- Giao diện lấy cảm hứng IDE-style của coding agent; không sao chép nhãn hiệu hoặc tài sản riêng của phần mềm khác.

## Kiểm thử cục bộ

Từ thư mục Hub, dùng Node.js:

```powershell
Get-ChildItem .\tests\verify-*.mjs | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { throw "Test failed: $($_.Name)" } }
```

Các bài kiểm thử dùng mock DOM và MCP, **không** tự chạy sửa file trong workspace bài lab của bạn. Các bước Web/Windows/API Gateway thật cần được kiểm chứng trên máy người dùng.
