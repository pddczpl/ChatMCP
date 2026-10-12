# Phase 0 execution report

Date: 2026-10-12 (Asia/Bangkok). Target: Windows 10/11 x64, local-first, single user. This report distinguishes current React/real-Hub evidence from scripted model responses, native browser smoke, and release validation.

## 1. Repository state

| Field | Observed state |
| --- | --- |
| Requested base | v2.6.0, `b1160c6862c658d85c90fb1f157cc085d9cfc244` |
| Source fixes | 45 files committed as `bda62dd059ca925ce81d6483c0b7e398fc646206` |
| Source PR | [PR #7](https://github.com/pddczpl/ChatMCP/pull/7), base `main` |
| Current branch | `fix/phase0-e2e-ci-gates`, based on the source commit above; tests, CI, packaging safeguards and this report are the follow-up change |
| Follow-up PR | Planned against `main`, dependent on PR #7 |
| Local `main` | Unchanged at `1f66d8e7d787b2498cf909231b3b51c345d2d910` |
| Merge / release tag | Neither performed; published v2.6.0 remains unchanged |

Tests use disposable workspaces and state directories. Existing ignored user state is preserved and excluded from installer payload selection.

## 2. Verified findings

The [desktop contract audit](PHASE0-DESKTOP-CONTRACT-AUDIT.md) contains the initial source evidence and classifications.

| Finding | Evidence and result |
| --- | --- |
| React/Hub contract mismatch | React read wrong task, status, history, approval and inspector fields. Adapters now consume actual Hub records and permission decisions. |
| Misleading workflow UI | New conversation submitted a sample prompt; plan/completion presentation invented progress or implied verification. Blank drafts and evidence-based status now replace those behaviors. |
| Missing event subscription | Hub exposed task SSE but current React did not subscribe. Task-scoped subscription and reconnect reconciliation are implemented; live-provider token streaming remains a separate unverified capability. |
| Onboarding/settings failures | Workspace errors could substitute a hard-coded path; setup choices were ineffective; Review mode sent an invalid execution policy. Real API calls and valid policy now persist the choices and expose errors. |
| Retained API key | A typed key survived save/provider/endpoint changes and could be sent to a different destination. The form now clears it; regressions use dummy keys and a local endpoint. |
| Delegate persistence race | Concurrent workers replaced the same result file. Persistence now serializes immutable snapshots and awaits outstanding workers. |
| Installer contamination | Directory copying included ignored private state and test output. Tracked runtime selection now excludes them. |
| Repeated native publish | Reusing native output could omit `WebView2Loader.dll`; a fresh output directory included it. Builds now use fresh native/installer directories and fail if required executable/loader files or the x64 loader check fail. The rebuilt ZIP contains the verified loader. |
| Missing CI gates | FastAPI dependencies, required no-skip enforcement and current React/real-Hub E2E were absent. The follow-up workflow adds them. |
| Skills | Already connected at the base. React and WebView2 regressions verify its rendering and actual local API requests. |

## 3. Implemented changes

- Task adapters, streamed state, conversation/history rendering, Stop/Resume, approval decisions and blank conversation creation now use actual Hub contracts.
- Plan, Activity, Files, Git and Terminal render recorded evidence, real changes/output, and explicit loading/error states. Model completion no longer certifies tests.
- Onboarding applies workspace, provider and permissions. Settings report local single-user/backend facts; typed API keys are cleared on successful save and destination changes.
- Existing delegate persistence is repaired. Worker shell restrictions and permission gates remain enforced.
- Playwright runs the current production React bundle against a real isolated Hub, Git workspace and scripted local provider. Unit/contract tests and a separate Windows WebView2 harness cover additional regressions.
- Installer payload selection, staging and cleanup are checked by disposable-fixture tests. CI installs pinned Python test dependencies, rejects skipped required tests, and adds Windows/Linux React E2E plus Windows payload/native smoke gates.
- README, development, architecture, user, security, changelog and audit documentation describe current behavior and its limits.

## 4. Testing evidence

| Check | Exact command / evidence | Result |
| --- | --- | --- |
| Strict Hub regression | In `CHATMCP-HUB`: `node tests/run-all.mjs --no-skip all --json test-results/phase0-final.json` | Exit 0; **48 passed / 0 failed / 0 skipped suites**, Windows x64, Node 24.19.0. |
| Final UI unit/contracts | In `CHATMCP-HUB/ui`: `npm run test:unit` | Exit 0; **36 passed / 0 failed / 0 skipped**. |
| Final React/real-Hub E2E | In `CHATMCP-HUB/ui`: `npm run test:e2e:built` | Exit 0; **6 passed / 0 failed / 0 skipped / 0 flaky**, 42.431 seconds; started `2026-10-12T09:56:21.011Z`. All six browser-error and all six browser-warning attachments are empty. |
| TypeScript/Vite build | In `CHATMCP-HUB/ui`: `npm run build` | Exit 0; final entry asset `index-DO6uWbE-.js`. |
| Final Windows WebView2 smoke | `node CHATMCP-HUB/ui/e2e/webview2-smoke.mjs` | Exit 0; **6 checks passed**, runtime `154.0.4258.62`; no captured JavaScript/console/API errors. |
| Installer payload regression | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/tests/Test-InstallerPayload.ps1` | Exit 0; **39 passed / 0 failed / 0 skipped**, including fresh-output/required-loader checks, optional DLL retention, PDB/XML exclusion, PowerShell 5.1 parsing and ASCII checks. |
| Final installer artifacts | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Build-Installer.ps1`; ZIP inspection and SHA-256 comparison | Build exit 0; required files/loader, payload exclusions, exact React assets and installer checksum verified. Existing `MSB3277` WindowsBase 4/5 warning; no build errors. |
| Documentation / whitespace | In `CHATMCP-HUB`: `node tests/verify-docs.mjs`; at repository root: `git diff --check` | Both exit 0 after this report was added; **12 documentation checks**, including all 19 docs linked from README. No whitespace errors. |

The tested React entry asset SHA-256 is `149051dc976535b26cf486d05b4ef102c9ef0c172665100c6b6b3bf6fb927272`.

Final `installer/payload.zip` contains **130 entries / 82,272,461 bytes**. Its generated index and all four referenced assets match the fresh UI by byte hash. No private state, imported skills, dependencies, tests or PDB files are included; the existing ignored `installed-plugins.json` remains untouched. The root `WebView2Loader.dll` is **194,912 bytes**, x64 PE machine `0x8664`, with SHA-256 `3426dcc55fdfb8b5e7ac623cf33b4ccf283fbf68a0c5a65bddfdb4d749a8abee`, matching pinned NuGet `1.0.4258.31`. Final `dist/ChatMCPSetup.exe` is **198,490,272 bytes**; SHA-256 `b52e93edbb8b9020dce34e05656185ed269ec84878f029d9e51d6e968ac08bdf` matches its sidecar.

The six E2E scenarios exercise real onboarding/configuration; empty conversation without a model request; running tools and task SSE; Approve/Deny; actual file edits, tests and Git diff; evidence-based plans; Activity/Files/Terminal/Skills APIs; permission settings; dummy-key clearing; Stop/Resume; settled conversation persistence across a Hub restart; and a failing test that remains visibly failed. Existing Hub recovery suites separately cover crash recovery. No test replaces the production UI with the legacy dashboard.

The WebView2 harness uses a temporary profile and real Hub; it does not prove the packaged desktop executable or install/upgrade/uninstall lifecycle. Live model requests, performance benchmarks and clean-VM release validation were not run or counted as passing tests.

## 5. Security status

Passing Hub suites exercise loopback/Host/Origin/CSRF, permissions, path/command controls and recovery. React tests retain Review mode and explicitly approve or deny real gate requests; denial leaves the fixture unchanged. Test credentials are fake and provider traffic stays on the local fixture.

Payload tests check private/development-file exclusion, tracked file boundaries, generated-output junction refusal and validated absolute staging cleanup. These are bounded regression checks, not certification of every compromised-build-machine race.

Windows host execution remains host execution; Git worktrees are not OS isolation. No unrestricted worker shell, public listener, hosted backend, release tag or invented license grant was introduced. [SECURITY](../SECURITY.md) retains the threat-model limits.

## 6. CI and GitHub

Source [PR #7](https://github.com/pddczpl/ChatMCP/pull/7) publishes `bda62dd059ca925ce81d6483c0b7e398fc646206`. All seven jobs in [Actions run 38233257082](https://github.com/pddczpl/ChatMCP/actions/runs/38233257082) succeeded under the **old workflow**. Each of its four Hub jobs reported **47 passed / 0 failed / 1 skipped**: FastAPI was skipped because `fastapi`, `httpx`, `pytest` and `uvicorn` were missing. Therefore this green run does **not** satisfy the requested no-skip acceptance gate or establish the follow-up React gate's results.

The follow-up PR will target `main` and depend on #7. It installs the Python dependencies and enforces the strict Hub/React/native gates. Its exact remote commit/check results and any blocking reviews must be recorded before merge. PR #7 had no reviews or comments at the last inspection; no `phoenix-mentor` response was observed. No merge or branch-protection bypass has occurred.

## 7. Feature completion matrix

| Feature / phase | Status | Evidence boundary |
| --- | --- | --- |
| P0 task status/history, approvals, blank draft, Stop/Resume | Implemented & Verified locally | Current React, real Hub and scripted provider; no duplicate task on resume/new draft. |
| P0 plans, Activity/Files/Git/Terminal/Skills | Implemented & Verified locally | Actual persisted/API data, Git diff and command output; evidence-aware progress. |
| P0 SSE consumer, onboarding, settings and key handling | Implemented & Verified locally | Contract/unit tests and browser assertions; live-provider token generation not established. |
| P0 current React E2E and native browser smoke | Implemented & Verified locally | Six Chromium scenarios and six native smoke checks. |
| P0 installer artifact gate | Implemented & Verified locally | Fresh build, required x64 loader, payload exclusions, exact UI assets and checksum checked; installation lifecycle remains outside this evidence. |
| P0 CI gate | Partial | Workflow implemented; follow-up remote checks/reviews outstanding. |
| P1 bounded coding loop and dynamic subagents | Partial (existing capabilities) | Existing tools/recovery/orchestration retained; requested new repair controller and dynamic orchestration not delivered here. |
| P1 OS-isolated worker execution | Blocked / Not Started | No verified Windows sandbox; existing worker restrictions stay in force. |
| P2 full Studio, context/cost management | Partial (existing capabilities) | Inspector repairs complete; full editor/dashboard and expanded budgets/pricing remain. |
| P2 provider streaming, attachments, MCP/browser/hooks/scheduler | Not Started in this branch | Existing optional integrations do not establish requested feature parity. |
| P3 security/release quality | Partial | Targeted fixes and regression gates complete; broad adversarial matrix and clean-Windows lifecycle remain. |
| P3 performance | Not Started | No measured startup/memory/repository-scale/latency baseline. |
| P3 license/provenance | Blocked | No top-level LICENSE found; notices and skill license detection do not grant redistribution permission. |

## 8. Remaining work

1. Publish the dependent CI/test PR, observe checks on its exact final commit, and address required or blocking review feedback before merge.
2. After Phase 0 gates pass, continue the requested Phase 1–3 dependency order. Keep worker restrictions until OS isolation is established.
3. Before release, verify clean-Windows install/upgrade/uninstall and user-state preservation, resolve license/provenance with the owner, and gather authorized live-provider/performance evidence. Signing requires an available authorized certificate.

## 9. Release readiness

**Not Ready.** Phase 0 source/UI behavior and installer artifacts have local evidence; follow-up remote CI/review remains outstanding. The broader clean-Windows lifecycle, live-provider, performance, signing and license gates also remain unverified or unresolved. Do not replace the published v2.6.0 tag or treat this work as a release certification.
