# DatGold v3.10.0 (test build) — streaming, thinking blocks, a model catalog and new tools

DatGold is the new name of ChatMCP ([docs/NAMING.md](docs/NAMING.md)). This is a **test build**, published as a *pre-release*: GitHub keeps showing v3.9.0 as the latest release. It contains everything merged after v3.9.0 (about 250 commits: roadmap phases P0, P1 and P3) and is meant to be installed over a v3.9.0 installation and tried, not to be read as a stable release.

The installer, its file names, the install folder and the settings folder still say ChatMCP on purpose, so that an upgrade finds what v3.9.0 made. The words you read inside the application say DatGold.

## What changed since v3.9.0

**Models and thinking.** A catalog of models (a dated snapshot of models.dev, refreshed only when you ask) gives each model's context window, output limit and prices. The Hub plans its history on them, stops at the first rise of the model's price, and shows an estimated cost; a number you type still wins over the catalog. A model picker shows the catalog's notes. New presets: Grok (xAI), GLM, Qwen and MiniMax; OpenAI now defaults to `gpt-5.6-terra` and DeepSeek to `deepseek-flash`. The thinking effort can be set in the AI connection and in model profiles, and for ONE task beside the composer (Chat Completions `reasoning_effort`, Responses `reasoning.effort`, Anthropic `output_config.effort`); Gemini has a thinking level (Gemini 3 and 4) or a token budget (2.5).

**Streaming.** The model's text appears while it arrives on all four protocols (Chat Completions, Anthropic Messages, Gemini, OpenAI Responses). A tool call is used only after the stream's final event. A stream that is cut or damaged is never half used: the same request is made once more without a stream and the text already shown is taken back.

**Anthropic thinking blocks.** Claude 5 models think by default. Their thinking blocks are kept and sent back with the result of their tool call when nothing before them has changed, and are left out when the Hub has shortened the history (a changed history would make the server refuse them). If a server refuses them anyway the request is repeated once without them. The transcript on disk holds neither the signatures nor the thoughts.

**Tools.** `edit_file` takes several edits in one call (at most 50, all or nothing, one receipt). `repo_map` is ranked by PageRank, resolves Python imports and lists the files Git lists. `search_files` and `find_files` use ripgrep 15.2.0, bundled in the installer, with `.gitignore` honoured; without it they fall back to the Git listing or a walk.

**Agent.** Hooks (`PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `TaskCompleted`) from an owner-level `hooks.json`; project instruction files (`AGENTS.md`, `CLAUDE.md`) read within a budget; skills selected on the conversation and loaded on demand; tool schemas selected automatically; results and stop notices of background agents; an Agents tab for agent groups and code edits. One writer keeps the model's history, and host messages wait until every result of a model turn is in.

**Safety.** The Hub requires a per-launch secret ([docs/HUB-AUTH.md](docs/HUB-AUTH.md)); the desktop shell, the installer and the scripts present it, and a Hub from v3.9.0 or older, which has none, is still stopped by the older flow. Full Access still asks before what cannot be taken back, and leaving Full Access is decided by the Hub. Read Only reads no protected file below a directory it searches. Agents spawned by a model are capped in depth and tree size. The ChatGPT Web path filters outgoing text for secrets, withholds protected files and can hold a message for your review. LICENSE (Apache-2.0) and NOTICE ship in the installer.

**Interface.** The name DatGold, a new application shell and Settings page, and an English version of the conversation screen, the sidebar, the Agents tab and the dialogs (the Vietnamese text is unchanged).

## Upgrade from v3.9.0

Download `ChatMCPSetup.exe` and its `.sha256` file from this release, compare the digest with `RELEASE-MANIFEST.json`, stop active tasks and install over the existing installation. The installer keeps your settings and history. The Browser Companion is a separately installed extension; its version stays **1.5.2** and only the name it shows changed, so reload the unpacked extension and pair again if asked.

The Hub's health version is `3.10.0` and the UI build identifier is `3.10.0-react-agent`.

## What to try

- Install over v3.9.0 and open DatGold: your connection and history should still be there.
- Ask a question with a real provider key: the text should appear while it arrives; stop a task in the middle.
- In Settings (AI Model), pick a model from the catalog and set a thinking effort; try the per-task choice beside the composer.
- With a Claude 5 model, run a task that calls several tools in a row.
- Ask for a search in a large repository, and an `edit_file` call with several edits.

## What is not verified

- **No test called a live provider** (Anthropic, OpenAI, Google or any other). The quirks of a real server's stream, and how a real Anthropic account reads "the same conversation" for a thinking block, are simulated from the vendors' documentation; the streams in the tests are generated from a plan, not recorded.
- The bundled ripgrep was staged and run by the installer build, never on a developer machine; searching 48,000 files took 2.3 s with a stand-in binary on a Windows machine with Defender (the target was 1 s). The notices of the libraries linked into `rg.exe` (PCRE2 and Rust crates) are still to be added to [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- Qwen's limits in the catalog are not checked against the vendor.
- The installer is not Authenticode-signed and no signed-in Edge/ChatGPT session was tried; `RELEASE-MANIFEST.json` says so.

## How it was built

It is published by the same release workflow as v3.9.0, which refuses to publish unless the full regression on the exact release commit, the installer build, the installed upgrade from the published v3.9.0, the WebView2 smoke test and the asset checksums have all passed. It does not claim equivalence with other coding agents. See [Security](SECURITY.md) and [the upgrade checkpoint](docs/UPGRADE-IMPLEMENTATION-STATUS.md).
