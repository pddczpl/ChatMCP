# Current React desktop UI integration tests

From `CHATMCP-HUB/ui`:

```sh
npm ci
npx playwright install chromium
npm run test:unit
npm run test:e2e
```

`test:e2e` builds the current TypeScript/Vite frontend before testing. The real
loopback Local Hub serves that build. Tests do not intercept Hub requests or
replace React components. `test:e2e:built` is for debugging an already built UI;
CI always uses the build-and-test command.

Every page signs in the way the desktop app does: the fixture asks the Hub for a one-time ticket (`app.signInUrl()`) and the page trades it for the Hub's per-launch secret, which it then sends as a bearer on every request, event stream included. `session.spec.mjs` covers the sign-in itself (fragment removed, secret only in sessionStorage, ticket usable once, the "reopen DatGold" screen for a tab without a session or after a Hub restart, and that `/api/tasks/events` streams with the bearer).

Every test creates a temporary Git workspace and isolated Hub state, uses a
credential-scrubbed child environment, and starts a scripted OpenAI-compatible
provider on loopback. Workspace selection, model save/tool check, permissions,
prompts and approval decisions are exercised through React. The file edits,
shell checks, Git diffs, task persistence and Hub restart are real. The terminal
display check creates a real manual session through the protected Hub API.
All temporary Hub processes, servers and files are cleaned up afterwards.

The required scenarios cover onboarding, an empty new conversation without a
model request, task/tool display, pending approval details and diff, approve and
deny, passing and failing project tests, Git/Files/Activity/Terminal/Skills tabs,
empty and saved plans, Stop/Resume, restored conversation history after a Hub
restart, Settings permission changes, and clearing a typed dummy key when saving
or changing destinations. Saving a custom loopback endpoint twice retains its
canonical provider and saved dummy key without submitting a model request.
Stop/Resume uses a read-only task and verifies the same conversation ID and
restored history; it does not establish mutation replay behavior.
With the language saved as English before the page loads, the first-run setup is
walked from its first screen to its last, every section of Settings is read, the
FULL ACCESS dialog is used with its typed phrase, and the command palette switches
the mode; each is read for Vietnamese letters, against the same Hub.
Console exceptions, failed requests, HTTP failures, malformed API JSON,
unexpected API content types and API error envelopes fail the test; task SSE
and plain-text report endpoints retain their explicit response formats, and a
task's recorded cancellation is treated as task data.
Deliberate page closes stop response capture and finish checking response bodies
already received before disposing the page, including the restart scenario.

`english-screens.spec.mjs` reads the English screens against the real Hub and the scripted model, each for Vietnamese in its text and in its titles, labels and placeholders: the Agents tab (the list of background tasks, with a real task and its opened card, and no switch to sections that hand out work), the light theme, the ribbon above the conversation that chat made (finished with its details open, and running with its Stop button), the banner a stop leaves (its title and its Continue button are English, and Continue runs the conversation again; what the Hub wrote about the stop is the Hub's own Vietnamese sentence, shown as written, so the banner is not read whole), then the conversation screen and the sidebar: the Stop toast and the message the Continue button writes as the person's own, the sidebar read whole, the bar above the conversation and the one below it read whole with the Git branch picker the first one holds opened, a group folded and unfolded and the two questions it asks before it lets go of a folder or a conversation (real browser dialogs, answered "no"), the toast of the permission mode, of an approval and of a denial with the approval history under the conversation (the approval card, which the test names in English: "Approval: local.", "Approve", "Deny", "Confirm denial"), the notice that the next turn goes through another channel and the ChatGPT Web banner with its tooltip. Screenshots of each step are attached to the test output.

`updates.spec.mjs` is the update notice against the real Hub and the production build, with a loopback server standing in for GitHub (`tests/e2e/update-feed-server.mjs`, the only thing the Hub is pointed at: one test hook that takes a loopback address and nothing else). The strip under the header asks the owner once, a yes makes one look, the release on offer is announced with the address, target and rel of its notes link (read, never clicked: it is the internet) and a button to skip it, and the skip, the choice and the notice survive a reload and a Hub restart; a no keeps the Hub quiet (zero requests in the timing in which a yes asks once), Settings → Cập nhật / Updates shows the versions, "Check now" and its minute, a failed look is said in words, and the screens are read for Vietnamese in English. Screenshots (light, dark, narrow) are attached.

Playwright writes its JSON result, Hub logs, and failure screenshots/traces to
`test-results/`. The required reporter also fails a run containing skipped tests;
`tests/e2e-gate.test.mjs` checks real process exit codes for skips and malformed
API responses using a temporary local HTTP server and isolated reports.
Delayed-body cases verify cleanup still catches malformed responses. CI runs
these checks on Windows and Linux with Chromium. These results do **not** verify a live AI
provider, paid model quality, OS sandboxing, installer lifecycle, or WebView2;
those require their own evidence.

On Windows with .NET SDK 10 and WebView2 Runtime, run the separate native smoke:

```sh
node e2e/webview2-smoke.mjs
```

It uses a real WinForms/WebView2 harness and a temporary Hub/profile. The harness is compiled against the desktop shell's own session, ticket and new-window code (`native-shared/`): it signs in with the Hub's session file and checks that a link holding a backslash, quotes and `</script>` reaches the page as the exact string and runs nothing. It also opens the Agents tab (navigation only: no model request, no task), so the list of background tasks is rendered in the real WebView2 as well, in the desktop and the compact layout, and the tab offers no switch to sections that hand out work. Missing
prerequisites fail by default and in CI. `--allow-unavailable` is only for local
environment surveys; a reported skip is not native verification.
