# Upgrade ChatMCP Studio 2.2.7 -> 2.2.8 (Windows)

1. Preserve the failing task's report and any open ChatGPT tab. Do not manually click Send while the old Companion owns an ambiguous turn.
2. Stop Hub with `CHATMCP-HUB\STOP-CHATMCP-HUB.cmd` and verify that `http://127.0.0.1:3007/api/health` is unavailable. Don't overwrite a running process.
3. Backup your persisted state at `F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp\deploy\.generated\chatmcp-hub` (if present).
4. Extract the ZIP **into** `F:\Personal_Project\Vin\ChatMCP` so the application lives at `...\CHATMCP-HUB\hub.mjs`. Never extract into `cloud-harness-mcp`.
5. In Edge, open `edge://extensions`, **Reload** ChatMCP Hub Companion. Check **1.4.2**. Close stale failed task tabs but keep any chat whose turn is still unverified until you inspect it.
6. Run `CHATMCP-HUB\START-CHATMCP-HUB.cmd` and inspect `Invoke-RestMethod http://127.0.0.1:3007/api/health | Select-Object version,uiBuild`. Expected: `2.2.8`, `2.2.8-react-offline`.
7. Open the Studio dashboard (Ctrl+F5). The selected session and history stay on disk. Resume a stopped session rather than starting over when it has a saved ChatGPT conversation URL. An unconfirmed *first send* may not have created a saved ChatGPT conversation, so this cannot always be resumed in the same remote chat.

If the spinner recurs, inspect: **Settings -> Companion phase / last note**, whether the owned ChatGPT tab shows the submitted user message or still contains an unsent draft, and the Browser Extension service-worker console. Never paste API credentials or unredacted auth headers.
