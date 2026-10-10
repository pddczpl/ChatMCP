# Upgrade to ChatMCP Studio 2.2.3 (Windows)

**Never extract into `cloud-harness-mcp`**. It is a different project and contains generated runtime state. Back up the existing Hub state first.

```powershell
# 1. Stop the old Hub
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd'

# 2. Verify that port 3007 is no longer serving the app
try { (Invoke-RestMethod 'http://127.0.0.1:3007/api/health' -TimeoutSec 3).version }
catch { 'OK: old Hub not responding' }

# 3. Back up state (the source is outside the application ZIP)
$state = 'F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp\deploy\.generated\chatmcp-hub'
$backup = 'F:\Personal_Project\Vin\ChatMCP\chatmcp-state-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
if (Test-Path -LiteralPath $state) { Copy-Item -LiteralPath $state -Destination $backup -Recurse -Force }
```

Download `CHATMCP-STUDIO-2.2.3.zip` and extract **only into** `F:\Personal_Project\Vin\ChatMCP`, overwriting the old `CHATMCP-HUB` application folder. Do not delete or replace `cloud-harness-mcp`, other project repositories, or `.generated`.

```powershell
# 4. Start updated application
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd'

# 5. Verify the actual running code
Invoke-RestMethod 'http://127.0.0.1:3007/api/health' |
  Select-Object app,version,uiBuild
```

Required output: `version=2.2.3` and `uiBuild=2.2.3-react-offline`.

Then Reload the unpacked Companion on `edge://extensions` (version **1.4.1**) and press `Ctrl+F5` on the Hub dashboard. In Settings, Test API confirms only a minimal request; run an agent task to check tool protocol compatibility. Never paste API keys into chat or commit them to a repository.

### If Hub STOP does not confirm closure

Do not overwrite files while the process still responds on port 3007. After waiting 15 seconds, check again. If the process is stuck, identify the **exact PID and executable command line** listening on port 3007 before terminating it; never terminate every Node.js process, as they may belong to unrelated applications.

### What if a previous conversation is failed/cancelled?

Choose the same history item, type a new continuation prompt, and verify the same canonical ChatGPT URL is reused. The error state of the previous run remains in the transcript. The app does not create a replacement conversation. Operations with uncertain side effects must be inspected before being repeated.
