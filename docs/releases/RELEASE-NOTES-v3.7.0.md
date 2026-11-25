# ChatMCP v3.7.0 — Autonomous In-Chat Workflows

This minor-feature release adds real, model-created multi-phase workflows to the local-first ChatMCP Windows desktop coding agent. It includes earlier workspace/conversation/task/subagent hierarchy and management from v3.6.0.

## What's new

- **Workflow orchestration directly in chat:** The model can call `spawn_workflow` to create a named workflow with 1–5 phases and up to 12 real specialized child agents. Later phases can explicitly depend on earlier phases.
- **Review → Verify:** Multiple independent Review agents can work concurrently in isolated Git worktrees. The Verify phase waits for every required predecessor task to finish successfully; failed, blocked, cancelled or uncertain jobs do not count as completion.
- **One workflow in two views:** The same persisted workflow is visible as an expandable progress card in the originating conversation and in Background Tasks under the correct workspace, conversation and task run. Phase counts, agent status, available model usage and duration are displayed.
- **Chat remains available:** The main agent can reply that the workflow started while background workers continue. The user may keep chatting or open other workspaces.
- **Safe cancellation/recovery:** Stop targets real child agents and respects the existing Permission Gate, including approval before creating Git worktrees in Review mode. Workflows are durably recorded; interrupted Git modifications are not blindly retried or erased.

## CI and verification

Source merged from [PR #36](https://github.com/pddczpl/ChatMCP/pull/36), verified by [CI 9/9 PASS](https://github.com/pddczpl/ChatMCP/actions/runs/38891039897) across Windows and Ubuntu (Hub tests Node 22/24, React/real Hub E2E, production frontend, Windows installer/WebView2 smoke and repository hygiene). The versioned release workflow independently rebuilds the Windows installer and checks SHA-256 before publication.

The tests use scripted model providers, not live paid gateways. Actual model ability to invoke functions and follow workflow instructions still depends on its provider protocol and model capabilities. This release does **not** establish behavioral parity with Codex Desktop, Claude Code, or Goose.

## Install or upgrade (Windows x64)

Download `ChatMCPSetup.exe` and its matching `ChatMCPSetup.exe.sha256` from this GitHub release. Verify the checksum before installing. Stop the older ChatMCP Hub process first to avoid the stale service on port 3007, then install and launch v3.7.0. Local credentials and task history are not intentionally deleted by upgrade.

## Security and known limitations

- **No Authenticode signature:** SHA-256 validates file contents but does not verify the software publisher.
- **Git worktrees are not OS sandboxes:** Child jobs run with the user's local permissions and subject to existing approval gates. Workers' branches are not automatically merged into a parent or main branch.
- **Verification remains necessary:** Review findings and code edits must be checked against source files, actual diff and project tests. Completion of a workflow is not a guarantee that its conclusions are correct.
- **Provider usage:** Running parallel agents can consume significantly more API requests and tokens and may incur charges. ChatMCP does not impose spending caps.
- **Interrupted tasks:** Inspect any uncertain Git mutation before retrying. Some tasks may remain paused/blocked after a restart until the user reviews them.
- **Legacy Studio Inspector:** Its file/Git/terminal operations remain bound to the primary project, and are not silently redirected when another workspace is selected.
