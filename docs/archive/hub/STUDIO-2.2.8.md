# ChatMCP Studio 2.2.8 — browser_claimed stuck-send fix

## Symptom
The Studio timeline shows `browser_claimed` (Companion has received protocol packet #1) but never `browser_sent`. The agent UI shows an endless spinner. This is a **delivery/confirmation problem**, not proof that Git/MCP operations ran.

## Changes
- **Companion 1.4.2:** `CHATMCP_BROWSER_SEND` no longer holds an extension message port open for up to 90 seconds waiting for a rendered ChatGPT message. It clicks the unique validated Send button at most once, then responds immediately with `confirmed` or `clicked_unverified`.
- After `clicked_unverified`, the background worker uses **read-only `RECOVER_SEND`** to verify the original turn, task ID and nonce before calling the Hub `sent` endpoint. It does **not** click Send a second time.
- Chrome tab IPC now has a 12-second acknowledgement timeout. A lost reply after a possible click goes through read-only reconciliation; it is never treated as permission to resend.
- Hub task API exposes a redacted delivery status (`pending` / `claimed` / `sent`) and claim time, not the task message or nonce.
- React UI shows the Companion's stage/note and an explicit warning after 90 seconds without a confirmed send. This does not mark an uncertain send as successful or automatically delete a task.

## Scope / limitations
- Automated send and the ChatGPT DOM must still be verified on the user's real browser. A site redesign, login prompt, blocked content script, disabled Send button or deleted chat may require manual intervention.
- A click with no reliable evidence remains **unverified**; the app does not resend automatically, even if the user sees a spinner. This avoids duplicate Git pushes/PRs/edits.
- The Hub's workspace selection is not a security boundary; Full Access is not an OS sandbox.
- This update does not implement or perform the requested branch merge, CI, PR review or push. Those steps must be executed by an active agent with real tool confirmations and authorization.

## Verification performed in build container
- All 25 `tests/verify-*.mjs` Node suites passed.
- `node --check` passed for 68 JavaScript / MJS files (excluding vendored minified React).
- React Chromium DOM tests passed, including claimed-but-unsent UI and version mismatch.
- New regression checks: delayed ChatGPT DOM returns `clicked_unverified` promptly; IPC acknowledgement reconciliation confirms later; neither path clicks Send twice.
- No Edge, Windows Desktop Commander, GitHub repository or ChatGPT real-site integration test was performed in this environment.
