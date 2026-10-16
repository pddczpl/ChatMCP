# ChatMCP v3.8.0 — Native Workspace Picker & ChatGPT Web Companion

This minor-feature release fixes Windows folder selection failures and exposes a user-paired ChatGPT Web Browser Companion transport for ChatMCP's local coding agent. It includes all earlier v3.7.0 autonomous workflow features.

## Native Windows workspace picker

The packaged ChatMCP Windows desktop now opens an Explorer-style folder picker owned by the active WinForms window through its WebView2 bridge. This avoids a hidden PowerShell child process that could fail with exit code 1 or leave the dialog invisible. The Hub keeps a PowerShell STA fallback with sanitized diagnostics for ordinary browser access; users may also enter an absolute path directly in Settings or the Workspace sidebar.

Adding/selecting a workspace never deletes or automatically modifies source files. Independent tasks already running in other workspaces continue undisturbed. The Windows-native GUI interaction is not fully reproducible in headless CI, so confirm it on your own desktop after installation.

## ChatGPT Web Companion mode

Open ChatMCP Settings, select **ChatGPT Web**, and install the included Chrome/Edge extension from `CHATMCP-HUB/extension` through Extensions → Developer Mode → Load unpacked. Open a regular `https://chatgpt.com` tab, sign in yourself, generate a temporary pairing code in ChatMCP Settings, and enter it into the extension. Use the desktop's selected registered workspace, create a new chat and submit a text prompt. The Companion relays the conversation to the local Hub and routes approved tools to that project's workspace.

ChatGPT Web conversations keep their own transport across follow-ups even if you later select Model API for new chats. A Web task and an API agent in a **different checkout** may run concurrently; the Hub rejects two agents trying to edit the same direct checkout. Current Browser Companion transport supports **text-only prompts and one active Web task at a time**. For image/file attachments and general multimodal API features, switch to Model API mode.

This works through the visible signed-in web UI and a paired extension. It **does not** use a private ChatGPT API, reuse an OpenAI API key, extract cookies, bypass account controls or convert a ChatGPT subscription into API credits. Site UI changes can break browser automation; real sign-in, extension setup, interactive Windows picker and live-provider performance remain user-acceptance tasks.

## Validation

Feature source merged in [PR #39](https://github.com/pddczpl/ChatMCP/pull/39), with [CI 9/9 PASS](https://github.com/pddczpl/ChatMCP/actions/runs/38934500898) across Hub tests Node 22/24 on Ubuntu/Windows, React/real-Hub E2E both platforms, frontend build, Windows installer/WebView2 smoke and repository hygiene. A separate Browser Companion selected-workspace fixture passed on both Windows and Ubuntu. The versioned release job re-runs pinned Windows Hub regression suites, freshly builds the installer, exercises WebView2 smoke and verifies SHA-256 before publishing.

## Windows x64 installation

Download `ChatMCPSetup.exe` plus matching `ChatMCPSetup.exe.sha256`, verify the checksum, stop the old ChatMCP Hub and then install. The extension source is included in the installed ChatMCP directory under `CHATMCP-HUB/extension`; Chrome/Edge browser extension installation and pairing require your explicit action.

## Limitations & security

- **Unsigned installer:** There is no Authenticode publisher signature. SHA-256 confirms file integrity but not software publisher identity.
- **One Web task at a time:** Browser Companion is text-only and depends on supported browser/ChatGPT Web behavior. No direct ChatGPT Web API access is claimed.
- **Permission gate applies:** Connected web conversations can request only those local tools authorized by ChatMCP. Uncertain writes must be reviewed rather than replayed.
- **Worktrees are not operating-system sandboxes.** Parallel agents must not be assumed isolated at the OS process/credential layer. Agent edits from separate worktrees are not automatically merged.
- **Usage costs:** Multiple simultaneous Model API agents can consume provider tokens and incur billing charges. Browser usage is separately subject to the user's ChatGPT plan and platform limits.
