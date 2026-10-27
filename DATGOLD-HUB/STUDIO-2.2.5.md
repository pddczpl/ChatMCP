# ChatMCP Studio 2.2.5 — Gemini MALFORMED_FUNCTION_CALL repair

## Actual incident

The user reported `gateway_text_finish_reason`: Gemini text-only returned HTTP 200 with `finishReason=MALFORMED_FUNCTION_CALL`, prompt=1670 tokens, output=50, thinking=76. That is an invalid model-generated function call, **not** a transport error, an auth error or direct evidence of an exhausted output-token budget. No MCP tool was executed from that response.

The configured Cloud Run gateway accepts the minimal `contents`-only request but previously rejected Gemini native tool fields with HTTP 400 `Unsupported request fields`. This is a custom gateway. Its internal behavior has not been inspected.

## Implementation

1. `lib/gemini-compat.mjs`: the text-only envelope contains exactly one `contents[0]` user message with instructions, transcript, and a final next-action prompt. It does NOT send `tools`, `toolConfig`, `systemInstruction`, or `generationConfig`. It explicitly requires literal JSON text rather than Gemini native function calling. Its instructions still preserve safety, workspace and project checks, and expose every real MCP tool via `mcp_catalog`/`mcp_describe` (no arbitrary truncation of the real tool inventory).
2. The parser treats `MALFORMED_FUNCTION_CALL` as a **retryable generation failure** only in this strict text-only dialect. It never interprets an unfinished candidate as a valid MCP tool invocation.
3. `lib/gateway-provider.mjs`: on that error, issue up to **two additional MODEL requests** to the same configured gateway asking for a compact literal JSON text action; do not replay preceding MCP calls. Repair information stays inside one user text part to preserve the contents-only contract. Per-request rate limits and API charges remain applicable.
4. If all attempts fail, the task remains in a resumable failed state with diagnostic `gateway_text_malformed_function`, actual finishReason and token metadata. Do not claim that the gateway is fixed; a server injecting native tools or a model unable to emit literal JSON will still require upstream changes.
5. `SAFETY` and unrecognized finish reasons remain **non-retryable**. Invalid router actions are refused. All MCP invocations still go through the original authorization gate, including Full Access policy choices.

## What was tested

The new regression test uses the actual GatewayProvider + AgentRunner with **mocked HTTP replies**, first rejecting tool fields, then returning the user's observed `MALFORMED_FUNCTION_CALL` and token counts, then a valid JSON tool action, and finally a result. It checks a single MCP invocation after recovery, bounded retries, same endpoint/key handling, and safe stop on repeated failure. Existing Web mode, session recovery and API tests were also rerun.

**Not verified:** real requests to the user's Cloud Run gateway, Windows 11, DPAPI, Edge or local project. This release cannot guarantee the custom gateway accepts or honors the new prompt. To fully resolve persistent failures, enable proper Gemini `functionDeclarations`/functionResponse support on the gateway or use a tool-compatible provider.
