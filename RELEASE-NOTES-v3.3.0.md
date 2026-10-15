# ChatMCP v3.3.0 — Agent Capabilities & Token Optimization

This release expands the local Windows coding agent beyond the v3.2.0 bundled code intelligence baseline, while retaining the local-only architecture and the existing PermissionGate.

## Improvements

- **95 LocalTools**, plus four built-in MCP routers. The default direct-tool advertisement is 95; set `CHATMCP_DIRECT_TOOL_LIMIT` to 0–124 to trade schema size against directly available tools. The internal catalog remains discoverable.
- **Browser development tools:** Playwright-backed navigation, interaction, screenshots, responsive and accessibility inspection and visual comparisons. Requires a compatible browser runtime; no claim of bundled browser binaries.
- **Code and debugging tools:** LSP-assisted code action/rename/format previews and guarded edits, Node inspector debugging, test/build workflows, GitHub review/CI/release helpers and targeted documentation or web retrieval.
- **Token optimization:** Reversible, internal RTK-inspired log reduction, Headroom-style context packing and Caveman-inspired concise responses with `CHATMCP_TOKEN_PROFILE` profiles (off, safe, balanced, aggressive). These are native approaches, not external RTK/Headroom/Caveman products.
- **Gateway resilience:** Bounded Gemini text-only tool schemas to reduce HTTP 413 failures; fixes the direct-tool inventory compaction regression.
- **Security boundaries:** No Hooks or external MCP client. Existing workspace safeguards, approval modes, PermissionGate and tool receipts remain.

## Release and limitations

- Published on explicit user instruction **without gating on the separate CI workflow**. This release workflow must still perform a fresh self-contained Windows installer build and independently verify its SHA-256 checksum before uploading assets.
- Windows binaries remain **unsigned** (no Authenticode certificate). SHA-256 verifies download integrity, not publisher identity.
- Clean Windows Sandbox/VM install and offline acceptance have not been certified. Browser runtime support and live paid-model autonomous coding quality may differ by environment.
- Multiple sequential model/tool cycles, retries and a large schema may consume substantial API tokens or request quota; the optimization profiles do not impose a per-task spending cap.

Download `ChatMCPSetup.exe` and the matching `.sha256` checksum from this release. Close existing ChatMCP processes before upgrading.
