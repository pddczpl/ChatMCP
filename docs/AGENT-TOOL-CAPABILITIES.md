# ChatMCP Agent Tools & Token Optimization

> Development-branch implementation guide (not a statement that all capabilities have shipped in a signed, clean-Windows release). This document tracks features added after v3.2.0 on the feature branch. **99 LocalTools + 17 declared StudioTools**; the agent catalog may suppress redundant Studio entries. The current number is verified by tests.

## Scope

This upgrade keeps the in-process LocalTools, StudioTools, Skills Hub and PermissionGate. It does **not** add Hooks or an External MCP Client. Existing permissions, workspace boundaries and per-action approvals remain mandatory. The normal model can discover all tools; an expanded tool list alone does not prove autonomous success.

## New tool families

| Family | New names | Implementation limits |
|---|---|---|
| Public research | web_fetch, web_extract, web_search, docs_search, dependency_lookup, github_code_search | HTTPS DNS pinned to validated public IP for direct fetches, redirects rechecked, bounded text and no JS execution. Search provider may throttle; gh code search needs authentication. Permission category execute. |
| GitHub automation | github_workflow_runs, github_workflow_status, github_job_logs, github_pr_review, github_rerun_failed, github_pr_merge, github_release_create | Uses authenticated local gh CLI; mutation requires explicit high-risk approval and respects remote branch protection. |
| Tests | test_discover, test_run, test_results, test_coverage, test_impact_analysis | Fixed known runners only. Impact is filename heuristic, not complete test selection. No claim that coverage instrumentation is installed automatically. |
| Browser | browser_launch, browser_navigate, browser_click, browser_fill, browser_screenshot, browser_console, browser_network, browser_close | Headless Playwright optional; localhost-only by default with explicit CHATMCP_BROWSER_ALLOWED_HOSTS. Requests to other origins are blocked. Requires local browser binary. |
| Visual | screenshot_capture, screenshot_compare, visual_diff, responsive_check, accessibility_audit | Captures real PNG with browser, pixel-level RGBA diff; no AI aesthetic judgment or full WCAG/axe certification (only lightweight accessibility smoke checks). |
| LSP | rename_symbol, format_document, organize_imports, code_actions, find_implementations, type_hierarchy | Reuses existing Pyright/TypeScript LSP. Preview by default. Single-file edit uses SHA optimistic concurrency and workspace checkpoint. Multi-file rename is preview-only, not silently applied. |
| Native debugger | debug_start, debug_breakpoint, debug_continue, debug_step, debug_stack, debug_variables, debug_evaluate, debug_stop | Node.js inspector (loopback CDP), process is task-owned and gated; Python debugpy/DAP and native .NET/C++ debuggers are not implemented. |
| Build and file inspection | build_detect, build_run, git_conflict_inspect, binary_inspect | Detects actual manifest before running fixed build commands. Binary inspection refuses protected paths. |
| Skills | skills_discover | Enumerates local instructions only; does not execute imported scripts. |
| Token pipeline | token_profile, token_stats, token_restore | Task-isolated, reversible optimization of model-visible tool results; original receipts are persisted by AgentRunner. |

## Direct tool count (adjustable; no <50 gate)

The legacy `verify-local-backend` assertion requiring fewer than 50 function definitions was a local schema-size design choice, **not an API restriction**. The default now advertises **all 99 LocalTools plus four internal router functions = 99**. Environment variable `CHATMCP_DIRECT_TOOL_LIMIT` selects 0..124 direct tools (95 available today); set `48` for providers with smaller context or tool limits, `95` for full exposure. Invalid values revert to 95, and requested values above 124 are capped at 124 to keep the total within 128 functions. Restart the Hub after changing the environment variable. Tool names remain subject to schema validation; remaining tools continue to be listed by `mcp_catalog`, inspected by `mcp_describe` and executed via internal `mcp_call` through PermissionGate. More schemas consume more prompt tokens and may exceed an individual provider's limits; RTK/Headroom output compression does not erase the tokens used by function schemas.

## RTK + Headroom + Caveman: complementary strategies

This branch implements its **own internal approximation**, rather than installing or redistributing official RTK, Headroom or Caveman binaries/SDKs. Refer to the original projects' licenses before any future vendoring; their licenses and dependency availability must be evaluated independently.

1. **RTK-inspired**: shorten repeated/noisy CLI, Git and test output; preserve diagnostic lines, head/tail, exit status and error results.
2. **Headroom-inspired**: compact JSON formatting and leverage the existing bounded conversation-history compactor without mutating the canonical persisted record.
3. **Caveman-inspired**: instruct the agent to produce short status/final responses while keeping tests, safety warnings, code and paths exact.
4. **Raw restore**: large tool outputs can carry task-private token receipt handles; token_restore retrieves exact character ranges. Receipts are in-memory and expire at task completion.

Profiles: off, safe (default), balanced, aggressive. Optional process environment: CHATMCP_TOKEN_PROFILE. Savings figures are character-based token **estimates**, never certified billing reduction. The pipeline does not impose new model quotas, disable tools, alter approval text or drop failed tool results.

## 14-group capability assessment

| Group | Status of this branch |
|---|---|
| File System & Code Editing | Existing tools retained; safe patch/transactional file edits already in base |
| Semantic Code Intelligence | New six LSP actions; single-file write support, multi-file safety limitation |
| Terminal & Process Management | Existing shell/tasks retained |
| Git & GitHub Automation | New CI inspection, PR operations, conflict inspection |
| Web Research & Documentation | New HTTPS and dependency discovery; external search reliability varies |
| Browser Automation | Added optional Playwright runtime, not bundled with installer |
| Debugger & Profiling | Built-in Node inspector for JS is implemented; Python DAP and native .NET/C++ debugger integration remain outstanding |
| Test Automation & Coverage | Runner discovery/execution/result tools; structured coverage summaries supported |
| Screenshot & Visual Testing | PNG pixel diff and responsive captures; accessibility/aesthetic audit pending |
| Document & Binary Tools | Binary type/hash metadata; PDF/Office extraction/editing not implemented |
| Skills & Tool Discovery | Existing Skills Hub plus safe instruction-file discovery |
| Autonomous Workflow & Recovery | Existing journals/recovery and additional action tools; no end-to-end claim of all tools being used autonomously |
| Build, CI/CD & Release | Existing installer and Actions plus build/GitHub workflow tools |
| Security & Permissions | PermissionGate applies to new tools; network policy, workspace protections and per-task ownership |

## Deployment and verification

- The installer source allowlist includes tracked CHATMCP-HUB/lib/*.mjs files; adding modules requires successful fresh installer-build CI to verify the actual payload.
- The Windows installer stages pinned Playwright + playwright-core JavaScript packages into runtimes/browser/node_modules. On Windows, browser launch prefers installed Microsoft Edge; a real Edge/Chromium executable remains an external prerequisite. Development uses the UI node_modules fallback. Installer library staging alone does not prove real browser launch or clean Windows acceptance.
- The GitHub CLI gh must be installed and authenticated to use repository automation at runtime. User accounts/API credentials must not be copied into the installer.
- Python and TypeScript LSP features require their bundled servers and Node runtime to initialize successfully, not only existence of source code.
- GitHub Actions on Ubuntu/Windows Node 22/24 and Windows installer build are acceptance gates. A green CI is not proof of a clean Windows install or Authenticode signing.
- Browser controls are testable with mocked Playwright lifecycle and PNG image fixtures; real browser E2E and Windows packaged runtime remain separate checks.
- New network tools do not grant content from retrieved pages authority over system policy. Downloads remain untrusted data.

## Required next acceptance

Run verify-direct-tool-capacity, verify-agent-capabilities, verify-browser-tools, verify-lsp-refactor, verify-workflow-extensions, verify-token-optimization, verify-node-debugger and the complete Node test runner. Confirm every CI job on the **exact head SHA** and inspect actual installer artifacts. Validate a clean Windows sandbox and Authenticode certificate separately (not included in this branch). Do not claim full Codex/Claude Code/Antigravity parity based solely on tool registration.
