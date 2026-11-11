# ChatMCP Studio 2.2.4 — Gemini text-only interrupted response recovery

## Incident reproduced

In Studio 2.2.3 the gateway sometimes returned HTTP 400 `Unsupported request fields` for native Gemini tool calling and HTTP 200 for the minimal `contents`-only compatibility payload. The 2.2.3 `normalizeGeminiTextReply` rejected every `finishReason` other than STOP/unspecified with the undifferentiated message `Gemini text-only: response chưa hoàn tất.` This left the task marked `gateway_text_protocol_invalid` even when an incomplete `MAX_TOKENS` response might be regenerated safely.

**No real gateway response body was provided for this specific failure.** The actual `finishReason` is unknown until the next live request; successful basic Test API calls do not prove coding-agent JSON action support.

## Implemented changes

1. The Gemini text-only reply parser distinguishes `MAX_TOKENS`, policy/safety/other stopping reasons, missing candidates, invalid JSON and invalid tool names. It reports finish reason and available prompt/output/thinking token counts **without logging raw response text or credentials**.
2. A `MAX_TOKENS` candidate is **never executed as an MCP command**. The provider attempts up to **two additional model-only requests** on the same configured HTTPS gateway to regenerate a small, complete JSON action. It also optionally retries malformed free-text/JSON responses. No tool call is sent until an allowlisted `chatmcp_action` has been parsed. These extra model requests may incur API charges.
3. A non-retryable stopping reason such as `SAFETY` is reported and is never automatically re-requested. Invalid tool names/arguments also fail closed.
4. The huge repeated MCP tool-name inventory is removed **only in the text-protocol prompt**; all names remain discoverable through `mcp_catalog` and the automatic project-check suggestions are preserved. Native Gemini/Web modes are unchanged.
5. Once the minimal `contents` payload gets a valid HTTP 200 JSON response, the gateway dialect is cached in memory even if model output is unfinished. An explicit task continuation therefore need not repeat the three known-unsupported formats.
6. Dashboard events for generation repair are labeled `model_repair`, not network loss.

## Boundaries

- No response can be assumed finished merely because HTTP returned 200. Responses that ended with safety filtering or unknown finish reason are **not** executed as tools.
- Two model-only retries are a safety/convergence limit, **not a task-level steps/minutes limit**. The overall agent remains uncapped by Hub; model, proxy and API quotas still apply.
- If the gateway persistently responds `MAX_TOKENS` (for example, due to an unconfigurable upstream output/thinking budget), Studio stops with an actionable diagnostic. Supporting native Gemini function calling on the gateway is preferable to JSON-in-text compatibility.
- This release was checked with an instrumented **mock gateway** that emits HTTP 400/HTTP 200 and `MAX_TOKENS` responses, not with the user's live Cloud Run endpoint or Windows/Edge installation.

## Tests

See `TEST-RESULTS-2.2.4.txt`. A regression test drives the real AgentRunner and GatewayProvider using a mocked Gemini HTTP endpoint; it confirms no duplicate MCP call after an interrupted first response and checks retries, safety blocking, malformed JSON, tool allowlisting, token diagnostics and credential redaction.
