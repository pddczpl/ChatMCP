# Naming: DatGold, formerly ChatMCP

The product is called **DatGold**. It was called ChatMCP until 2026-10-24. Releases up to 3.9.0 were published under the old name and stay available under it.

The change was made in two steps so that nothing a person already has stops working:

1. **The name people read** (this step, done). Every screen, message, window title, document and the Browser Companion say DatGold.
2. **The identifiers** (not done). Names that other programs, scripts, stored data or an upgrade depend on keep the old spelling until each can change with an alias or a migration. The table below lists them; nothing in it is an oversight.

The legal name of the copyright holder did not change: **Phan Danh Dat** (see [NOTICE](../NOTICE)).

## What says DatGold

- The React UI, in Vietnamese and in English (screens, dialogs, toasts, confirmations), and the title of the page.
- The title and status texts of the desktop window, and the product, company and description fields of the application file.
- The Browser Companion: the name Chrome and Edge show (`DatGold Hub Companion`), its button, popup and instructions.
- The messages and sentences the Hub writes for a person: the sign-in and pairing errors, the Windows Sandbox probe, the verification and hook notes at the end of an answer, the "withheld" notice for a protected file, the header of the exported ChatGPT-web transcript, the names of the files it offers to save, the authors of the built-in skills, the hooks schema.
- The README, NOTICE, SECURITY, CONTRIBUTING, the third-party notices and the living documents in `docs/` and `design/`.

`CHATMCP-HUB/tests/verify-display-name.mjs` reads those places and fails for any ChatMCP that is not one of the exceptions below, so the old name cannot come back unnoticed.

## What still says ChatMCP, and why

| Where | What | Why it stays | Changes with |
| --- | --- | --- | --- |
| Repository and releases | `github.com/pddczpl/ChatMCP`, `ChatMCPSetup.exe`, `ChatMCP-Browser-Companion.zip`, the release workflows | Links in the UI and the documents, the file names the upgrade test downloads, and releases that exist | The release pipeline step (P5) |
| Installer and installed program | `ChatMCP.exe`, `%LOCALAPPDATA%\Programs\ChatMCP`, the Start menu folder, the `ChatMCP Studio` shortcuts, the `ChatMCP Studio` entry of Apps & features, the registry key, the wizard texts | The installer finds, replaces and removes what an earlier version made by these names, and CI installs the published 3.9.0 first and upgrades it. Renaming only the new ones would leave orphans | The installer step: new names, removal of the old ones on upgrade, and the upgrade test |
| User data | `%LOCALAPPDATA%\ChatMCP` (Hub state, logs, WebView2 data) | The history, key store and settings of every existing install are there | The installer step, with a migration |
| Source tree | the folder `CHATMCP-HUB/`, file names `chatmcp-*`, namespaces `ChatMCP.*`, environment variables `CHATMCP_*`, request headers `X-ChatMCP-*`, browser storage keys `chatmcp:*`, project files `.chatmcp/`, the health id `chatmcp-local-hub` | They are interfaces: scripts, stored data, the extension and other programs use them | The identifier step, one family at a time, each with an alias for the old name |
| What models are told | The system prompts and the text of the gateway and Gemini contracts ("You are the task agent in ChatMCP Hub") | They are instructions, not a display name; changing a word changes what a model is told and needs its own test | The next revision of the prompts |
| Tasks saved by an older Hub | A final text that ends `[Verification notice] ChatMCP has NOT independently verified ...` | It is stored data. The Hub reads both wordings and writes the new one | Stays |
| Developer tools | Git identities used by the coding agent (`ChatMCP Coding Agent`), the console banners of the test and smoke scripts, comments in the code | Not shown to a person using the product | With the identifier step |
| Older things | The helper extension `ChatMCP Button Fix` (a different, older helper), the legacy pages `/classic` and `/legacy`, and the historical documents (`RELEASE-NOTES-*`, `CHANGELOG.md`, `docs/PHASE*`, `docs/agent-handoffs/`) | They describe or belong to the past; history is not rewritten | The legacy pages are deleted in P8; the rest stays |

Two phrases keep the old name on purpose because they describe a real folder: "the folder where ChatMCP is installed" (the Browser Companion instructions) and `cd ChatMCP` (the folder `git clone` makes). Both change with the folders.

## Checking

```
node CHATMCP-HUB/tests/verify-display-name.mjs
```

A new string, screen or document must say DatGold. If something truly has to keep the old spelling, add it to this table and to the `TECHNICAL` list in that test, with the reason.
