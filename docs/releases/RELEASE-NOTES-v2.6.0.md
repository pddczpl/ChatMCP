# ChatMCP v2.6.0 — Local-only Windows

This release transitions ChatMCP into a **single-owner local-first Windows AI coding agent** ([PR #6](https://github.com/pddczpl/ChatMCP/pull/6)).

## Changes

- The Hub now binds exclusively to **127.0.0.1**. The old Cloud Harness/Desktop Commander MCP backend, Render/Docker **server** deployment, public owner auth, remote cloud workspaces and tenant RBAC have been removed.
- Retains multi-provider AI gateway, local tool-calling models (Ollama/LM Studio), local file/Git/terminal tools, permission approvals and checkpoints.
- Retains parallel coding workers on separate Git worktrees with revision-bound diff review and explicit Draft PR publication.
- Retains pinned, integrity-checked GitHub Agent Skills and supported text/binary assets; imported scripts are not automatically executed.
- Reworked README, Windows setup, architecture and security documentation. Local-only **does not mean offline-only**: outbound AI provider and GitHub connectivity remains available when used.

## Windows installer

Download **ChatMCPSetup.exe** and **ChatMCPSetup.exe.sha256** from this release's Assets. Verify SHA-256 before installing. Windows 10/11 x64 and WebView2 Runtime are required. Git for Windows is needed for Git/worktree operations; the installer includes portable Node.js.

## Verification and known limitations

The installer is taken from a successful GitHub Actions run on the exact release commit (Windows/Ubuntu Node 22/24 Hub suites, TypeScript/Vite frontend, Windows installer build and checksum verification). The optional FastAPI integration suite was skipped in CI because its Python dependencies were not provisioned.

**The installer is unsigned (no Authenticode certificate), and clean-Windows VM install/upgrade/uninstall and live-model E2E have not been independently verified.** Windows SmartScreen may warn. Git worktrees do not provide operating-system sandbox isolation.

Removing legacy cloud files does not erase Git history, revoke previously exposed tokens or stop old external deployments. Rotate old credentials and retire those systems separately.

[README](https://github.com/pddczpl/ChatMCP#readme) · [SECURITY](https://github.com/pddczpl/ChatMCP/blob/main/SECURITY.md)
