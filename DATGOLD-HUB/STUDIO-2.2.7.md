# ChatMCP Studio 2.2.7 — Gemini Cloud Run HTTP 413 (128 KiB) fix

## Incident reproduced from a user-visible task log

A real Studio 2.2.6 task had already called Desktop Commander and read `README.md`, `GUIDE.md` and `RUBRIC.md`. At model turn 8 the Cloud Run gateway rejected the next request with **HTTP 413 — Request body exceeds 128 KiB**. This is not an API-key or network issue; the Gemini text-only adapter concatenated *all prior MCP outputs* into a growing request. A prior call to `desktop-commander.read_file` used the wrong argument name (`filePath` instead of `path`) and returned `isError`; a subsequent `path` call succeeded. Tool schema errors are separate from HTTP 413.

## Changes (2.2.6 → 2.2.7)

1. `lib/gemini-compat.mjs`: `geminiTextEnvelope(...)` now measures the actual UTF-8 **serialized JSON HTTP body**; its default request budget is **96 KiB**, leaving headroom under the observed 128 KiB gateway limit. Normal short requests are unchanged. Long conversations use a selective provider-facing view that retains the first/latest user prompts, the latest tool result, bounded excerpts of recent evidence and a clear marker for omitted history. The parser's JSON `chatmcp_action` contract still comes after the untrusted transcript. It explicitly warns that omitted document passages are not evidence of a completed review.
2. `lib/gateway-provider.mjs`: if the gateway returns HTTP 413, **only the model request** is retried with a reduced budget (96 → 64 → 32 KiB). A 413 plain-text/HTML response from a proxy is recognized even if it cannot be parsed as JSON. For a previously unrecognized oversized native Gemini request, the provider can switch to the bounded text-only compatibility mode. If even the 32 KiB request is rejected, the task stops with an actionable error rather than indefinitely retrying or silently dropping safety rules.
3. `lib/agent.mjs`: the timeline logs a separate `context_compaction` event, including approximate local versus outbound request size. Existing local journals and full MCP results remain unchanged. The selected workspace, session ID, permissions, Web Companion and model-output allowlist are unaffected.
4. Bumped package/server/UI version together to `2.2.7` to prevent the daemon/UI mismatch encountered during prior upgrades.

## Correctness and limitations

- **No MCP replay by the provider's 413 recovery:** resizing/resending a model HTTP request never calls Desktop Commander again. However, a later *separate model decision* could still request a tool and is subject to the existing router, permissions and pending-operation checks. Do not interpret this as mathematical proof that all possible duplicate effects are impossible.
- The complete MCP result is retained in the local task journal; **the model may receive only excerpts**. The model must reread required sections through the available MCP tools (after checking their real parameter schema) rather than assume omitted portions were reviewed.
- Some gateways may reject even a small body, or have undocumented limits. The fix will report a remaining HTTP 413 after the limited attempts.
- This patch does **not** prove Gemini native function calling support. The contents-only JSON text fallback remains a compatibility mechanism with known limitations.
- No authenticated call was made to the user's actual Cloud Run gateway, and no Windows project files were edited in this environment.

## Test evidence

See `TEST-RESULTS-2.2.7.txt` for commands and results. The new test checks true UTF-8+JSON body size at 96/64/32 KiB, long multi-file MCP history, model-only retry on **two** simulated HTTP 413 responses (including a plain-text response), and presence of complete original MCP outputs in the on-disk journal. Existing Node/HTTP/Web continuation, Full Access, and mocked React UI tests also passed.
