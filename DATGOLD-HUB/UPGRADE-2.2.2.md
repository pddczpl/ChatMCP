# ChatMCP Studio 2.2.2 — Local Upgrade & Security

1. STOP the existing Hub; verify port 3007 is closed. Make a separate backup of `cloud-harness-mcp/deploy/.generated/chatmcp-hub`.
2. Extract this ZIP under `F:\Personal_Project\Vin\ChatMCP` so that `CHATMCP-HUB/hub.mjs` exists next to `cloud-harness-mcp`; **never extract into cloud-harness-mcp**.
3. START the Hub, reload the Companion only if necessary, Ctrl+F5 in the browser.
4. Verify `Invoke-RestMethod http://127.0.0.1:3007/api/health` reports version `2.2.2` and `uiBuild: 2.2.2-react-offline`.
5. From Settings choose `host-review`, `sandbox-only` or **Full Access**. Full Access requires typing `FULL ACCESS`. It's persisted until disabled, and the UI displays an amber warning while it is active.

## Full Access — exactly what it means

* Enables **automatic** permission to call arbitrary declared MCP tools, execute Windows shell commands and use Internet through those tools, and pass absolute paths outside workspace.
* Works only under the effective OS privileges of the Windows account / MCP process. It cannot bypass ACLs, UAC, antivirus/firewall, private network controls, administrator restrictions, or tool limitations.
* Native Studio git, indexing and Explorer remain scoped to the selected workspace; use Desktop Commander or shell for files outside the workspace.
* No OS sandbox is active for unrestricted host tools. MCP results are untrusted, and an agent can make harmful modifications; back up files and repositories before using.
* Switching back to Host-review or Sandbox-only immediately restores the policy for **future** MCP calls, but cannot undo already executed changes.
* Full Access remains enabled after restart until you explicitly disable it. Keep the local Hub accessible only on loopback and your Windows session protected.

## Gateway diagnostics

The key previously exposed in the chat is **not included in this ZIP**. If it was saved locally in the Hub, `Settings → Test API · Tự nhận dạng` reuses it. Use `windows/Test-Gateway-Live.ps1` for a direct Gemini REST test when the Hub is not configured. That script asks for the key interactively and displays the redacted gateway response.

**Not tested in this build:** the user's actual Cloud Run gateway (network DNS blocked in the build environment) and end-to-end Windows/Edge runs.
