# ChatMCP v3.0.2 — Clearer Skills, Agents and readable output

This patch makes the desktop workspace easier to read and use, especially when managing Skills, choosing an agent workflow and inspecting streamed responses.

## Changes

- **Readable interface:** clearer typography, spacing and text contrast across chat and inspector panels.
- **Skills you can manage:** installed GitHub Skills show their current state and offer enable, disable, update and uninstall actions. Installation feedback reflects the local library so an installed Skill is no longer presented as a fresh install.
- **Simpler Agents:** plain-language guidance explains the available workflows, while advanced configuration remains available when needed.
- **Output and copying:** expanded tool results remain readable in light and dark themes, with visible copy actions for responses and streaming text.

GitHub discovery now saves beside your installed skill library. Existing installed skills remain available; select **Làm mới** in Skills to rebuild an older discovery cache, and re-add any custom discovery sources if needed. AI profile storage is unchanged.

## Windows installer

Download `ChatMCPSetup.exe` and `ChatMCPSetup.exe.sha256` from the release assets. Verify the checksum, then close ChatMCP and install the update. The installer includes Node.js and the .NET desktop runtime; WebView2 and Git for Windows remain prerequisites for their respective features.

Hub, UI, Desktop and Installer share version 3.0.2. The installer is not Authenticode-signed.
