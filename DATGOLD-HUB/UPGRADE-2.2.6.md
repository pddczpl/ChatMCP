# Upgrade ChatMCP Studio to 2.2.6 (Windows)

1. In the ChatMCP dashboard, stop/pause active tasks before shutting down. Do not overwrite running Node processes. Stop Hub:

   ```powershell
   & 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd'
   ```

   Verify that `http://127.0.0.1:3007/api/health` is no longer available. If it is, inspect the process holding port 3007 before replacing code.

2. Backup history and configuration before extracting:

   ```powershell
   $src = 'F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp\deploy\.generated\chatmcp-hub'
   $dst = 'F:\Personal_Project\Vin\ChatMCP\chatmcp-state-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
   if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force }
   ```

3. Extract `CHATMCP-STUDIO-2.2.6.zip` into **`F:\Personal_Project\Vin\ChatMCP`**, replacing files in the existing `CHATMCP-HUB` directory. In particular, verify `F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\hub.mjs`. **Never extract into** `cloud-harness-mcp`. Leave the `.generated` history directory and the user's project untouched.

4. Start Hub:

   ```powershell
   & 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd'
   Invoke-RestMethod 'http://127.0.0.1:3007/api/health' | Select-Object app, version, uiBuild
   ```

   Required: `version=2.2.6`, `uiBuild=2.2.6-react-offline`. Refresh dashboard with **Ctrl+F5**. Companion remains **1.4.1**; no extension-code changes in this patch.

5. Select the same previously failed conversation from the sidebar; do not create a new one. A safe continuation prompt is:

   > Tiếp tục đúng phiên này. Đọc lại kết quả công cụ đã thực hiện và kiểm tra các file đang có trước khi quyết định bước tiếp theo. Không gọi lại lệnh đã thành công chỉ vì lỗi định dạng phản hồi. Nếu công việc chưa hoàn thành, tiếp tục các bước còn thiếu; sau đó chạy kiểm thử và báo cáo kết quả thực tế.

6. If schema recovery still fails, share the new `errorCode`, `formatIssue`, sanitized `trường:` keys, and approximate stage/turn, never the gateway credential or entire raw response. You can also inspect the gateway container log for why its model refuses the strict JSON action schema.

Note: two model-only recovery attempts can incur API charges. No previous MCP mutation is automatically re-executed by the retry loop; the model may still select a new tool call as a distinct next action if its context warrants it, subject to permissions.
