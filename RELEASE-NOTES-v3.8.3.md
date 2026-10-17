# ChatMCP v3.8.3 — Native lifecycle, in-place upgrades and Companion safety

## Fixed

The native desktop now has one window per Windows user/session. A second invocation activates the existing window instead of creating another Hub controller. Closing the window **keeps the Hub session running**; use the installed `CHATMCP-HUB/STOP-CHATMCP-HUB.cmd` or the dashboard's explicit shutdown to stop it. No task is restarted or replayed by closing/reopening the GUI.

Before loading WebView2, the launcher verifies the installed package version and the running Hub's `app`, `version`, `uiBuild` and initialization status. An old or foreign service returning HTTP 200 is not sufficient. A disconnected/version-changed Hub is shown by a native status overlay, not an apparently running stale task pane. Startup does not terminate a foreign listener.

The installer stages and hashes the complete payload, checks native/Hub runtime versions, verifies the listener's PID, bundled executable and Hub script, refuses active work, requests authenticated shutdown and confirms process exit. A per-installation lock serializes upgrades against new Hub process creation. Every destination is preflighted before any replacement. A caught installation failure restores touched files from the verified backup; user-created files and state remain outside the ownership manifest. An interrupted transaction/failed rollback leaves `.chatmcp-update-pending.json` and its backup journal; the launcher blocks a mixed installation rather than claiming success. Keep those backups for recovery; automatic recovery after power loss is not claimed.

Installer/Installed Apps version now derives from the compiled assembly, not a hard-coded historical version. Installation phase logs are stored at `%LOCALAPPDATA%\ChatMCP\logs`. Quiet mode is explicit and uses the same guarded engine: `ChatMCPSetup.exe --quiet --install-dir "<absolute directory>"`; `Uninstall.exe --quiet --uninstall`. Exit 1 means failure; GUI installation remains the default.

Companion **1.5.2** requires an identified chat composer and rejects conflicting Search labels before modifying a draft. URL recovery refuses incomplete, timed-out, inaccessible, malformed, ambiguous or truncated candidate scans. The existing nonce/route ownership, permissions, active-task priority and uncertain-send no-replay controls remain intact.

## Update

Finish/stop active tasks, run this installer into your existing ChatMCP installation and wait for completion. Updating an installed unpacked extension is separate: update/reload **ChatMCP Hub Companion 1.5.2** in Edge/Chrome and reload its ChatGPT tabs. The desktop installer cannot silently replace a copy loaded from a different folder. Hub health must report `3.8.3` and `3.8.3-react-agent` before testing a new Studio conversation. Do not replay an old task with an uncertain Send outcome.

## Validation scope

Release gates include the full Node suite, React build/E2E, actual Chromium MV3 worker-to-content-script delivery on scripted pages, native shared-class/version/transaction tests, a published 3.8.2 baseline setup followed by this real candidate setup, the actual installed `ChatMCP.exe` single-instance and close/reopen lifecycle, foreign-port/version refusal and uninstall with preserved user files. Windows workflow tests run in a fresh disposable runner, not the owner's workstation. Existing native WebView2 smoke, runtime dependency validation, extension source/ZIP/installer parity and SHA-256 checks remain required.

This does **not** claim a clean offline Windows Sandbox acceptance run, Authenticode signing or a successful session on the owner's signed-in Edge/ChatGPT layout. Installer remains unsigned. Login, model/account limits and approval gates are unchanged.
