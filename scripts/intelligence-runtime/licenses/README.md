# Vendored licence notices for the bundled Tree-sitter grammars

`stage.mjs` copies the files below to `licenses/<project>/LICENSE` in the staged runtime, which `Build-Installer.ps1` ships as `CHATMCP-HUB/licenses/`. `notices.mjs` lists them (`GRAMMAR_NOTICES`).

| File to add here | Upstream project | Compiled into |
|---|---|---|
| `tree-sitter-javascript.LICENSE` | <https://github.com/tree-sitter/tree-sitter-javascript> | `grammars/tree-sitter-javascript.wasm` |
| `tree-sitter-typescript.LICENSE` | <https://github.com/tree-sitter/tree-sitter-typescript> | `grammars/tree-sitter-typescript.wasm`, `grammars/tree-sitter-tsx.wasm` |
| `tree-sitter-python.LICENSE` | <https://github.com/tree-sitter/tree-sitter-python> | `grammars/tree-sitter-python.wasm` |

Each file is the project's own `LICENSE` file, copied unchanged from the upstream repository (`tree-sitter-wasms` 0.1.13 declares `^0.20.3`, `^0.20.5` and `^0.21.0` as the development dependencies it built the grammars from; the exact versions are not recorded in the package). A file is accepted only when it has a copyright line with a year and the MIT permission paragraph; anything else counts as missing.

**These three files are not in the repository yet.** They were not available offline when the notice work was done and the text must not be written from memory. Until they are added:

- `stage.mjs` stops, so `Build-Installer.ps1` and the release workflow fail with a message that names the missing files.
- A build that is not a release may set `CHATMCP_ALLOW_PENDING_NOTICES=1` (CI does). It stages `licenses/PENDING-NOTICES.txt`, records `pendingNotices` in `runtime-manifest.json` and prints a warning.
- `tests/verify-notices.mjs` prints which notices are pending and fails if a release workflow sets the variable.
