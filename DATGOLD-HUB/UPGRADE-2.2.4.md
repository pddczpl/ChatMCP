# Upgrade to ChatMCP Studio 2.2.4 on Windows

1. Stop the existing Hub using `F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd`. Wait until `http://127.0.0.1:3007/api/health` no longer responds. Avoid overwriting files while the old Hub runs.
2. Preserve your state directory at `F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp\deploy\.generated\chatmcp-hub`. Back it up before upgrading. Preserve your project workspace and Docker/Cloud Harness configuration. No migration is required.
3. Extract `CHATMCP-STUDIO-2.2.4.zip` into **`F:\Personal_Project\Vin\ChatMCP`**, so `hub.mjs` ends up at `F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\hub.mjs`. **Never extract this archive into `cloud-harness-mcp`.**
4. Start `F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd`. In PowerShell check:

   ```powershell
   Invoke-RestMethod 'http://127.0.0.1:3007/api/health' |
     Select-Object app, version, uiBuild
   ```

   Require `version = 2.2.4` and `uiBuild = 2.2.4-react-offline`. Reload the dashboard with Ctrl+F5. Browser Companion remains **1.4.1**, so no extension update is needed from 2.2.3.
5. Select the **existing failed conversation** in the left sidebar, enter a follow-up asking the agent to continue, and first test a **read-only** task such as listing three workspace files. The dialog and checkpoints remain in the original session. Review the workspace before asking the agent to repeat any previously uncertain writes.
6. If failure persists, report only the `errorCode`, `finishReason`, and `tokens input/output/thinking` values from the dashboard plus the Cloud Run container-side error (if available). **Do not share API keys or Authorization headers.**

This update cannot force a custom gateway to provide more output tokens or function calling if its implementation does not support those capabilities. Two additional model requests may generate API cost. If the problem persists, adjust the gateway's upstream generation/thinking budget or route coding-agent requests through a genuinely tool-compatible endpoint.
