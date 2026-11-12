# Evidence: DatGold in a JetBrains IDE (AI Assistant)

**Status: not run yet.** Nothing in this folder shows that DatGold works in a JetBrains IDE. The guide is in [docs/ACP.md, "JetBrains IDEs"](../../ACP.md#jetbrains-ides-ai-assistant).

## The smoke test (8 items)

Run it on Windows (not in WSL: AI Assistant does not support ACP agents there), with DatGold installed and the desktop app open, in a project folder that is a Git repository with at least one commit, in a JetBrains IDE of version 2025.3 or later. For each item, note what you saw and keep a screenshot named after the item (`1-agent-listed.png`, …).

1. **The agent is listed.** AI Chat, menu, "Add Custom Agent"; put the entry of the guide in `acp.json`; "DatGold" is offered in AI Chat.
2. **It starts.** Choose it; "Get ACP Logs" shows `initialize` answered with protocol 1 and `"name": "datgold"`.
3. **A prompt runs.** Ask "What does this project do?"; an answer arrives and the turn ends.
4. **A call is shown.** Ask for something that reads a file; the read appears with the file's name and completes.
5. **An approval is asked.** Put DatGold in Review mode in the desktop app, ask for a small edit; the IDE asks with the change; "Allow" writes the file, and a second try with "Reject" writes nothing.
6. **A cancel stops it.** Ask for a long task and stop it; the turn ends cancelled and the desktop app shows the task stopped.
7. **The desktop app is untouched.** The workspace selected in the desktop app is the same before and after; the folder of the IDE project appears in its list.
8. **Closing the IDE ends the agent.** After closing the IDE, no `node` process of the agent is left, and the desktop app's Hub is still running.

## How the evidence is kept

- One file per item (a screenshot, or a text file with what was seen), and `notes.md` with the date, the versions (IDE and its build, AI Assistant plugin, DatGold, Windows) and anything that went differently.
- A manifest `SHA256SUMS` in this folder: one line per file, `<sha256>  <file name>`, made last (`Get-FileHash -Algorithm SHA256`). Nothing is changed after the manifest is made; a new run is a new folder `run-<date>/`.
- Nothing that was not seen is written down. An item that failed is kept as a failure, with what was seen.
