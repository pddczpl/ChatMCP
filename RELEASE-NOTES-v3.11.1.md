# DatGold v3.11.1 — skills chosen from the project, bigger attachments and a compaction you can tune

This is a normal release and is published as the latest release. It contains everything of v3.11.0 and what was merged after it. It is the first release that an installed v3.11.0 can offer through the **Update button**.

## What changed since v3.11.0

**Compaction you can tune, and a check of what it kept.** Settings → Dự án → Tác tử has the percent of its history budget from which the agent compacts the conversation: a whole number from 50 to 95, **80 when you choose none**. From that point the Hub shortens the copy of old tool results and replaces the oldest part with a checkpoint built from its own record of the task (your requests, the files looked at or changed, the latest failing command that was not fixed since, the pictures that left the request), not from the model's recent words. After each compaction the activity log says `Kiểm tra giữ lại thông tin: n/m` and names anything that did not make it into the request. The Hub always keeps the three newest call/result pairs whole, so at a low percent, a small window and very large results there may be no safe place to cut: it says so and deletes nothing. The choice is read at every model request, so it applies to a conversation that is already open.

**The Hub can accept the checks it ran — only if you turn it on.** The same card has a switch, **off by default**: with it on, a criterion of the objective acceptance panel that asks for a check is matched by the Hub to the latest passing check it ran and recorded, once the objective before it is accepted. This **relaxes the promise that only you accept**, for checks only: the evidence says `acceptedBy: auto_hub_check`, the panel tags the criterion ("Hub tự chấp nhận") and you can press Confirm to replace it with your own acceptance; "observed" and "edited" stay yours. A passing check only says that a command exited with 0.

**Objective acceptance is quicker to read.** Each criterion shows the latest receipt of the kind it needs already chosen, and one button confirms the whole plan in the order the Hub needs. You still read and confirm; nothing is accepted for you.

**Skills are chosen from the project, and the model can read the rest.** The selector reads Vietnamese phrases as well as English ones and takes the kind of project into account (from the names of the files in its root and the dependencies it declares). The skill index now also names every enabled skill, so the model can read one on demand with `skill_load` when none was preloaded. A manual script, `DATGOLD-HUB/tests/live/skill-load-live.mjs`, asks a real model a question about a custom skill and reports whether it read the skill; it costs money and is never run by CI.

**Attachments up to what the providers accept.** A message takes up to 10 files, 3.75 MiB per picture, 12 MiB in all and text files up to 200,000 bytes; a bigger file gets a notice that points to the project folder route. The page fits a picture that is too large before it is sent. A picture used to be dropped without a word from a long conversation, because the size estimate counted its base64 as text; each picture now counts as a fixed number of tokens, and when pictures do leave a request the model and you are told how many.

**Models and providers.** A Kimi preset; models that a provider has deprecated are hidden in the picker; the catalog snapshot is dated 2026-10-28 and a weekly workflow proposes a refreshed one as a draft pull request (it can open one only after the repository setting that lets Actions open pull requests is turned on, which it is not today; the Hub itself still refreshes only when you press the button); the default model of the Groq preset is `openai/gpt-oss-120b`.

**Smaller things.** "View evidence" on the banner of a failed turn opens the evidence; the top bar shows the new gold D mark; the source folder is `DATGOLD-HUB` (an installation keeps its `CHATMCP-HUB` folder, see [docs/NAMING.md](docs/NAMING.md)).

**Downloads.** A release now carries `DatGoldSetup.exe` and `DatGold-Browser-Companion.zip` (each with its `.sha256`) and `RELEASE-MANIFEST.json` with its signature. **`ChatMCP-Browser-Companion.zip` is no longer published.** An app of v3.10.x or older links to that name from its "download the Companion" button, which answers 404 until that copy is replaced by v3.11.0 or later.

## Upgrade

**From v3.11.0:** Settings → Updates → Check now. When it shows 3.11.1 with a valid signature, press Download; when the download is checked, press **Install and restart** in the desktop app. This is the first time the button is used on a real release.

**From v3.10.x or older:** install by hand, once. Download `DatGoldSetup.exe` and its `.sha256` file, compare the digest with `RELEASE-MANIFEST.json`, close DatGold, stop active tasks and install over your version. Copies installed from older builds were made without the keys that sign releases, so their apps cannot check a signature.

The Browser Companion is a separately installed extension; its version stays **1.5.2**.

The Hub's health version is `3.11.1` and the UI build identifier is `3.11.1-react-agent`.

## What to try

- Settings → Dự án → Tác tử: choose 70, send a long task and look at the activity log for `Kiểm tra giữ lại thông tin`.
- Leave the Hub-accepts-checks switch off and check that the acceptance panel shows no tag; turn it on, run a task that ends with a passing check, accept the first objective yourself and see the tag on the check of the next.
- Ask a question in Vietnamese in a project with a `package.json` and look at the line under the turn that says which skills were selected.

## What is not verified

- **The Update button has not yet been used on a real release.** v3.11.0 was signed with the project's real key and its signature was read back from GitHub by the Hub's own code, and a CI job drives the click on a hosted Windows runner with a stand-in for GitHub and a key made for the run. This release is the first that a v3.11.0 installed on a real machine can be updated to; whether it works there is for the first person who tries.
- The compaction was tested with a scripted model. No test shows that a real model does better after a compaction, and the retention check shows that the Hub's facts are in the request, not that the model uses them.
- **With the Hub-accepts-checks switch on, a check that passes proves little**: the model chooses the command, and an empty test suite exits with 0.
- With the real tools a coding plan cannot reach a "ready" completion: the `git_diff` tool leaves no receipt that the Hub accepts as a review of the diff, so every coding run still ends with "No independently recorded Git diff review". This is known and is not changed here.
- Windows may ask for confirmation, or block, a setup that is not Authenticode-signed (SmartScreen, Smart App Control); the installer is not signed and `RELEASE-MANIFEST.json` says so.
- No automated test calls a live provider, and no signed-in Edge/ChatGPT session was tried.

## How it was built

It is published by a copy of the v3.11.0 release workflow, which refuses to publish unless the full regression on the exact release commit, the installer build, the installed upgrade from the published v3.9.0, the WebView2 smoke test, the release gate and the asset checksums have all passed. The signature of `RELEASE-MANIFEST.json` is made by hand with the project's release key after the workflow has finished and is added to the release afterwards, so until it is there an app only announces the release. See [Security](SECURITY.md) and [the upgrade checkpoint](docs/UPGRADE-IMPLEMENTATION-STATUS.md).
