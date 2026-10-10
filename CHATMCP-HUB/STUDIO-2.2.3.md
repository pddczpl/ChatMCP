# ChatMCP Studio 2.2.3 — Resume / Gateway compatibility / Unlimited local budgets

## Why this release exists

Observed failures in 2.2.2:

1. After **Stop → 'tiếp tục đi'** in ChatGPT Web, Companion logged `user_intervened_in_owned_chat`, even though Hub had queued the first follow-up in the original chat. The browser worker forwarded the saved `resumeUrl` but dropped `resumeStart` on the `CHATMCP_BROWSER_PREPARE` request. As a result, the content script treated an explicit continuation as an ordinary subsequent MCP packet and demanded stale ownership proof. **Fixed by forwarding `resumeStart` end to end**, with a regression test verifying the actual background-to-tab message. The exact original URL, per-message identity and no-double-send policy remain enforced.

2. A Gemini gateway may **return 200 for `Test API` but 400 `Unsupported request fields` for coding-agent requests**. The prior test used a tiny `contents`-only prompt; the coding agent used `systemInstruction`, `tools.functionDeclarations`, `generationConfig`. The adapter now retries, but **only on HTTP 400 errors explicitly indicating unsupported request fields**, across a bounded set of request formats on the *same endpoint* with the same authentication. Its final compatibility mode uses only Gemini `contents` and represents tool routing as a strictly parsed JSON action (`chatmcp_action=tool/final`) with an allowlist of MCP router tools. All actual tool execution still passes through the original permission system, validation and journal; no untrusted freeform text becomes a shell command. Native function calling is preferred and preserved whenever supported.

3. API jobs previously had hard-coded **maximum model turns and total minutes**. The React composer no longer displays those controls; API tasks created without explicit limits default to `maxSteps=null`, `maxMinutes=null`, and no wall-clock deadline timer. Long tasks still respect platform/model quotas, user Stop, explicit tool timeout, context size, memory/disk and other safety limits. Cost per model call and repeated requests may accrue indefinitely; check gateway billing. The legacy dashboard also omits the old inputs.

4. Settings fixes: the API protocol and authentication dropdowns now match actual backend values (`gemini` / `openai-chat`, `auto` / `google-key` / `bearer`). The displayed `agentRequestMode` distinguishes untested/native/tool-text compatibility. Test API still only proves basic model reachability, **not native function-calling support**.

## Version and files

- Hub: **2.2.3**; UI build: **2.2.3-react-offline**.
- Companion: **1.4.1** (Reload required under `edge://extensions`).
- New: `lib/gemini-compat.mjs`, `tests/verify-gateway-compat-unlimited.mjs`.
- Updated: `lib/gateway-provider.mjs`, `lib/agent.mjs`, `lib/studio-resumer.mjs`, `lib/manager.mjs`, `extension/browser-background.js`, `tests/verify-browser-continuation.mjs`, React/legacy UI, Windows gateway diagnostic version check, regression fixtures.

## Not a promise of infinite execution or identical model behavior

- "No limits" removes Hub's **user-selected count/duration caps**, not provider quotas, rate limits, context-window or cost constraints.
- JSON-text compatibility is less reliable than native Gemini tool calling; the model may fail to return parseable JSON. In that case Studio reports a bounded error and does not execute fabricated tools.
- This release has **not** been tested against the user's actual Cloud Run gateway or an actual Edge session. Tests use a simulated gateway returning `200` for plain `contents` and `400 Unsupported request fields` for extra fields, as well as DOM and browser-worker simulations.
- Missing / deleted canonical ChatGPT conversation, genuinely changed tab, and ambiguous previous tool results still fail closed. A prior tool may already have modified files when stopped; inspect real state before retrying.

## Recovery procedure

1. Stop the running Hub; verify port 3007 is no longer responding before overwriting application files.
2. Back up `cloud-harness-mcp/deploy/.generated/chatmcp-hub` and preserve the project repositories.
3. Extract the ZIP to the **parent** `F:\Personal_Project\Vin\ChatMCP` so the new entrypoint is `F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\hub.mjs`. Do NOT extract over `cloud-harness-mcp`.
4. In Edge `edge://extensions`, reload `ChatMCP Hub Companion` and verify **1.4.1**. Close only the browser tabs of failed task *messages*; retain the canonical chat URL and historical conversation.
5. Start Hub and verify `/api/health` reports `version=2.2.3` and `uiBuild=2.2.3-react-offline`. Reload dashboard using `Ctrl+F5`.
6. Select your **existing** Sensor Fusion conversation in the sidebar and send 'tiếp tục đi'. The first new packet will reattach to the exact saved URL. It must not create a new chat. Inspect the actual files if a prior mutating tool execution was cancelled or unverified.
7. For API mode with 400 errors, run a **new** request; progress will indicate any fallback. `Test API` status 200 alone does not prove native agent-tool compatibility.

## Actual validation here

- 21 Node.js test files PASS, including a new real-transport-shaped two-turn mocked Gemini/MCP loop (not a live Cloud Run request).
- React Chromium mock test and v2.2 UI theme/index/preview mock test PASS.
- JS/MJS syntax and ZIP checksum are validated when packaging.
