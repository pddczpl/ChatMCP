# Upgrade to ChatMCP Studio 2.2.5 on Windows

1. Stop the Hub with `F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd`; wait until `http://127.0.0.1:3007/api/health` no longer responds. Do not overwrite a running Node process.
2. Back up (do not delete) `F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp\deploy\.generated\chatmcp-hub` and preserve the project workspace.
3. Unzip `CHATMCP-STUDIO-2.2.5.zip` into **`F:\Personal_Project\Vin\ChatMCP`**. `hub.mjs` must end up at `F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\hub.mjs`. **Never extract into `cloud-harness-mcp`.**
4. Start with `F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd`.
5. Check:

   ```powershell
   Invoke-RestMethod 'http://127.0.0.1:3007/api/health' | Select-Object app, version, uiBuild
   ```

   Expected: `version=2.2.5`, `uiBuild=2.2.5-react-offline`. Reload dashboard with `Ctrl+F5`. Companion is unchanged at **1.4.1**; it does not need an update for this API-only fix.
6. Open the **same failed conversation** in the Hub sidebar and enter an explicit continuation: `Tiếp tục công việc trong workspace cũ. Kiểm tra tiến độ, thay đổi file và lệnh chưa xác minh trước khi chạy lại.` Do not create a new session. Run a read-only listing first to confirm tool routing before permitting mutations.
7. If `MALFORMED_FUNCTION_CALL` persists, send only `errorCode`, `finishReason`, tokens input/output/thinking and redacted Cloud Run container logs. No API key, bearer headers or original secret values.

**Limits:** This update retries model generation at most twice for this error; it never replays MCP side effects. These extra model requests can incur API charges. The gateway may still be incompatible with text action routing until its native tools support is corrected.
