# Proof-of-Done: the proof ledger at the guard seam (P4 pod-17)

`DATGOLD-HUB/lib/proof/service.mjs` writes the **proof ledger of every task** ([PROOF-LEDGER.md](PROOF-LEDGER.md)) from the one place
every tool call passes: `HubManager.#guardCalls` (`lib/manager.mjs`). The agent, the Browser Companion, a side chat or spawned agent (each
in its own `HubManager`) and a client of the MCP host all reach their tools through that seam, so all of them are recorded without
knowing about the service. Tree snapshots come from the pod-15 engine ([PROOF-TREE.md](PROOF-TREE.md)).

**Status: wired in, nothing reads it yet.** Every task now gets a ledger in `<Hub data folder>/proof/<taskId>.jsonl`. No screen shows it
and no claim to users is made from it ([THREAT-MODEL.md](THREAT-MODEL.md) and [CLAIMS.md](CLAIMS.md) are unchanged); the receipts that
bind to it and the pack that cites it are later pods'.

## A run in the ledger

```text
task_start                       a new ledger only: {format, taskId, workspace, granularity, budgetMs}
tree  event task_start | run_start   full snapshot of the run's start (run_start for a resumed run)
tree  event call_start           cached snapshot right before a scanned call
call                             right after it: treeBefore, treeAfter, changed, outcome, overlapped
...
tree  event task_end             full snapshot of the run's end
task_end                         {format, run, status, errorCode, granularity, calls, scans, meanScanMs}
```

| Moment | Where | What is written |
|---|---|---|
| a task's run opens its tool session | `HubManager.createAgentSession`, after the task holds the workspace (`acquireTask`) and after the MCP preflight | `task_start` when the ledger is new, the `uncertain` records a run that died left out (below), then the full snapshot |
| a call the gate allowed, in a scanned category | `#guardCalls`, after the checkpoint, right before the tool | a cached snapshot, `tree` call_start |
| the call returned, reported an error or threw | `#guardCalls`, right after the tool and before the PostToolUse hooks (a hook's own file change is not put on the call) | a cached snapshot, `call`; then the caller's `onProof` |
| the run ends, whatever its status | `AgentRunner#finish`, `BrowserRunner.finish`, the MCP host's `#stop`: `HubManager.finishProof` before `releaseTask` | the full final snapshot (`tree` task_end) and `task_end` |
| the Hub starts again after it died in a run | `AgentRunner.load` for a task it finds interrupted: `HubManager.recoverProof` | the missing `uncertain` records |

The two records of the service have closed schemas in the ledger ([PROOF-LEDGER.md](PROOF-LEDGER.md), "Record types"):
`tree` = `{event, run, callId, tool, category, tree, scanMs}` and `call` = `{run, callId, tool, category, outcome, treeBefore,
treeAfter, changed, overlapped, scanMs, beforeSeq}`. A tree is the tree reference of a snapshot (`treeRef`: status, algorithm, object
format, `tree`, `rawTree` of full snapshots, counts, limitations, time); a snapshot that failed is `{status: 'failed', engineReason}` with
no id. `changed` is `treeBefore.tree !== treeAfter.tree`, and null when either has no id or they are of different algorithms. `callId` is
the guard's id of the call (the `toolUseId` the hooks see). `outcome` is `ok`, `error` (the tool reported an error) or `threw`. `scanMs`
is the time of the two snapshots. `beforeSeq` is the seq of the call's `tree` call_start record.

## Which calls are scanned

`scannedCall({category, touchesWorkspace})`: the calls the permission gate **allowed** in the categories that can change files,
`workspace_edit`, `dangerous`, `execute` and `unknown`. A read (`read`), a checkpoint or plan call, a call the gate or a hook refused,
and a call refused for its arguments are not scanned and leave no record.

**External MCP tools** (category `external`) are scanned only when the owner flagged their server `touchesWorkspace: true` in
`mcp-servers.json`, the same rule that gives them a checkpoint ([MCP-CLIENT.md](MCP-CLIENT.md)). A server runs outside the Hub and its
tools say nothing reliable about what they touch; scanning every external call would put a snapshot around every lookup of a search
server. The change an unflagged server makes is not lost: it shows in the next snapshot (the `treeBefore` of the next scanned call, or the
final tree), only not attributed to its call.

## The tree ids never reach the model

The trees are delivered to the caller through an **awaited `onProof` option** of `session.callTool`, beside `onDecision` and
`onCheckpoint`: the guard calls it after the `call` record is written and before it returns the result, with `{seq, callId, tool,
category, outcome, changed, overlapped, treeBefore, treeAfter, granularity}` (each tree as `{status, treeAlgorithm, objectFormat, tree,
rawTree}`). The tool's result is returned exactly as the tool gave it: no tree id is added to it, to the task's events, to its pending
call or to anything a resumed run reads. The agent writes the proof as a `proof` line of the task's transcript (`transcript.jsonl`), next
to the call's other records, with the model's call id; the history journal does not read that line type. An `onProof` that throws
changes nothing of the result (the call has run); the Hub logs it. The Companion and the MCP host pass no `onProof`: their calls are in
the ledger only. `tests/verify-proof-service.mjs` checks every request sent to the strict model mock, and the message the Companion hands
to ChatGPT, for every tree id of the ledger.

## What an `uncertain` record holds

| `reason` | Written by | Fields |
|---|---|---|
| `call_interrupted` | recovery: a `tree` call_start of a run without its `call` record (the Hub died in the middle of the call) | `run`, `callId`, `tool`, `category`, `treeSeq` (the seq of the call_start record, whose tree is the last one known before the call) |
| `run_interrupted` | recovery: a run without `task_end` | `run` |
| `call_unfinished_at_end` | `end()`: a call still running when the run ended and after the wait | `run`, `callId`, `tool`, `category`, `treeSeq` |
| `checks_only` | the budget switch (below) | `run`, `granularity` (`checks-only`), `meanScanMs`, `scans`, `budgetMs` |
| `torn_tail` | the ledger itself ([PROOF-LEDGER.md](PROOF-LEDGER.md)) | `bytes`, `sha256` |

Recovery is written once: a run counts as ended by its `task_end` or by its `run_interrupted` record, and a call by its `call`, its
`call_interrupted` or its `call_unfinished_at_end` record. `uncertain` keeps the ledger's open schema (masked whole); its records hold no
tree id, only the seq of the record that does.

## The budget switch to `checks-only`

A scan costs 0.1 to 0.9 s per mutating call on an ordinary workspace (two cached snapshots; [PROOF-TREE.md](PROOF-TREE.md) has the
engine's budgets). What is measured: the wall time of each snapshot taken **around a call** (before and after), with
`performance.now()`; the full snapshots of a run's start and end are not counted. After each recorded call, from the second scan of the
run on (`SCAN_BUDGET.minScans`), the mean of the run's scans is compared with `SCAN_BUDGET.meanScanMs` = 1,500 ms; when it is **strictly
greater**, the run switches to `checks-only`: the call just recorded keeps its record, an `uncertain` `checks_only` record says so, and
the later calls of that run are not scanned. Checks (pod-21) and the run's start and end are still recorded, and `task_end` says the
granularity that held at the end. The next run of the task starts at `calls` again. The service takes `{clock, budget}`
(`HubManager.proofOptions`, handed to a side chat's manager too).

Measured on this repository's suite (Windows 11, small Git repositories): a scanned call adds a median of 117 ms (both snapshots), a
full snapshot of a run's start or end a median of 142 ms (`PROOF_SERVICE_COST` line of `tests/verify-proof-service.mjs`).

## Cancel, crash and resume

- **Cancelled or failed run.** The runner calls `finishProof` in its end path for every status, before it releases the workspace. A stop
  does not wait for the tool (the agent stops waiting at once), so `end()` first waits up to 15 s (`END_WAIT_MS`) for a scanned call that
  is still running, whose `call` record then comes before the end; a call that outlasts the wait gets `call_unfinished_at_end` and its late
  result is not written. Then the full final snapshot and `task_end` with the run's status and error code (`cancelled` /
  `user_cancelled`). The snapshot after a call takes no stop signal: the call has run, so what it changed is looked at.
- **Crash (the Hub process killed).** The ledger ends where the process died; a line torn by the kill is repaired by the ledger itself.
  When the Hub starts again, `AgentRunner.load` marks the task interrupted and `recoverProof` appends `call_interrupted` for the call it
  was in and `run_interrupted`. The next `begin` of the task does the same for a ledger nobody recovered (a Companion task, a side chat).
- **Resume.** A continued conversation keeps its task id and its ledger: no second `task_start`, the chain goes on (seq, prev), the run
  starts with a `tree` run_start record whose `run` is one more than the runs before. A task that ran in plan mode is recorded the same
  way; its calls are reads, refused or plan calls, so they leave no `call` record.

## One service per manager and workspace

`HubManager.proofService()` makes the service for the manager's current workspace (again when the workspace changed). A side chat or a
spawned agent (`ConcurrentApiAgent#initChild`), the Companion's manager of a second workspace and each client of the MCP host are
`HubManager`s with **their own data folder**, so their ledgers are their own, keyed by their task id in their folder, and their
snapshots are of their own worktree. Only `proofOptions` is handed down. The snapshotter of a state folder
(`<data folder>/proof/snapshots/<workspace key>`) is shared by the services of one process (one temporary index per folder). Two scanned
calls in flight at once on one workspace (a second chat on the same checkout, parallel calls of an MCP client) cannot be told apart by
their trees: both records say `overlapped: true`.

**A data folder inside the workspace is refused** (`disabled: 'state_inside_workspace'`, checked on the path and again with both paths
resolved on disk, so a junction or a short name counts): every ledger line would change the tree it records. Nothing is written then.
Only `..` itself or a relative path that starts with `..` and a separator leaves the workspace: `<workspace>/..hub` and `<workspace>/...`
are inside it (audit of #154, N1; the same test as `lib/proof/cli/session.mjs`).

A call id or tool name over 200 characters is written as its first 120 characters, `…sha256:` and the sha256 of the whole name: the
ledger refuses more than 256 characters, and a record it refused would stop the run's recording (audit of #154, N2). Today the guard's ids
(`chatmcp_<uuid>`) and the catalog's names are far shorter.

A ledger that cannot be written (broken by an edit, a full disk) stops the service for that run: one line in the Hub log, no more
snapshots or appends, and the calls go on. The proof ledger is evidence, not a gate: it never refuses a call. A ledger that is broken
when a run begins is left as it is.

## The baseline store

The task-start snapshot does **not** take a baseline ([PROOF-BASELINE.md](PROOF-BASELINE.md)). A baseline imports the whole tree into a
private store (seconds on a large workspace) and is what a pack's patch is made from; the verify CLI takes one at `chatmcp verify
snapshot`, and pod-26 / pod-32 wire it where a pack is built. The ledger's task-start `tree` record names the tree a later baseline can be
compared with.

## Not done here

- No `permission` records yet (the pack reads them, [spec/agent-change-v0.1.md](spec/agent-change-v0.1.md)); no `outbound` records for
  the Companion's messages.
- The MCP host's end of a client's task is written when the host stops the client's manager; no suite checks that line yet.

## Tests

`DATGOLD-HUB/tests/verify-proof-service.mjs` (16 checks): the service alone on real Git repositories (the records of a run, a resumed run in
the same chain, recovery once, a recovery that died half way, the data folder inside the workspace (`..hub` too) and through a junction, a call id and a tool name over 200 characters, a registered
secret inside a tree id, overlapping calls, a failed snapshot, `end()` while a call runs and after it outlasts the wait, a ledger broken
during a task, the budget at exactly 1,500 ms, at 1,501 ms and with `minScans`); the guard through a real session (the awaited `onProof`,
reads, refused and invalid calls, an error and a call that throws); a real `AgentRunner` with the strict Chat Completions mock (a
`write_file` call record whose trees differ, no record for the read, no tree id in any request, the continued conversation); a cancelled
task with a running command; a side chat in its own worktree; a real `BrowserRunner` driven like the extension; and kill -9 of a real Hub
process in the middle of `run_command`, then the restarted Hub. Mutation list: `DATGOLD-HUB/tests/mutation/proof-service.json`; the schemas
of the two records are in `tests/mutation/proof-ledger.json`. The external-tool rule is checked with real MCP servers in
`tests/verify-mcp-agent-seam.mjs` (section 5: both calls to the flagged server have a call record, the other server's call none;
mutations S22 and S23 of `tests/mutation/mcp-agent-seam.json`).
