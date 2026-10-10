# Upgrade ChatMCP Studio 2.2.1 on Windows

**IMPORTANT: DO NOT extract the app into**
`F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp`.
The ZIP contains a folder named `CHATMCP-HUB` and must be extracted into its
parent: `F:\Personal_Project\Vin\ChatMCP`.

1. Ensure no project mutation is in progress. Stop the Hub:

```powershell
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd'
```

If STOP says closure unconfirmed, wait and verify `/api/health` before replacing.
Do not force-kill every `node.exe` on your PC; unrelated apps may use Node.

2. Back up persistent state (if directory exists):

```powershell
$base = 'F:\Personal_Project\Vin\ChatMCP'
$src = Join-Path $base 'cloud-harness-mcp\deploy\.generated\chatmcp-hub'
$dst = Join-Path $base ('chatmcp-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force }
```

3. Extract `CHATMCP-STUDIO-2.2.1.zip` under `F:\Personal_Project\Vin\ChatMCP`
   and replace program files in `CHATMCP-HUB`. Keep `.generated`, Docker data,
   your app workspace, Git and previous backups intact.

4. Restart:

```powershell
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd'
Invoke-RestMethod 'http://127.0.0.1:3007/api/health' |
    Select-Object app,version,uiBuild,initialized
```

Expected: `version = 2.2.1`, `uiBuild = 2.2.1-react-offline`.
If it still says 2.1.0/2.2.0, an old process or old extracted path is active.
Do not interpret UI behaviour as the new version before this check matches.

5. Open `http://127.0.0.1:3007`, refresh using Ctrl+F5. Browser Companion is
   still version **1.4.0**; reload it only if the Web runner needs reconnecting.

6. In Settings → API Gateway, enter a **new, rotated** API key, base URL and
   model; click **Test API · Tự nhận dạng**. Probes can cost money. On success,
   the protocol and authentication mode are saved automatically. If all fail,
   the error lists status and sanitized server messages for each attempt. Inspect
   Cloud Run *application logs* to learn the exact custom-gateway validation.

7. Choose your workspace, type a task and press **Bắt đầu**. The Hub starts MCP
   automatically and the agent selects project tools. Dangerous commands still
   require approval, depending on Permission mode.

This update does not prove Windows ConPTY or the custom Cloud Run gateway is
ready. It does not auto-install development dependencies or replay uncertain
file mutations.
