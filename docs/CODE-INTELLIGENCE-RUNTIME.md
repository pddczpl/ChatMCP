# Bundled Code Intelligence Runtime — ChatMCP v3.2.0

## Installed layout

- `runtimes/node/node.exe` — pinned portable Node runtime from the Windows build host.
- `CHATMCP-HUB/runtimes/lsp/node_modules/` — locked TypeScript, Pyright and Tree-sitter runtimes.
- `CHATMCP-HUB/grammars/` — JavaScript, TypeScript, TSX and Python WASM grammars.
- `CHATMCP-HUB/runtimes/python/` — official CPython 3.11.9 Windows embeddable distribution.
- `CHATMCP-HUB/runtime-manifest.json` — verified file hashes and dependency information.

## Build procedure

`scripts/intelligence-runtime/stage.mjs` installs from `package-lock.json` via `npm ci --ignore-scripts` and stages the lockfile-approved npm dependencies. It invokes `stage-python.ps1` on Windows to download or accept a local archive after strict SHA-256 validation.

Official Python archive: `https://www.python.org/ftp/python/3.11.9/python-3.11.9-embeddable-amd64.zip`

Expected SHA-256: `33b448f95fecb7c6f802157dbd5e6b40a2ad9bfc8b95ca634a06ba4073ad1ac0`

Source manifest: https://www.python.org/ftp/python/3.11.9/windows-3.11.9.json

An optional `CHATMCP_PYTHON_EMBED_ARCHIVE` environment variable may supply a predownloaded archive; the same digest is required. The archive is extracted to disposable staging, not committed to Git.

`verify.mjs` validates file hashes and all required components. `Build-Installer.ps1` verifies copied payload and invokes `test-runtime.mjs` with the bundled Node executable for real TypeScript/Pyright cross-file LSP requests and embedded Python AST worker tests.

## Security and limitations

The installed hub resolves executable paths from its bundled runtime; developer global PATH is not required. Explicit health probes initialize real bundled engines. Sandbox-only execution mode continues to prevent host language-server execution.

Release signing and clean Windows VM offline installation acceptance are **not** included in this task and must not be represented as completed.
