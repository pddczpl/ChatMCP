# Evidence of runs in real editors

The ACP agent of DatGold ([../ACP.md](../ACP.md)) is tested against a real Hub with the official TypeScript SDK as the client. No real editor has been run against it yet:

| Folder | Editor | Status |
| --- | --- | --- |
| [acp-zed](acp-zed/README.md) | Zed | not run yet |
| [acp-jetbrains](acp-jetbrains/README.md) | a JetBrains IDE (AI Assistant) | not run yet |

## What the owner clicks (about 15 minutes for each editor)

1. Install DatGold, open the desktop app, connect a model.
2. Open a Git project in the editor and paste the entry of [the guide](../ACP.md#set-it-up-in-an-editor) (Zed: `zed: open settings file`; JetBrains: AI Chat, menu, "Add Custom Agent"), with the real install folder.
3. Go through the 8 items of the folder's README, one screenshot each, in a new folder `run-<date>/`.
4. Write `notes.md` (date, versions, what went differently), then make `SHA256SUMS` last.
5. Commit the folder as it is. A failed item stays a failure.
