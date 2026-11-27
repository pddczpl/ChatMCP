# DatGold v3.12.0 — review every change, plan before the agent writes, MCP servers and true resume

This is a normal release and is published as the latest release. It contains everything of v3.11.2 and what was merged after it (pull requests 97 to 174). It is the first release that an installed v3.11.2 can offer through the **Update button**, and the first one made by the hand-started release workflow. Updating is recommended.

## What changed since v3.11.2

**You see and judge what changed.** The new **Review** tab shows the files of a conversation hunk by hunk; you accept or reject each hunk, or all of them. The approval card of a file change shows the real change, worked out by the Hub from the files as they are, and the call that follows is refused when a file changed after you answered. You can undo one step, the whole task, or only some files of a checkpoint.

**Plan mode.** In the mode menu of the message box, *Plan* starts a conversation (or its next message) that reads and plans and changes nothing until you approve the plan. The approval card lets you edit the plan, ask for changes, or approve it for Review or for Autonomous; the Plan tab can be edited at any time. It is a setting of that conversation, never of the permission mode. Not available with the ChatGPT Web Companion.

**A continued conversation gets its real history back.** The Hub keeps the conversation in a versioned journal, so continuing after a stop or a restart replays the history instead of a summary. A chip says how the run was resumed. Tasks made by older versions continue from their checkpoint text, as before.

**External MCP servers.** The *MCP servers* tab (under More) is where you add a server, approve how it is started and approve its tools. Nothing of a server runs or is offered to the agent before that, a tool list that changed has to be approved again, and the tools of external servers have a permission category of their own: you can allow, ask for or deny each one.

**DatGold as an MCP server, off by default.** Local MCP clients can call the Hub's tools through a separate loopback port with its own token, behind the same permission gate and your approvals. A new token may run the project's checks and read Git's view of the work; reading files and writing are opt-in. There is no setup screen yet ([MCP-SERVER.md](https://github.com/pddczpl/ChatMCP/blob/v3.12.0/docs/MCP-SERVER.md)).

**DatGold as an agent in your editor (ACP).** An editor that speaks the Agent Client Protocol can start DatGold as its agent: sessions, prompts, events, approvals in the editor, loading a session ([ACP.md](https://github.com/pddczpl/ChatMCP/blob/v3.12.0/docs/ACP.md)).

**`git_push` for the agent.** It publishes one branch to a configured remote. It asks every time, in Full Access too, never forces and refuses main, master and the default branch of the remote.

**Proof-of-Done, the first parts.** Receipts of checks are bound to the exact tree of the workspace, and a proof ledger records the calls and the checks of a task. When a project has a `.chatmcp/acceptance.yml` that you trusted, the agent cannot finish "done" while your checks fail: it is sent back once with the results, and a second failure ends the task as failed. **The command line that trusts such a file (`chatmcp verify`) is not part of the installation yet**: it runs from a checkout of the repository ([PROOF-CLI.md](https://github.com/pddczpl/ChatMCP/blob/v3.12.0/docs/PROOF-CLI.md), [PROOF-GATE.md](https://github.com/pddczpl/ChatMCP/blob/v3.12.0/docs/PROOF-GATE.md)). Without a trusted file nothing is gated. A run that the done-gate judged leaves a proof pack: the Hub keeps the latest one of each task and answers it over HTTP as JSON, Markdown or HTML, in English or Vietnamese, and an acceptance file can be trusted over HTTP too ([PROOF-HUB-API.md](https://github.com/pddczpl/ChatMCP/blob/v3.12.0/docs/PROOF-HUB-API.md)). There is no page for it yet.

**The approval card of a command.** The card of a command shows every part of it that bash, PowerShell or cmd acts on: the program, the files it writes to and the text it runs as code. Ordinary credentials (`--password X`, `API_KEY=X`, `Authorization: Bearer X`, a password in a URL) stay hidden, and a registered secret is hidden wherever it stands. The summary, the reasons, the line that starts an MCP server and the command an editor is asked about over ACP follow the same rule ([APPROVAL-PREVIEW.md](https://github.com/pddczpl/ChatMCP/blob/v3.12.0/docs/APPROVAL-PREVIEW.md)).

**Fixes.**
- A task starts in the folder you just chose or added in the sidebar, not in the one before it.
- Stopping a terminal ends its whole process tree; it says when it could not.
- The credential files of command-line tools (Docker, GitHub CLI, Azure, Terraform state and others) are protected files.
- The live streams of both engines reach the page, and a streamed answer is masked like the saved one.
- Uninstall removes the files before the entry in Apps, and a shortcut or registry entry that fails is reported.
- An expired approval is not recorded again as cancelled; `replace_all` counts every place it changed; the arguments of a tool call are masked as the texts they hold.
- The old dashboards are gone: an installation without its page answers 503 and says so.
- Helper programs (GitHub CLI, Git, Docker, Python, the language servers, `taskkill`, `icacls`) are started by the absolute path of the installed program, never from the workspace; one that is not installed is reported as not installed.
- In plan mode, calls that the model put behind an approved plan in the same turn wait for the next turn, so a step you took out of the plan does not run. A plan is addressed by its task id exactly as the Hub writes it, and a plan that masking makes too long is reported to the model instead of ending the run.

**Downloads.** `DatGoldSetup.exe` and `DatGold-Browser-Companion.zip` (each with its `.sha256`) and `RELEASE-MANIFEST.json` with its signature, as in v3.11.2.

## Upgrade

**From v3.11.0, v3.11.1 or v3.11.2:** Settings → Updates → Check now. When it shows 3.12.0 with a valid signature, press Download; when the download is checked, press **Install and restart** in the desktop app.
**From v3.10.x or older:** install by hand, once. Download `DatGoldSetup.exe` and its `.sha256` file, compare the digest with `RELEASE-MANIFEST.json`, close DatGold, stop active tasks and install over your version. Copies installed from older builds were made without the keys that sign releases, so their apps cannot check a signature.

The Browser Companion is a separately installed extension; its version stays **1.5.2** (only its instruction files changed).

The Hub's health version is `3.12.0` and the UI build identifier is `3.12.0-react-agent`.

## What to try

- Let the agent change a file, open **Review**, reject one hunk and look at the file.
- Start a conversation in *Plan*, edit a step in the approval card, approve it for Review.
- Close DatGold in the middle of a conversation, open it again and continue: the chip should say that the history was replayed.
- Add an MCP server you trust in the *MCP servers* tab.
- Update from v3.11.2 with the button, and tell us what happened.

## What is not verified

- **None of the new parts was used on a real installation with a real model.** They are tested by the Hub's own suites, mutation lists and browser tests, with scripted models and real processes.
- **The Update button** is verified only on a hosted runner. A click on a real machine against the real GitHub is for the first person who tries and tells us.
- **Editors:** no real editor (Zed, JetBrains, Neovim, Emacs, VS Code) has been connected over ACP.
- **MCP:** no server beyond two reference servers and the test fixtures, no OAuth for HTTP servers; no real client (Claude Code, Codex, Claude Desktop) has connected to the Hub's MCP server.
- **Resume:** whether a real provider accepts every continued conversation was not tried; a Hub that is killed and started again was tested from a copy of its files.
- **Plan mode** was not tried in the WebView2 window or with a screen reader.
- **Proof-of-Done:** the baseline of a large workspace takes time and disk that were not measured; agents started by another agent, the Companion and MCP clients are not gated.
- Windows may ask for confirmation, or block, a setup that is not Authenticode-signed (SmartScreen, Smart App Control); the installer is not signed and `RELEASE-MANIFEST.json` says so.
- No automated test calls a live provider, and no signed-in Edge/ChatGPT session was tried.

## How it was built

It is published by the hand-started release workflow ([RELEASING.md](https://github.com/pddczpl/ChatMCP/blob/v3.12.0/docs/RELEASING.md)), which refuses to publish unless the complete Hub regression on the exact release commit, the installer build, the installed upgrade from the published v3.9.0, the WebView2 smoke test, the release gate and the asset checksums have all passed. The signature of `RELEASE-MANIFEST.json` is made by hand with the project's release key after the workflow has published the files.
