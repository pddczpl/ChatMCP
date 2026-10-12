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
or changing destinations. Console exceptions, failed requests,
HTTP failures and API error envelopes fail the test; a task's recorded
cancellation is treated as task data.

Playwright writes its JSON result, Hub logs, and failure screenshots/traces to
`test-results/`. The required reporter also fails a run containing skipped tests;
`tests/e2e-gate.test.mjs` checks its real process exit codes. CI runs these checks
on Windows and Linux with Chromium. These results do **not** verify a live AI
provider, paid model quality, OS sandboxing, installer lifecycle, or WebView2;
those require their own evidence.

On Windows with .NET SDK 10 and WebView2 Runtime, run the separate native smoke:

```sh
node e2e/webview2-smoke.mjs
```

It uses a real WinForms/WebView2 harness and a temporary Hub/profile. Missing
prerequisites fail by default and in CI. `--allow-unavailable` is only for local
environment surveys; a reported skip is not native verification.
