# ChatMCP v3.0.1 — Gemini JSON and local tool routing fixes

This patch addresses two failures that could interrupt a coding task: Gemini text-only replies that did not follow the JSON action contract, and `mcp_call` rejecting the short name of a local tool that was already available.

## Fixes

- Keep progress notes inside the JSON `progress` field and use the actual tool allowlist in both initial and repair prompts.
- Preserve valid JSON examples in tool history, including object arguments, and distinguish previous progress notes from final answers.
- Accept an exact, registered local alias such as `read_file` through `mcp_call` or `mcp_describe`, resolving it to `local.read_file`. Exact catalog names take priority. No fuzzy matching or automatic installation of unknown tools is performed.
- Keep schema validation, permission checks, strict reply parsing and the two model-only repair attempts. A format repair does not replay a completed MCP operation.

## Windows installer

Download `ChatMCPSetup.exe` and `ChatMCPSetup.exe.sha256` from the release assets. Verify the checksum, then close ChatMCP and install the update. The installer includes Node.js and the .NET desktop runtime; WebView2 and Git for Windows remain prerequisites for their respective features.

The installer is not Authenticode-signed. Automated model tests use scripted responses; they do not establish compatibility with every custom Gemini gateway. The published release records the CI run and installer validation performed for its exact artifact.
