# Phase 0 execution report

Evidence snapshot: 2026-10-12. Target: Windows 10/11 x64, local-first, single user. Scripted-model React E2E, native browser smoke, installer artifacts and clean-machine release validation are distinct evidence categories.

## 1. Repository and integration state

| Item | Verified state |
| --- | --- |
| Phase 0 base | `b1160c6862c658d85c90fb1f157cc085d9cfc244` (v2.6.0) |
| [PR #7](https://github.com/pddczpl/ChatMCP/pull/7) | Merged 2026-10-12 10:50:01 UTC; final source head `cd51d5df8b2f14689e050d756cc8afb272ce8176`; merge commit `270e5b9ac104389aa7c11778d7bd1612f073f561`. |
| #7 source commits | Initial contracts `bda62dd`; canonical AI configuration/path correction `e51a782`; coding persistence correction `cd51d5d`. |
| [PR #8](https://github.com/pddczpl/ChatMCP/pull/8) | Merged 2026-10-12 11:06:19 UTC; final head `8a56d85d08dc6b897ef49d13db28b8339ec2195c`; merge commit `2764000da93b466f933ecfadfad2f4c0bec1abca`. The branch first received the #7 main merge through `8688f47`, then passed strict CI before being marked Ready and merged. |
| Integrated Phase 0 main | `2764000da93b466f933ecfadfad2f4c0bec1abca`; [CI 38240516292](https://github.com/pddczpl/ChatMCP/actions/runs/38240516292) passed **9/9 jobs** before this report and the next-phase plan were finalized. |
| Review policy | Owner explicitly waived independent review in this task on 2026-10-12. No independent approval was submitted or claimed. No repository rulesets or protected-main requirement were present at merge verification. |
| Tags/releases | No new tag/release or modification to published v2.6.0. |

A merge commit preserves the ancestry of the dependent PR. After updating #8 with main, its diff contains only E2E, CI, packaging and associated documentation; runtime fixes belong to #7. No force push, history rewrite, direct main push or protection bypass was used. Existing ignored user state remains untouched.

## 2. Verified findings and fixes

The [contract audit](PHASE0-DESKTOP-CONTRACT-AUDIT.md) records the original Phase 0 findings. Follow-up review read the complete #7 change and the separate #8 delta.

| Finding | Reproduction and correction |
| --- | --- |
| React/Hub contracts, history, approval and inspector data | Adapters now consume real Hub envelopes and recorded history. Blank drafts do not send a sample prompt. Plans and completion text no longer invent verification. SSE reconciles actual task data. |
| Custom AI configuration could not be saved again | The Hub normalized a named provider with a custom URL, but the form retained the original preset and cleared its typed key. A second save could reject the saved credential. Save/test results now reconcile canonical configuration without replacing newer form edits. Real provider configuration regression uses dummy credentials and no network. |
| Tests failed in checkout paths containing spaces | URL pathnames retained percent escapes. Component tests now use `fileURLToPath`; the disposable checkout reproduction changed from failure to 5/5 passing checks. |
| Coding-worker persistence race on Windows | The first full review run failed a concurrent `jobs.json` rename: 47 passed / 1 failed / 0 skipped suites. Immutable writes are serialized; save failures settle active workers and stop queued work; initial/final failures release locks correctly. Deterministic regression and the subsequent full 48-suite run passed. |
| Research persistence race | The original #7 fix serializes immutable snapshots and waits for outstanding workers after failure. |
| E2E silently accepted malformed APIs | The actual fixture incorrectly passed HTTP 200 HTML, even when labelled JSON. The collector now rejects parse errors and unexpected response types, with explicit task SSE/text-report contracts. A process regression is red with the old collector and green with the correction. |
| Overstated Stop/Resume test name | The browser case uses reads; its title and documentation now claim same-conversation/history preservation, not proof of mutation replay prevention. Existing backend recovery suites provide separate evidence. |
| Packaging contamination and missing native loader | Tracked runtime allowlisting excludes private/development state. Fresh native publish directories and required x64 loader validation address the reproduced missing-loader case. |
| CI omitted required checks | #8 installs pinned FastAPI dependencies, requires all Hub suites, runs current React E2E on Windows/Linux, and requires Windows payload/native smoke checks. |

## 3. Implemented scope

Runtime/UI repairs are in #7; test infrastructure, CI and installer safeguards are in #8. The four follow-up defects were corrected in their respective PRs. Worker shell permissions, integration/publish review gates and local-only architecture remain enforced. No Phase 1 feature implementation is included.

## 4. Local testing evidence

All commands below completed with exit code 0 after their relevant correction unless explicitly marked historical.

| Check | Command and observed result |
| --- | --- |
| Strict final Hub regression | `node tests/run-all.mjs --no-skip all --json test-results/phase0-review-pr7-fixed.json` in `CHATMCP-HUB`: **48 passed / 0 failed / 0 timed out / 0 skipped suites**, Windows x64, Node 24.19.0. |
| Coding/research regression | `node tests/verify-phase4-features.mjs`: **37 checks passed**, including real worktrees and restricted AgentRunner tools. |
| #7 UI unit/contracts | `node --experimental-strip-types --test tests/*.test.mjs` in UI: **38 passed / 0 failed / 0 skipped**. |
| Final #8 UI unit/contracts and gate tests | `npm run test:unit`: **40 passed / 0 failed / 0 skipped**, including malformed and delayed-response lifecycle regressions. |
| Final current React / real Hub E2E | `npm run test:e2e:built`: **7 passed / 0 failed / 0 skipped / 0 flaky**, 44.953 seconds, started 2026-10-12 10:58:15 UTC; all seven error and seven warning attachments empty. |
| #8 error-gate regression | Actual Playwright fixture/reporter process tests: **2 passed**; malformed JSON, HTML and unexpected SSE fail as intended; legitimate JSON null, task streams and text reports pass. |
| Custom-endpoint browser regression | Current React bundle and real Hub: **1 passed / 0 failed / 0 skipped / 0 flaky**; two saves preserve the canonical preset and saved dummy key without another model request. |
| Installer payload regression | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/tests/Test-InstallerPayload.ps1`: **39 passed / 0 failed / 0 skipped**. |
| TypeScript/Vite and Windows installer | `npm run build` and `scripts/Build-Installer.ps1`: successful; final UI entry `index-DL0RT7yX.js`. |
| Native browser smoke | `node CHATMCP-HUB/ui/e2e/webview2-smoke.mjs`: **6 checks passed**, WebView2 `154.0.4258.62`, zero recorded errors. |
| Documentation and whitespace | `node CHATMCP-HUB/tests/verify-docs.mjs`: **12 checks passed**; `git diff --check`: no whitespace errors. |

The final local installer is **198,490,272 bytes**, SHA-256 `44d7d0435092c1654a3d0888df34008fb81d53a2629dba2b051ab93c108bf3f0`, matching its sidecar. The payload is **82,272,973 bytes / 130 entries**. Its index, all four referenced Vite assets and both corrected orchestrator modules match the checkout by byte hash; prohibited state/development entries are absent. The entry JS SHA-256 is `f939c1c7d5dca4799bc8483fb6b9bb6f74dd0228b550855ac021ab6c4aa6ca92`. Required x64 `WebView2Loader.dll` is 194,912 bytes, SHA-256 `3426dcc55fdfb8b5e7ac623cf33b4ccf283fbf68a0c5a65bddfdb4d749a8abee`.

During full E2E validation, the stricter collector exposed a fixture teardown race: it closed the page before reading an observed JSON body. Deliberate closure now seals capture and awaits those checks before destroying the page. Delayed valid/malformed response regressions verify this without suppressing genuine parse failures.

The no-skip count describes all 48 required Hub suites. Platform-specific individual probes may report inapplicability; a Windows-only filesystem probe is not evidence about Linux behavior. Browser tests use a scripted loopback model, not live-provider inference. The native harness proves six rendering/navigation checks in WinForms/WebView2, not installation or packaged-app lifecycle.

## 5. Security status

Hub regressions exercise loopback/Host/Origin/CSRF controls, permissions, path/command boundaries and recovery. Browser tests approve or deny actual gate requests through the UI; they use temporary repositories, isolated state and fake credentials. Denial preserves the fixture file.

Payload checks cover tracked-file boundaries, private-state exclusion, generated-output junction refusal, validated staging cleanup and loader architecture. They do not certify every compromised-build-machine race. Git worktrees are not OS isolation; workers still cannot run arbitrary host commands.

## 6. GitHub CI and review evidence

- #7 final head `cd51d5d`: [CI 38238282472](https://github.com/pddczpl/ChatMCP/actions/runs/38238282472), **7/7 jobs successful**, verified before merge. Downloaded summaries confirm the old workflow reported **47 passed / 1 skipped suite** in each Hub job: FastAPI lacked `fastapi`, `httpx`, `pytest` and `uvicorn`. The local strict 48-suite run included it; #8 subsequently supplies and passes the remote no-skip gate on the inherited runtime fixes.
- Main after #7, `270e5b9`: [CI 38238789064](https://github.com/pddczpl/ChatMCP/actions/runs/38238789064), successful. The separate existing v2.6.0 publication workflow [38239305225](https://github.com/pddczpl/ChatMCP/actions/runs/38239305225) failed its intentional release-title guard (`Not the authorized v2.6.0 merge`); no release/tag was created. CI and release authorization are distinct.
- #8 final head `8a56d85`: [PR CI 38239781287](https://github.com/pddczpl/ChatMCP/actions/runs/38239781287) and [push CI 38239775768](https://github.com/pddczpl/ChatMCP/actions/runs/38239775768), **9/9 jobs successful in each run**, verified before Ready/merge. Downloaded summaries from both runs show every Windows/Linux, Node 22/24 Hub job at **48 passed / 0 failed / 0 timed out / 0 skipped suites**. All four React reports show **7 passed / 0 failed / 0 skipped / 0 flaky**; logs confirm **40 unit tests**, payload **39 checks**, native smoke and installer checksum success.
- Integrated main `2764000`: [CI 38240516292](https://github.com/pddczpl/ChatMCP/actions/runs/38240516292), **9/9 successful**. Downloaded artifacts independently confirm all four Hub jobs at **48/0/0/0** (pass/fail/timeout/skip) and both React reports at **7 passed / 0 failed / 0 skipped / 0 flaky**. This is the Phase 0 integration gate, not release certification.
- Phoenix Mentor exists as a GitHub App and `phoenix-mentor[bot]` exists, but the repository permission lookup returned `none`. GitHub rejected the attempted #7 review request because it could not resolve the bot as a reviewer. App installation could not be established with the available token. The only listed collaborator was the author, `pddczpl`.
- At the pre-merge inspection there were no reviews, review requests or blocking comments. The owner then explicitly said an independent reviewer was unnecessary. Self-review and green CI are not recorded as approval.

## 7. Completion matrix

| Track | State and evidence boundary |
| --- | --- |
| Phase 0 runtime/UI contracts | Implemented and verified in #7; merged. Real Hub and scripted-provider evidence. |
| Phase 0 E2E/CI/packaging | Implemented and verified in #8; merged after strict final-head checks. |
| Phase 1 OS-isolated worker tests | Not implemented. Existing worker shell restriction remains. |
| Phase 1 bounded repair and dynamic delegation | Planning only; existing orchestration does not establish these new capabilities. |
| Live-model E2E/benchmarks | Not run; no provider/model/data/spend authorization was granted. |
| Clean-Windows lifecycle and release validation | Not verified. |

## 8. Remaining work

The [Phase 1 implementation plan](PHASE1-IMPLEMENTATION-PLAN.md) defines seven ordered PRs, concrete files/contracts, regression and real-machine gates, budgets, capability restrictions and stop conditions. It retains Windows 10/11 application support while proposing Windows 11 24H2+ x64 as the initial isolated-execution backend target. Windows Sandbox/CLI was absent on this development machine at read-only inspection; no OS setup or live-model spending was performed. Implementing the plan is separate from this Phase 0 task.

Before release, gather clean-Windows install/upgrade/uninstall and state-preservation evidence, authorized live-provider and performance results, signing evidence where an authorized certificate exists, and resolve missing top-level license/provenance with the owner.

## 9. Release readiness

**Not Ready.** Build/test evidence does not establish clean-machine installation, live-model quality, OS sandboxing, performance, signing or redistribution rights. No release or tag is authorized by this report.
