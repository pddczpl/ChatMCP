# Bundled Code Intelligence Runtime — ChatMCP v3.2.0

## Installed layout

- `runtimes/node/node.exe` — pinned portable Node runtime from the Windows build host.
- `CHATMCP-HUB/runtimes/lsp/node_modules/` — locked TypeScript, Pyright and Tree-sitter runtimes.
- `CHATMCP-HUB/grammars/` — JavaScript, TypeScript, TSX and Python WASM grammars.
- `CHATMCP-HUB/runtimes/python/` — official CPython 3.11.9 Windows embeddable distribution.
- `CHATMCP-HUB/runtimes/ripgrep/` — official ripgrep 15.2.0 `rg.exe` (x86_64-pc-windows-msvc) with its `LICENSE-MIT`, `UNLICENSE` and `COPYING`; the engine of `search_files` and `find_files` (`CHATMCP-HUB/lib/ripgrep.mjs`).
- `CHATMCP-HUB/licenses/ripgrep/` — the license texts of PCRE2, of the Rust standard library and of the Rust crates that `rg.exe` is linked with (the ripgrep archive does not carry them), and `MANIFEST.json`, their inventory; vendored in `scripts/intelligence-runtime/licenses/ripgrep/`.
- `CHATMCP-HUB/runtime-manifest.json` — verified file hashes and dependency information.

## Build procedure

`scripts/intelligence-runtime/stage.mjs` installs from `package-lock.json` via `npm ci --ignore-scripts` and stages the lockfile-approved npm dependencies. It invokes `stage-python.ps1` on Windows to download or accept a local archive after strict SHA-256 validation.

Official Python archive: `https://www.python.org/ftp/python/3.11.9/python-3.11.9-embeddable-amd64.zip`

Expected SHA-256: `33b448f95fecb7c6f802157dbd5e6b40a2ad9bfc8b95ca634a06ba4073ad1ac0`

Source manifest: https://www.python.org/ftp/python/3.11.9/windows-3.11.9.json

An optional `CHATMCP_PYTHON_EMBED_ARCHIVE` environment variable may supply a predownloaded archive; the same digest is required. The archive is extracted to disposable staging, not committed to Git.

Ripgrep is staged the same way by `stage-ripgrep.ps1`:

Official ripgrep archive: `https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip` (1,789,611 bytes)

Expected SHA-256: `71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5` (the digest GitHub states for that release asset)

Only `rg.exe`, `LICENSE-MIT`, `UNLICENSE` and `COPYING` are taken from the archive (from its top or from the one folder below it); both license texts must be there and must be the license texts; the staged `rg.exe` must report `ripgrep 15.2.0`. `CHATMCP_RIPGREP_ARCHIVE` may supply a predownloaded archive for an approved offline build; the same digest is required. At run time the Hub uses, in this order, the binary named by `CHATMCP_RIPGREP` (an absolute path; `off` switches ripgrep off), the bundled `rg.exe`, and (only when the Hub runs from a source checkout; an installed Hub, which has `runtime-manifest.json`, never does) an `rg` on PATH; with none of them `search_files` and `find_files` search without ripgrep, as before.

`rg.exe` is also linked with PCRE2, with the Rust standard library and with Rust crates whose texts the archive does not carry. `stage.mjs` stages the vendored texts and their inventory as `licenses/ripgrep/`; it stops without them, and when `stage-ripgrep.ps1` pins another release than the one the inventory was derived for. `verify.mjs` requires them with their vendored hashes, `Build-Installer.ps1` checks them in the payload (`Assert-InstallerRipgrepNotices`), and `test-runtime.mjs` looks for the PCRE2 version string of the notice in the bytes of `rg.exe` and checks that `rg --pcre2-version` prints what the inventory records (it prints `PCRE2 10.45`, constants of the Rust bindings, while the compiled library is 10.46); it also looks for the source paths of the Rust toolchain (`/rustc/<commit>`) in those bytes and checks that the import table names no C runtime DLL (the static C runtime is named in `THIRD-PARTY-NOTICES.md`). `scripts/intelligence-runtime/licenses/README.md` says how the list is derived and how to derive it again for a new ripgrep release.

`verify.mjs` validates file hashes and all required components. `Build-Installer.ps1` verifies copied payload and invokes `test-runtime.mjs` with the bundled Node executable for real TypeScript/Pyright cross-file LSP requests, embedded Python AST worker tests and a search with the bundled ripgrep.

## Security and limitations

The installed hub resolves executable paths from its bundled runtime; developer global PATH is not required. Explicit health probes initialize real bundled engines. Sandbox-only execution mode continues to prevent host language-server execution.

Release signing and clean Windows VM offline installation acceptance are **not** included in this task and must not be represented as completed.
