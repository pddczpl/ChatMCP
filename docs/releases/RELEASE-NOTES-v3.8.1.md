# ChatMCP v3.8.1 — ChatGPT Web Companion transport switching

This Windows x64 patch release includes the changes from [PR #42](https://github.com/pddczpl/ChatMCP/pull/42), while retaining all v3.8.0 workspace, browser and coding-agent capabilities.

## Changes

- **Switch Model API ↔ ChatGPT Web within an existing conversation.** The next user message goes through the newly selected transport. ChatMCP creates a *new linked execution task*, keeps original history locally and provides only a bounded, redacted context handoff rather than impersonating or reusing the previous model's session.
- **Safer transport changes.** In-flight or uncertain file mutations cannot be transferred invisibly. The Hub does not silently replay tool calls or assume an earlier action succeeded.
- **Recover official ChatGPT chat URL.** When the original web task lacks a canonical `chatgpt.com/c/...` URL, open its **original existing tab** and choose the recovery option in the ChatMCP conversation. Companion 1.5.0 scans only eligible user-opened ChatGPT tabs and binds the URL only after verifying a unique task ID + nonce witness. It does **not** click Send or duplicate the prompt.
- **Browser Companion 1.5.0.** Updated Chrome/Edge extension source, route verification and setup instructions. The extension remains separately installed and paired by you.

## Downloads

The release contains **four matching artifacts** built from the same release commit:

1. `ChatMCPSetup.exe` — Windows x64 desktop installer.
2. `ChatMCPSetup.exe.sha256` — installer SHA-256 integrity checksum.
3. `ChatMCP-Browser-Companion.zip` — separately installable Chrome/Edge extension with `manifest.json` at the ZIP root.
4. `ChatMCP-Browser-Companion.zip.sha256` — extension ZIP checksum.

The release pipeline builds both archives, verifies checksums, validates the extension's manifest and exact-source parity with the installer payload, and then publishes the version tag and files.

## Upgrade and browser pairing

Stop the old ChatMCP Hub on `127.0.0.1:3007`, install the new Windows setup, and restart the desktop app. For ChatGPT Web mode, extract `ChatMCP-Browser-Companion.zip` to a local folder, open `edge://extensions` or `chrome://extensions`, enable Developer mode and choose **Load unpacked** on the extracted folder that contains `manifest.json`. Reload the existing `chatgpt.com` tab after enabling Companion 1.5.0. Pair the extension explicitly in ChatMCP Settings using a fresh one-time pairing code. Previous pairing may need to be renewed after reinstalling the extension.

To recover an earlier web conversation URL, keep the **original ChatGPT tab** open and use the recovery action. Do not paste browser cookies, ChatGPT passwords, authorization tokens or arbitrary URLs.

## Verification and limitations

[PR #42 CI 9/9 PASS](https://github.com/pddczpl/ChatMCP/actions/runs/38949174830), [Browser Companion regression Windows/Ubuntu PASS](https://github.com/pddczpl/ChatMCP/actions/runs/38949174876), and [Companion package verification PASS](https://github.com/pddczpl/ChatMCP/actions/runs/38949174827). These automated tests are scripted; they do not prove compatibility with every future ChatGPT Web UI change or all live model configurations. Native Windows/browser acceptance testing is still recommended.

ChatGPT Web mode uses the ordinary, signed-in `chatgpt.com` interface through a user-installed extension. It is **not** a private API, does not extract cookies, and does not convert ChatGPT subscriptions into OpenAI API credits. It currently supports text prompts and one active Web task at a time. Local tool execution remains controlled by the existing Permission Gate; Git worktrees do not provide an OS sandbox. The Windows installer is **not Authenticode-signed**. SHA-256 verifies file integrity, not publisher identity.
