# DatGold v3.10.2 — streaming, a model catalog, hooks and a DatGold installer

DatGold is the new name of ChatMCP ([docs/NAMING.md](docs/NAMING.md)). This is the first **normal release** since v3.9.0 and is published as the latest release. It contains everything of the two test builds that were published as pre-releases (v3.10.0 and v3.10.1) and what was merged after v3.10.1: roughly the roadmap phases P0, P1 and P3, a DatGold installer, a new icon and fixes for installations that have been used for a while.

The file names (`ChatMCPSetup.exe`, `ChatMCP.exe`), the install folder, the settings folder and the registry key still say ChatMCP on purpose, so that an upgrade finds what v3.9.0 made. What you read says DatGold: the application, and from this version the installer, the uninstaller, the shortcuts and the entry in Apps & features.

## What changed since v3.9.0

**Models and thinking.** A catalog of models (a dated snapshot of models.dev, refreshed only when you ask) gives each model's context window, output limit and prices. The Hub plans its history on them, stops at the first rise of the model's price, and shows an estimated cost; a number you type still wins over the catalog. A model picker shows the catalog's notes. New presets: Grok (xAI), GLM, Qwen and MiniMax; OpenAI now defaults to `gpt-5.6-terra` and DeepSeek to `deepseek-flash`. The thinking effort can be set in the AI connection and in model profiles, and for one task beside the composer (Chat Completions `reasoning_effort`, Responses `reasoning.effort`, Anthropic `output_config.effort`); Gemini has a thinking level (Gemini 3 and 4) or a token budget (2.5).

**Streaming.** The model's text appears while it arrives on all four protocols (Chat Completions, Anthropic Messages, Gemini, OpenAI Responses). A tool call is used only after the stream's final event. A stream that is cut or damaged is never half used: the same request is made once more without a stream and the text already shown is taken back.

**Anthropic thinking blocks.** Claude 5 models think by default. Their thinking blocks are kept and sent back with the result of their tool call when nothing before them has changed, and are left out when the Hub has shortened the history (a changed history would make the server refuse them). If a server refuses them anyway the request is repeated once without them. The transcript on disk holds neither the signatures nor the thoughts.

**Tools.** `edit_file` takes several edits in one call (at most 50, all or nothing, one receipt). `repo_map` is ranked by PageRank, resolves Python imports and lists the files Git lists. `search_files` and `find_files` use ripgrep 15.2.0, bundled in the installer, with `.gitignore` honoured; without it they fall back to the Git listing or a walk.

**Agent.** Hooks (`PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `TaskCompleted`) from an owner-level `hooks.json`; project instruction files (`AGENTS.md`, `CLAUDE.md`) read within a budget; skills selected on the conversation and loaded on demand; tool schemas selected automatically; results and stop notices of background agents. One writer keeps the model's history, and host messages wait until every result of a model turn is in. The Agents tab lists the background tasks; the two sections that v3.10.0 had for agent groups and for code edits are gone from the page (the Hub routes behind them are unchanged).

**Safety.** The Hub requires a per-launch secret ([docs/HUB-AUTH.md](docs/HUB-AUTH.md)); the desktop shell, the installer and the scripts present it, and a Hub from v3.9.0 or older, which has none, is still stopped by the older flow. Full Access still asks before what cannot be taken back, and leaving Full Access is decided by the Hub. Read Only reads no protected file below a directory it searches. Agents spawned by a model are capped in depth and tree size. The ChatGPT Web path filters outgoing text for secrets, withholds protected files and can hold a message for your review. LICENSE (Apache-2.0), NOTICE and the license texts of what is compiled into the bundled `rg.exe` ship in the installer.

**Interface and installer.** The name DatGold, a new application shell and Settings page, an English version of the conversation screen, the sidebar and the dialogs (the Vietnamese text is unchanged), and a new icon: a gold "D" on the dark rounded square. The setup wizard and the uninstaller are in DatGold's name. Setup makes the Desktop shortcut `DatGold Studio` and the Start menu folder `DatGold` (both boxes of the wizard are checked by default); on an upgrade it removes the shortcuts that earlier versions made as `ChatMCP Studio`, but only those that point into the installation it replaces, and the uninstaller removes both sets.

**Fixes since v3.10.1.** On an installation that had been used for a while, the installer, the uninstaller and `STOP-CHATMCP-HUB.cmd` could not read the Hub's state, which grows with use (445,101 bytes on one machine), through limits of 256 KiB and 64 KiB; an upgrade or an uninstall then ended in "Cannot write more bytes to the buffer than the configured maximum buffer size" and the uninstaller in the .NET "Unhandled exception" dialog. The limit is now 64 MiB, and the uninstaller shows what stopped it in a message box and returns to its question.

## Upgrade

Download `ChatMCPSetup.exe` and its `.sha256` file from this release, compare the digest with `RELEASE-MANIFEST.json`, close DatGold, stop active tasks and install over v3.9.0, v3.10.0 or v3.10.1. The installer keeps your settings and history. The Browser Companion is a separately installed extension; its version stays **1.5.2**, so reload the unpacked extension and pair again if asked.

If you have used v3.10.1 or v3.10.0 for a while, **install this version over it instead of running the old uninstaller or the old `STOP-CHATMCP-HUB.cmd`**: both of those still have the size limit above and fail on a used installation. The new setup stops the Hub itself and replaces `Uninstall.exe`.

The Hub's health version is `3.10.2` and the UI build identifier is `3.10.2-react-agent`. Pins on the taskbar or Start menu that were made from the old `ChatMCP Studio` shortcut keep that name until they are pinned again; if Windows still shows the old icon, `ie4uinit.exe -show` or signing out and in refreshes its cache.

## What to try

- Install over v3.10.1 (or v3.9.0) with DatGold closed: the wizard says "DatGold Studio Setup"; afterwards the Desktop has `DatGold Studio`, the Start menu has the folder `DatGold`, Apps & features lists `DatGold Studio`, no `ChatMCP Studio` shortcut is left, and your connection and history are still there.
- Open DatGold: the Agents tab shows the background tasks only.
- Uninstall from Apps & features: both sets of shortcuts go and your data folder stays. With a task still running the message box says why and nothing is removed.
- Ask a question with a real provider key: the text should appear while it arrives; pick a model from the catalog and set a thinking effort.

## What is not verified

- **No automated test calls a live provider.** The thinking-block rules were tried once, by hand, against a real Anthropic account (claude-sonnet-5-5); every other provider, and the quirks of a real server's stream, are simulated from the vendors' documentation, and the streams in the tests are generated from a plan, not recorded.
- CI runs the upgrade from the published v3.9.0 on a hosted Windows runner (shortcut migration and uninstall included). The upgrade from v3.10.0 and v3.10.1, `guest-lifecycle.ps1` (Windows Sandbox) and the new message box in a real window were not run by CI.
- The bundled ripgrep was staged and run by the installer build; searching 48,000 files took 2.3 s with a stand-in binary on a Windows machine with Defender (the target was 1 s). Qwen's limits in the catalog are not checked against the vendor.
- The installer is not Authenticode-signed and no signed-in Edge/ChatGPT session was tried; `RELEASE-MANIFEST.json` says so.

## How it was built

It is published by a copy of the v3.10.1 release workflow, which refuses to publish unless the full regression on the exact release commit, the installer build, the installed upgrade from the published v3.9.0, the WebView2 smoke test and the asset checksums have all passed. It does not claim equivalence with other coding agents. See [Security](SECURITY.md) and [the upgrade checkpoint](docs/UPGRADE-IMPLEMENTATION-STATUS.md).
