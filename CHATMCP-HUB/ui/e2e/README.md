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

Every page signs in the way the desktop app does: the fixture asks the Hub for a one-time ticket (`app.signInUrl()`) and the page trades it for the Hub's per-launch secret, which it then sends as a bearer on every request, event stream included. `session.spec.mjs` covers the sign-in itself (fragment removed, secret only in sessionStorage, ticket usable once, the "reopen ChatMCP" screen for a tab without a session or after a Hub restart, and that `/api/tasks/events` streams with the bearer).

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
Console exceptions, failed requests, HTTP failures, malformed API JSON,
unexpected API content types and API error envelopes fail the test; task SSE
and plain-text report endpoints retain their explicit response formats, and a
task's recorded cancellation is treated as task data.
Deliberate page closes stop response capture and finish checking response bodies
already received before disposing the page, including the restart scenario.

`orchestrator.spec.mjs` covers the Agents tab against the real Hub: the owner plans a coding task, starts a worker (after switching the permission mode to Autonomous in Settings, which the tab asks for), reads its diff, merges it into a new branch and sees that the worker's own claim ("all tests pass") is shown as the AI's report and never as the Hub's evidence; a read-only analysis and a hand-made helper group (the scripted model answers "OK" to a request with no tools, which is enough to see a report and a failed plan); the section switch as an ARIA tablist; 600 and 900 px windows with a real run on screen; a second folder in view; English and the light theme. The tests that start a worker need Git; the project the fixture makes is a clean repository, which the Hub requires. Screenshots of each step are attached to the test output.

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

It uses a real WinForms/WebView2 harness and a temporary Hub/profile. The harness is compiled against the desktop shell's own session, ticket and new-window code (`native-shared/`): it signs in with the Hub's session file and checks that a link holding a backslash, quotes and `</script>` reaches the page as the exact string and runs nothing. Missing
prerequisites fail by default and in CI. `--allow-unavailable` is only for local
environment surveys; a reported skip is not native verification.
