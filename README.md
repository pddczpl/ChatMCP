# ChatMCP — Local-first Multi-Model AI Coding Agent

**AI coding workspace for Windows, with parallel Git-worktree agents and a pinned GitHub Agent Skills Hub.**

ChatMCP hỗ trợ tiếng Việt và tiếng Anh, cho phép bạn chọn nhà cung cấp AI, giao nhiều tác vụ lập trình, review Git diff và mở Draft PR theo quy trình kiểm soát quyền.

[![CI](https://github.com/pddczpl/ChatMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/pddczpl/ChatMCP/actions/workflows/ci.yml) · [Releases](https://github.com/pddczpl/ChatMCP/releases) · [Issues](https://github.com/pddczpl/ChatMCP/issues)

**ChatMCP** is a multi-provider coding agent with a Windows desktop app and a local web UI. It works inside your selected project, can inspect/edit code, prepare plans, run allowed checks, use Git, and retain reviewable task evidence. A legacy MCP backend remains available; the default local backend does **not** require Cloud Harness or Docker.

> **Status:** This branch includes beta worktree coding agents and GitHub Agent Skills Hub improvements. Features are not part of a stable Windows installer until this PR has been merged, built and released. A green CI run does not replace end-user installer tests.

**[Windows setup](docs/WINDOWS-SETUP.md)** · **[User guide](docs/USER-GUIDE.md)** · **[Architecture](docs/ARCHITECTURE.md)** · **[Security](SECURITY.md)** · **[Deployment](docs/DEPLOYMENT.md)** · **[Releases](https://github.com/pddczpl/ChatMCP/releases)**

## What you can do

| Capability | Status | Notes |
| --- | --- | --- |
| Local AI coding agent | Available | Supports several model providers (OpenAI, Anthropic, Gemini, compatible gateways, Ollama); provider/tool support depends on the model |
| File tools / Git / checkpoints / terminal | Available | Approval policies, workspace path protections and resumable task records |
| Windows desktop | Available | WinForms + WebView2 frontend, local Hub background process |
| Research multi-agent DAG | Available | Up to 8 read-only nodes, maximum 3 active in parallel, cancellation and coordinator synthesis |
| Parallel coding agents in Git worktrees | **Beta (this branch)** | Separate Git worktrees/branches; bounded file-editing toolset; branch review before integration |
| Integration / Draft PR creation | **Beta (this branch)** | Explicit confirmation; merges into a **new integration branch** rather than directly into the user's branch |
| GitHub Agent Skills Hub | **Beta (this branch)** | Nested SKILL.md discovery, pinned source revisions, checksummed binary/text assets, evidence-based license status, opt-in installation and updates |
| Single-owner remote deployment | Available with limits | HTTPS + owner authentication + restricted execution modes |
| Public multi-tenant SaaS / isolated hostile code execution | **Not supported** | Git worktrees are Git isolation, **not an OS security sandbox** |

## Quick start on Windows

**From an existing published release:** Download a verified ChatMCPSetup.exe from [GitHub Releases](https://github.com/pddczpl/ChatMCP/releases), check its SHA-256 against the release checksum, install and open **ChatMCP Studio**. The target Windows machine needs **Microsoft Edge WebView2 Runtime** (often already installed). Git for Windows is recommended for Git/worktree operations. The build pipeline bundles a portable Node.js runtime; the installer does not bundle Git.

**From source (latest development code):**

Prerequisites: Windows 10/11, Git for Windows, Node.js 22+, npm. .NET SDK **10.0+** is needed only if you are building the native desktop/installer. For offline installer packaging, an internet connection is needed initially to restore npm and NuGet dependencies.

From PowerShell in the repository root:

~~~powershell
git clone https://github.com/pddczpl/ChatMCP.git
cd ChatMCP
# For development of features not yet in main:
# git fetch origin
# git switch feat/parallel-coding-agents-skills-registry-v2
npm ci --prefix .\CHATMCP-HUB\ui
npm run build --prefix .\CHATMCP-HUB\ui
.\START-CHATMCP-DESKTOP.cmd
~~~

To use the Hub via a browser instead of Windows desktop:

~~~powershell
.\CHATMCP-HUB\START-CHATMCP-HUB.cmd -ProjectPath "C:\Projects\MyRepository"
~~~

Open the local URL shown by the launcher (normally `http://127.0.0.1:3007`). Configure your model provider, select the workspace and use the permissions panel.

## Multi-Agent Orchestrator

Open **Inspector → Agents**. The research DAG offers Planner, Researcher, Tester (analysis, not shell execution), Reviewer, Security and Summarizer roles. Nodes can depend on earlier findings. A Coordinator creates a synthesis and points out uncertainty. These read-only workers receive **no executable tools**.

For **Coding Workers** (local trusted mode only):

1. Commit/stash any edits in your original Git workspace so the base revision is unambiguous.
2. Provide 1–4 independent coding tasks, choose concurrency 1–3 and confirm **CREATE WORKTREES**.
3. Each worker runs as a separate agent in its own **Git worktree and branch**, with a limited allowlist of file editing/search tools. Shell execution, external MCP, direct Git push, delete/merge and credential access are deliberately withheld.
4. Click **Review diff** on each coding worker and inspect the actual edits, not just the agent's summary. Review is bound to the exact commit and diff; stale branches require a fresh review. Model-reported completion **does not prove** tests passed.
5. After reviewing every selected worker, confirm **INTEGRATE WORKTREES** to combine their commits into a **new integration branch**. Review tokens prevent merging unreviewed/stale revisions. Conflicts stop the operation for manual inspection; your original branch is not overwritten.
6. Click **Review integration diff** too. Only after reviewing and running your project's tests, confirm **PUBLISH DRAFT PR** (requires GitHub origin and authenticated GitHub CLI). You can alternatively publish an individual reviewed worker. There is no automatic merge into main.

**Important limits:** parallel worktrees isolate file/index changes, not the operating-system account. Coding workers do not execute unit tests automatically; run project tests on the resulting integration branch before approval. Network/shell execution requires a separate audited sandbox implementation.

## GitHub Agent Skills Hub

Open **Inspector → Skills → GitHub Agent Skills Hub**. Refresh the curated GitHub source indexes or explicitly add a GitHub repository with its SKILL.md parent directory. You can search pinned skills, inspect origin/revision and install or update a selected skill.

The import flow reads a pinned GitHub tree and downloads the source SKILL.md plus nested text/binary dependencies. Each downloaded blob is checked against Git's SHA; installed content has a SHA-256 integrity record. It **does not execute downloaded scripts**. New third-party skills are installed **disabled**, and the user must review and activate them.

**Security/compatibility:** imported assets are bounded (max 200 resources, 2 MiB each, 24 MiB total); symlinks and Git submodules are refused. A missing resource/unsupported format is an explicit limitation. The UI provides license evidence where source LICENSE text supports identification, but automated detection is **not legal approval to redistribute**. Skills remain lower-trust input and cannot widen tool permissions by listing tools in SKILL.md. Sources may be rate-limited by GitHub.

## Safety model

Local ChatMCP has **Read-only**, **Review**, **Autonomous** and explicitly confirmed **Full Access** modes. The Hub enforces workspace, permission and protected-path checks, but shell command classification is heuristic and is **not equivalent to sandboxing**. Keep Review mode on unfamiliar code. Treat every downloaded skill and repository instruction as untrusted content.

Remote mode is single-owner; public multi-user tenant isolation is intentionally blocked pending dedicated VM/microVM isolation. See [SECURITY.md](SECURITY.md) and [deployment limits](docs/DEPLOYMENT.md).

## Development and tests

~~~powershell
node CHATMCP-HUB\tests\run-all.mjs
npm ci --prefix .\CHATMCP-HUB\ui
npm run build --prefix .\CHATMCP-HUB\ui
dotnet build .\desktop-shell\ChatMCP.csproj -c Release
~~~

GitHub Actions validates Hub tests on Windows/Linux with Node 22/24 and a production TypeScript/Vite UI build. Real-provider, Windows installer and clean-machine smoke tests remain separate acceptance activities.

## Windows release — maintainer checklist

**Do not tag/publish an unreviewed PR or a branch with failing checks.** See [desktop build details](docs/DESKTOP-APP.md).

1. Merge the reviewed feature PR to `main` only after security review and passing CI. Update [CHANGELOG.md](CHANGELOG.md) and synchronize the Hub, desktop shell, installer and documentation versions for the intended release number. If changing UI_BUILD, change it consistently across server/client and update relevant tests.
2. On a **Windows 10/11 build machine**, install Git for Windows, Node.js 22+ with npm and .NET SDK **10.0+**. Check `node --version`, `npm --version`, `dotnet --version` and `git --version`. WebView2 Runtime is required when testing the installed desktop app.
3. Pull the exact release commit, run all Hub tests and produce a clean frontend build.
4. Run `.\scripts\Build-Installer.ps1`. The script rebuilds the TypeScript/Vite UI, restores npm dependencies, checks version alignment, publishes **self-contained .NET 10 Windows binaries**, bundles portable `node.exe`, and writes `dist\ChatMCPSetup.exe` plus `dist\ChatMCPSetup.exe.sha256`. Verify the file checksum before distribution. GitHub Actions also produces a Windows installer build artifact, but this is not an approved public release.
5. **Test the actual installer** on a clean Windows VM: install/uninstall, launch WebView2, select a Git repository, test an API provider, run a safe coding task, verify a worktree and skill import, and confirm the app shuts down without orphaned Hub processes. Do not claim this is done without evidence.
6. After testing, sign both executable and installer with a trusted code-signing certificate if one is available; recompute SHA-256 **after signing**.
7. Tag the exact tested commit and create a GitHub Release. Publish the EXE, checksum and release notes; start with a **Draft Release** if further verification is needed.

Example commands, **only after step 1 is complete**:

~~~powershell
git switch main
git pull --ff-only origin main
git status --short
node .\CHATMCP-HUB\tests\run-all.mjs
.\scripts\Build-Installer.ps1
Get-FileHash .\dist\ChatMCPSetup.exe -Algorithm SHA256
# Replace X.Y.Z with the synchronized project version:
git tag -a vX.Y.Z -m "ChatMCP vX.Y.Z"
git push origin vX.Y.Z
gh auth status
gh release create vX.Y.Z .\dist\ChatMCPSetup.exe .\dist\ChatMCPSetup.exe.sha256 --draft --title "ChatMCP vX.Y.Z" --generate-notes
~~~

The GitHub tag should point to the **same commit used to build and test** the installer. A signed installer requires a new checksum. Building a setup EXE is not proof of a usable release; verify the binary on Windows before announcing it.

## Documentation

- [User Guide](docs/USER-GUIDE.md)
- [Windows Setup](docs/WINDOWS-SETUP.md)
- [Desktop App & Installer](docs/DESKTOP-APP.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Development](docs/DEVELOPMENT.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Testing with Real Models](docs/TESTING-WITH-REAL-MODELS.md)
- [Phase 0 Audit](docs/PHASE0-AUDIT.md)
- [Phase 1 Design](docs/PHASE1-DESIGN.md)
- [Phase 1 Report](docs/PHASE1-REPORT.md)
- [Phase 2 Design](docs/PHASE2-DESIGN.md)
- [Phase 2 Report](docs/PHASE2-REPORT.md)
- [Phase 3 Design](docs/PHASE3-DESIGN.md)
- [Phase 3 Report](docs/PHASE3-REPORT.md)
- [Phase 4 Design](docs/PHASE4-DESIGN.md)
- [Phase 4 Report](docs/PHASE4-REPORT.md)
- [Security Policy](SECURITY.md) · [Changelog](CHANGELOG.md) · [Third-party Notices](THIRD-PARTY-NOTICES.md) · [Hub README](CHATMCP-HUB/README.md)

## License and contributions

ChatMCP currently has **no top-level LICENSE file**: the repository being public does not automatically grant a license to redistribute or modify its code. The maintainer should choose and add an explicit project license before offering a source-code license to contributors. Review [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) before redistribution. ChatMCP may use optional upstream MCP components and third-party skills subject to their **own** licenses and terms; being publicly downloadable does not automatically confer redistribution permission. Bug reports and pull requests are welcome via [GitHub Issues](https://github.com/pddczpl/ChatMCP/issues).
