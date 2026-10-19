# ChatMCP Security Policy

This policy describes the current single-owner, local-first Windows product. It does not claim a security audit, fully isolated host command execution, or live-browser acceptance of every website revision.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability / Security Advisory** option for this repository if it is available. Never post API keys, tokens, private keys, exploit payloads containing secrets, or personal data in public issues. If a private reporting channel is not available, open a minimal public [issue](https://github.com/pddczpl/ChatMCP/issues) asking the maintainer to arrange a private disclosure channel. Do not disclose the vulnerability details publicly before that channel is established.

## Supported deployment boundary

ChatMCP is designed for a single local Windows account with a Hub listening on **127.0.0.1:3007**. The desktop client and the browser dashboard communicate with the loopback Hub. Public port binding, reverse-proxy publication, cloud-hosted Cloud Harness infrastructure, public multi-tenant use, and mandatory cloud accounts are not supported deployment modes.

The local HTTP interface validates Host and Origin and applies CSRF protection to mutations. Browser Companion pairing grants separately authenticated access for the user's own ChatGPT tab; it is not a public remote-control interface. Other processes running with the same Windows account must still be treated as a security concern. Loopback binding is **not** protection against malware already executing as that user.

## Permissions and execution isolation

- **Read Only:** inspect without approving file, shell, or Git mutations. Shell commands run in this mode only when the command classifier (`lib/command-analysis.mjs`, `lib/read-programs.mjs`) positively recognises them as read-only: a program is "read" only if **every** option is on that program's allowlist (exact long names, short clusters split letter by letter, `--opt=value` split first), and `sed` only for scripts that a strict grammar accepts (addresses plus `p`, `d`, `q`, `=` and `s///` with `g`, `p`, `i`, count flags) or under GNU `sed --sandbox`. Anything it does not recognise, such as `sed` `e`/`r`/`w` commands, `sort -o`, `uniq IN OUT`, `file -C`, `rg --pre`, `find -fprint`, `tree -o`, `less +cmd`, or a wildcard that could expand into an option, is treated as an unreviewed command and is refused. The classifier reads command text and is not a sandbox; `tests/fixtures/readonly-bypass-corpus.json` is the regression corpus.
- **Review:** ask the owner to approve potentially mutating or risky operations.
- **Autonomous:** allow only operations permitted by the selected policy and the PermissionGate.
- **Full Access:** requires explicit owner activation. Operations execute using the signed-in Windows account's effective permissions. This is not OS privilege elevation, nor a promise that host commands are harmless.

Repository text, instructions in third-party skills, search results, agent replies, and tool outputs are untrusted inputs and may contain prompt injection. Path normalization, protected paths, permission checks, review tokens, checkpoints, and rollback guards reduce risk but do not make arbitrary shell commands safe. Git worktrees isolate branch checkouts, **not** host processes or filesystem permissions. Host command results must not be described as Windows Sandbox or independent attestation. Where supported, Windows Sandbox execution and sealed verification receipts have their own provenance requirements; experimental support does not prove every test runner is isolated or independently certified.

An interrupted or timed-out mutation can have uncertain effects. ChatMCP must preserve evidence and require inspection instead of blindly repeating file writes, Git operations, shell commands, or browser submissions.

## Credentials, providers, and diagnostics

Configured model API requests may transmit task instructions, selected source excerpts, tool definitions and output, images/attachments, and conversation context to the selected provider or custom gateway. **Local-first does not mean offline.** Users are responsible for selecting and trusting remote endpoints, verifying allowed sharing, and checking provider retention and charging terms. Ollama or LM Studio can operate locally when installed and configured separately.

Where stored, model credentials and custom gateway HTTP header values use the local Windows DPAPI-based secret protection mechanisms. Protected custom headers are bound to the exact configured provider origin, are never returned as plaintext in public state or diagnostic exports, and are cleared when switching to another origin. Environment-variable header references are resolved locally at request time; missing values fail rather than issuing a malformed request. Environment-sourced and session-only credentials have separate lifetimes. Switching credential destinations must not silently forward existing keys to an unrelated origin. Avoid entering sensitive content into model prompts or untrusted source repositories. Diagnostic exports and errors should redact known secrets, but redaction is defense in depth and not a guarantee against every accidental disclosure; inspect logs before sharing them.

Skills Hub downloads pinned repository assets and verifies content hashes; importing a skill is not permission to execute bundled scripts automatically. Upstream licensing and integrity must be reviewed independently.

## Browser Companion and desktop lifecycle

The separately installed Chrome/Edge Manifest V3 Companion pairs with the loopback Hub using a user-approved process. Its ChatGPT Web transport is constrained to supported text-based interaction and transport-specific safety checks. Pairing does not grant API quota. Browser verification on scripted pages is not equivalent to a signed-in user's live ChatGPT session. If a send outcome is uncertain, recovery must not duplicate submissions.

The native desktop enforces single-instance activation, Hub identity/version checks, and ownership-sensitive lifecycle operations. Closing the GUI preserves the running Hub; use an explicit shutdown to stop it. The installer checks owned payloads, prevents unsafe active-task upgrades, stages changes, and retains rollback markers when completion is uncertain. These controls do not provide power-loss atomicity for an entire directory or defend against an adversarial process with the same Windows privileges.

## Distribution and historic risk

Validate downloaded installers and Companion archives against the release SHA-256 files and release manifest. Verify Authenticode independently when a publisher signature is present. An unsigned installer must be described as unsigned; checksum verification only checks byte integrity relative to the published hash. Signing must precede final checksum calculation.

Older repository history may still contain retired Cloud Harness configuration or credentials. Removing files from the latest branch does **not** erase Git history or revoke a leaked secret. Rotate any potentially exposed credentials and separately decommission old servers, tokens, and deployment resources. Do not treat passing CI, successful packaging, or release checksums as a penetration test.

[README](README.md) · [Windows Setup](docs/WINDOWS-SETUP.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Historical security and test reports](docs/INDEX.md)
