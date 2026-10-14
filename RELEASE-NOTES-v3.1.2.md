# ChatMCP v3.1.2 — Hybrid Intelligence & Secure Profiles

**Windows maintenance release.** This version includes the three-tier Code Intelligence integration already merged into `main` and repairs the Ubuntu CI regression introduced by the stricter AI Profiles DPAPI requirement.

## Code Intelligence: three tier execution

- **Tier 1 — LSP:** When a trusted TypeScript/Python language server is available and running, the Code Intelligence tools can obtain semantic cross-file definition/reference results.
- **Tier 2 — Tree-sitter/Python AST:** Optional `web-tree-sitter` plus compatible `.wasm` grammar files, or the existing Python `ast` worker when Python is installed, provide richer syntactic structure.
- **Tier 3 — Heuristic fallback:** The built-in zero-dependency parser continues to support repositories without optional language servers/parsers.
- The six existing tool names are retained: `repo_map`, `code_symbols`, `find_definition`, `find_references`, `dependency_graph` and `code_diagnostics`.

**Optional engine prerequisites are not installed automatically** by ChatMCPSetup.exe. This release does not claim LSP/Tree-sitter is active on machines without the relevant language server/parser, or that all available languages have full semantic resolution.

## Security and CI repair

- Keep Windows DPAPI encryption mandatory for stored AI Profile keys; no plaintext or Base64 fallback is re-enabled.
- Ubuntu Node 22 and Node 24 previously failed in `verify-phase3-features.mjs` because the test attempted to save a key with production DPAPI behavior under Linux.
- Use a **test-only** AES-256-GCM adapter in the verification suite to test save/reload, while independently asserting the production store rejects an unencrypted key and that the fixture never persists plaintext.
- CI runs 78 Hub Node suites across Windows and Ubuntu, Node 22 and Node 24, plus React E2E, frontend build and Windows installer smoke tests.
- The release workflow publishes installer files **only from the exact, successful `main` CI commit** and validates `ChatMCPSetup.exe` against `ChatMCPSetup.exe.sha256`.
- The gateway implementation, sandbox safeguards, permission approvals and user data policies remain unchanged by this patch.

## Installation

Download `ChatMCPSetup.exe` and `ChatMCPSetup.exe.sha256` from this release, verify their SHA-256 before running and close any running ChatMCP processes before upgrading. Git for Windows and Microsoft Edge WebView2 Runtime are required for their corresponding features.

The Windows installer is **not Authenticode-signed**. Tests exercise scripted model providers, not the end-to-end coding quality of a paid live language model.
