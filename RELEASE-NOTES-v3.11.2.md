# DatGold v3.11.2 — more skills install, review receipts that hold and the Hub side of per-hunk review

This is a normal release and is published as the latest release. It contains everything of v3.11.1 and what was merged after it (pull requests 92 to 95). It is the first release that an installed v3.11.1 can offer through the **Update button**.

## What changed since v3.11.1

**More skills of the catalogs install.** Pressing Install on `claude-api` in Settings → Kỹ năng (catalog `anthropics/skills`) stopped with "Unsupported or malformed SKILL.md YAML on line 3". The skill's file starts its description with `description: |-`, a YAML block scalar with a chomping indicator, and the Hub's small YAML reader only knew `|` and `>`. It now reads `|`, `>` with an optional `-` or `+` and an optional indentation digit (`|-`, `|+`, `|2`, `>-`), and keeps refusing everything else it does not understand. `claude-api` and nine skills of `github/awesome-copilot` can be installed now. **8 of the 549 skills that the five catalogs list still cannot be read** (2 of `vercel-labs/agent-skills`, 6 of `github/awesome-copilot`). The error now names the skill, the key and the line of the file (the first `---` is line 1; before, it counted from the line after it). A manual, read-only script, `node DATGOLD-HUB/tests/live/check-skill-manifests.mjs --source all`, reads every `SKILL.md` that the Skills card lists and says which ones cannot be read and why; CI never runs it.

**A real `git_diff` leaves its review receipt, and receipts go stale when they should.** The Hub looked for a `diff` field in the result of `git_diff` that the real tool never returned, so a real coding run could not have a review receipt. The tool now returns the digest of a diff that is whole and not empty, and the Hub makes the receipt from it. A receipt also goes stale after every tool that can change the files: `move_path`, `delete_path`, `git_checkout`, `git_merge`, adding or removing a worktree and switching branches (a tool called through `mcp_call` is judged by the name it ran under). Before, the list that did this named `move_file` and `delete_file` where the Hub's tools are called `move_path` and `delete_path`, so a move or a delete after a passing check or a review cleared nothing. **Accepting the objective is still yours**; this changes which receipts the Hub can offer you.

**The Hub side of per-hunk review (no screen uses it yet).** Tool events carry `callId`, a bounded `input` (paths or the command, never the text of a file) and, when the guard made one for that call, `checkpointId`. `GET /api/studio/task-review?taskId=` lists the files a task changed, each against the first checkpoint of the task, and `POST /api/studio/review/reject-created` moves a file that the task created to the undo folder, after a verified copy. The text save of the Studio keeps the BOM and the line endings of the file and takes up to 300,000 bytes. The contract is in [docs/REVIEW-API.md](docs/REVIEW-API.md).

**A file that is not UTF-8 is no longer opened for editing.** `GET /api/studio/file` answers 415 `not_utf8` for a file that would not go back to the same bytes (a Windows-1252 text, for instance). It used to open, and saving replaced the file with the editor's text. The Files tab cannot open such a file any more.

**Downloads.** `DatGoldSetup.exe` and `DatGold-Browser-Companion.zip` (each with its `.sha256`) and `RELEASE-MANIFEST.json` with its signature, as in v3.11.1.

## Upgrade

**From v3.11.0 or v3.11.1:** Settings → Updates → Check now. When it shows 3.11.2 with a valid signature, press Download; when the download is checked, press **Install and restart** in the desktop app.
**From v3.10.x or older:** install by hand, once. Download `DatGoldSetup.exe` and its `.sha256` file, compare the digest with `RELEASE-MANIFEST.json`, close DatGold, stop active tasks and install over your version. Copies installed from older builds were made without the keys that sign releases, so their apps cannot check a signature.

The Browser Companion is a separately installed extension; its version stays **1.5.2**.

The Hub's health version is `3.11.2` and the UI build identifier is `3.11.2-react-agent`.

## What to try

- Settings → Kỹ năng → catalog `anthropics/skills` → Install `claude-api`. If another skill still fails, the message says which key of its front matter.
- Ask the agent to change a file and then to show the diff: the proof strip should list a review receipt that comes from the diff. Edit the file again, or move or delete a file, and the receipt should be stale.
- Open a text file that is not UTF-8 (an old Windows-1252 file) in the Files tab and see that it is refused instead of opened.
- Update from v3.11.1 with the button, and tell us what happened.

## What is not verified

- **The Update button is verified only on a hosted runner.** v3.11.0 and v3.11.1 were signed with the project's real key and read back from GitHub by the Hub's own code, and a CI job drives the click on a hosted Windows runner with a stand-in for GitHub and a key made for the run. A click on a real machine against the real GitHub is for the first person who tries and tells us.
- **The new error message of the Skills card was not seen in the running app.** The Hub's code that raises it, and the code of the card that shows it, were read; no run pressed Install on a skill that cannot be read. The live script reads the files of the catalogs; it installs nothing.
- **The review API has no screen yet.** It is tested by the Hub's own tests and mutation lists only, not by a person clicking.
- A coding run can now carry a review receipt from the real `git_diff`. No test with a real model shows a run that ends "ready" with it.
- Compaction, the Hub-accepts-checks switch and the other changes of v3.11.1 are as described in its notes: tested with a scripted model, not shown to do better with a real one.
- Windows may ask for confirmation, or block, a setup that is not Authenticode-signed (SmartScreen, Smart App Control); the installer is not signed and `RELEASE-MANIFEST.json` says so.
- No automated test calls a live provider, and no signed-in Edge/ChatGPT session was tried.

## How it was built

It is published by a copy of the v3.11.1 release workflow, which refuses to publish unless the full regression on the exact release commit, the installer build, the installed upgrade from the published v3.9.0, the WebView2 smoke test, the release gate and the asset checksums have all passed. The signature of `RELEASE-MANIFEST.json` is made by hand with the project's release key after the workflow has finished and is added to the release afterwards, so until it is there an app only announces the release. See [Security](SECURITY.md) and [the upgrade checkpoint](docs/UPGRADE-IMPLEMENTATION-STATUS.md).
