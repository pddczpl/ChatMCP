# CI health

Two numbers decide whether CI can be trusted as evidence: **how many runs one push costs** and **how often CI fails on `main`**. This page says how the workflows are triggered, how that was checked without GitHub, how `scripts/ci-health.mjs` measures both numbers, and what the numbers were before the change. Gate G0 of the roadmap asks for: no duplicate run per push, and a failure share of the completed runs on `main` of at most 15%.

## Triggers after this change

| Workflow | Starts on | Skipped for | Concurrency group |
|---|---|---|---|
| `ci.yml` (CI) | `pull_request`; `push` to `main` only; `workflow_dispatch` | documentation-only changes (see below) | `ci-<PR number>`, or `ci-<ref>` on `main`; only pull request runs are cancelled by a newer push |
| `docs-gates.yml` (Documentation gates) | the same events, only when a changed path is a documentation path | any change that touches no documentation path | `docs-gates-<PR number or ref>` |
| `dco.yml` | `pull_request` (opened, reopened, synchronize, edited) | nothing | `dco-<PR number>` |
| `browser-companion-regression.yml` | `pull_request` and `push` to `main`, only for the Companion paths it lists; `workflow_dispatch` | other changes | `browser-companion-<PR number or ref>` |
| `browser-companion-package.yml` | the same, for the extension and its packaging scripts | other changes | `companion-zip-<PR number or ref>` |
| `publish-v*.yml` | push to `main` (12 files) or completion of CI on `main` (6 files); each job is guarded by a condition on the commit | nothing at the trigger | per commit |

What was wrong: `ci.yml` ran on `push` for `main` and for `dev/**`, `fix/**`, `feat/**`, `refactor/**` **and** on `pull_request`, so every push to a branch with a pull request started it twice. `browser-companion-regression.yml` and `browser-companion-package.yml` each pinned one feature branch in `push` with the same effect. `phase1-component-tests.yml` was pinned to a branch that no longer exists; it is deleted, and the suites it ran are part of `node tests/run-all.mjs` in `ci.yml`. A branch **without** a pull request is no longer built on push; open the pull request, or start `ci.yml` by hand (`workflow_dispatch`).

### Why documentation-only changes skip `ci.yml` but not every check

`ci.yml` ignores `*.md` (top level), `docs/**`, `LICENSE`, `NOTICE`, `HUONG-DAN.txt` and `VALIDATION.txt`. Five suites read exactly those files: `verify-docs`, `verify-trust-labels`, `verify-notices`, `verify-threat-model` and, from the claims work, `verify-claims-map`. A bare `paths-ignore` would have let a README, threat model or claims-map change merge without them. `docs-gates.yml` therefore starts under the opposite condition (its `paths` list **is** the `paths-ignore` list of `ci.yml`; `tests/verify-ci-triggers.mjs` fails when the two differ) and runs those suites in about a minute. A change that touches both documentation and code runs both workflows. Files outside the list, for example `CHATMCP-HUB/tests/requirements-e2e.txt`, `CHATMCP-HUB/THIRD-PARTY-NOTICES.txt` or `CHATMCP-HUB/README.md`, still start `ci.yml`.

If branch protection makes jobs of `ci.yml` **required** status checks, a documentation-only pull request leaves them "Pending" because the workflow never starts. In that case require the check `Documentation suites` for documentation changes through a ruleset that matches the same paths, or do not require path-dependent checks; no setting of the workflow files can fix this. Whether branch protection is configured is not visible from the repository.

## How "one run per push" was checked without GitHub

`tests/verify-ci-triggers.mjs` reads the real workflow files with a small model of GitHub's trigger rules (`tests/fixtures/workflow-triggers.mjs`: branch, tag and path filters with `*`, `**` and `!`, the default activity types of `pull_request`, the rule that `paths-ignore` skips a run only when every changed file matches, and the concurrency group with its expressions). It replays the events GitHub sends for one pushed commit, and for each of the 23 workflow files asserts at most one run:

- a push to a branch that has an open pull request: the `push` event and the `pull_request` "synchronize" event (nine branch names, including the two that used to be pinned);
- a code change, a documentation-only change and a mixed change;
- a merge to `main`, a push to a branch without a pull request, a tag, a manual start.

The same replay on the v3.9.0 trigger block (embedded in the test) gives **two** runs for `feat/**`, `fix/**`, `dev/**` and `refactor/**`; that is the negative control. Seven defects put into in-memory copies of the current files (an old glob back, no branch filter, a pinned branch, a documentation path lost from `docs-gates.yml`, the old concurrency group, cancelled `main` runs, documentation no longer ignored) are each detected.

**Not shown by this:** that GitHub agrees with the model. The first pull requests after the change are the proof; measure them with `ci-health.mjs --since <date of the merge>`. The model also does not cover required checks, forks or `workflow_run`.

## `scripts/ci-health.mjs`

```bash
node scripts/ci-health.mjs --repo pddczpl/ChatMCP --workflow CI
node scripts/ci-health.mjs --repo pddczpl/ChatMCP --since 2026-11-01 --json
node scripts/ci-health.mjs --fixture CHATMCP-HUB/tests/fixtures/ci-health/gh-output.json
```

It needs the GitHub CLI (`gh`, logged in) and only reads: the allow-list is `gh run list` and `gh pr list`, enforced before a process starts, and `tests/verify-ci-health.mjs` checks that no mutating verb can be built. `--fixture` replays a saved `{"runs": [...], "pulls": [...]}` file (the raw output of those two commands), which is how the arithmetic is tested offline.

Definitions, fixed in the script and repeated in its output:

- **window**: the N most recent runs of the workflow on `main` (pull request runs excluded), newest first, whatever their status; N is 50 and 100. Fewer runs than N is reported ("only 26 runs exist"), never padded.
- **completed**: status `completed`; queued and in-progress runs are counted apart.
- **failure**: conclusion `failure`, `timed_out` or `startup_failure`.
- **failure share** = failures ÷ (successes + failures). Cancelled, skipped, neutral and stale runs say nothing about the code and are reported on their own. The share of all completed runs (failures ÷ completed) is printed beside it, because the two differ a lot when many runs were cancelled (below). The gate text says "completed runs"; which of the two is meant is the owner's call, and the stricter one is the default.
- **runs per merged PR**: runs of the workflow whose head branch is the pull request's branch and that started between its creation and its merge, any event. A pull request with no run in the fetched history is "no data", not "zero runs", and stays out of the mean.
- **built twice**: two runs of the same workflow for the same commit (a `push` and a `pull_request` run, in practice).
- A re-run keeps its run id, so a failure turned green by a re-run shows as success; the number of re-run runs is printed.

Exit code: 0 when every limit holds (`--max-failure-share`, default 0.15; `--max-duplicated-commits`, default 0), 1 when one is exceeded, 2 for a usage or `gh` error, 3 when there is nothing to judge.

## Baseline before the change (read with `gh` on 2026-10-19)

| | Last 50 runs of CI on `main` | Last 100 |
|---|---|---|
| success / failure / cancelled | 11 / 2 / **37** | 37 / 7 / **56** |
| failure share (failures ÷ success+failure) | 15.4% (2 of 13) | 15.9% (7 of 44) |
| failure share of all completed runs | 4.0% | 7.0% |

- More than half of the recent runs on `main` were **cancelled**, because the old `cancel-in-progress: true` also applied to `main`: a newer push cancelled the run of the previous commit, so a red commit could be replaced before anyone saw it. For all 56 cancelled runs among the last 100, a newer run on `main` had started before the cancelled one ended (checked on the same data). Only pull request runs are cancelled now. The failure share rests on 13 and 44 decided runs, a small sample; a few failures move it by several points.
- Of the 30 most recent merged pull requests, 16 still have runs in the history. They cost **16.2 runs each**, and in 10 of them the same workflow built 112 commits twice (`push` + `pull_request`). After the change this number must be 0: `ci-health.mjs --since <merge date of the first pull request>`.

## Why the failure share was about 24% (read with `gh` on 2026-10-20, task bc-14)

The 1,000 most recent runs of `CI` (all events, 2026-10-12 to 2026-10-19) contain **62 failed, 198 successful and 740 cancelled** runs: 62 of the 260 decided runs, **23.8%**. On `main` alone (129 runs in the same window): 55 success, 15 failure, 59 cancelled, so 15 of 70 (**21.4%**); since 2026-10-17 two failures of 17 decided runs. The window is the one in which the audit's phases landed, so most failures are branch work meeting the checks, not a flaky machine.

How it was measured, so that it can be repeated: `gh run list --workflow CI --limit 1000 --json ...` for the runs, then `gh run view <id> --json jobs` and `gh run view <id> --log-failed` for each of the 62 failed ones. The suite names are the `FAIL verify-*.mjs` lines `run-all.mjs` prints; a suite that failed in all four jobs of a run is a change that broke it, one that failed only in the two Windows (or the two Linux) jobs depends on the OS, one that failed in a single job of four depends on timing or load.

| Class | Failed runs (of them on `main`) | Seen as | Examples | At this commit |
|---|---|---|---|---|
| **A. Stale inventory**: a count, version or list in a test or a document no longer matches the code | 17 (3) | all four jobs, every time | `verify-docs` (11 runs: suite counts, versions, tool counts, links, mutation lists), `verify-local-backend`, `verify-local-tools`, `verify-tool-selector`, `verify-parity-runtime`, `verify-launcher` | each fixed by a later commit; nothing fails now. It comes back whenever a change adds a suite or a tool and not the number, which is why `docs/DEVELOPMENT.md` states the count rule and `docs-gates.yml` runs the document suites on documentation-only changes |
| **B. Windows path aliases**: the runner's temp folder is `C:\Users\RUNNER~1\...` (an 8.3 name) while the code compares canonical `runneradmin` paths | 15 (0) | both Windows jobs | `verify-windows-sandbox-config`, `verify-lsp-refactor`, `verify-code-intelligence`, `verify-smart-context-compaction`, `verify-concurrent-chat-workspaces`, `verify-phase2-context`, `verify-phase4-features` | fixed in the code (canonical workspace roots) and in the tests (`fs.realpath`). The cause can be reproduced here: the temp folder of the machine these suites were run on is itself an 8.3 name (`C:\Users\DATPHA~1\...`), and all of them pass |
| **C. A Linux job ran a Windows-only expectation** (or the reverse) | 5 (1) | both Linux jobs | `verify-windows-sandbox-config`, `verify-windows-sandbox-smoke`, `verify-phase3-features` ("requires Windows DPAPI") | fixed |
| **D. A real regression on a branch** | 10 (1) | all four jobs | `verify-e2e-recovery` (auto-resume 404), `verify-browser-continuation`, `verify-phase2-recovery`, `verify-e2e-adversarial` (on `main`, 2026-10-17), `verify-local-backend` | fixed by the next commit each time; these are the checks doing their job |
| **E. Timing and races** | 13 (5) | one job of four, or two | `verify-concurrent-chat-workspaces` (`task_not_running`: a follow-up in the moment between "completed" and "workspace lock released"; fixed in `ConcurrentApiAgent.continue`), `verify-outbound-hub` (409 while the Companion task was still closing) and `verify-hub-auth` (ACL of an elevated process), both fixed in `eb1e81c`; `verify-v2-http`, `verify-e2e-isolation`, `verify-phase3-worktrees`, `verify-persistent-sessions`, `verify-browser-web-workspaces` ("heap out of memory", Windows) | the races with a known cause are fixed. The rest could not be made to fail again: 12 rounds of `verify-concurrent-chat-workspaces`, `verify-gateway-autodetect`, `verify-phase3-worktrees`, `verify-v2-http` and `verify-persistent-sessions`, six processes at a time, gave 60 passes and no failure. A cause that is not found is what `--retry-failed-once` is for (below) |
| **F. The runner's Windows DPAPI** | 2 (0) | both Windows jobs | `verify-gateway-autodetect` ("cannot save or read the key under this Windows account"): a provider that saved a key was built without an injected protector and so called the real DPAPI through PowerShell | fixed (the suite injects `protect`/`unprotect`); the rule is "a test that saves a key brings its own protector" |
| **G. Node 22 performance** | 2 (0) | both Node 22 jobs | `verify-outbound-redaction` (1 MiB of base64 took 8-16 s; the slow rule is `discord-bot-token`) | open, owned by the pull request 44 work |
| **H. Outside the Node suites** | React E2E job 14 (5), Windows installer jobs 9 (4) | | the Playwright step "Build current React UI and run required E2E", the WebView2 smoke, the host supervisor fixture | not part of `run-all.mjs`; not analysed here |

A run can contain several classes, so the rows do not add up to 62. In 54 of the 62 failed runs at least one Node suite failed (84 suite failures); the other 8 failed only in the React E2E or installer jobs (class H). 73 of the 84 suite failures were in two or more of the four jobs of the same run: they depend on the commit or on the OS, not on luck. Classes A to D (66 suite failures in 41 runs) are the bulk of the 24%; they are not flakes and a retry would not have helped (the second attempt of the same commit fails the same way). Of the 15 failed runs on `main`, A, D and E explain 9, class C one, and the other 5 failed only in class H.

## Retry, `FLAKY`, and the streak gate

`node tests/run-all.mjs --retry-failed-once` (used by `ci.yml`) runs a suite that **failed or timed out** a second time, once.

| First attempt | Second attempt | Result | Counts as |
|---|---|---|---|
| passes | not run | `PASS` | pass |
| fails or times out | passes | **`FLAKY`** | `summary.flaky`, never `summary.pass` |
| fails or times out | fails or times out | `FAIL` / `TIMEOUT` ("failed twice") | fail / timeout |
| fails or times out | skips | `FAIL` ("a skip never rescues a failure") | fail |

A `FLAKY` entry in `summary.json` carries both attempts with their exit codes, notes and **the output of the attempt that failed**; the console prints that output under the table line, and GitHub Actions gets a `::warning title=FLAKY suite` annotation and a line in the step summary. One `FLAKY` suite does not make the run red (a retry exists for the rare accident); `--fail-on-flaky` makes it red where nothing should need a retry.

The same suite passing only on retry in run after run is a defect, not an accident. `scripts/ci-flaky-gate.mjs` (job `flaky-gate` of `ci.yml`, on pushes to `main` only, after `hub-tests` succeeded) adds up the `FLAKY` counts of the `hub-test-summary-*` artifacts of this run and of the previous ones and **fails when this run and the two runs of `main` before it each had one**. Definitions: a *flaky run* has more than 0 `FLAKY` suites in its summaries (a summary from before the retry existed counts 0); a run with no readable summary is *unknown* and ends a streak, because the gate never fails on something it did not see; the history is the previous completed `push` runs of `CI` on `main` that ended in success or failure, newest first. The script only reads GitHub (`gh run list`, `gh run download`; the artifacts go to a temporary folder). `tests/verify-test-runner.mjs` tests the retry rules, the decision function and the command line against fixture folders; mutating any of them (FLAKY reported as PASS, a skip rescuing a failure, an off-by-one streak, unknown counted as flaky) fails it.

## G1-8, and what it cannot be

Gate G1-8 asks for a failure share of the completed runs on `main` of at most 10% **and** four consecutive weekly releases. The owner has decided there is no release until the whole roadmap is done, so the second half cannot be met as written. The evidence that stands in for it, once the first half holds: four consecutive weeks in which the completed `CI` runs on `main` have a failure share of at most 10% (`node scripts/ci-health.mjs --since <date>` reports it), with no streak of `FLAKY` runs (`flaky-gate` green on every push), plus a dry run of the release pipeline once one exists. The share on `main` since 2026-10-17 is 2 of 17 (11.8%), too few runs to claim anything.

## Not verified here, and open

- The first real run of `docs-gates.yml`, of the changed concurrency expressions, and of the claims job: nothing here can start a GitHub run. They are checked by the trigger model and by running the same commands locally (`verify-docs`, `verify-trust-labels`, `verify-notices`, `verify-threat-model`).
- `publish-v*.yml`: 18 old release workflows remain. Twelve start on **every** push to `main` and six on every completion of CI on `main`; their jobs are guarded by a condition on the commit message and end "skipped", but each one is a run. They inflate the run count per merge on `main` (not per pull request) and hide the interesting runs in the list. Deleting those of releases that are out is the owner's decision, so it is not done here. `ci-health.mjs` counts the `CI` workflow by default for that reason.
- The installer jobs of `ci.yml` set `CHATMCP_ALLOW_PENDING_NOTICES=1` while the three Tree-sitter grammar licenses are missing (`scripts/intelligence-runtime/licenses/README.md`); `tests/verify-notices.mjs` requires the variable to be removed once they are added and refuses it in any release workflow.
