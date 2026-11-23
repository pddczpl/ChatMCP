# Proof-of-Done: the check runner

The check runner runs the criterion checks of `.chatmcp/acceptance.yml` ([PROOF-ACCEPTANCE.md](PROOF-ACCEPTANCE.md)) and records every
attempt as one check receipt of the proof ledger ([PROOF-LEDGER.md](PROOF-LEDGER.md)). It then rolls the receipts up per criterion with
the roll-up of the proof pack ([spec/agent-change-v0.1.md](spec/agent-change-v0.1.md)). It belongs to phase P4 (Proof-of-Done core),
plan task pod-21.

**What exists today:** `DATGOLD-HUB/lib/proof/check-runner.mjs` (`runAcceptanceChecks`, `reapAttempt`, `processTreeOf`) and
`rollUpCriteria` in `lib/proof/pack.mjs`. **What does not exist yet:** nothing in the agent, the Hub or the `chatmcp verify` command
line calls the runner. Wiring the ledger into the agent is pod-17; the `exec` and `check` commands of the CLI come later
([PROOF-CLI.md](PROOF-CLI.md)).

## What runs

Only the checks of the **baseline** file run: the bytes of `.chatmcp/acceptance.yml` as they were when the task started, which the
caller passes. `resolveAcceptance` gives the list, and the runner never takes a list of commands from anywhere else. Nothing runs, and
`blocked` says why, when:

| `blocked` | When |
|---|---|
| `no_baseline` | there was no acceptance file when the task started |
| `acceptance_untrusted` | the owner has not trusted the sha256 of the baseline bytes |
| `acceptance_edited` | the file in the workspace is no longer the baseline bytes: edited, replaced by a file that does not read, or deleted |

The runner does not ask PermissionGate. The owner approved these exact commands by the file's sha256 after reading them. A second
approval of the same text would add nothing, and the agent cannot add a command to a trusted file without changing its hash. Every
check runs through `ShellRunner` (`lib/shell-runner.mjs`): stdin closed, credential-looking variables removed from the environment
(`scrubEnv`), the output bounded, and the command's process tree killed on timeout and on cancel (`killTree`). The `cwd` of a check
is resolved by the workspace on the real path. A folder that leaves the workspace through a link (`symlink_escape`), or that does
not exist (`bad_cwd`), is refused before anything runs. The check is then reported with that `error` and the next check still runs.

## Order and concurrency

One check at a time, criteria in the order of the file and the checks of a criterion in their order. An attempt starts only after the
one before it has been recorded. Two runners on one workspace are not coordinated with each other: the caller runs one at a time.

## One attempt

An attempt is pod-16's `recordCheck`, extended in two ways. It produces the same check receipt (`checkReceipt`), and there is no
second receipt format. The steps:

1. the tree before (pod-15 `TreeSnapshotter.snapshot`; a cancel stops it);
2. `ShellRunner.run` with the check's command, folder and timeout;
3. the processes the command left behind are reaped (below), **before** the tree after is taken, so a leftover cannot change the tree
   behind the receipt's back;
4. the tree after, taken even when the attempt was cancelled, so a cancelled attempt is recorded too;
5. the toolchain versions (`ToolchainProbe`, once per workspace), and one `check` line appended to the ledger.

**Timeouts.** A check's `timeout` is in seconds (1 to 3,600, default 600). ShellRunner caps it at its `maxTimeoutMs`, which is
`MAX_TIMEOUT_MS` (900 s) by default. The report gives the time used (`timeoutMs`) and says when the file asked for more
(`timeoutCapped`). A check that times out did not pass.

**Output.** The receipt holds the sha256 and the byte count of every byte each stream wrote, whether the capture dropped a middle
(`truncated`), and a masked preview of at most 2 KiB. Truncation does not change a result: the exit code decides.

## Attempts and repeats

A run **passed** when its exit code is the check's `expect.exit` and it neither timed out, nor was cancelled, nor ended by a signal.
The tree **changed** when the trees before and after are both known, comparable (same algorithm and object format) and different. It
is unknown when either is missing.

| The attempt | What the runner does next |
|---|---|
| did not pass | stops this check. A failure is never run again: a re-run could turn a flaky failure into a pass. |
| passed, the tree did not change (or is unknown) | counts it; stops when the count reaches `repeat` |
| passed and changed the tree | runs the check again on the new tree and starts the count again (passes before the change were on another tree) |
| passed and changed the tree for the third time | stops: the check is **unreliable** (`checks[].unreliable: true`) |

So a check is run again because it changed the tree at most `TREE_RERUNS` = 2 times. Each attempt is one receipt and one entry of
`attempts`, numbered from 1 per check. `repeat` is the owner's tool against flaky checks: `repeat: 3` asks for three passing runs on
the final tree. The runner never retries a failure, so a check that fails once in three runs is `failed` when that run happens, and
`passed` when it does not happen within `repeat` runs.

## Fresh against the final tree

The **final tree** is a full snapshot taken after the last attempt. A pass is evidence for the final tree only when its run started
**and ended** on it: same algorithm, object format and tree id before and after. A run that changed the tree is no evidence that the tree
passes. A formatter run as a check fixes what it checks and still exits 0. A failure that started on the final tree counts whatever
the run did afterwards. These are the rules of the pack ("A check against the receipts" in
[spec/agent-change-v0.1.md](spec/agent-change-v0.1.md)), not a second copy of them.

When the tree is unknown, nothing can be fresh:

- a receipt without a tree (no snapshot engine, or a snapshot that failed), or with a tree of another algorithm or object format, makes
  the check `tree_unknown`;
- without a final tree (no snapshot engine, or the last snapshot failed) the runner rolls nothing up: `criteria` is `null`, and nothing
  is evidenced.

**Outputs a check writes: a plain folder.** Which writes change the tree depends on the snapshot engine ([PROOF-TREE.md](PROOF-TREE.md)).

- **A Git workspace** uses `git-pinned-v1`. An untracked path that `.gitignore` excludes is not in the tree, so a check that writes
  only ignored outputs leaves the tree as it found it.
- **A plain folder** (no Git repository) uses `raw-v1` with no ignore rules (`ignoreRules: 'none'`). The same holds when Git is
  missing, and when the repository's configuration makes the Hub refuse to start Git at all (`repository_config_refused`). Other
  `raw-v1` fallbacks still let Git list the files and keep the ignore rules. Without ignore rules every byte a check writes into the
  workspace is part of the tree: `__pycache__`, `.pytest_cache`, a coverage report, `node_modules/.cache`, build output.

A run that wrote such outputs changed the tree, so its pass is not evidence. The runner runs the check again on the new tree:

- if the re-run writes the same bytes (compiled `.pyc` files of unchanged sources, say), the tree is unchanged and the re-run counts;
- if every run writes new bytes (a coverage report with a time stamp, a cache that records the last run), the check stays unreliable
  and its criterion is never `evidenced`.

The ways out:

- make the workspace a Git repository and list the outputs in `.gitignore` (`__pycache__/`, `.pytest_cache/`, `.coverage`,
  `coverage/`);
- or make the check write nothing into the workspace, for example
  `run: "PYTHONDONTWRITEBYTECODE=1 python -m pytest -p no:cacheprovider"`, or a coverage report written outside the workspace.

A check whose receipts are on an older tree because a later check changed the tree is `stale`. The runner does not go back and run it
again. A caller that wants fresh evidence runs the checks again once the tree no longer changes.

## How an unreliable check shows

The roll-up is the pack's (below), and the pack has no `unreliable` result. An unreliable check shows in two places:

- in the runner's report, `checks[].unreliable: true` and its `attempts`, each with `treeChanged: true`;
- in the roll-up, every one of its runs changed the tree, so none counts as a pass. Its result is `stale`, its criterion is not
  `evidenced`, and the reason `check_stale` says `ran on the final tree but did not leave it as it found it` when a run started on the
  final tree.

A check that toggles a file is the case where the stricter rule matters. Its runs go T1→T2, T2→T1, T1→T2. Its second run started on the
final tree T2 and passed, but it changed that tree, so it does not count.

## The roll-up

`criteria` in the report is `rollUpCriteria` of `lib/proof/pack.mjs`. It takes the final tree, the `resolveAcceptance` result, the
pod-22 check-changes report and the bytes of the ledger. `buildAgentChangeStatement` builds the criteria of a pack with the same
function, so a pack built from the runner's ledger and final tree has exactly the runner's criteria. The suite checks this in every
scenario, and that the pack validates. It follows that:

- a criterion is `evidenced` only when every one of its checks is `passed` (at least `repeat` passing runs that started and ended on the
  final tree, and no run on the final tree that did not pass), the acceptance is trusted, the check-changes report has its row without
  `checks_modified`, and the ledger's chain verifies;
- without a check-changes report (`checkChanges: null`) every criterion of kind `checks` has the reason `check_changes_unknown` and is
  at most `unverified`. The caller passes the pod-22 report, or a function that computes it after the runs, when the final work tree
  exists.

What each case of the test plan gives (`tests/verify-proof-checks.mjs` runs each one with real commands):

| The check | Attempts | Check result | Criterion |
|---|---|---|---|
| passes | 1 | `passed` | `evidenced` |
| exits 3 where `expect.exit: 3` | 1 | `passed` | `evidenced` |
| fails (exit 1) | 1 | `failed`, `exit 1, expected 0` | `failed` |
| times out (`timeout: 1`) | 1, its process tree killed | `failed`, `timed out` | `failed` |
| writes 100,000 bytes over a 4,096-byte capture | 1, `truncated` | `passed` | `evidenced` |
| `repeat: 2` | 2 | `passed` | `evidenced` |
| flaky, `repeat: 3`, fails on the 2nd run | 2 (the 3rd never runs) | `failed` | `failed` |
| flaky, `repeat: 3`, fails on the 3rd run | 3 | `failed` | `failed` |
| changes the tree once, then settles | 2 | `passed` on the new tree | `evidenced` |
| changes the tree on its 2nd run only, `repeat: 2` | 4 (the count starts again) | `stale` when a later check changed the tree | `stale` |
| ran before another check changed the tree | 1 | `stale` | `stale` |
| keeps changing the tree | 3, `unreliable` | `stale` | `stale` |
| writes new bytes on every run, into a folder `.gitignore` lists (Git workspace) | 1 | `passed` | `evidenced` |
| the same check in a plain folder (`raw-v1`, no ignore rules) | 3, `unreliable` | `stale` | `stale` |
| toggles a file | 3, `unreliable` | `stale` | `stale` |
| its folder is missing | 0, `error: bad_cwd` | `not_run` | `unverified` |
| leaves a child process behind (quiet, or holding the output) | 1, the child reaped | as its exit code | `evidenced` |
| the acceptance file is untrusted | 0 | `not_run` | `unverified` (`acceptance_untrusted`) |
| the file was edited since the baseline | 0 | `not_run` | `unverified` |
| cancelled while it runs | 1, `cancelled` | `failed`, `cancelled` | `failed` |
| a check after the cancel | 0 | `not_run` | `unverified` |

## Cancel

An `AbortSignal` cancels the run. ShellRunner kills the running command's tree. The attempt is still recorded (reaped, its tree
after taken, its receipt saying `cancelled: true`), and no later check starts: the next attempt's tree snapshot, or ShellRunner itself,
refuses the aborted signal before anything runs. The report says `cancelled: true` and still rolls up what was recorded. A cut check is
`failed` with the detail `cancelled`, and the checks that never started are `not_run`. A signal aborted before the call runs nothing.

## Processes left behind

A check can leave a process running after its shell exits: a server started in the background, a watcher. ShellRunner notices only
the one that holds the output pipe (`lingering`) and kills nothing after the shell has exited. So after every attempt the runner
reaps what is left of the shell's tree (`attempts[].reap`: `left` says whether anything was found, `leftovers` lists what was still
alive after the last round):

- **POSIX.** The shell led its own process group (ShellRunner spawns it detached). The group is signalled with SIGKILL and the
  runner waits up to 1 s for it to be gone. Not reached: a process that left the group (`setsid`).
- **Windows.** Windows keeps the parent pid of an orphan, so the tree can be walked by parent pid and creation time after the shell
  exited (`processTreeOf`). A process belongs to the shell when the holder of its parent pid *at its creation* (the latest process with
  that pid created no later than it) belongs to the shell. A pid reused by a newer process does not adopt that process's children.
  Git Bash needs more than one reading: Git's `bin/bash.exe` is a launcher that starts `usr/bin/bash.exe` and exits with it, so
  everything a check starts is a grandchild of the process the runner spawned. Once both have exited, the chain is broken. The runner
  therefore reads the process table (`Get-CimInstance Win32_Process`, through Windows PowerShell) again and again while the attempt
  runs, 250 ms after each reading ends, and once more after it. It walks the union of the readings and kills every live process of the
  tree with its own tree (`taskkill /T /F`), for up to three rounds. Not reached: a process whose whole chain of parents started and
  exited between two readings. A check that starts a background job and exits within a fraction of a second can leave it unreached.
  Each reading starts one Windows PowerShell process.

## The report

`runAcceptanceChecks` resolves with:

| Field | What it holds |
|---|---|
| `format` | `chatmcp.check-run/1` |
| `blocked` | `null`, `no_baseline`, `acceptance_untrusted` or `acceptance_edited` |
| `cancelled` | the signal was aborted |
| `acceptance` | `{baselineSha256, trusted, edited}` |
| `finalTree` | the final tree as a receipt holds a tree (`treeRef`), or `null` |
| `checks` | per runnable check: `criterionId`, `index`, `attempts` (count), `unreliable`, `error` (`{code, message}` when ShellRunner refused it), `timeoutMs`, `timeoutCapped` |
| `attempts` | per attempt, in order: `criterionId`, `index`, `attempt`, the ledger `seq` and `hash`, `passed`, `treeChanged` (true, false or null), `exit`, `signal`, `timedOut`, `cancelled`, `lingering`, `durationMs`, `startedAt`, `endedAt`, `reap` |
| `criteria` | the roll-up (`rollUpCriteria`), or `null` without a final tree |
| `ledger` | `{present, verified, records, lastHash, brokenAt, reason}` of the ledger read for the roll-up, or `null` |

It throws only when it cannot run at all: a baseline that does not read (`AcceptanceError`, the owner's file to fix), or a ledger that
refuses a record (`ledger_broken`, `ledger_record_too_large`).

## Limits

- **Toolchain.** A check that calls `dotnet`, `python` or another toolchain can behave differently on another machine or CI runner.
  The receipt records the versions of node, python, dotnet and git that the agent's PATH finds. The runner does not pin or normalise
  them.
- **Integrity.** The ledger is tamper-evident, it is not tamper-proof: the agent runs as the same Windows user as the Hub and could
  rewrite it. A pack built from it keeps the integrity level `unconfined`.
- **Measured on Windows only so far.** The suite ran on Windows (Git Bash). The POSIX path of the reaper is exercised by the Linux CI
  run.

## Tests

`tests/verify-proof-checks.mjs` (real Node scripts through the real ShellRunner, the pod-15 engine on real Git repositories, the pod-20
trust store and the pod-22 detector) and the mutation list `tests/mutation/proof-checks.json`. The stricter pass rule in the pack is
covered by `tests/verify-proof-pack.mjs` and `tests/mutation/proof-pack.json`.
