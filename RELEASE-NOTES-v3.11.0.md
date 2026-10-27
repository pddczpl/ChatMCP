# DatGold v3.11.0 — the Update button, signed releases and a repair for an update that stopped halfway

This is the first release with the **Update button**. It is a normal release and is published as the latest release. It contains everything of v3.10.2 and what was merged after it: the update from the app, signed releases, a repair for an update that stopped halfway, and DatGold names for the downloads.

## What changed since v3.10.2

**Update from the app.** DatGold finds out that a newer release exists. It asks you once whether it may look by itself (about once every 12 hours, GitHub then sees your IP address and the line `DatGold/<version>` and nothing else), and "Check now" in Settings → Updates works whenever you ask, with a short pause between two checks. On your click it downloads the installer; it checks the signature of the release manifest and the SHA-256 of the file; and in the desktop app a second click, "Install and restart", closes the app, installs the new version over the old one and opens the app again. Nothing is downloaded or installed without a click. Work that is running holds the update back, and says so. Every refusal is told in words: a file that does not match its manifest, a signature that does not check, another update at work, a download that is gone. After an update the page says "Updated to DatGold x.y.z" once.

**Signed releases.** `RELEASE-MANIFEST.json` is signed (ECDSA P-256 over the exact bytes of the file; the signature is the file `RELEASE-MANIFEST.json.sig`) by a key that only the project's owner holds. The Hub and the desktop shell check it against the two public keys in `CHATMCP-HUB/lib/release-keys.json`, and the shell does it again with its own code before it starts the setup. The signature is added by hand after the release workflow has run, because the key is not in CI; until it is there, the app only announces the release and offers no Download.

**A repair for an update that stopped halfway.** When the setup cannot put every file back after a failed update it keeps a marker and a backup, and DatGold does not start behind them. The setup now repairs the installation from that backup: by itself, once, right after its own failed update; with the button "Repair now" in the window of the update; with the setup wizard, which asks first; and with `DatGoldSetup.exe --quiet --recover --install-dir "<the DatGold folder>"`. It puts a file back only when it can prove what the file is (the bytes the update wrote, or the old ones), and otherwise refuses and changes nothing. The launcher says what to run when it finds the marker.

**File names.** The downloads of a release are `DatGoldSetup.exe` (with its `.sha256`) and `DatGold-Browser-Companion.zip`. `ChatMCP-Browser-Companion.zip` is published too, with the same bytes, because every installed copy links to that name. The installed program (`ChatMCP.exe`), its folders and its registry key keep the ChatMCP name so that an upgrade finds what the earlier versions made ([docs/NAMING.md](docs/NAMING.md)).

**Fixes.** The Hub ownership query that the installer, the uninstaller and the updater run before they stop a Hub gets 30 seconds a try and a second try (a hosted runner once took more than 10 seconds and the setup refused). A program of another user that is called ChatMCP no longer stops the closing step of the installer. The installer build shows the end of MSBuild's output when a publish fails. The same query now keeps the letters that the OEM code page cannot hold: with a Windows profile named in Vietnamese, say, the installer, the uninstaller and the updater no longer refuse to stop the installed Hub with `foreign_listener`.

## Upgrade

**Install this version by hand, once.** Download `DatGoldSetup.exe` and its `.sha256` file from this release, compare the digest with `RELEASE-MANIFEST.json`, close DatGold, stop active tasks and install over v3.9.0, v3.10.0, v3.10.1 or v3.10.2. The installer keeps your settings and history. Copies installed from earlier builds were made without the keys that sign releases, so their apps cannot check a signature and do not offer an update. From this version on, a later release that is signed with the project's key can be installed from the app.

The Browser Companion is a separately installed extension; its version stays **1.5.2**. The page now links to `DatGold-Browser-Companion.zip`.

The Hub's health version is `3.11.0` and the UI build identifier is `3.11.0-react-agent`.

## What to try

- Install over v3.10.2 with DatGold closed. Open Settings → Updates: it shows version 3.11.0, "Check now" and the choice about automatic checks.
- When a later release exists and is signed: Download, then, in the desktop app, Install and restart. DatGold closes, the setup runs, and the new version opens with a note that it was updated.
- If an update ever stops halfway, run `DatGoldSetup.exe`: it asks whether to repair the installation first.

## What is not verified

- **No release has been signed with the real key before this one**, and the Update button has not been tried against GitHub itself. A CI job installs an old build on a hosted Windows runner, presses Download and Install and restart in the page of the installed app, and checks that the new build runs and that the refusals leave the old one working (139 checks), but with a key made for the run, a stand-in for GitHub on a loopback port, and mouse events that are injected through the DevTools protocol, not the operating system's mouse.
- Windows may ask for confirmation, or block, a setup that is not Authenticode-signed (SmartScreen, Smart App Control); the installer is not signed and `RELEASE-MANIFEST.json` says so.
- A power cut during an update was not tried for real. The states it leaves were made by a process that is killed in the middle of the update, and the repair was run on them; the question box of the wizard was looked at, not driven by a test. The repair by hand in the setup guide was run in Windows PowerShell 5.1 only.
- No automated test calls a live provider, and no signed-in Edge/ChatGPT session was tried.

## How it was built

It is published by a copy of the v3.10.2 release workflow, which refuses to publish unless the full regression on the exact release commit, the installer build, the installed upgrade from the published v3.9.0, the WebView2 smoke test, the release gate (it now refuses a key file that holds a placeholder or a test key) and the asset checksums have all passed. See [Security](SECURITY.md) and [the upgrade checkpoint](docs/UPGRADE-IMPLEMENTATION-STATUS.md).
