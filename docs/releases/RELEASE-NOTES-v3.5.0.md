# ChatMCP v3.5.0 — Concurrent Coding Workspace

ChatMCP v3.5.0 is a minor-feature release for the local-first Windows desktop coding agent. It replaces the single-active-conversation experience with independent background work and direct subagent delegation inside chat.

## What's new

- **Multi-chat while an agent runs:** Open and use another conversation instead of waiting for the prior coding task to finish. Overlapping writable coding tasks operate in separate Git worktrees; sequential tasks can continue on an idle main checkout.
- **Background tasks and model-driven subagents:** The coding model can call `spawn_agent` to request an independent coding/research task, with parent-child linkage. The Background Tasks sidebar shows active, queued, dependent, blocked and completed work, with per-task Stop actions.
- **Explicit dependencies:** Start a task only after selected predecessors complete; separate tasks may proceed concurrently. There is no automatic merge of independent Git branches.
- **Chat during execution:** Additional instructions sent to a running agent are queued for its next safe model boundary, without attempting to repeat a file edit or command already in flight.
- **Git workspace selection:** See branches and existing worktrees after choosing a project; create new coding conversations from a selected committed branch.
- **File and screenshot input:** Attach selected files, drag-and-drop, or paste images with Ctrl+V. Valid image data is forwarded to OpenAI-compatible Chat Completions, Anthropic Messages and native Gemini endpoints. Minimal text-only Gemini gateways explicitly reject vision inputs rather than pretending the image was inspected.
- **Cleaner activity and longer context:** Consecutive tool calls are collapsed into an expandable summary; a structured rolling context checkpoint reduces older model-request history while preserving newer tool-call/result pairs. Full durable local task records are retained.

## Verification

The implementation was merged from [PR #31](https://github.com/pddczpl/ChatMCP/pull/31), where [the full nine-job CI matrix passed](https://github.com/pddczpl/ChatMCP/actions/runs/38795167258): Hub tests on Ubuntu and Windows (Node 22/24), React-to-real-Hub browser E2E on both operating systems, TypeScript/Vite production build, Windows installer and WebView2 smoke, and repository hygiene checks. The versioned release workflow performs another set of tests and a fresh Windows installer build before tagging or publication.

The tests use synthetic/scripted model providers. They do not prove that arbitrary live gateways implement tools, images and context handling correctly or establish parity with Claude Code, Codex or Goose.

## Install and upgrade

Download `ChatMCPSetup.exe` for Windows x64 and `ChatMCPSetup.exe.sha256` from this GitHub Release. Check SHA-256 before installation. The app requires a supported Windows x64 system, Git for Windows for worktrees and the Microsoft Edge WebView2 Runtime; model usage requires access to a configured AI provider.

When upgrading an earlier installation, stop the previous ChatMCP Hub before starting v3.5.0, then reopen the app and refresh its UI if a stale-version warning appears. Existing local task history and DPAPI-protected model credentials are not intentionally deleted by the upgrade.

## Important limitations

- The installer is **not Authenticode-signed**. SHA-256 confirms file integrity, not publisher identity.
- Git worktrees isolate checkouts, **not processes or the operating system**. Existing permission approvals and safe-execution controls still apply. This release is not a certified Windows Sandbox security boundary.
- If Git mutation outcome is uncertain after a cancellation/crash, the user must inspect the recorded worktree and branch; ChatMCP does not blindly replay mutations or delete possible work.
- Parallel subagent changes remain in their own branches until the user reviews and integrates them.
- Running independent agents can increase provider model requests, token usage and costs. ChatMCP does not independently impose provider spending limits.
