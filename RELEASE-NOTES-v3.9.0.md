# ChatMCP v3.9.0 — Evidence, model profiles and local coding workflows

This release continues the single-owner, local-first Windows coding-agent architecture. It contains real source changes and uses the release workflow's exact-SHA CI, installed-upgrade test, fresh build and asset hashes as publication gates. It does **not** claim equivalence with other coding agents or proof of live browser compatibility.

## What changed

**Task completion and owner acceptance.** The Agent now records an explicit difference between receiving a completed model response, having fresh first-party test/edit/Git receipts, and an owner accepting each objective criterion. Previously passing tests and file hashes are invalidated after potentially mutating edits. The user can review and match current receipts to individual criteria rather than relying on model prose.

**Model configuration.** AI Settings can manage multiple encrypted local provider profiles, default selection and per-task/role overrides (e.g. coder, reviewer, verifier). Profile revisions protect resumed work against silent endpoint or credential switching. Named-provider switching does not silently carry stored credentials to another origin. Custom origin-bound HTTP headers support protected literal values or named environment references and reject unsafe names/values.

**Provider protocols.** The standalone OpenAI Responses API adapter supports validated text/function call messages, tool result correlation, bounded SSE with terminal completion, and the separate function-probe path. Existing Chat Completions, Anthropic Messages and Gemini adapters remain. Invalid/partial tool calls or orphan responses cannot authorize an action.

**Context and usage.** Model-specific context budgets estimate instructions, tool schemas and reserved response space, compact only safe history views and preserve full local transcripts. Provider-reported token counts are distinguished from missing usage, and cached/reasoning subsets are not charged twice. Owner-supplied USD-per-million-token rates can produce a known subtotal for priced responses. No guessed total is shown when usage, pricing or failed-attempt billing is unknown.

**Coding verification.** Read-only project check discovery can list Node, TypeScript, Python, Rust, Go and Playwright checks. Execution still requires explicit user action or PermissionGate approval. A deterministic evaluation CLI runs existing real-process regression fixtures and saves revision-bound reports; it does not fabricate live-model results. Sequential continuation after the task finishes but before the workspace lock is released is handled without treating the follow-up as a message to a stopped run.

**Documentation.** README and the root security policy are in English. Detailed development, security and evaluation notes remain under docs/.

## Upgrade from v3.8.3

Download `ChatMCPSetup.exe` and its `.sha256` file from this release. Check the digest and `RELEASE-MANIFEST.json` against the downloaded bytes, stop active coding tasks and install over the existing owned installation. The installer preserves user state and checks installed files/ownership, rollback markers, foreign listeners and lifecycle state. If a transaction remains uncertain, retain the backup and follow the recovery instructions rather than automatically replaying it.

Browser Companion is a **separately installed extension**. The canonical `ChatMCP-Browser-Companion.zip` is packaged from the matching source/payload and verified in the release workflow. Reload/update the unpacked extension in Chrome/Edge and re-pair if required. Companion source version remains **1.5.2** because this release does not claim a new browser transport capability.

The expected local Hub health version is `3.9.0`; the current React UI build identifier is `3.9.0-react-agent`.

## Verification boundaries and security

Publication requires success on the **exact release commit** for the full Linux/Windows Hub regression matrix, React build/E2E, Chromium MV3 scripted Companion delivery, native installer build, installation-over-v3.8.3 and uninstall lifecycle, source/installer UI payload parity, and asset checksums. `RELEASE-MANIFEST.json` records the exact SHA and independent signing/live-login status.

Tests using a scripted model are deterministic regression evidence, **not** a paid-provider benchmark. In particular, an arbitrary custom Responses gateway has not been live-certified; a signed-in ChatGPT Edge session is not reproduced by scripted Chromium pages; host Git worktrees are not an OS sandbox. Live-model benchmark parity, offline Windows Sandbox certification, Authenticode signing and real-user browser account acceptance are **not claimed**. Multi-agent code worktrees must still be reviewed and integrated through guarded workflows, never silently merged or pushed. The installer may remain unsigned; read the manifest rather than assuming a publisher signature.

See [Security](SECURITY.md), [Evaluation](docs/EVALUATION.md) and [Upgrade implementation checkpoint](docs/UPGRADE-IMPLEMENTATION-STATUS.md).
