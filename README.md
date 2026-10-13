# ChatMCP — Local-first AI Coding Agent

**AI coding workspace for Windows with parallel Git-worktree agents, multi-provider models and a provenance-aware Agent Skills Hub.**

[![CI](https://github.com/pddczpl/ChatMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/pddczpl/ChatMCP/actions/workflows/ci.yml) · [Windows Releases](https://github.com/pddczpl/ChatMCP/releases) · [Issues](https://github.com/pddczpl/ChatMCP/issues) · [Security](SECURITY.md)

> **Local-only release v2.6.0:** This release removes the formerly hosted Docker/Render deployment stack and legacy Cloud Harness/Desktop Commander MCP proxy backend. The Hub listens on 127.0.0.1, with no cloud account, server deployment, tenant database or owner-login service. Outbound connectivity remains available for chosen AI providers, GitHub, trusted Skills sources and user-authorized research. **Local-only does not mean fully offline.**
>
> Stable releases are tagged on GitHub. This is the **v2.6.0 local-only release** (PR #6); the code is not an OS security sandbox and may execute approved commands with your Windows account's privileges.

## Features and status

The unreleased Phase 0 fixes reconnect the current React UI to persisted task history, the live permission gate, plans, Git and terminal data. See the [desktop contract audit](docs/PHASE0-DESKTOP-CONTRACT-AUDIT.md), [execution report](docs/PHASE0-EXECUTION-REPORT.md) and [next Phase 1 implementation plan](docs/PHASE1-IMPLEMENTATION-PLAN.md) for verified behavior, remaining gates and ordered work. A model's final answer does not certify that tests passed.

**Phase 3 (unreleased, stacked on Phase 2):** [Advanced multi-agent coding DAG and integration safety](docs/PHASE3-LOCAL-MULTIAGENT.md). Still requires Phase 2 and Phase 1 G4/security gates.

**Phase 2 (unreleased, stacked on Phase 1):** [Reliable autonomous development — recovery and evidence roadmap](docs/PHASE2-LOCAL-RELIABILITY.md). This branch is draft work and cannot be released until Phase 1 G4 and installer acceptance pass.

**Current Phase 1 development:** [staged implementation and outstanding safety gates](docs/PHASE1-STAGED-STATUS.md). The [G4 trusted publisher transport ADR](docs/PHASE1-G4-PUBLISHER-TRANSPORT-ADR.md) explains why writable mapped-folder HMAC remains blocked and the experimental, non-attesting CLI output probe. For the exact current Windows hardware handoff, see [Antigravity Phase 1 acceptance task](docs/agent-handoffs/ANTIGRAVITY_NEXT_TASK.md). This work is unreleased: backend sandbox execution remains blocked pending authenticated supervisor publication and supported Windows hardware acceptance.

| Capability | Status | Important limitations |
| --- | --- | --- |
| Windows Desktop Studio | Available | WinForms + WebView2, bundled local Node runtime; Git for Windows is separate |
| Coding agent with local tools | Available | LocalTools (36 công cụ): workspace-scoped files/search, terminal, Git, plans, checkpoints, approvals |
| AI providers | Available | OpenAI, Anthropic, Gemini and compatible providers; Ollama/LM Studio via loopback; model must support tool calls |
| Research Multi-Agent DAG | Available | Static DAG plus explicit dynamic read-only planning; no model usage quota in ChatMCP; no host execution tools for research subagents |
| Parallel Coding Workers | Beta | Up to 4 tasks on separate Git worktrees; 2 concurrent model workers by default for local process stability; no worker shell/network/push |
| Review and Draft PR | Beta | Exact Git diff review token required; integration uses a new branch; explicit confirmation required for publishing |
| GitHub Agent Skills Hub | Beta | Nested SKILL.md discovery, pinned revisions, SHA-checked bounded text/binary assets, source and license evidence; third-party scripts not auto-run |
| Hosted Cloud Harness / public server | **Removed** | No Render, VPS, public/multi-tenant auth, Cloud Harness proxy or Linux execution broker in the runtime |

## Start ChatMCP on Windows

**Use a published release:** Download ChatMCPSetup.exe from [GitHub Releases](https://github.com/pddczpl/ChatMCP/releases), compare its SHA-256 with the published checksum if provided, and install. Windows 10/11 with Microsoft Edge WebView2 Runtime is required; Git for Windows is needed for Git and worktree features.

**Build and run from source:** Git for Windows, Node.js 22.12+ and npm are required. Open PowerShell:

~~~powershell
git clone https://github.com/pddczpl/ChatMCP.git
cd ChatMCP
# To inspect the local-only development branch instead:
# git fetch origin
# git switch refactor/local-only-remove-cloud
npm ci --prefix .\CHATMCP-HUB\ui
npm run build --prefix .\CHATMCP-HUB\ui
.\START-CHATMCP-DESKTOP.cmd
~~~

You can also launch the local browser dashboard without the native window:

~~~powershell
.\CHATMCP-HUB\START-CHATMCP-HUB.cmd -ProjectPath 'C:\Projects\MyRepository'
~~~

It is available only at **http://127.0.0.1:3007** by default. Select a workspace and your AI model/provider. Start with Review permissions. The model API key is optional if you use a local tool-capable Ollama or LM Studio model. Configure your own compatible **Base URL, API key and model**; ChatMCP does not impose an API-token, model-call or monetary spending quota. Your provider may still enforce rate limits, credits and billing.

The native desktop UI includes its own workspace browser, editor, terminal, Git review and tool panels. **VS Code and other IDEs are not required or integrated as external control surfaces.** Settings offers Read Only, Review, Autonomous and an explicit **Full Access** option; choosing Full Access requires typing `FULL ACCESS`, runs permitted host tools under the current Windows account and does not grant OS administrator privileges. Worker test isolation remains an independent safety requirement.

You do **not** need Docker, Render, Cloud Harness or a server account. Do not set CHATMCP_PUBLIC, use --repo-root, or select the removed mcp backend.

## Multi-Agent Orchestrator

Open **Inspector → Agents**.

- **Research DAG:** Planner, Researcher, Reviewer, Security and summary roles receive bounded excerpts and no executable tools. The coordinator synthesizes results and uncertainty.
- **Coding Workers:** Supply 1–4 independent tasks, choose concurrency 1–3 and explicitly approve CREATE WORKTREES. Each coding agent edits its own Git worktree. It cannot invoke shell commands, Git push/merge or privileged external MCP tools by itself.
- **Mandatory human review:** Use Review diff for each worker. The resulting review token binds to the revision and diff. If the branch changes, repeat review.
- **Integration:** Explicitly select workers and approve INTEGRATE WORKTREES. ChatMCP merges into a **new integration branch**, never directly into main. Conflicts stop integration.
- **Draft PR:** Review the integration diff and run actual project tests first. Then explicitly approve PUBLISH DRAFT PR. GitHub CLI authentication is required for PR creation.

Git worktrees are a source-control isolation mechanism, **not** OS-level process or filesystem security isolation.

## GitHub Agent Skills Hub

Open **Inspector → Skills → GitHub Agent Skills Hub**. You may refresh curated GitHub source indexes, add an explicitly trusted GitHub source, search nested SKILL.md manifests, inspect revisions and import/update a skill.

- All tree/asset downloads are pinned to the source commit, verified against Git blob SHA where applicable, and bounded in file count and bytes.
- Binary and text files under a selected skill folder can be imported; symlinks/submodules are refused.
- Dependencies outside the pinned folder and external references are reported as unresolved/external. Imported scripts are stored but **not executed automatically**.
- Third-party skills start **disabled** until manually reviewed and enabled.
- Detected LICENSE text is *advisory provenance*, not confirmed legal redistribution permission. Publishing a public repository does not automatically grant reuse rights.

## Security and privacy

ChatMCP is a **single-owner local desktop app**: no public server, account registration or cloud workspace hosting. It binds to loopback, checks Host/Origin and requires CSRF for dashboard mutations. File/command operations remain behind PermissionGate with protected-path checks and approval modes. These safeguards do not protect against every malicious command running as your own Windows account.

AI providers and selected integrations can receive source/context as part of requests you authorize. Use local models when you need to avoid external model API transmission. Check [SECURITY.md](SECURITY.md) for limits and the historical Cloud Harness token caveat.

## Tests and Windows releases

~~~powershell
node .\CHATMCP-HUB\tests\run-all.mjs
npm ci --prefix .\CHATMCP-HUB\ui
npm run build --prefix .\CHATMCP-HUB\ui
# Maintainers only: .NET SDK 10+ on Windows
.\scripts\Build-Installer.ps1
~~~

CI checks Hub tests on Windows/Linux (Node 22/24), the frontend build, repository hygiene and Windows installer creation. An installer artifact is **not** proof of a tested release. Test on a clean Windows VM before tagging or publishing.

This release is **v2.6.0**, following v2.5.0. Verify the installer checksum and test installation on a clean Windows machine; CI build success does not prove installation/upgrade compatibility. See [Windows desktop release guide](docs/DESKTOP-APP.md) and [Changelog](CHANGELOG.md).

## Documentation

**Full documentation index (current and historical):** [PHASE0-AUDIT](docs/PHASE0-AUDIT.md) · [PHASE1-DESIGN](docs/PHASE1-DESIGN.md) · [PHASE1-REPORT](docs/PHASE1-REPORT.md) · [PHASE2-DESIGN](docs/PHASE2-DESIGN.md) · [PHASE2-REPORT](docs/PHASE2-REPORT.md) · [PHASE3-DESIGN](docs/PHASE3-DESIGN.md) · [PHASE3-REPORT](docs/PHASE3-REPORT.md) · [PHASE4-DESIGN](docs/PHASE4-DESIGN.md) · [PHASE4-REPORT](docs/PHASE4-REPORT.md). Historical PHASE docs describe previous Cloud architecture and are not current operating instructions.


[Windows Setup](docs/WINDOWS-SETUP.md) · [User Guide](docs/USER-GUIDE.md) · [Architecture](docs/ARCHITECTURE.md) · [Development](docs/DEVELOPMENT.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Real Model Testing](docs/TESTING-WITH-REAL-MODELS.md) · [Windows Sandbox Feasibility](docs/WINDOWS-SANDBOX-REAL-FEASIBILITY.md) · [Historical Cloud Deployment Notice](docs/DEPLOYMENT.md)

Historical phase documents are retained as archives of earlier releases. Any instructions referring to Render, Cloud Harness, Docker server or public mode are **retired**, not current product capabilities.

## License and contributions

Check the repository's current top-level LICENSE before assuming redistribution rights. Every imported Skill also has its own provenance and terms; **license detection is not legal verification**. Contributions and bug reports are welcome via [GitHub Issues](https://github.com/pddczpl/ChatMCP/issues).
