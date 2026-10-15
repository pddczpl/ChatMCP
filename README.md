# ChatMCP — Local-first AI Coding Agent

**AI coding workspace for Windows with parallel Git-worktree agents, native Windows Sandbox hardware verification, crash recovery journals, multi-provider models, and a provenance-aware Agent Skills Hub.**

[![CI](https://github.com/pddczpl/ChatMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/pddczpl/ChatMCP/actions/workflows/ci.yml) · [Windows Releases](https://github.com/pddczpl/ChatMCP/releases) · [Issues](https://github.com/pddczpl/ChatMCP/issues) · [Security](SECURITY.md)

> **Development version v3.2.0 (not yet released):** ChatMCP operates entirely on local infrastructure (`127.0.0.1:3007`). There is no cloud account, hosted server deployment, multi-tenant database, or external login service. All tool execution is controlled through a local Permission Gate. Outbound network access is restricted to user-configured AI providers, GitHub, and authorized research lookups. **Local-first does not mean fully offline.**
>
> Releases are tagged on GitHub and include an installer SHA-256 checksum. The installer is not Authenticode-signed. **v3.2.0** integrates bundled language servers, compatible Tree-sitter WASM and embedded Python with build-time validation (release pending) dependencies, and preserves fail-closed Windows DPAPI storage for AI Profiles. [Release notes](RELEASE-NOTES-v3.1.2.md).

---

**v3.2.0 development:** This build extends the full cross-platform CI matrix for hybrid intelligence and secure AI Profiles. CI provider fixtures do not disable production DPAPI safeguards.

HTTP model-request budget: `CHATMCP_MAX_HTTP_REQUESTS=80` by default (set 0 for unlimited).
Optional provider-reported input/output token caps are `CHATMCP_MAX_INPUT_TOKENS` and
`CHATMCP_MAX_OUTPUT_TOKENS` (default 0 = no cap); this is a safety limit on model
calls, not a guarantee of upstream billing. Current task usage records actual HTTP attempts.

## Features and Capabilities

ChatMCP v3.2.0 targets complete autonomous software engineering capabilities while enforcing strict local security boundaries:

- **Desktop UI Contract Integration:** Full bidirectional synchronization between the WinForms/WebView2 desktop shell and the local Hub daemon, supporting real-time streaming, interactive plan editing, terminal sessions, Git reviews, and execution checkpoints.
- **Hardware-Attested Sandbox Isolation:** Disposable Windows Sandbox guest environments running under restricted security tokens (`DISABLE_MAX_PRIVILEGE | LUA_TOKEN`) with unshared HMAC-SHA256 exit-code publication and automated host fallback policies.
- **Reliable Autonomous Coding & Crash Recovery:** Transactional state journaling with SHA-256 hash chaining (`prevEntrySha256`), corruption quarantine, persistent recovery acknowledgements across Hub restarts, and atomic rollback protections.
- **Progress-aware long-task execution:** bounded semantic inspection-cycle detection, a proposed multi-step plan, independently hashed local file-change evidence, test receipts and two recovery prompts before a controlled stop. Progress receipts do not guarantee task correctness.
- **Multi-Agent DAG & Parallel Git Worktrees:** Dependency-aware orchestrator (`A -> B -> C` and `A -> no-op B -> C`), parallel coding workers isolated on separate Git worktrees (default concurrency limit <= 2), cryptographic review tokens, and collision-free branch integration.

| Capability | Status | Description & Safety Boundaries |
| --- | --- | --- |
| Windows Desktop Studio | Available | WinForms + WebView2 desktop application with bundled local Node.js runtime; Git for Windows required for worktrees |
| Coding agent with local tools | Available | LocalTools (95 công cụ), cho phép trực tiếp 95 tool + 4 internal router (99 definitions) mặc định; cấu hình CHATMCP_DIRECT_TOOL_LIMIT để giảm tải schema cho model yếu |
| AI Providers & Models | Available | 12 preset provider configurations (OpenAI, Anthropic, Gemini, DeepSeek, Ollama, LM Studio, etc.) + custom OpenAI-compatible endpoints; no token or monetary spending quotas imposed by ChatMCP |
| Task State Machine | Available | 11 trạng thái lifecycle (created, planning, planned, running, paused, awaiting_approval, awaiting_review, completed, failed, cancelled, checkpoint_failed) with strictly validated transitions |
| Crash Recovery & Journaling | Available | Tamper-evident transaction journal with cryptographic chaining; persistent recovery acknowledgements across daemon restarts; context compaction and rollback safety |
| Research Multi-Agent DAG | Available | Static DAG and dynamic read-only planning roles (Planner, Researcher, Reviewer, Security) with bounded context and no host execution privileges |
| Parallel Coding Workers | Available | Up to 4 tasks running in parallel on isolated Git worktrees (concurrency limit 2 by default); workers cannot execute host shell commands or external push operations |
| Mandatory Human Review & Draft PR | Available | Exact Git diff review token required; changes merge into a dedicated integration branch (never directly to main); explicit user confirmation required to publish Draft PR |
| GitHub Agent Skills Hub | Available | Curated and custom GitHub skill sources, nested SKILL.md discovery, pinned revision downloads, Git blob SHA asset verification, and license provenance auditing |
| Windows Sandbox Driver | Available | Isolated guest command execution via Windows Sandbox CLI with exit-code transport verification and zero-fallback safety locks |
| Hosted Cloud Harness / Public Server | **Removed** | Completely removed legacy Docker/Render cloud stack, multi-tenant databases, and remote authentication proxies |

---

## Start ChatMCP on Windows

### 1. Download Official Installer
Download the latest standalone installer from [GitHub Releases](https://github.com/pddczpl/ChatMCP/releases):
- File: `ChatMCPSetup.exe` (v3.2.0 once CI gates pass)
- Checksum: Verify against `ChatMCPSetup.exe.sha256`
- Requirements: Windows 10/11 x64 with Microsoft Edge WebView2 Runtime, Git for Windows.

### 2. Build and Run from Source
Prerequisites: Windows 10/11, Git for Windows, Node.js 22.12+ (or Node 24), and npm.

Open PowerShell:

~~~powershell
git clone https://github.com/pddczpl/ChatMCP.git
Set-Location ChatMCP
npm ci --prefix .\CHATMCP-HUB\ui
npm run build --prefix .\CHATMCP-HUB\ui
.\START-CHATMCP-DESKTOP.cmd
~~~

You can also launch the headless Hub daemon and access the browser interface directly:

~~~powershell
.\CHATMCP-HUB\START-CHATMCP-HUB.cmd -ProjectPath 'C:\Projects\MyRepository'
~~~

The dashboard is accessible only at **http://127.0.0.1:3007** by default.

### 3. Permission Modes
The desktop UI provides four security authorization levels:
- **Read Only:** Inspect files and view project state without modifying files or executing commands.
- **Review (Default):** Prompts for user confirmation before executing write tools, commands, or Git mutations.
- **Autonomous:** Automatically permits safe local workspace operations within predefined policy boundaries.
- **Full Access:** Explicit elevation requiring typing `FULL ACCESS`; executes approved tools under the local Windows user account without OS privilege escalation.

---

## Multi-Agent Orchestrator

Navigate to **Inspector → Agents**:

1. **Research DAG:** Specialized read-only agents (Planner, Researcher, Reviewer, Security) collaborate to gather documentation, evaluate requirements, and formulate multi-step plans without host execution privileges.
2. **Parallel Coding Workers:** Assign up to 4 concurrent subtasks across separate Git worktrees. Each worker operates in an isolated worktree folder, preventing conflicts with your working directory.
3. **Mandatory Review Tokens:** Inspect the exact Git diff generated by each worker. Generating an approved review token cryptographically binds the owner's sign-off to that specific diff and commit.
4. **Integration Branching:** Approved worker branches merge into a newly created integration branch (`feat/integrate-*`), guaranteeing that `main` is never modified directly.
5. **Publish Draft PR:** Review the final integrated diff and test results before approving draft pull request creation via the GitHub CLI (`gh pr create --draft`).

---

## Agent Skills Hub

Navigate to **Inspector → Skills → GitHub Agent Skills Hub**:

- **Repository Discovery:** Search and browse nested `SKILL.md` configurations across curated or custom GitHub repositories.
- **Cryptographic Asset Pinning:** All skill manifests and related assets are pinned to immutable commit SHAs and verified against Git blob hashes.
- **Safe Import:** Imported scripts and helper files are downloaded to local storage with size limits and disabled by default until explicitly enabled by the user.
- **License Provenance:** Audits licensing terms and notifies the user of third-party usage restrictions.

---

## Reliability and Crash Recovery

ChatMCP includes persistent, crash-resilient task execution:

- **Cryptographic Journaling:** Task state transitions are logged in an append-only JSON journal secured by SHA-256 hash chaining (`prevEntrySha256`).
- **Restart Resilience:** If the Hub daemon or Windows crashes mid-task, unacknowledged repairs and task states are reconstructed upon restart.
- **Quarantine Engine:** Corrupted journal entries are automatically quarantined to prevent cascading failures.
- **Context Compaction:** Large conversation histories are summarized deterministically to conserve model context while preserving exact tool call receipts.

---

## Security Model

ChatMCP is designed exclusively as a single-tenant local application:
- **Loopback Binding:** Binds strictly to `127.0.0.1`, validates HTTP `Host` and `Origin` headers, and enforces CSRF protection on all dashboard mutations.
- **Workspace Scoping:** Path resolution algorithms prevent directory traversal attacks outside the designated workspace root.
- **Local Credentials:** API keys for AI providers are stored locally and never transmitted to ChatMCP telemetry servers.
- For vulnerability reporting and security advisories, see [SECURITY.md](SECURITY.md).

---

## Testing and Verification

Verify the entire repository using the test runner:

~~~powershell
# Run the complete test suite (85 bộ Node và 5 bộ giao diện)
node .\CHATMCP-HUB\tests\run-all.mjs

# Build and verify the frontend
npm ci --prefix .\CHATMCP-HUB\ui
npm run build --prefix .\CHATMCP-HUB\ui

# Verify documentation consistency
node .\CHATMCP-HUB\tests\verify-docs.mjs

# Maintainers: Build the Windows installer package
.\scripts\Build-Installer.ps1
~~~

---

## Documentation Index

Comprehensive documentation across all architecture, implementation, and verification phases:

### System Architecture and Guides
- [Bundled Code Intelligence Runtime](docs/CODE-INTELLIGENCE-RUNTIME.md) — Offline LSP, WASM, embedded Python staging, verification and limitations
- [Architecture](docs/ARCHITECTURE.md) — System components, security model, and task state machine
- [Windows Setup](docs/WINDOWS-SETUP.md) — Prerequisites, environment variables, and Windows configuration
- [Desktop Application](docs/DESKTOP-APP.md) — WinForms + WebView2 architecture, packaging, and releases
- [User Guide](docs/USER-GUIDE.md) — Workflow instructions, tool definitions, and dashboard navigation
- [Development](docs/DEVELOPMENT.md) — Contributing guidelines, testing workflows, and codebase conventions
- [Testing with Real Models](docs/TESTING-WITH-REAL-MODELS.md) — Integration testing with live AI provider endpoints
- [Agent Tools & Token Optimization](docs/AGENT-TOOL-CAPABILITIES.md) — Updated internal tool inventory, security contracts, deployment dependencies, and acceptance gaps
- [Troubleshooting](docs/TROUBLESHOOTING.md) — Diagnosing common startup, permission, and runtime issues
- [Historical Cloud Deployment Notice](docs/DEPLOYMENT.md) — Archived notice regarding deprecated cloud infrastructure
- [Windows Sandbox Feasibility](docs/WINDOWS-SANDBOX-REAL-FEASIBILITY.md) — Technical feasibility analysis of Windows Sandbox integration

### Phase 0: Desktop Contract Reconnection
- [Phase 0 Audit](docs/PHASE0-AUDIT.md) — Codebase baseline audit and debt assessment
- [Phase 0 Desktop Contract Audit](docs/PHASE0-DESKTOP-CONTRACT-AUDIT.md) — Hub-to-UI contract alignment and API verification
- [Phase 0 Execution Report](docs/PHASE0-EXECUTION-REPORT.md) — Test receipts and reconnection milestone verification

### Phase 1: Windows Sandbox & Hardware Security
- [Phase 1 Design](docs/PHASE1-DESIGN.md) — Sandbox isolation architecture and security requirements
- [Phase 1 Implementation Plan](docs/PHASE1-IMPLEMENTATION-PLAN.md) — Step-by-step development roadmap for execution drivers
- [Phase 1 Report](docs/PHASE1-REPORT.md) — Verification receipts and security gate assessment
- [Phase 1 Blackbox Checks](docs/PHASE1-BLACKBOX-CHECKS.md) — Native test suite for guest execution boundaries
- [Phase 1 Staged Status](docs/PHASE1-STAGED-STATUS.md) — Incremental verification log for driver integration
- [Phase 1 G4 Publisher Transport ADR](docs/PHASE1-G4-PUBLISHER-TRANSPORT-ADR.md) — Architecture decision record for guest exit-code transport
- [Phase 1 G6 Clean Windows](docs/PHASE1-G6-CLEAN-WINDOWS.md) — Clean-machine installation, upgrade, and uninstallation verification
- [Phase 1 G4/G6 Execution Handoff](docs/agent-handoffs/G4-G6-EXECUTION-2026-10-13.md) — Detailed execution handoff and test receipts

### Phase 2: Reliable Local Development
- [Phase 2 Design](docs/PHASE2-DESIGN.md) — Journaling engine, crash recovery, and context management specifications
- [Phase 2 Local Reliability](docs/PHASE2-LOCAL-RELIABILITY.md) — Implementation guide for crash resilience and rollback protection
- [Phase 2 Report](docs/PHASE2-REPORT.md) — Verification receipts and recovery benchmark results

### Phase 3: Advanced Multi-Agent Worktrees
- [Phase 3 Design](docs/PHASE3-DESIGN.md) — Multi-agent DAG engine, worktree coordinator, and review token architecture
- [Phase 3 Local Multi-Agent](docs/PHASE3-LOCAL-MULTIAGENT.md) — Coordination workflows, concurrency rules, and Git integration
- [Phase 3 Report](docs/PHASE3-REPORT.md) — Multi-agent benchmark results, DAG execution receipts, and merge verification

### Phase 4: Extended Planning & Optimization
- [Phase 4 Design](docs/PHASE4-DESIGN.md) — Long-horizon agent planning and autonomous optimization design
- [Phase 4 Report](docs/PHASE4-REPORT.md) — Experimental evaluation and future milestone documentation

---

## License and Notices

- Check the repository's current top-level LICENSE file before assuming redistribution rights. Every imported Skill also has its own provenance and terms; **license detection is not legal verification**.
- For third-party dependencies and open-source licenses, see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- Detailed release history and migration notes are maintained in [CHANGELOG.md](CHANGELOG.md).
- Contributions and bug reports are welcome via [GitHub Issues](https://github.com/pddczpl/ChatMCP/issues).
