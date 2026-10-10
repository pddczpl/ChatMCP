# ChatMCP Studio 2.2.2 — Full Access + Live Gateway Diagnostics

## Summary

Adds an opt-in **Full Access** execution policy to the existing `host-review` and `sandbox-only` modes. User confirmation requires the exact text `FULL ACCESS` in both React UI and backend. A prominent banner appears in the main conversation while this mode is enabled. The policy is persisted until explicitly disabled.

In Full Access, MCP tools (including Desktop Commander) are allowed without per-tool prompts or Studio workspace-path filtering. Windows account permissions, OS access controls, network firewall, actual availability of the network and installed MCP tools continue to apply. Git, AST index and native Studio Explorer still operate relative to the selected workspace. Desktop Commander / the local host terminal are the route to arbitrary paths and Internet access. No OS privilege escalation or network security bypass is attempted.

Full Access has a significant risk: an agent or malicious tool output could cause irreversible changes to any accessible file or send information to remote destinations. The user should operate only on trusted tasks, keep backups and disable the mode afterwards. Stop/cancel is still honored, and unknown MCP outcomes are not retried blindly.

## Gateway diagnostics

The build environment could not resolve the user's Cloud Run gateway hostname and therefore **no authenticated live request** was completed here. Official Gemini documentation lists model `gemini-3.8-flash`, but whether this specific custom gateway accepts that model and REST format is not known without its response body.

This release includes:

* `windows/Test-Gateway-ViaHub.ps1` — real request via the running local Hub, reusing an API key already saved in Hub memory or Windows DPAPI. No key is printed or embedded in the script. Runs the existing bounded API dialect autodetection.
* `windows/Test-Gateway-Live.ps1` — real minimal Gemini REST POST directly from Windows, using `GOOGLE_API_KEY` (process env) or masked interactive input. Default destination is the explicitly requested gateway only, HTTPS only, redirects disabled. Supports `google-key` and `bearer` auth modes.

Each live request may consume the account's gateway/API quota. Rotate the previously exposed key as soon as feasible.

## Verified in the build environment

* 20 Node.js test scripts passed, including 15 explicit Full Access assertions, 27 HTTP integration assertions, 22 Gateway adapter/autodetect assertions.
* 4 Chromium/Playwright React UI test scripts passed with a mocked backend (not Windows Edge).
* 64 JS/MJS files passed `node --check`.
* ZIP hashes and archive readability checked during packaging.

**Not verified here:** the actual gateway's key validity or behavior; operating as real Windows Desktop Commander Full Access; 24-hour soak tests; permissions of other Windows user accounts. The automation still depends on the browser/UI reliability for ChatGPT Web mode.
