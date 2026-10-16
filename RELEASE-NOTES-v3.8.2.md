# ChatMCP v3.8.2 — ChatGPT Web task delivery repair

## Fixed

- A pending URL recovery for an old task no longer prevents a new queued task from being prepared, claimed and sent. Hub and Companion both enforce this separation; idle recovery remains read-only and bounded.
- A newly created task tab opens in the foreground once, rather than preparing the editor in a hidden tab.
- Companion 1.5.1 can recognize scoped Lexical, accessible contenteditable/plaintext and explicitly labelled ChatGPT textarea layouts in addition to the legacy editor. Ambiguous, hidden, dialog and conversation inputs are rejected.
- Missing content-script receivers get one bounded restoration attempt, only before claim, in the exact owned ChatGPT tab. The installed listener is idempotent. There is no restoration or repeated click after an uncertain SEND.
- Readiness diagnostics preserve safe error categories (receiver missing/timeout, composer missing, send button disabled/missing) instead of collapsing them into a generic network wait. Queue timeout retains the safe category without prompt, nonce, token or page text.

## Update both components

Stop the old Hub and install the new ChatMCPSetup.exe. Extract ChatMCP-Browser-Companion.zip and update/reload the **ChatMCP Hub Companion 1.5.1** extension in Edge/Chrome. Choose the folder containing the canonical manifest.json, not the repository-root legacy helper. Reload existing ChatGPT tabs after updating the extension; pair again only if pairing is no longer valid. Installing the desktop EXE alone does not update an already loaded unpacked extension.

The extension now declares `scripting` solely for pre-claim restoration of its two bundled scripts in an owned top-frame ChatGPT tab, in the ISOLATED world. Existing host permissions remain only chatgpt.com and the localhost Hub. No cookies, remote scripts, browser-wide tabs or debugger permission are added.

Test a **new ChatMCP Studio conversation** after updating both components. A previously failed task with no canonical ChatGPT URL is not silently replayed or rebound. Ordinary idle polling of a failed task is not another model request.

## Validation and limits

`verify-browser-delivery-readiness.mjs` exercises queued task/recovery contention, tab loading, receiver restoration, safe diagnostics, uncertain-send reconciliation, idle polling, Hub recovery isolation and representative editor layouts. Existing permission, nonce/URL ownership, no-duplicate-send and regression suites remain required by the release workflow. Release assets are built from the same versioned commit and source/ZIP/installer extension parity plus SHA-256 are verified.

Tests use scripted browser fixtures and the Windows WebView2 smoke test. They do not certify the owner's current signed-in Edge tab or every ChatGPT A/B layout. The Windows installer remains unsigned by Authenticode. Model limits, account login and user approvals are unchanged.
