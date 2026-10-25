# Lịch sử thay đổi

## [3.10.2] — 2026-10-25 — Streaming, a model catalog, hooks and a DatGold installer (latest release)

This is the first normal release since 3.9.0. It contains everything of the test builds 3.10.0 and 3.10.1 (listed below) and what was merged after 3.10.1.

- The installer and the uninstaller say DatGold: the wizard, the shortcuts (Desktop `DatGold Studio`, Start menu folder `DatGold` with the launcher and the uninstaller) and the entry in Apps & features. An upgrade removes the shortcuts that earlier versions made under the old name, but only those that point into the installation it replaces, and the uninstaller removes both sets. File names, the install folder, the settings folder and the registry key keep the ChatMCP spelling so that an upgrade finds what 3.9.0 made (docs/NAMING.md).
- New icon: a gold "D" on the dark rounded square (installer, application and browser tab).
- The Agents tab shows the background tasks only. The sections "Nhóm trợ lý" (agent groups) and "Sửa mã" (code edits) are removed from the page; the Hub routes behind them (`/api/studio/dynamic-delegates/*`, `/delegates/*`, `/coding/*`, `/workflow`) are unchanged.
- Fix: the installer, the uninstaller and `STOP-CHATMCP-HUB.cmd` could not read the Hub's state once it had grown past 256 KiB (installer and uninstaller) or 64 KiB (the stop script). The state grows with use (445,101 bytes on one machine), so an upgrade or an uninstall of a used installation failed with "Cannot write more bytes to the buffer than the configured maximum buffer size", and the stop script ended with "Could not finish: reading the verified Hub session". All three now read up to 64 MiB. A used installation of 3.10.1 or earlier still has the old uninstaller and stop script: install this version over it, and the new setup stops the Hub itself.
- Fix: the uninstaller window shows what stopped the uninstall in a message box and returns to its question, instead of the .NET "Unhandled exception" dialog.
- Tests: the native lifecycle unit tests grew to 87 checks (shortcut migration on real `.lnk` files, the size of the Hub's answer); the hosted-runner lifecycle test checks the shortcuts of the published 3.9.0, of the upgrade and of the uninstall; a static check keeps the setup and uninstall windows from ending in the crash dialog; the PowerShell stop script is tested against a stand-in Hub whose state is 600 KB.

**Limitations:** no automated test calls a live provider. The thinking-block rules were tried once, by hand, against a real Anthropic account (claude-sonnet-5-5). The upgrade from 3.10.0 and 3.10.1 is not run by CI, which runs the upgrade from 3.9.0; `guest-lifecycle.ps1` (Windows Sandbox) is not run. The installer is not Authenticode-signed.

## [3.10.1] — 2026-10-25 — Test build: fixes and notices after 3.10.0 (pre-release)

- Fix: a Hub started from a PowerShell 7 (pwsh) session no longer hands the module path of PowerShell 7 to the Windows PowerShell that it starts, which lost `Get-FileHash`, `New-Guid`, `New-TemporaryFile`, `Format-Hex`, `Import-PowerShellDataFile` and `ConvertFrom-SddlString` without any error at start. It covers every shell of the command runner on Windows (`run_command`, background tasks, hooks that run through bash or PowerShell), the terminal, the folder picker, the DPAPI helper, the Windows Sandbox probe and the launcher.
- Fix: the uninstaller no longer leaves `Uninstall.exe` behind when it is started from a PowerShell 7 session (its self-delete helper lost `Get-FileHash`); that helper and the Hub ownership query now start Windows PowerShell without `PSModulePath`.
- Fix: agents that start together get their git worktrees one at a time per repository. Two `git worktree add` at once on one repository could make Git fail and leave an agent `uncertain` and the agents that wait for it `blocked`; the checkouts of agents that start together now run one after the other (8 agents on a tiny repository: about 0.7 s before, 1.5 s after).
- Add the license texts of what is compiled into the bundled `rg.exe` to the installer: PCRE2, 30 Rust crates and the Rust standard library, with an inventory that the installer build checks against the shipped binary, and a summary of the Microsoft C/C++ runtime terms that apply to the static C runtime in `rg.exe` and to `vcruntime140` in the CPython archive (what Microsoft publishes and what it leaves open; not legal advice). The Tree-sitter grammar notices are listed as shipped.
- Tests and CI: the narrow-window browser test no longer hangs on a late media-query event; the native lifecycle unit tests (65 checks) run in the pull request CI; a failing suite shows its whole assertion difference in the log.

**Limitations:** this is the second test build and the limitations of 3.10.0 still hold: no test called a live provider, and the part of the thinking-block work that needs a live Anthropic account (the `drop_block` beta header and the logging of input transformations) is not built. The upgrade from 3.10.0 to 3.10.1 was not run by CI, which runs the upgrade from 3.9.0.

## [3.10.0] — 2026-10-25 — Test build: streaming, thinking blocks, a model catalog and new tools (pre-release)

- The product name people read is DatGold (formerly ChatMCP). The installer, its file names, the install folder and the settings folder keep the ChatMCP name so that an upgrade finds what 3.9.0 made (docs/NAMING.md).
- Add streaming on all four protocols (Chat Completions, Anthropic Messages, Gemini, OpenAI Responses) through one SSE reader. A tool call is used only after the final event; a cut or damaged stream is never half used: the request is repeated once without a stream and the text already shown is taken back.
- Keep Anthropic thinking blocks and send them back with the result of their tool call where nothing before them changed; leave them out when the Hub shortened the history; repeat once without them if a server refuses them.
- Add a model catalog (a dated models.dev snapshot, refreshed on request) for context windows, output limits and prices, a model picker, estimated cost, and a plan that stops at the first rise of a model's price. Add presets for Grok, GLM, Qwen and MiniMax; new defaults for OpenAI (gpt-5.6-terra) and DeepSeek (deepseek-flash).
- Add thinking effort per connection, per profile and per task (Chat Completions, Responses, Messages) and a Gemini thinking level or budget.
- Add `edit_file` with several edits in one call, a PageRank `repo_map`, and ripgrep 15.2.0 (bundled in the installer) behind `search_files` and `find_files`.
- Add hooks (PreToolUse, PostToolUse, Stop, SubagentStop, TaskCompleted), project instruction files (AGENTS.md, CLAUDE.md), skills selected on the conversation and loaded on demand, automatic tool selection, results and stop notices of background agents, and an Agents tab.
- Require a per-launch secret for the Hub; the shell, the installer and the scripts present it. Filter outgoing ChatGPT Web messages for secrets, withhold protected files and offer a review hold. Cap the depth and size of model-spawned agent trees. Ship LICENSE (Apache-2.0) and NOTICE in the installer.
- Add an English version of the conversation screen, the sidebar, the Agents tab and the dialogs.

**Limitations:** no test called a live provider; streams and thinking-block replay are checked against generated streams and strict mock servers written from the vendors' documentation. The bundled ripgrep was run only by the installer build, its PCRE2 and Rust-crate notices are pending, and searching 48,000 files took 2.3 s on a developer machine (target 1 s). Qwen limits in the catalog are not checked against the vendor. The installer is not Authenticode-signed. See RELEASE-NOTES-v3.10.0.md.

## [3.9.0] — 2026-10-17 — Model profiles, evidence-oriented workflows and release safety

- Add per-task and role-specific API model profiles, encrypted local credential references, revision checks on resume, and protected origin-bound custom headers.
- Add OpenAI Responses API function calls, validated tool-result pairing, opt-in SSE completion parsing, and explicit provider probes; retain Chat Completions, Anthropic and Gemini protocols.
- Replace fixed model-context thresholds with configurable model capacity and conservative context accounting. Track actual provider usage separately from unknown token counts.
- Introduce user-priced token cost ledgers with known subtotals and unknown totals where provider metrics or prices are unavailable.
- Add first-party verification receipt invalidation after file changes and explicit owner review of objective acceptance criteria; a final model message alone is not acceptance.
- Add read-only multi-language verification discovery and deterministic reproducible regression evaluations, including browser/worktree fixture reports.
- Improve continuation after workspace-lock cleanup; preserve durable task records and original action receipts after interruption.
- Rewrite top-level README and security policy in English, retain detailed documentation under docs/INDEX.md.

**Limitations:** scripted-model tests do not establish parity with Codex, Claude Code or Antigravity; live paid-provider acceptance, signed-in Edge/ChatGPT browser behavior, offline Windows Sandbox acceptance and Authenticode signing are not claimed. Coding worktrees still require independent owner review for integration. See RELEASE-NOTES-v3.9.0.md.


## [3.8.3] — 2026-10-17 — Native upgrade lifecycle and verified Companion delivery

- Native desktop is single-instance per Windows user/session. Reopening activates the primary window; closing the GUI leaves the Hub session running without replaying tasks.
- Validate exact Hub identity/version/UI build before loading the desktop UI; show a native disconnected state instead of stale interactive task controls.
- Installer stages and validates all payload versions, stops only its verified idle Hub, preflights destinations and rolls back touched files on an installation error. Preserve user state and retain recovery evidence after an interrupted/failed rollback.
- Installer DisplayVersion comes from the compiled assembly. Explicit quiet install/uninstall uses the same guarded engine as the wizard; install logs are kept under LocalAppData/ChatMCP/logs.
- Companion 1.5.2 rejects foreign Search/form editors before inserting a draft and refuses to bind a URL from an incomplete recovery scan.
- Add Windows native-class/transaction regressions, real installed-EXE upgrade and single-instance tests, and real Chromium MV3 message delivery on scripted pages. These tests do not certify a signed-in Edge account or all ChatGPT layouts.

## [3.8.2] — 2026-10-17 — Web task delivery repair

- Separate idle URL recovery from active queued/send reconciliation; bound tab verification waits.
- Foreground newly created task tabs, support scoped modern editors, and restore a missing receiver once before claim.
- Preserve privacy-safe readiness/timeout diagnostics and all no-replay/nonce/permission guards.
- Ship Companion 1.5.1 with explicitly documented host-limited scripting permission and matching installer/ZIP hashes.
- Add executable delivery-readiness regression coverage. Live signed-in Edge verification remains an owner acceptance step.

## [3.8.1] — 2026-10-17 — ChatGPT Web Companion transport switching and URL recovery

- **Switch channel on the next message of an existing conversation:** Changing Model API ↔ ChatGPT Web creates a new linked physical task on the selected transport while retaining the same logical ChatMCP conversation and original local history. A bounded, redacted handoff is provided to the newly selected model, without covertly reusing an incompatible model session.
- **No duplicate sends on uncertain results:** Active/uncertain tasks are not silently moved mid-operation. Browser Companion does not replay an old prompt merely to recover a task's official ChatGPT conversation URL.
- **ChatGPT URL recovery:** User-initiated read-only recovery scans eligible already-open `chatgpt.com` tabs, verifies an unambiguous task ID + nonce witness and a canonical `/c/...` URL, and binds the official conversation URL only when it can prove ownership.
- **Companion 1.5.0:** Update the extension's manifest, runtime and installation instructions, and present an explicit recovery action in the desktop conversation UI. Manual Chrome/Edge Load unpacked and pairing are still required; no cookie, password or token extraction.
- **Regression coverage:** PR #42 passed 9/9 full CI, Windows/Ubuntu Browser Companion workspace regression, portable contracts, and a separately verified Browser Companion ZIP packaging workflow. Tests use scripted fixtures; live browser UI and login flow should still be checked on an owner's desktop.
- **v3.8.1 release packaging:** Ship four assets from one tagged commit: fresh Windows installer + SHA-256 and a standalone Browser Companion ZIP + SHA-256. Assert ZIP root validity and SHA-256 parity between canonical extension source, ZIP and installer payload.
- Windows installer remains unsigned by Authenticode. Browser transport is text-only and supports one active Web task at a time; Git worktrees are not OS sandboxes.

## [3.8.0] — 2026-10-16 — Native Windows Folder Picker & ChatGPT Web Companion

- Replace the packaged desktop's hidden/background PowerShell folder chooser with a native WinForms `FolderBrowserDialog` owned by the visible WebView2 desktop window. Guard the message bridge by exact localhost origin, strict request IDs and validated folder selection; the chooser does not rebind other running workspaces.
- Keep a PowerShell STA fallback for ordinary browser access. Emit sanitized exception-type diagnostics rather than a generic `powershell.exe` exit code, and provide a manual absolute-path selection option in Settings and the workspace sidebar.
- Expose an existing paired Browser Companion transport as a selectable **ChatGPT Web** mode. A user-installed Chrome/Edge extension pairs with a short-lived code and transports model responses from an ordinary signed-in `chatgpt.com` tab to the authorized local Hub; no cookies, browser session tokens or private ChatGPT API are extracted.
- Bind Web-mode tasks to the currently selected registered workspace, including independent local HubManager/Permission Gate contexts for secondary projects. Follow-up messages retain the chat's original API or Web transport, and conflicting direct-checkout writes are refused.
- Group ChatGPT Web jobs beneath their owning workspace and conversation in Background Tasks. Keep API tasks in different checkout roots independent of a running Web task.
- Expand portable, Windows STA native-picker, provider transport, selected-workspace browser continuation, pairing/security and React E2E regression coverage. The dedicated browser fixture workflow remains enabled after merging into main.
- PR #39 passed all nine CI jobs on Windows/Ubuntu Node 22/24, React E2E, production frontend build, installer/WebView2 smoke and repository hygiene; separate Browser Companion regression passed on Windows and Ubuntu.
- Browser Companion is currently text-only and handles one active Web task at a time. Real interactive chooser and signed-in ChatGPT Web UI compatibility still require a manual Windows/browser acceptance test. The installer remains unsigned without Authenticode.

## [3.7.0] — 2026-10-16 — Autonomous In-Chat Phased Workflows

- Add model-callable `spawn_workflow` to create durable, named multi-phase workflows in an ordinary coding conversation (up to five phases and twelve specialist child agents).
- Independent reviewers run concurrently on distinct Git worktrees. Later phases wait for all predecessors to succeed. Verifiers receive bounded earlier results as untrusted historical data and must inspect actual files and test evidence; branches are not auto-merged.
- The same live workflow appears in the originating chat and in Background Tasks under its exact workspace/conversation/task, displaying phases, individual agent states, durations, and available provider-reported token usage.
- Parent conversations stay interactive while workflows execute independently. Users can cancel a workflow; cancellation targets the actual child jobs and preserves uncertainty about interrupted Git mutations.
- Persist workflow DAG, phase/task IDs, parent-run links and dependencies locally; never auto-replay an ambiguous write after a restart.
- Extend real-Hub and React E2E coverage for concurrent reviewers, dependent verification, Review-mode worktree approvals, cancellation, persistence and safe descendant cleanup.
- PR #36 passed all nine CI jobs on Windows/Ubuntu, Node 22/24, real React E2E, Windows installer/WebView2 smoke and repository hygiene. Scripted tests do not verify live provider parity with Codex or Claude.
- Installer remains unsigned by Authenticode; SHA-256 ensures file integrity only. Worktree isolation is not an OS sandbox.

## [3.6.0] — 2026-10-16 — Workspace/Conversation/Task Hierarchy & Gateway Diagnostics

- Redesign the desktop workspace structure as **multiple registered local workspaces → conversations → individual execution runs → delegated subagents**. The left sidebar groups conversations by their original workspace, never shows a subagent as an independent user chat, and preserves task history across additional conversation turns.
- Replace the old conversation list in Background Tasks with **task-run records**, including distinct run IDs, original prompts, execution status, parent-run-linked subagents, and independent Stop actions. Conversation-wide token telemetry is labeled explicitly; it is not reported as per-task billing.
- Allow a native Windows directory picker to add or activate another workspace while unrelated background agents continue working. Keep separate project roots independent, with Git worktree isolation for overlapping writes. Non-Git folders remain selectable and display no branch list instead of throwing HTTP 409.
- Bind newly started tasks to the registered folder chosen by the user. Restrict legacy Studio Inspector actions to the primary workspace to avoid silent wrong-project edits when viewing a secondary project.
- Extend API connection probes and tool-calling probes to **20 seconds each**, with adequate total diagnostic timeout. Keep strict explicit protocol selection and avoid forwarding stored keys to other provider origins.
- Add synthetic regression coverage for native Anthropic, OpenRouter, DeepSeek, OpenAI and Gemini routing, protected credential separation, multiple independent workspaces, per-conversation follow-up task runs, and parent-run-scoped subagent metadata.
- PR #33 passed the full nine-job GitHub Actions CI matrix on Ubuntu/Windows, Node 22/24: Hub tests, React E2E, frontend, Windows installer/WebView2 smoke and repository hygiene. Live paid gateway quality and safe real Windows Sandbox guest acceptance remain unverified.
- Git worktrees are not operating-system sandboxes. The installer remains **unsigned** (no Authenticode publisher identity); verify SHA-256 for file integrity.

## [3.5.0] — 2026-10-16 — Concurrent Chats, Background Agents & Desktop Workspace

- Enable independent concurrent API coding conversations with a persistent task registry, Git worktree-backed isolation for overlapping writing, and explicit dependency queues.
- Add model-initiated `spawn_agent` delegation directly within chat, with visible parent/child links, independent task progress and cancellation through the Background Tasks panel; remove the legacy standalone "Trợ lý" interface.
- Allow the user to send further messages while a task is running; deliver new instructions at a model-turn boundary without cancelling or replaying in-flight tool mutations.
- Add inline branch/worktree selection and attach/paste/drag-drop of images and source files. Forward images using OpenAI Chat Completions, Anthropic Messages and native Gemini formats; reject images clearly on minimal text-only Gemini gateways.
- Group consecutive tool calls into expandable one-line activity summaries; supplement old-output compaction with structured rolling context checkpoints that preserve recent paired tool call/result records.
- Harden worktree cancellation and recovery: revoke pending approvals on Stop and record uncertain Git mutations for review instead of blindly retrying or discarding them.
- Expand regression coverage for concurrent worktree sessions, task dependencies, injected chat messages, model-driven subagent spawning, media adapters and interrupted worktree preparation.
- Verified the feature integration with nine successful CI jobs in PR #31 (Ubuntu/Windows Hub tests on Node 22/24, React E2E, frontend build, installer/WebView2 smoke and hygiene); subsequent release-commit CI and release workflow re-verify the versioned output.
- The installer remains unsigned with Authenticode; worktrees are not operating-system sandboxes. Live-model success rates and parity with proprietary coding agents have not been independently established.


## [3.4.2] — 2026-10-15 — Custom Gateway Protocol Selection & Settings Reliability

- Fix custom OpenAI-compatible gateway selection from a previous custom Gemini connection. React preserves the same base URL/model and exposes custom Gemini/Anthropic choices, rather than overwriting the intended host with a generic default.
- Preserve the existing Windows DPAPI-protected API key only when switching between custom protocols on the same HTTPS origin; unrelated named-provider switches and any origin change still require fresh authentication.
- Save the explicitly selected wire protocol and verify the applied Hub state, with visible unsaved-settings and inline save errors rather than a transient toast only.
- Make React's Save & Test diagnostic strict about the selected protocol so it cannot silently auto-switch OpenAI to Gemini. Optional explicit auto-discovery via other callers remains available.
- Add gateway protocol/key-isolation unit tests, config-form unit tests, and React-to-Hub E2E coverage without using any real credentials.
- Windows installer remains unsigned. Scripted CI does not certify every live gateway/model combination.


## [3.4.1] — 2026-10-15 — Retry/Continue and Bounded Repo Map Preflight

- Fix API agent `queued` hangs with a cancellable 90-second preflight watchdog; preserve task ID, transcript and safe retry without model quotas (PR #28).
- Fix ChatGPT Web continuation packets that remain unclaimed by Companion with a 120-second unsent-only watchdog; no automatic replay of uncertain actions (PR #28).
- Bound automatic Repo Map preflight to 240 entries, 320 directories, 100 quickly parsed files and a 12-second budget; avoid optional Tree-sitter/Python startup in the preflight path.
- Report `repo_map_started` and `repo_map_skipped`; fall through to the AI model when optional indexing is unavailable.
- Add large-source-tree regression and cancellation checks; CI is scripted-provider, not live-model acceptance.
- Installer remains unsigned; SHA-256 verifies download integrity but not publisher identity.


## [3.4.0] — 2026-10-15 — Reliable Agent Runtime and Workflow Upgrades

- Remove all ChatMCP-imposed HTTP model request, input/output token and shared-worker quota ceilings. Keep task-level telemetry of real sends, including retries, plus provider-reported input/output, cache-hit/cache-creation and reasoning token details. API billing remains controlled by the user's provider.
- Expand from 95 to 99 registered LocalTools, with four in-process routers and optional task-aware direct tool selection. Existing PermissionGate and Skills Hub remain unchanged; no Hooks or external MCP client.
- Add evidence-aware task objectives/dependencies and explicit warnings when verified file edits, passing project checks or Git-diff review receipts are absent.
- Add browser ARIA snapshots, assertions, role/name locators and task-scoped local Playwright trace ZIPs, which may contain sensitive page data.
- Add guarded multi-file LSP rename operations with review manifests, SHA-256 revision checks, full targeted checkpoint coverage, source mode preservation and best-effort conflict-aware rollback.
- Add deterministic and opt-in model-assisted worktree DAG planning with owner review before any worker run.
- Add a benchmark summary CLI for externally graded matched coding tasks; reports are diagnostic and do not establish parity with Codex or Claude Code.
- Windows Sandbox is unchanged; its guest security acceptance is not certified by this release. Windows installer remains unsigned, with SHA-256 integrity assets.


## [3.3.0] — 2026-10-15 — Local Agent Capabilities & Token Optimization

- Expand ChatMCP local coding toolkit to 95 LocalTools with four internal function routers, configurable direct-tool limit (default 95) and improved Gemini text-only schema budgeting. No external MCP client or Hooks were introduced.
- Add Playwright-driven browser inspection, screenshots, responsive/accessibility checks, local Node inspector debugging, bundled-LSP refactoring previews, build/test discovery and execution, GitHub CI/review/release helpers, safe network/document lookup and workspace tool extensions.
- Add reversible internal RTK-inspired CLI output reduction, Headroom-style context compaction and Caveman-inspired concise agent messaging; profiles off/safe/balanced/aggressive and local restoration receipts. These are internal techniques, not bundled third-party RTK, Headroom or Caveman applications.
- Keep PermissionGate, workspace restrictions, tool evidence and model transcripts; provide configurable `CHATMCP_DIRECT_TOOL_LIMIT` to reduce model schema cost when needed.
- User requested merge and release without checking CI as a publication gate. Installer generation and SHA-256 integrity verification remain required for publication.
- Windows installer remains unsigned; full clean-Windows Sandbox/VM installation, live paid-model quality and browser runtime across all machines are not certified.


## [3.2.0] — 2026-10-15 — Bundled Windows Code Intelligence

- Package pinned TypeScript / Pyright language servers and Tree-sitter WASM grammars for JavaScript, TypeScript, TSX and Python.
- Include official SHA-256-pinned CPython 3.11.9 embeddable runtime and zero-dependency heuristic fallback.
- Use bundled Node and embedded CPython for installed Code Intelligence, auto-initialize LSP, expose explicit engine health tests and run real-engine build checks.
- Preserve workspace permission gates and reject missing or tampered staged runtime files.
- Installer is unsigned; clean Windows VM/offline acceptance is excluded from this release gate and has not been verified.

## [3.1.2] — 2026-10-15 — Hybrid Code Intelligence and secure AI Profiles CI repair

- Integrate capability-aware, three-tier Code Intelligence: optional LSP for cross-file symbol definitions/references, optional Tree-sitter WASM and Python native AST for syntax, and the existing zero-dependency structural heuristic parser as a fallback.
- Wire StudioIntelligence into LocalTools while retaining the six public Code Intelligence tool names. Language servers, WASM grammars and the Python runtime are optional dependencies and may require separate installation.
- Keep Windows API profile keys protected by DPAPI; never reinstate the insecure Base64 fallback, and keep production storage fail-closed outside Windows when DPAPI is required.
- Fix Ubuntu Node 22/24 `verify-phase3-features.mjs`: inject an explicitly test-only AES-256-GCM keyStore; verify no plain or bare-Base64 key is persisted, verify decrypt after reload and verify production rejects saving keys without DPAPI.
- Confirm the complete 78-suite Node test matrix (Windows/Ubuntu, Node 22/24), both browser E2E jobs, frontend build, Windows installer smoke and same-CI-run SHA-256 checks before release.
- Bump Hub, React UI, Desktop and Installer to 3.1.2; preserve all older release tags and API gateway implementation.

## [3.1.1] — 2026-10-15 — Code Intelligence and Smart Context CI repair

- Ship six Code Intelligence tools (repo map, symbols, go-to-definition, references, dependency graph and diagnostics), with the production async workspace resolver, canonical Windows/Junction path handling and protected-path containment.
- Integrate bounded, query-aware Repo Map as untrusted task context and compact a **model request copy** of older tool results while preserving call IDs, real result differences, recent evidence, multimodal data and the complete canonical transcript.
- Align version identifiers for Hub, Desktop, Installer and UI at 3.1.1; retain the previous v3.1.0 tag unchanged because it points to a commit with failed CI and its release had no Windows installer.
- Update 42-tool schemas/contracts and 78 Node regression suites. Require Windows/Ubuntu Node 22/24 tests, browser E2E and a SHA-256 verified self-contained Windows installer before publication.
- Gateway code and the existing user permission/security boundaries remain unchanged. CI uses scripted providers; long-task quality with live paid models is not established.

## [3.1.0] — 2026-10-14 — Code Intelligence & Smart Context (tagged, installer not released)

- Add the zero-dependency Code Intelligence Engine with six local read-only tools: `repo_map`, `code_symbols`, `find_definition`, `find_references`, `dependency_graph`, and `code_diagnostics`. The current LocalTools catalog has 42 tools.
- Support the actual asynchronous StudioWorkspace resolver and guard workspace boundaries and protected paths in code intelligence reads.
- Attach a bounded Repo Map as explicitly untrusted user-level task data and compact only a copy of older tool history while retaining call IDs and the canonical transcript.
- Preserve different results from identical read-only tool arguments (files and Git diffs may have changed) and preserve multimodal outputs and the latest tool receipts.
- Add Code Intelligence and Smart Context Compaction regression suites to the Hub's `verify-*.mjs` CI discovery (78 Node suites).
- The v3.1.0 tag was published with no Windows installer while CI on its commit was failing; this is a historical release entry. The tested, packaged correction is v3.1.1.

## [3.0.4] — 2026-10-14 — Goal-aware agent planning and adaptive recovery

- Propose and persist a structured multi-stage plan for clearly multipart user tasks without changing the initial user message or escalating permissions.
- Recognize repeated unchanged read/search evidence across equivalent tools and queries, while exempting legitimate process polling and distinct source ranges.
- Validate local file changes independently using fresh SHA-256 reads; record successful approved verification commands from actual exit code 0 without trusting model narration.
- Issue at most two strategic recovery prompts at repetition thresholds before safely stopping with a resumable checkpoint and specific `progress_stalled` reason.
- Persist goal-plan and host evidence summaries into durable task history and reports, adding deterministic `verify-agent-autonomy.mjs` regression coverage (76 Node suites total).
- Preserve gateway configuration and permission, Git review, Windows Sandbox, and uncertain-operation safeguards.
- Synchronize Hub, UI, Desktop, and Installer versions to 3.0.4. The unsigned Windows installer is released with a CI-verified SHA-256 checksum; full live-model coding quality has not yet been independently established.

## [3.0.3] — 2026-10-14 — Progress-aware agent loop safeguards

- Detect repeated identical tool calls and results without changing the model provider or gateway networking behavior.
- Warn after four consecutive repeated results; stop safely with `progress_stalled` after ten and retain the task checkpoint for explicit continuation.
- Persist bounded host-owned progress evidence (inspected targets, edit attempts, verification attempts and result fingerprints) in task history, reports and across Hub restarts; do not treat an edit attempt as a verified change or test pass.
- Exclude normal process-output polling from stagnation detection and add `verify-agent-progress.mjs` regression coverage.
- Retain permissions, uncertain-operation safeguards, Git review and Windows Sandbox policies. This release does not yet automatically decompose large tasks or prove long-task completion with a paid AI provider.
- Synchronize Hub, UI, Desktop and Installer to 3.0.3; release the Windows installer with a verified SHA-256 checksum (unsigned Authenticode).

## [3.0.2] — 2026-10-14 — Clearer Skills, Agents and readable output

- Improve UI typography, spacing and text contrast so navigation, chat messages and inspector panels are easier to read.
- Show installed GitHub Skills with their current state and actions to enable, disable, update or uninstall them; keep installation feedback in sync with the local library.
- Simplify the Agents workspace with plain-language guidance, clear task choices and advanced controls available when needed.
- Keep expanded tool output readable in light and dark themes and provide visible copy actions for responses and streaming text.
- Synchronize Hub, UI, Desktop and Installer versions to 3.0.2.

## [3.0.1] — 2026-10-14 — Gemini JSON and local tool routing fixes

- Gemini text-only requests use one consistent JSON action contract for progress, built-in tools, MCP routers, historical actions and bounded repair requests.
- Preserve tool-error, permission and unknown-outcome safeguards when adapting legacy agent instructions to text-only gateways.
- Resolve registered local short names such as `read_file`, `run_command` and `find_files` inside `mcp_call` and `mcp_describe`, while preserving exact catalog matches, schema validation and permission checks. Unknown names remain rejected without execution.
- Add regression coverage for Gemini direct-tool recovery and local router aliases; align the HTTP 413 fixture with the documented 32 KiB minimum request budget.
- Synchronize Hub, UI, Desktop and Installer versions to 3.0.1. Installer assets include SHA-256 checksums and are not Authenticode-signed.

## [3.0.0] — 2026-10-14 — Autonomous Coding, Native Sandbox Verification & Multi-Agent Worktrees

> **Correction (added after 3.9.0; the text below is kept as it was published).** The first bullet of this entry overstated what shipped.
> - "Chống giả mạo HMAC-SHA256" (HMAC-SHA256 anti-forgery) is not a guarantee. In the `diagnostic-hmac` protocol the Hub stages the HMAC key in a folder that the guest can read (`lib/windows-sandbox-driver.mjs`), so a receipt that verifies shows only that the bytes were not changed in transit, not that the code under test did not write them. The code itself calls this "a temporary diagnostic transport, NOT an attested ACL guarantee" and says the legacy HMAC "supplies no authenticated Node test-outcome authority" (`lib/windows-sandbox-publisher.mjs`).
> - "Windows Sandbox isolation", "zero-fallback privilege drop", "Job Object containment" and "black-box verification" name implemented code paths and design goals. No CI job launches a Windows Sandbox guest (`tests/windows-sandbox/smoke.mjs` says so itself and only exercises host-side fixtures and the Job Object supervisor); real-guest acceptance was recorded by hand for specific builds under `docs/agent-handoffs/` and is not repeated for each release. Read the entry as "implemented, experimental, checked manually for particular builds", not as continuous isolation, attestation or certification of test results.
> - Git worktrees, host commands and the "sandbox-only" execution policy are not operating-system sandboxes.
>
> *Đính chính (tiếng Việt):* HMAC trong chế độ `diagnostic-hmac` chỉ kiểm tra tính toàn vẹn khi truyền, vì khóa nằm trong thư mục mà máy khách (guest) đọc được. Các mục "cô lập Windows Sandbox / Job Object / xác minh black-box" là mã đã triển khai ở mức thử nghiệm: CI không khởi chạy guest Windows Sandbox thật, việc nghiệm thu guest thật chỉ được ghi tay cho từng bản dựng, nên đó không phải bằng chứng cô lập liên tục hay chứng nhận kết quả kiểm thử.

- **Phase 1 (Windows Sandbox Isolation & Native Black-box Verification):** Giao diện và kiến trúc thực thi kiểm thử độc lập black-box trong Windows Sandbox với `system-sealed-exit-v1`, zero-fallback privilege drop, Job Object containment, chống giả mạo HMAC-SHA256 và quy trình vòng đời cài đặt máy sạch (G6 Clean Windows).
- **Phase 2 (Reliable Coding Recovery Checkpoints):** Nhật ký khôi phục sự cố (crash recovery journal) với chuỗi băm mật mã SHA-256 tamper-evident, cơ chế cô lập trạng thái lỗi (corruption quarantine), xác nhận phục hồi bền vững (recovery acknowledgement) qua các lần restart Hub và xem trước context an toàn.
- **Phase 3 (Dependency-Aware Multi-Agent Coordination):** Điều phối đồ thị phụ thuộc tác vụ (DAG A → B → C và no-op handling), công nhân độc lập trên Git worktree thật với giới hạn đồng thời, hủy bỏ tác vụ an toàn, chặn tác vụ hạ nguồn khi phụ thuộc thất bại và phòng chống xung đột cấu trúc file-vs-directory.
- Đồng bộ hợp đồng giao diện React/Vite/Tailwind, loại bỏ các trạng thái giả định, xác thực mã băm SHA-256 của bundle cài đặt tự chứa.

- Map real AgentRunner summaries and full conversation records through a typed React adapter; use canonical task states for Stop/Resume and retain drafts after failed sends.
- Show actual PermissionGate pending requests and decision history, including structured command/content previews and expiry; no automatic approval.
- Create a blank conversation without calling a model. Replace synthetic plan/stage completion with persisted plans and actual tool evidence.
- Read task activity, Git changes/diffs and terminal output from their existing APIs; surface request failures. Mount task SSE with scoped deltas and state reconciliation after reconnect.
- Connect onboarding workspace and permission selections, reuse the actual AI configuration/test form, and stop reporting a failed browse as a selected workspace.
- Clear typed API keys after saving and on destination changes; remove stale RBAC and static health claims from local Settings.
- Serialize concurrent research snapshot writes and wait for all active workers after a persistence failure before releasing the run.
- Add regression coverage for the current React components and adapters. Release number and the published v2.6.0 tag remain unchanged.
- Add current React/real-Hub Playwright scenarios with a scripted local provider, strict no-skip CI gates, pinned Python E2E dependencies, and a native WinForms/WebView2 smoke harness.
- Package tracked runtime sources and fresh UI output only; exclude local state, imported skills and development dependencies, and validate staging cleanup paths.

## [2.6.0] — 2026-10-12 — Local-only Windows release

- Removed Render, Docker public server, public auth/workspaces/tenancy, Linux execution broker and legacy Cloud Harness MCP proxy backend.
- Removed obsolete Cloud Harness setup snapshot, bootstrap scripts, cloud-only tests and mutation fixtures.
- Hub now accepts local-only startup flags and binds to 127.0.0.1; hosted/public settings fail closed.
- Preserved desktop coding agents, Git worktrees, browser companion, AI gateway, GitHub Skills Hub and optional local test sandbox.
- Reworked README, SECURITY, Windows Setup and deployment retirement notice; retained historical notes without treating retired capabilities as supported.
- Version 2.6.0 is built from a CI-verified commit and checked with SHA-256. Authenticode signing, live-provider E2E and a clean-Windows VM installation/upgrade smoke test were not established by CI.


## [2.5.0] — 2026-10-12 — Multi-Agent coding worktrees, GitHub Skills Hub & hardening

Bản này nối tiếp bản cài đặt `v2.4.0` (giao diện React/Vite/Tailwind, đã phát hành riêng); `v2.4.0` không bị sửa hay gắn lại. Số phiên bản của Hub, Desktop, Installer và giao diện được đồng bộ về `2.5.0`.

### Bảo mật và độ tin cậy (PR #2)

- **Khôi phục checkpoint an toàn:** bắt buộc `expectedShas` cho mọi file, từ chối bản cũ bằng HTTP 409 (`stale_state`), có preview/dry-run, sao lưu hoàn tác trước khi ghi, và chặn khi agent đang chạy (`task_in_progress`). Giao diện luôn gọi preview trước khi khôi phục.
- **Skill ID và hệ thống tệp:** chuẩn hóa ID, từ chối `..`, dấu `/` `\`, đường dẫn tuyệt đối và tên thiết bị Windows (`CON`, `NUL`, `COM1`…); kiểm tra containment và symlink trước khi cài/gỡ; bỏ ID cũ không an toàn khi nạp.
- **SSRF khi cài skill từ URL:** phân giải DNS trước khi tải, chỉ chấp nhận IP công khai (chặn loopback, RFC 1918, CGNAT, link-local, metadata, IPv6 ULA và IPv4-mapped), kiểm tra lại từng bước chuyển hướng, giới hạn 512 KB và thời gian chờ.
- **Nguồn gốc và giấy phép:** bỏ nhãn `github-verified` và SHA commit giả khỏi danh mục; giấy phép tự khai không được coi là đã xác minh quyền phân phối lại (`redistributable: false`).
- **Chọn skill:** chỉ đưa vào ngữ cảnh khi đủ liên quan (ngưỡng điểm), có ngân sách ngữ cảnh; lỗi ghi lockfile không bị nuốt.

### Tính năng

- **Parallel Coding Agents (beta):** Git worktrees/branches riêng cho từng coding worker (tối đa 4, song song tối đa 3), công cụ đọc/sửa file giới hạn, không shell/network/Git push trực tiếp. Có integration branch và Draft PR theo từng worker khi người dùng xác nhận. Git worktrees không phải OS sandbox.
- **Agent Skills Hub (beta):** Tìm SKILL.md lồng nhau từ GitHub tree revision được ghim; nhập tài nguyên nhị phân và văn bản theo hạn mức và kiểm tra SHA; quản lý nguồn được phép, xem/cập nhật revision, lưu giấy phép dạng evidence (không tự suy ra quyền redistribution).
- **README & desktop documentation:** Cập nhật trải nghiệm bắt đầu (Việt/Anh), yêu cầu review Git diff gắn SHA trước khi tích hợp coding workers, điều kiện release Windows .NET 10, SHA-256 và kiểm thử installer trên máy sạch.
- **Windows packaging:** Build UI mới trước khi đóng gói, xác thực .NET SDK 10/Node.js 22+, self-contained Windows publish, tạo installer checksum và CI job build Windows installer.
- **Review & registry integrity:** Coding workers/integration branch yêu cầu diff preview có revision token trước khi merge/publish; Skills Registry giữ chỉ mục cũ khi refresh GitHub thất bại và dùng ID ổn định theo source path.
- **Validation:** Mở rộng `verify-phase4-features.mjs` để kiểm tra real Git worktrees, agent tool permissions và GitHub skill blob integrity. Phải nghiệm thu CI và thử installer trên Windows sạch trước khi phát hành.



Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/). Phiên bản Hub (`CHATMCP-HUB/package.json`) và UI_BUILD hiện tại (`2.6.0-react-agent`) được đồng bộ; bản 2.5.0 được giữ trong phần lịch sử.

Các bản trước 2.3.0 (2.0.0 … 2.2.8) có ghi chú riêng ở `CHATMCP-HUB/STUDIO-*.md`, `UPGRADE-*.md`, `TEST-RESULTS-*.txt`; chúng là tài liệu lịch sử và không được cập nhật.

## [2.3.0] — nhánh `dev/chatmcp-agent` (đã gộp vào `main`; không có tag riêng)

Mục tiêu của bản này: biến Hub thành một **AI Coding Agent chạy được trên Windows 11 cho một người dùng**, không cần Docker, Cloud Harness hay Desktop Commander. Nhãn từng tính năng nằm ở [README.md](README.md); báo cáo và bằng chứng ở [docs/PHASE1-REPORT.md](docs/PHASE1-REPORT.md).

### Thêm

- **Backend `local` (mặc định):** Hub tự chạy vòng lặp agent và các công cụ trong chính tiến trình của nó (`lib/local-tools.mjs`, 36 công cụ: đọc/liệt kê/tìm file, `git_status/diff/log/add/commit/branch`, ghi/sửa/đổi tên/xóa, `run_command`, kế hoạch). Backend `mcp` (Cloud Harness + Desktop Commander) vẫn còn, ở vai trò cũ (legacy), `--backend mcp`.
- **Ba chế độ quyền:** `Chỉ đọc` (mới), `Review`, `Tự động`; `manual` là tên cũ của `Review`. Khung duyệt hiển thị lệnh/diff nguyên văn, có đồng hồ hết hạn 10 phút (hết hạn = từ chối).
- **Phân tích lệnh shell** (`read`/`verify`/`edit`/`exec`/`dangerous`), **vùng cấm file bí mật** (`.env*`, khóa riêng, `.git`…), đi theo đường dẫn thật qua symlink/junction/tên 8.3/ổ đĩa ảo PowerShell (`lib/command-paths.mjs`), kiểm tra cấu hình Git của kho trước khi chạy `git` (`lib/git-trust.mjs`), `ShellRunner` (Git Bash trước, PowerShell sau; stdin đóng; timeout giết cả cây tiến trình; xóa biến môi trường dạng khóa).
- **Checkpoint trước mỗi thay đổi**; không tạo được thì thao tác không chạy (`checkpoint_failed`).
- **Lớp model nhiều nhà cung cấp:** Anthropic Messages, OpenAI-compatible (đã làm chắc), Gemini; 12 provider presets available in that release (Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek, Groq, Mistral, Ollama, LM Studio, 3 gateway tùy chọn); tải danh sách model; **thử tool calling** khi kiểm tra kết nối; thử lại có giãn cách; rút gọn ngữ cảnh có kiểm soát; che bí mật trong lỗi/nhật ký.
- **Lưu API key:** Windows DPAPI (đã thử vòng khứ hồi thật trên Windows); AES-256-GCM trên Linux/macOS; hoặc dùng biến môi trường; hoặc chỉ giữ trong bộ nhớ.
- **Máy trạng thái tác vụ chuẩn** với 11 trạng thái (`created`, `queued`, `planning`, `running`, `waiting_approval`, `verifying`, `paused`, `completed`, `failed`, `cancelled`, `uncertain`) và lịch sử chuyển trạng thái. **Phục hồi phiên không phát lại thao tác ghi chưa rõ kết quả**: tác vụ vào `uncertain`/`paused`, bạn xem Git diff rồi quyết định.
- **Bằng chứng do Hub ghi** (số thao tác sửa file thành công, lệnh kiểm tra đã chạy và thoát mã 0) hiển thị dưới kết quả; "Hoàn tất" không còn đồng nghĩa với "đạt".
- **Giao diện:** hộp thoại thiết lập 4 bước lần đầu, form nhà cung cấp, công tắc quyền cạnh ô nhập, khung duyệt phía trên ô nhập, banner cho trạng thái dừng giữa chừng, thẻ kế hoạch của agent, tiêu đề tab báo "Cần duyệt".
- **Launcher Windows độc lập** `START-CHATMCP-HUB.cmd` / `STOP-CHATMCP-HUB.cmd`: chạy Hub ở nền, chờ kiểm tra sức khỏe, dùng lại Hub đang chạy, không đụng cổng của chương trình khác, không đổi ExecutionPolicy.
- **Bộ kiểm thử:** bộ chạy chung `npm test` (46 bộ kiểm thử Node lúc phát hành 2.3.0, mỗi bộ một tiến trình, có `--json`/`--filter`/`--no-skip`; có cả bộ kiểm tra chính bộ chạy test, bộ đối chiếu tài liệu với mã và bộ kiểm tra công cụ đột biến), 5 bộ giao diện Playwright (`--python`), khung E2E với **mô hình giả có kịch bản** (6 kịch bản: FastAPI thật, sửa lỗi, Git/nhánh, phục hồi phiên, cô lập hai người dùng ở mức Hub, kho độc hại), công cụ **kiểm thử đột biến** `tests/mutation/run-mutations.mjs` (hỏng mã một chỗ nhỏ mỗi lần trong bản sao tạm, xem bộ test có nhận ra không) cùng 4 danh sách đột biến đã dùng (xem DEVELOPMENT.md). CI: `.github/workflows/ci.yml` (Linux + Windows × Node 22/24, mọi action ghim theo SHA; **chưa chạy trên GitHub**). Bản cập nhật workflow (cài Python cho bộ FastAPI, job giao diện Chromium, `--no-skip all` để một bộ bị bỏ qua không làm CI xanh giả) **chưa được áp dụng**: công cụ của phiên làm việc không được ghi vào `.github/workflows/`, nên bản đề xuất nằm ở [docs/ci-proposal.yml](docs/ci-proposal.yml) và báo cáo Phase 1 hướng dẫn cách áp dụng.
- **Tài liệu:** README, ARCHITECTURE, DEVELOPMENT, WINDOWS-SETUP, USER-GUIDE, TROUBLESHOOTING, DEPLOYMENT, SECURITY, TESTING-WITH-REAL-MODELS, THIRD-PARTY-NOTICES, PHASE0-AUDIT, PHASE1-DESIGN, PHASE1-REPORT.
- **Chế độ công khai và tự host (Phase 2):** Bật bằng `CHATMCP_PUBLIC=1`. Đăng nhập token chủ sở hữu (`CHATMCP_OWNER_TOKEN`), so sánh constant-time, cookie phiên `__Host-chatmcp_session` (`HttpOnly`, `Secure`, `SameSite=Strict`), CSRF theo phiên, chống brute-force theo IP và toàn cục. Cổng kiểm tra mặc định từ chối (`lib/public-gate.mjs`) trước mọi route nội bộ.
- **Tách quyền tiến trình Linux (Docker):** `docker/supervisor.mjs` (root, tini) khởi chạy Hub dưới quyền user không đặc quyền `hub` (uid 10000). Môi giới lệnh qua socket Unix (`lib/exec-broker.mjs`) khởi chạy lệnh workspace dưới quyền user `agent` (uid 10001) với `no_new_privs` và tước toàn bộ capabilities.
- **Đóng gói Docker và Render:** `Dockerfile` phân tầng bảo mật, `docker-compose.yml`, `.env.example`, `render.yaml` cho Render free tier (giới hạn heap Node 192 MB, tương thích 512 MB RAM). Đã build ảnh `chatmcp:latest` và vượt qua 51/51 bộ test trong container.
- **Quản lý Workspace từ xa & GitHub PR:** `lib/workspaces.mjs` hỗ trợ clone an toàn qua HTTPS, giới hạn dung lượng kho, push lên nhánh cô lập `chatmcp/...`, tạo Pull Request qua GitHub REST API (`POST /api/workspace/pr`), và tải tarball workspace.
- **Streaming thời gian thực (SSE):** `GET /api/tasks/:id/stream` và `GET /api/tasks/events` truyền sự kiện trạng thái và từng token văn bản từ mô hình; giao diện React cập nhật hiệu ứng gõ chữ trực tiếp với con trỏ nhấp nháy.
- **Công cụ xoay token Cloud Harness** (`scripts/Rotate-CloudHarnessToken.ps1`, mặc định chỉ xem trước) và khóa phiên bản phụ thuộc bên thứ ba (`deps/`).
- **Khóa đồng thời Workspace (Phase 3):** `lib/workspace-lock.mjs` bảo vệ workspace bằng khóa nguyên tử `.chatmcp-workspace.lock`, kiểm tra liveness của PID qua `process.kill(pid, 0)` và tự động giải phóng/thu hồi khóa chết (dead PID hoặc quá 30 phút).
- **Quản lý Đa cấu hình AI (Phase 3):** `lib/ai-profiles.mjs` hỗ trợ lưu trữ nhiều cấu hình mô hình (Claude 3.5 Sonnet, GPT-4o, Gemini, Ollama) trong `ai-profiles.json`, che giấu API keys trong snapshot/list, mã hóa qua KeyStore, và chuyển đổi profile mặc định linh hoạt.
- **Động cơ Sandbox hợp nhất (Phase 3):** `lib/sandbox-engine.mjs` cung cấp tầng trừu tượng thực thi linh hoạt (`host`, `broker`, `isolated`), áp dụng hạn ngạch tài nguyên (timeout, RAM, CPU, max output bytes), thu thập số liệu thời gian thực và mã thoát.
- **Chế độ Full Access 1-Click trên UI (Phase 3):** Bổ sung nút chuyển đổi Full Access trực tiếp trên thanh công cụ Composer (`react-app.js`, `react.css`) với hộp thoại xác nhận tường minh, cảnh báo viền đỏ, tự động hạ cấp chính sách khi đổi sang chế độ an toàn, và duy trì nguyên tắc fail-closed bất biến đối với các tệp nhạy cảm (`.env`, `.git/`, DPAPI keys).
- **Chợ kỹ năng & Quản lý Plugin (Phase 4):** `lib/plugins.mjs` cung cấp danh mục marketplace tuyển chọn (Git Workflow Pro, Python Architect, Docker DevOps, SQLite Explorer, Web Researcher, Security Guard), quản lý vòng đời plugin (cài đặt, gỡ bỏ, bật/tắt, manifest tùy chỉnh) và tự động hợp nhất các prompt chuyên môn cùng công cụ vào vòng lặp của Agent.
- **Phân quyền người dùng RBAC (Phase 4):** `lib/governance.mjs` triển khai ma trận kiểm soát truy cập theo 3 vai trò (`viewer`, `developer`, `admin`), chặn đứng mọi hành vi can thiệp trái phép hoặc leo thang đặc quyền.
- **Cô lập ranh giới Tenant Workspace (Phase 4):** Quản lý không gian làm việc theo tổ chức/người thuê (`tenantId`), ngăn chặn truy cập, khóa hoặc xuất dữ liệu chéo giữa các tenant.
- **Nhật ký kiểm toán Doanh nghiệp (Phase 4):** Ghi nhận có cấu trúc (append-only JSONL) mọi hành động trọng yếu vào `enterprise-audit.jsonl` và hỗ trợ truy vấn lọc theo hành động, người dùng và số lượng bản ghi.

### Thay đổi

- Backend mặc định là `local` (trước đây phải có Cloud Harness). `--backend mcp` giữ hành vi cũ.
- Lớp provider chỉ-Gemini được tổng quát hóa thành bộ chuyển đổi trung lập (`standard-adapter`); đường Gemini cũ được giữ.
- Terminal: tự lùi về pipe khi `node-pty`/ConPTY không có hoặc hỏng; đóng terminal được chờ đầy đủ; dừng bằng nhóm tiến trình; đường dẫn checkpoint chuẩn hóa (`d6f2817`).
- Chế độ "ChatGPT Web" được gắn nhãn **legacy / thử nghiệm cục bộ** (người dùng tự đăng nhập; Hub không đọc cookie/phiên).
- Giao diện báo "Tự động" đúng hành vi: công cụ chưa phân loại bị **từ chối** (trước đây nhãn ghi là "vẫn hỏi").

### Sửa

- `Stop-ChatMcpHub` và thừa kế pipe của tiến trình con làm `Start` treo.
- Bốn script `CHATMCP-HUB/windows/` (smoke, soak, watchdog, kiểm tra gateway) ghi cứng phiên bản 2.2.x nên báo sai với Hub 2.3.0; nay lấy phiên bản từ `package.json` và bản dựng giao diện từ `/api/health`. `Run-StudioSoak` trước đây thoát mã 0 dù Hub không trả lời mẫu nào; nay thoát 1 nếu có mẫu xấu.
- Các lỗ hổng do kiểm thử đối kháng tìm ra và đã đóng (mỗi mục có test hồi quy): lệnh "chỉ đọc" đi theo symlink tới file bí mật; `core.fsmonitor` và hook `pre-commit` của kho tải về chạy chương trình; ổ PowerShell (`Env:`, `HKCU:`, `FileSystem::`) và `ps e` lộ bí mật; bộ lọc môi trường bỏ sót `PGPASSWORD`, `MYSQL_PWD`, biến kết thúc bằng `_KEY` và URL có mật khẩu. Chi tiết ở [SECURITY.md](SECURITY.md).
- Lỗi flaky trong `tests/verify-task-state.mjs` do va chạm khóa file trong atomic rename trên Windows được xử lý bằng cách chờ disk write và catch transient lock.
- Lỗi biến môi trường daemon thừa kế trong `tests/run-all.mjs` khi chạy trong container Docker với `CHATMCP_PUBLIC=1` và `CHATMCP_EXEC_MODE=broker`.
- Trùng mẫu đột biến trong `verify-docs.mjs` khi triển khai `createPullRequest` (sử dụng `github_token_missing`).

### Bảo mật

- Các phát hiện Phase 0 (S1–S4, token Cloud Harness trong lịch sử Git công khai, dữ liệu trạng thái trong lịch sử, định danh cá nhân, telemetry của Desktop Commander) được **ghi lại và đang chờ chủ sở hữu quyết định**; chưa ai xoay token, chưa ai viết lại lịch sử Git. Xem [SECURITY.md](SECURITY.md).
- Giới hạn đã biết (chưa khắc phục) được liệt kê đầy đủ ở SECURITY.md, trong đó: Hub không có xác thực khi ở chế độ cục bộ nên **chỉ chạy ở loopback cho một người dùng**; đa người dùng **bị chặn**.
- Khi mở ra mạng công cộng (`CHATMCP_PUBLIC=1`), bắt buộc có token chủ sở hữu mạnh, cookie phiên an toàn và tách quyền người dùng Linux.

### Vệ sinh repository

- Thêm `.gitignore`, `.gitattributes`, `.editorconfig`; ngừng theo dõi (không xóa khỏi đĩa) các bản clone lồng nhau, thư mục phụ thuộc, bản sao lưu trạng thái, thư mục "rescue" và file ZIP (`e9cfba4`, `2089911`, `3571def`). **Không viết lại lịch sử Git, không force-push.**
- Đã gỡ bỏ mã OAuth cũ không còn sử dụng (`CHATMCP-HUB/lib/chatgpt-auth.mjs`, `CHATMCP-HUB/lib/provider.mjs`) và tệp băm lỗi thời `CHATMCP-HUB/SHA256SUMS.txt`.
- Làm sạch URL dịch vụ cá nhân trong `CHATMCP-HUB/windows/Test-Gateway-Live.ps1`.

### Chưa làm / bị chặn

- Thử với mô hình thật và tạo Pull Request GitHub thật trên github.com: **blocked** (cần khóa/xác thực của bạn; [TESTING-WITH-REAL-MODELS.md](docs/TESTING-WITH-REAL-MODELS.md)).
- Cô lập đa người dùng: **blocked** (không có bằng chứng; yêu cầu VM/microVM).
- Cập nhật workflow CI: **blocked** ở phía công cụ (file nằm trong `.github/workflows/` bị bảo vệ); bản đề xuất đã soạn và kiểm tra cú pháp, chờ bạn áp dụng.
- Chọn giấy phép cho repository: chưa có `LICENSE` (cần chủ sở hữu quyết định).
