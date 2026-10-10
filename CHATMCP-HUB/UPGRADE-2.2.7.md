# Upgrade ChatMCP Studio 2.2.6 → 2.2.7 (Windows)

This release changes **Hub code only**; Companion remains **1.4.1**.

1. In the Studio dashboard, stop or pause any active task. Run the installed `STOP-CHATMCP-HUB.cmd` and ensure `http://127.0.0.1:3007/api/health` is no longer available before replacing files. If it still responds, investigate the exact process using port 3007; do not kill unrelated programs by port guesswork.
2. Preserve conversations/configuration by backing up the generated state directory:

   ```powershell
   $src = 'F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp\deploy\.generated\chatmcp-hub'
   $dst = 'F:\Personal_Project\Vin\ChatMCP\chatmcp-state-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
   if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force }
   ```

3. Extract `CHATMCP-STUDIO-2.2.7.zip` **into `F:\Personal_Project\Vin\ChatMCP`**, replacing the existing `CHATMCP-HUB` program files. Do not extract into `cloud-harness-mcp`; do not delete `deploy\.generated`, histories, credentials or the DeepWeeds/Sensor Fusion workspaces.
4. Start Hub and verify the exact version:

   ```powershell
   & 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd'
   Invoke-RestMethod 'http://127.0.0.1:3007/api/health' | Select-Object app, version, uiBuild
   ```

   Expected: `version: 2.2.7`, `uiBuild: 2.2.7-react-offline`. Refresh the React dashboard with `Ctrl+F5`. If the health endpoint still reports an old version, stop the old daemon before proceeding.
5. Open **the previous conversation** in the sidebar, not a new one. Example continuation:

   > Tiếp tục phiên DeepWeeds này. Đầu tiên xác minh các công cụ đã thành công và các file đang có. Đọc phần còn thiếu bằng các lệnh đọc theo đoạn, không gửi lại toàn bộ README/GUIDE/RUBRIC trong một lần. Không lặp thao tác ghi hoặc chạy train nếu chưa kiểm tra kết quả hiện tại; tiếp tục các bước còn thiếu rồi báo cáo kiểm thử thực tế.

The task that failed with HTTP 413 is not automatically resumed by installing a ZIP. You need to select its existing conversation and send a follow-up. Read `STUDIO-2.2.7.md` for the tradeoff of trimming provider-facing context while retaining the complete local journal.
