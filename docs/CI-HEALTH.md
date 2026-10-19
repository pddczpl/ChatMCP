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

## Not verified here, and open

- The first real run of `docs-gates.yml`, of the changed concurrency expressions, and of the claims job: nothing here can start a GitHub run. They are checked by the trigger model and by running the same commands locally (`verify-docs`, `verify-trust-labels`, `verify-notices`, `verify-threat-model`).
- `publish-v*.yml`: 18 old release workflows remain. Twelve start on **every** push to `main` and six on every completion of CI on `main`; their jobs are guarded by a condition on the commit message and end "skipped", but each one is a run. They inflate the run count per merge on `main` (not per pull request) and hide the interesting runs in the list. Deleting those of releases that are out is the owner's decision, so it is not done here. `ci-health.mjs` counts the `CI` workflow by default for that reason.
- The installer jobs of `ci.yml` set `CHATMCP_ALLOW_PENDING_NOTICES=1` while the three Tree-sitter grammar licenses are missing (`scripts/intelligence-runtime/licenses/README.md`); `tests/verify-notices.mjs` requires the variable to be removed once they are added and refuses it in any release workflow.
