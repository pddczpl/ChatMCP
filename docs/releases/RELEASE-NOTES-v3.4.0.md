# ChatMCP v3.4.0 — Reliable Agent Runtime & Workflow Upgrades

This release upgrades the ChatMCP v3.3.0 Windows local coding agent. It includes PR #27 and retains the existing local-only PermissionGate, Skills Hub, bundled Node/LSP/Python, and Git worktree-based architecture.

## Agent reliability and usage
- Removes ChatMCP-imposed limits on model HTTP requests, tokens or cost. Quotas, actual provider billing, optional task step/time controls, and Stop remain user/provider controlled.
- Records **actual HTTP sends** (including transport retries and Gemini compatibility retries), input/output tokens and provider-reported cache and reasoning tokens where available. Usage telemetry is not an authoritative invoice.
- Supports optional task-aware direct tool selection with an always-available internal router catalog. **99 LocalTools and four internal routers** are present. Tool selection never increases permissions.
- Adds task goal dependencies and acceptance criteria, and warns when the agent lacks independent file/test/Git-diff completion evidence.

## Coding, browser and multi-agent
- Reviewed multi-file LSP rename edits with SHA-based preconditions, full targeted checkpoints, guarded writes, mode preservation and conflict-aware rollback. Files changed by other processes may still require manual reconciliation.
- Playwright browser tooling: accessible role/name locators, ARIA snapshots, declarative element assertions, screenshots and local trace artifacts. Traces can contain sensitive browser data; keep them private.
- Coding worker DAG proposals can be deterministic or optionally requested from a model. Every proposal is an editable preview; worker creation, test approvals, Git integration and publication retain their explicit permission gates.
- Provides an offline parity-report aggregator for matched tasks, usage and externally supplied grades. The aggregator does not prove Codex/Claude Code parity or run paid-model benchmarks.

## Security and release conditions
- No Hooks or external MCP client added.
- No Windows Sandbox code changes are included for this upgrade's OS acceptance; real Windows Sandbox guest isolation and clean-VM verification remain the owner's responsibility.
- Fresh self-contained Windows installer is built during release publication; its SHA-256 is checked before upload.
- The installer is **not Authenticode-signed**. A SHA-256 checksum checks file integrity, not publisher identity.
- CI synthetic tests and installer build do not prove live-model autonomy, model provider coverage across arbitrary gateways, or exact cost savings.

Download `ChatMCPSetup.exe` and its matching `.sha256` asset from this release. Shut down an existing ChatMCP instance before upgrading.
