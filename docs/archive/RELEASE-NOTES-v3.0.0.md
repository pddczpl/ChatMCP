# ChatMCP v3.0.0 — Autonomous Coding, Native Sandbox Verification & Multi-Agent Worktrees

ChatMCP v3.0.0 marks a major architectural milestone, delivering complete autonomous coding capabilities, hardware-attested Windows Sandbox verification, durable crash recovery journals, and dependency-aware multi-agent coordination.

## Major Advancements

### 1. Phase 1 — Windows Sandbox Isolation & Hardware Black-box Verification
- **Isolated Execution Boundary:** Disposable Windows Sandbox guest environment running with zero-fallback restricted tokens (`DISABLE_MAX_PRIVILEGE | LUA_TOKEN`) and race-free Job Object containment.
- **System-Sealed Verification:** Publisher authentication protocol (`system-sealed-exit-v1`) with unshared HMAC-SHA256 signatures, preventing in-guest receipt forgery or privilege spoofing.
- **Clean Windows Lifecycle (G6):** Complete verification of installation, in-place upgrade, and clean uninstallation on pristine Windows 11 environments.

### 2. Phase 2 — Reliable Coding Recovery Checkpoints
- **Crash Recovery Journal:** Tamper-evident journal entries backed by SHA-256 cryptographic hash chaining (`prevEntrySha256`).
- **Corruption Quarantine:** Automatic isolation of corrupted journal records preventing state loss.
- **Persistent Owner Acknowledgements:** Recovery state and pending repair acknowledgements persist safely across Hub daemon restarts.
- **Safe Context Previews:** Atomic preview and rollback protections before applying mutations to workspaces.

### 3. Phase 3 — Dependency-Aware Multi-Agent Coordination
- **Task DAG Engine:** Strict dependency execution (`A -> B -> C`) and intelligent no-op handling (`A -> no-op B -> C`).
- **Parallel Git Worktrees:** Isolated Git worktrees for concurrent worker agents with bounded concurrency limits (<= 2).
- **Graceful Cancellation & Downstream Cascading:** Safe worker termination and fail-closed blocking of downstream tasks upon upstream failure.
- **Collision Prevention:** Early detection and rejection of structural file-vs-directory naming conflicts.

## Windows Installer

Download **ChatMCPSetup.exe** and **ChatMCPSetup.exe.sha256** from this release's Assets. Verify the SHA-256 hash before running.
- **OS Requirement:** Windows 10/11 x64 with WebView2 Runtime.
- **Prerequisites:** Git for Windows (for Git worktrees); includes self-contained Node.js runtime and .NET desktop shell.

[README](https://github.com/pddczpl/ChatMCP#readme) · [SECURITY](https://github.com/pddczpl/ChatMCP/blob/main/SECURITY.md)
