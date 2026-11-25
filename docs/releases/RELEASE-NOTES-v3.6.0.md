# ChatMCP v3.6.0 — Workspace Hierarchy & Gateway Reliability

This Windows x64 release corrects how ChatMCP organizes multiple projects and autonomous agent work, and improves model gateway connection checks. Changes from [PR #33](https://github.com/pddczpl/ChatMCP/pull/33) are included.

## What's new

- **Multiple workspaces:** Register local project folders using the native Windows folder picker. Selecting another workspace does not stop agents already running in different project folders.
- **Workspace → Conversation → Task → Subagent:** The conversation sidebar groups chats by workspace; Background Tasks displays *individual execution runs* rather than counting chats as tasks. A single conversation can contain several distinct task runs, each with its own persistent run ID and title.
- **Parent-run-scoped subagents:** A child agent is shown under the task run that spawned it, not under a later conversation continuation or as a separate top-level user chat.
- **Concurrent project work:** Separate registered workspaces can execute independently. Overlapping writers are isolated with Git worktrees; worktrees still need explicit review and integration.
- **Git-optional folders:** Ordinary directories without initialized Git remain selectable; the branch/worktree picker returns an empty Git list rather than a connection error.
- **Gateway diagnostics:** Each connection probe and tool-calling probe can wait **up to 20 seconds**. The overall diagnostic deadline has been increased accordingly. Provider-specific routing and credential isolation have regression coverage for Anthropic/Claude, DeepSeek, OpenRouter, OpenAI and Gemini.
- **Model list:** The interface includes Mistral along with the existing named and custom provider options.

## Verification

The source changes were merged in [PR #33](https://github.com/pddczpl/ChatMCP/pull/33), with [all nine required CI checks passing](https://github.com/pddczpl/ChatMCP/actions/runs/38866191218): Hub tests on Windows/Ubuntu Node 22 and Node 24, React E2E on both systems, frontend build, Windows installer/WebView2 smoke, and repository hygiene. The updated `main` commit additionally passed its post-merge CI. The versioned release workflow rebuilds the installer from the **exact tagged commit**, reruns Hub regression tests, performs native WebView2 smoke and verifies SHA-256 before publishing.

These tests use scripted providers, not paid live API probes; production compatibility still depends on the specific URL, endpoint protocol, model, rate limits, and provider support for tool calling and image inputs.

## Install or upgrade

Download `ChatMCPSetup.exe` for **Windows x64** plus its matching `ChatMCPSetup.exe.sha256` from this release. Verify SHA-256 before installation. Stop the existing ChatMCP Hub before upgrading, then restart the desktop app. Existing local conversation history and DPAPI-protected model credentials are not intentionally deleted.

## Current limitations

- **Unsigned installer:** No Authenticode publisher signature is present. SHA-256 verifies file contents but does not establish software publisher identity.
- **Legacy Inspector:** File/Git/terminal mutations in the existing Studio Inspector are scoped to the original primary Hub workspace. When another workspace is selected, those controls are hidden to avoid accidentally modifying the wrong project; conversation and Background Tasks controls remain usable.
- **Git worktrees are not sandboxes:** Concurrent worktree writers operate with local user privileges subject to the existing permission gate. No OS sandbox guarantee or automatic Git merge is implied.
- **In-flight Git mutations:** After an interrupted or uncertain mutation, check the saved worktree and branch before continuing. The agent does not blindly replay writes or delete possible user changes.
- **Usage:** Parallel subagents may increase API requests, token usage and provider fees. ChatMCP does not impose its own billing quota.
