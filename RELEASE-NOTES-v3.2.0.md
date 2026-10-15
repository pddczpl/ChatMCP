# ChatMCP v3.2.0 — Bundled Code Intelligence

Windows installer target: Node-based TypeScript Language Server and Pyright, Tree-sitter WASM grammars for JavaScript, TypeScript, TSX and Python, plus isolated embedded CPython 3.11.9 for Python AST.

## Improvements
- Bundle locked Node packages and all required WASM files with SHA-256 manifest verification.
- Launch bundled language servers on demand and perform actual cross-file semantic queries, with bounded failures and heuristic fallback.
- Run the Python AST worker with embedded CPython, without requiring a globally installed Python interpreter.
- Run real-engine LSP / AST integration tests during the Windows installer build.
- Expose a Code Intelligence Engines health-probe section in Settings.
- Preserve workspace permissions and existing local-only security boundaries.

## Limitations
- The installer remains **unsigned**; SHA-256 validates the artifact bytes, not publisher identity.
- Clean Windows Sandbox/VM offline acceptance was explicitly excluded and has **not** been verified.
- Only bundled code-analysis engines run offline; hosted AI model APIs still require Internet.
- CI scripted model providers do not independently verify live-model autonomous coding quality.

Use the matching `.sha256` checksum before running `ChatMCPSetup.exe`. Close existing ChatMCP instances before upgrading.
