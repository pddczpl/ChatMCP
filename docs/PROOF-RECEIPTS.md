# Proof-of-Done: receipts bound to the workspace tree (P4 pod-18)

The agent's own completion evidence (the receipts of `lib/agent-progress.mjs`: a file read, a file edit, a passing check, a Git diff review)
is bound to the **workspace tree it was made on**. Before pod-18 a list of tool names (`FILE_MUTATION`) decided which calls emptied the
receipts; a shell command that edited a file, a tool of another name or a change made between two runs left them in place. Now the trees
come from the proof service at the guard seam ([PROOF-SERVICE.md](PROOF-SERVICE.md)), which snapshots every allowed call that can change
files whatever it is called, and a receipt is judged by the tree, not by a name.

## Fresh, stale, unknown

| Freshness | When |
|---|---|
| **fresh** | the receipt's tree is the latest tree the Hub knows for the task (`progress.tree`) |
| **stale** | both trees are known and they differ: the files changed after the receipt was made |
| **unknown** | the receipt has no tree, or the Hub does not know the current tree |

**Unknown is never fresh.** A tree is compared by its key, `treeAlgorithm:objectFormat:tree` (`treeKey` in `lib/agent-progress.mjs`): two
ids compare only within one algorithm ([PROOF-TREE.md](PROOF-TREE.md)), so a git-pinned-v1 tree is never equal to a raw-v1 one. A tree
reference without an id (a snapshot that failed, an `unbounded` tree) has no key.

`progress.receipts` keeps every receipt (the last 24 of each kind) with its tree. `verifiedInspections`, `verifiedFiles`, `verifiedChecks`
and `gitReviews` are **projections**: the fresh receipts of each kind, made again from `receipts` and `tree` every time the progress is read
or changed. A stale receipt stays in `receipts`: the files may come back to its tree (a revert), and it is fresh again then.

## Which tree a receipt is bound to

`verifyHostEvidence` (`lib/agent-autonomy.mjs`) checks a receipt as before (the first-party local backend, a fresh hash of the file on disk,
exit 0, not cut, not timed out) and binds it to a tree:

| Receipt | Tree | No receipt, or unknown |
|---|---|---|
| a passing check (`run_command` of kind verify) | its tree before = its tree after | **no receipt** when the two trees differ: a check that changed the files it checked is unreliable, the same rule as the strict pass rule of [PROOF-CHECKS.md](PROOF-CHECKS.md); unknown when either tree is missing or the call overlapped another one on the folder |
| an edit (`edit_file`, `write_file`, `files_apply_patch`, each file of `files_write_batch`) | the tree after it | unknown without trees or when it overlapped |
| a read (`read_file`), a diff review (`git_diff`) | the current tree: these calls are not scanned (they cannot change files) | unknown when the Hub does not know the current tree |

The agent learns a call's trees from the guard's `onProof` (`AgentRunner.#proved` keeps them per call id) and whether a call may change
files from `onDecision`'s `mayChangeFiles` (the categories the proof service scans, `scannedCall`, an external server flagged
`touchesWorkspace` included). No snapshot is taken by the agent.

## The current tree

| Event | `progress.tree` after it |
|---|---|
| a run starts | the run's start tree: `ProofService.begin()` returns the ids of the full snapshot it recorded and `HubManager.createAgentSession` puts them on the session as `proofStart`; none: unknown |
| a call with trees | its tree after, whatever the tool and whatever it returned (an error, a refusal of the tool itself) |
| a call that may change files and came back without trees (checks-only, the service disabled or halted) | unknown |
| a read, a call refused by the gate or a hook, a call that never ran | unchanged |
| the run ends (`ProofService.end()`, after the completion was judged) | the run's real final tree, when it is known and differs from the current one (below) |
| the Hub died while a call that may change files was running (the task is `uncertain` after the restart) | unknown |

A change made outside a scanned call (an external MCP server the owner did not flag, the person's own editor, a process left running) is not
attributed to a call: it shows in the tree **before** the next scanned call, so in the tree after it, and the receipts made on the old tree
are stale from then on. A follow-up run of the conversation starts on the tree the ledger recorded at its start: the receipts of the earlier
run are fresh again when the files are as they were, stale when they changed between the runs.

## The completion is judged against the final tree

`assessCompletionEvidence(plan, progress, {tree})` and `classifyTaskCompletion(plan, progress, {tree})` judge the receipts the plan asks for
(an edit, a passing check, a Git diff review) against the final tree: `tree` when the caller gives one (the done-gate of pod-23 may), else
the latest tree the progress knows. For each kind the state is fresh when one receipt is fresh, else unknown, else stale, else missing, and
`missing` says which:

```text
No verified successful project check                                  no receipt of the kind
No verified successful project check on the final tree: its receipts are stale (the files changed after them)
No verified successful project check on the final tree: freshness unknown (the Hub has no tree to compare them with)
```

Both carry `freshness`: `fresh` (ready), else `unknown` before `stale` before `missing`, and `not_applicable` without a plan. The task's
`verificationOutcome.missing` and its answer's warning (`DatGold has NOT independently verified full completion: ...`) use these words.

**The run's real final tree.** The completion is judged when the model gives its final answer, against the latest tree the run knows: the
tree after its last scanned call. A change made after that call by something the Hub does not scan (a process a command left running, a
watcher, the person's own editor, an external tool the owner did not flag) is not in that tree. The full snapshot `ProofService.end()` takes
when the run ends is: `AgentRunner#finish` compares it with the tree the completion used (`#judgeFinalTree`). When both are known and
differ, the final tree becomes the current tree, the receipts made on the other one are stale, and a completed task is judged again:
`verificationOutcome.ready: false`, `completionOutcome.verification: 'missing_evidence'`, `freshness: 'stale'`, the Hub's warning added to
its answer and a `verification_unverified` event with `reason: 'final_tree_changed'`, all saved. The task's status stays `completed`. A
final tree that is not known (the snapshot failed, the service is disabled) changes nothing: it is no evidence that the files changed. The
Stop and TaskCompleted hooks run before the end and see the judgment made at the final answer.

**What a task with unknown freshness ends as.** A coding task whose receipts are of unknown freshness at the end (checks-only after the scan
budget switch, the Hub's data folder inside the workspace, a snapshot that failed) ends `completed` with `verificationOutcome.ready: false`,
`completionOutcome.verification: 'missing_evidence'`, `freshness: 'unknown'`, the warning in its answer, and nothing to accept: the same
outcome as a task without receipts, with words that say why. A short request without a plan is not judged (`not_applicable`), as before.

## Owner acceptance

A receipt id (`objectiveReceiptId`) carries the first 12 hex characters of its tree: `verify:3:<id>@<tree prefix>`. Only receipts fresh on
the latest tree are offered (`availableObjectiveReceipts`), accepted (`acceptObjectiveCriterion`, judged at accept time) and counted
(`acceptedObjectiveIds`): an acceptance made on a tree that is gone no longer counts, and counts again if the files come back to it. The
Hub's own matching of checks (`autoAcceptVerifiedChecks`) takes the latest fresh check. The evidence report a resumed run hands to the model
lists receipts by kind, step and path only: no receipt id, so no tree prefix, reaches the model.

At accept time the latest tree is the one the task's last run knew; a change made after the run ended is not seen until the next run starts
(no snapshot is taken at accept time).

## The Studio timeline

`StudioWorkflow` (`lib/studio-workflow.mjs`, `/api/studio/workflow`) no longer keeps a sticky `verified` flag. It keeps the latest tree it
knows (the guard gives it each call's trees and `mayChangeFiles`, and `noteTree` for a call that threw) and the tree of each passing check
(`passes`, the last 24). `verified` is computed: a pass fresh on the latest tree; `freshness` is `none`, `fresh`, `stale` or `unknown`.

## Tasks saved by older versions

A task file written before pod-18 holds the four lists without trees and no `receipts`. `createTaskProgress` moves them into `receipts` with
no tree, so they load, are counted and shown, and are of **unknown** freshness: none is fresh, none is offered for acceptance. A tree
written into such a list is not believed. The completion such a task was given is shown as it was saved. A Studio timeline of an older
version loads with its counts, `verified: false` and `freshness: 'unknown'`.

## What the UI shows

`/api/tasks/:id` adds `receiptFreshness` (`{tree, fresh, stale, unknown}`), `freshness` in `verificationOutcome` and `completionOutcome`, and
`freshness: 'fresh'` on each of `objectiveReceipts`. The conversation header's details show "Fresh receipts: fresh / all" with what the
rest are, or that the Hub does not know the tree; the acceptance panel says how many receipts are left out as stale or of unknown freshness.

## Not done here

- The done-gate that sends the model back when its receipts are not fresh is pod-23's. The final tree is checked after the run, so the
  model is not asked to do anything about a change it did not see.
- No snapshot is taken at accept time: a change made after the run ended is seen at the next run.
- The Browser Companion and the MCP host do not keep agent receipts; their calls are in the ledger only.
