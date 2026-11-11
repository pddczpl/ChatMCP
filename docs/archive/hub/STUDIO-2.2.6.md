# ChatMCP Studio 2.2.6 — JSON action recovery after a successful MCP call

## Incident

The agent successfully ran `desktop-commander.list_directory` against a Windows workspace and received the directory listing. On the *following* model turn the custom Gemini gateway returned an HTTP-200 Gemini candidate with an object that did not satisfy ChatMCP's strict action envelope. The previous parser failed with:

`Gateway text-only: phản hồi thiếu chatmcp_action tool/final hợp lệ.`

This is not proof that the preceding MCP tool failed, and it is not the same as a transport failure or `MALFORMED_FUNCTION_CALL`. The original unredacted candidate is not available in this report, so its precise keys are unknown.

## Changes

- `lib/gemini-compat.mjs`: keep the **JSON-only output contract at the end** of the one-part Gemini `contents` text message, after the untrusted transcript and the most recent MCP result. Clearly tell the model that previous MCP output has already been executed and must not be replayed only to correct JSON formatting.
- JSON objects with missing/incorrect `chatmcp_action`, missing `final.text` or missing tool argument objects become *model-repairable* format failures, rather than failing the entire task immediately. Tool names outside the exact four-router allowlist still fail closed with no automatic replay.
- The adapter supports an **explicit final action** using a textual `text`, `answer`, or `message` field and the common `args` alias for an explicitly selected allowlisted router tool. The agent runner continues to validate the complete router schema, catalog, permissions and arguments before actual MCP execution.
- Split Gemini text parts can form one JSON object without forced newline insertion. A candidate that contains any native `functionCall` is not interpreted as a text-tool action.
- `lib/gateway-provider.mjs`: on the recoverable format error, ask the **model** up to two times for a correct action object. The new instruction includes only sanitized *root JSON key names*, not response content, API keys, or raw MCP results in error logs.
- Do not automatically call the preceding MCP command again to repair a model-generated response. A repeated model request can consume quota and may still fail if the underlying gateway/model refuses to produce the required format.

## Tested

- Full agent simulation with mocked Gemini HTTP: `list_directory` succeeded, malformed *valid* JSON arrived in the next turn, the model returned corrected final JSON, and the MCP tool executed **once**.
- Wrong router name fails closed; native `functionCall` in text-only response fails closed; multiple text parts are supported; a `final.answer` alias works; exhausted format retries stop with explicit diagnostic.
- Legacy Node test suites, API/Web/session recovery and React UI simulations pass.

## Not validated

No authenticated request was sent to the user's custom Cloud Run gateway. The exact model output responsible for the logged schema failure was not provided. No end-to-end verification on Windows/Edge/DPAPI/Desktop Commander or the user's current project was performed. This is a compatibility fix with bounded recovery, **not a guarantee of native Gemini tool calling support**.

To eliminate the root incompatibility in the long term, the custom gateway should faithfully support Gemini tool declarations/function calls and responses, or expose an actually OpenAI-compatible tool-calling endpoint.
