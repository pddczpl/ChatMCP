# Archive

Documents of versions that are long past. They are kept as history and are **not** updated: commands, file names, folder names (`CHATMCP-HUB/`), the product name (ChatMCP Studio) and version numbers in them are those of their time, and links inside them may point at files that no longer exist. Nothing in the product, the tests or the workflows reads this folder. For the current state start at [docs/INDEX.md](../INDEX.md).

The files were moved here in November 2026 with `git mv`, so `git log --follow <file>` shows their history.

| What | Files | Where it stood |
|---|---|---|
| Notes of Hub 2.0.0 to 2.2.8: what each version changed, how to upgrade, the test output of the day | `hub/STUDIO-2.*.md`, `hub/UPGRADE-2.*.md`, `hub/TEST-RESULTS-2.*.txt` | `DATGOLD-HUB/` |
| Release texts of Hub 1.2.0, 1.3.0 and 2.0.0 | `hub/RELEASE-1.2.0.txt`, `hub/RELEASE-1.3.0.txt`, `hub/RELEASE-2.0.0.txt` | `DATGOLD-HUB/` |
| Notes on single features of the 1.x and 2.x Hub: retry after a lost connection, session recovery, the two agent modes | `hub/NETWORK-RECOVERY.txt`, `hub/SESSION-RECOVERY.md`, `hub/AGENT-MODES.md` | `DATGOLD-HUB/` |
| Local test results of Studio 1.3.0 with Companion 1.4.0 | `hub/VALIDATION.txt` | `DATGOLD-HUB/` |
| Mock-up pictures of the 2.x Studio page | `hub/ui-preview-mock.png`, `hub/screenshots/studio-dark-mock.png`, `hub/screenshots/studio-light-mock.png` | `DATGOLD-HUB/docs/` |
| Validation record of the helper extension ChatMCP Button Fix 1.1.0, whose files stood at the repository root until they were removed in the same change | `VALIDATION.txt` | the repository root |
| Release notes of 3.0.0, 3.0.1 and 3.0.2, the three versions that have no publish workflow | `RELEASE-NOTES-v3.0.0.md`, `RELEASE-NOTES-v3.0.1.md`, `RELEASE-NOTES-v3.0.2.md` | the repository root |

The release notes from 3.0.3 on stay at the repository root, because the `publish-vX.Y.Z.yml` workflow of each version reads its file from there. [CHANGELOG.md](../../CHANGELOG.md) is the history of record.
