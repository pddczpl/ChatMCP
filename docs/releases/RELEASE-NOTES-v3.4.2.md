# ChatMCP v3.4.2 — Custom Gateway Protocol Persistence

This Windows patch release fixes the model-settings workflow that could leave a 9Router-compatible endpoint configured as **Gemini** even after the user selected **Khác: tương thích OpenAI**.

## Changes

- **Correct protocol routing:** when changing the API dialect for the same custom gateway, ChatMCP keeps the gateway address and selected model rather than replacing them with unrelated defaults.
- **Credential preservation:** an already saved API key stays protected by Windows DPAPI and may be reused between **custom** protocol presets on exactly the same origin. Switching to another origin or unrelated named provider still drops the key and requires explicit credentials.
- **Truthful UI state:** shows which protocol the Hub is actually using, warns when changes have not been saved, and displays errors persistently rather than only briefly.
- **Strict “Lưu & kiểm tra”:** the selected OpenAI Chat Completions protocol is checked without silently switching to Gemini; automatic protocol detection remains available through other explicit diagnostic workflows.
- **Regression tests:** gateway unit tests for same-origin retention, cross-origin isolation and strict protocol; React form unit tests and React/real Hub E2E tests using synthetic credentials.

## Notes

Use **Custom (OpenAI)** with an OpenAI-compatible Base URL such as `https://<your-gateway-host>/v1`, `Bearer` authentication and a model ID supported by your gateway. The displayed `configured` state means credentials/config are present, not that the model endpoint has passed a live tool-calling test.

After upgrading, shut down the previous Hub process and start the installed app. Existing conversations, checkpoints and secured keys are not intentionally removed. If an API key was previously exposed in chat or logs, revoke and rotate it with the gateway provider.

The **Windows installer is not Authenticode-signed**. Verify the matching `ChatMCPSetup.exe.sha256` checksum; a checksum establishes file integrity, not publisher identity. CI uses scripted providers and does not guarantee arbitrary third-party gateways work with every model.
