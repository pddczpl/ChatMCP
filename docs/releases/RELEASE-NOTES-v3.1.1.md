# ChatMCP v3.1.1 — Code Intelligence & Smart Context Fixes

This is the **tested Windows installer** for Code Intelligence and Smart Context Compaction. The older v3.1.0 tag is preserved for history; it points at a commit whose CI failed, and its GitHub Release did not contain a Windows installer. Install **v3.1.1** instead.

## Code Intelligence

Six new read-only local coding tools: `repo_map`, `code_symbols`, `find_definition`, `find_references`, `dependency_graph`, and `code_diagnostics`.

- Handle the production asynchronous `StudioWorkspace.resolve()` contract correctly.
- Resolve Windows path aliases/junctions safely while denying symlink escapes outside the selected workspace and protecting sensitive paths.
- Offer bounded, query-focused source maps and symbol line ranges instead of requiring repeated full-file reads.

## Smart Context Compaction

- Inject a bounded Repo Map into the model's task input as explicitly **untrusted source data**, without changing the original prompt or granting extra permissions.
- Compact only a **copy of older conversation tool outputs** sent to the model. Preserve `call_id`/tool-result pairing and the full canonical on-disk transcript.
- Keep recent outputs, multimodal receipts and genuinely different results from identical read commands intact.

## Quality and safety

- 42 local tools and 78 automated Node suites; CI covers Node 22/24 on Windows and Ubuntu, React UI E2E, and native Windows installer smoke tests.
- The Windows installer and its SHA-256 checksum are built and verified from the **exact passing main CI commit**.
- All existing permission approvals, Git review policies, uncertain-mutation safeguards and Windows Sandbox boundaries remain in force. The AI gateway code is unchanged.
- The Code Intelligence parser extracts AST-like structural information; this does not guarantee exhaustive language-semantic resolution. CI uses scripted models and does **not** establish large-task coding reliability with real paid AI models.

## Windows installation

Download `ChatMCPSetup.exe` plus `ChatMCPSetup.exe.sha256` below. Verify SHA-256 before installing. Close ChatMCP Desktop and Hub before updating; restart after installing. Git for Windows and Edge WebView2 Runtime may be required for relevant functionality.

The self-contained Windows installer is **not Authenticode signed**. Hub, UI, Desktop and Installer all use version **3.1.1**.
