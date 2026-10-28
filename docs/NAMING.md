# Naming: DatGold, formerly ChatMCP

The product is called **DatGold**. It was called ChatMCP until 2026-10-24. Releases up to 3.9.0 were published under the old name and stay available under it.

The change was made in two steps so that nothing a person already has stops working:

1. **The name people read** (done). Every screen, message, window title, document and the Browser Companion say DatGold, and so do the setup and uninstall wizard and the shortcuts and the Apps & features entry they make (2026-10-25).
2. **The identifiers** (not done). Names that other programs, scripts, stored data or an upgrade depend on keep the old spelling until each can change with an alias or a migration. The table below lists them; nothing in it is an oversight.

The legal name of the copyright holder did not change: **Phan Danh Dat** (see [NOTICE](../NOTICE)).

## What says DatGold

- The React UI, in Vietnamese and in English (screens, dialogs, toasts, confirmations), and the title of the page.
- The title and status texts of the desktop window, and the product, company and description fields of the application file.
- The setup wizard and the uninstaller (title, header, every text, the file properties of the setup file), the shortcuts they make (Desktop `DatGold Studio`, Start menu folder `DatGold`) and the entry in Apps & features (`DatGold Studio`). Setup also removes the shortcuts that versions up to 3.10.1 made under the old name, and the uninstaller removes both sets (see below).
- The files you download from a release: `DatGoldSetup.exe` with its `.sha256`, and `DatGold-Browser-Companion.zip` (from the first release after 3.10.2). Releases up to 3.10.2 published `ChatMCPSetup.exe` and `ChatMCP-Browser-Companion.zip` and keep those file names; every later release also publishes the Companion under the old name, as a copy (see the table). The setup file inside is built as `DatGoldSetup.exe`, so its properties, and those of the `Uninstall.exe` that it copies, name DatGold; setup still recognises an `Uninstall.exe` of an earlier version by its old names (`IsOwnVersionInfo` in `installer/InstallerEngine.cs`).
- The icon: a gold D on a dark rounded square, drawn by `scripts/generate-brand-icon.py` without a font. It is the icon of the application, the setup file, the shortcuts, the Apps & features entry and the browser tab (the files keep their old names: `assets/icons/chatmcp.ico`, `DATGOLD-HUB/web/favicon.ico`).
- The Browser Companion: the name Chrome and Edge show (`DatGold Hub Companion`), its button, popup and instructions.
- The messages and sentences the Hub writes for a person: the sign-in and pairing errors, the Windows Sandbox probe, the verification and hook notes at the end of an answer, the "withheld" notice for a protected file, the header of the exported ChatGPT-web transcript, the names of the files it offers to save, the authors of the built-in skills, the hooks schema.
- The README, NOTICE, SECURITY, CONTRIBUTING, the third-party notices and the living documents in `docs/` and `design/`.

`DATGOLD-HUB/tests/verify-display-name.mjs` reads those places and fails for any ChatMCP that is not one of the exceptions below, so the old name cannot come back unnoticed.

## What still says ChatMCP, and why

| Where | What | Why it stays | Changes with |
| --- | --- | --- | --- |
| Repository and releases | `github.com/pddczpl/ChatMCP`, the release workflows, the file names of releases up to 3.10.2 (`ChatMCPSetup.exe`, `ChatMCP-Browser-Companion.zip`), and `ChatMCP-Browser-Companion.zip` as a copy of the Companion in every later release | A published file cannot be renamed; the upgrade test downloads the published 3.9.0 as `ChatMCPSetup.exe`; every installed version links to `releases/latest/download/ChatMCP-Browser-Companion.zip`, so a release without that file would break the link in the app | The release pipeline step (P5); the copy can go when no supported version links to it |
| Installer and installed program | `ChatMCP.exe`, `%LOCALAPPDATA%\Programs\ChatMCP`, the registry key `...\Uninstall\ChatMCP`, and the update folder `.ChatMCP-update-*`. (The Hub folder inside the installation is `DATGOLD-HUB\`, as in the repository. Installations made up to 3.11.0 called it `CHATMCP-HUB\`: the setup of a newer version still recognises the Hub that such an installation started, and renames the folder in one step after it stopped the Hub (`InstallerEngine.RenameLegacyHubFolder`; the update then replaces in it what changed, as in any other update). When Windows refuses the rename it goes file by file: it removes the files that the old setup put there and the folders that are left empty, and keeps any file that somebody changed.) | The installer finds, replaces and removes what an earlier version made by these names, and CI installs the published 3.9.0 first and upgrades it | The identifier step, with the same upgrade test |
| User data | `%LOCALAPPDATA%\ChatMCP` (Hub state, logs, WebView2 data) | The history, key store and settings of every existing install are there | The identifier step, with a migration |
| Source tree | file names `chatmcp-*`, namespaces `ChatMCP.*`, environment variables `CHATMCP_*`, request headers `X-ChatMCP-*`, browser storage keys `chatmcp:*`, project files `.chatmcp/`, the health id `chatmcp-local-hub` | They are interfaces: scripts, stored data, the extension and other programs use them | The identifier step, one family at a time, each with an alias for the old name |
| What models are told | The system prompts and the text of the gateway and Gemini contracts ("You are the task agent in ChatMCP Hub") | They are instructions, not a display name; changing a word changes what a model is told and needs its own test | The next revision of the prompts |
| Tasks saved by an older Hub | A final text that ends `[Verification notice] ChatMCP has NOT independently verified ...` | It is stored data. The Hub reads both wordings and writes the new one | Stays |
| Developer tools | Git identities used by the coding agent (`ChatMCP Coding Agent`), the console banners of the test and smoke scripts, the old checkout installer `scripts/install-desktop.ps1` and `uninstall-desktop.ps1` (they make `ChatMCP Studio` shortcuts that point into a checkout, which setup leaves alone), comments in the code | Not shown to a person using the product | With the identifier step |
| Older things | The helper extension `ChatMCP Button Fix` (a different, older helper), the legacy pages `/classic` and `/legacy`, and the historical documents (`RELEASE-NOTES-*`, `CHANGELOG.md`, `docs/PHASE*`, `docs/agent-handoffs/`) | They describe or belong to the past; history is not rewritten | The legacy pages are deleted in P8; the rest stays |

**Shortcuts of versions up to 3.10.1.** Those versions made the Desktop shortcut `ChatMCP Studio` and the Start menu folder `ChatMCP` with `ChatMCP Studio` and `Uninstall ChatMCP Studio`. Setup now makes `DatGold Studio` and the folder `DatGold`. When it installs over an earlier version it removes the old shortcuts that point into that installation, whichever shortcut choices the wizard shows (the machine then shows one name), and removes the folder `ChatMCP` only if nothing else is in it. The uninstaller removes both sets. A tile that a person pinned to the taskbar or to Start from an old shortcut keeps its old name until it is pinned again. The names setup looks for are `LegacyAppName` and `LegacyStartMenuFolder` in `installer/InstallerEngine.cs`; `scripts/tests/Test-NativeLifecycle.ps1` installs the published 3.9.0 and upgrades it to check the whole sequence.

Two phrases keep the old name on purpose because they describe a real folder: "the folder where ChatMCP is installed" (the Browser Companion instructions) and `cd ChatMCP` (the folder `git clone` makes). Both change with the folders.

## Checking

```
node DATGOLD-HUB/tests/verify-display-name.mjs
```

A new string, screen or document must say DatGold. If something truly has to keep the old spelling, add it to this table and to the `TECHNICAL` list in that test, with the reason.
