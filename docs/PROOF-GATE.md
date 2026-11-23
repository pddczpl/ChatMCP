# Proof-of-Done: the done-gate (P4 pod-23)

The agent of DatGold cannot finish "done" while the checks its owner trusts fail on its final tree. When the model gives a final answer,
the Hub runs the criterion checks of `.chatmcp/acceptance.yml` ([PROOF-ACCEPTANCE.md](PROOF-ACCEPTANCE.md)) fresh, through the check runner
([PROOF-CHECKS.md](PROOF-CHECKS.md)). If one fails, the agent is sent back once with the results. If they fail again, the task ends with
`completionOutcome.requirements: 'failed'` and a notice at the top of what the Hub says about the answer.

Code: `DATGOLD-HUB/lib/proof/gate.mjs` (`DoneGate`), called by `AgentRunner` (`lib/agent.mjs`) at the start of a run (`begin`) and at every
final answer (`review`).

## When it runs, and when it does not

The gate runs when all of this holds: a `.chatmcp/acceptance.yml` with at least one check, its sha256 trusted by the owner
(`chatmcp verify trust`), the mode not Read Only, and a final answer with text.

| Situation | What happens |
|---|---|
| no acceptance file | no gate, no event (there is nothing the owner could trust) |
| a file the owner has not trusted, when the run starts | no gate; one `proof_gate` event (`gate: 'untrusted'`) says so |
| a file that does not read (or is over 64 KiB) | no gate; one event (`invalid`) with the line and the reason |
| only manual criteria | no gate; one event (`skipped`, `no_checks`) |
| Read Only, plan mode (its plan not approved), sandbox-only, a Hub whose shell is off | nothing runs; one event (`skipped`) with the reason. The mode is read when the answer comes |
| an agent that another agent started | no gate (below) |
| an answer that a message the person queued replaces, an empty answer, a run that fails, is stopped or reaches a limit | nothing was finished, so nothing is judged (`proofGate` is null) |

**Trust is asked at every answer.** A trust given while the run goes on counts at once: the conversation is held to the file from there on
(without a baseline the changes to the checks are unknown, so the result is `unproven` at best). A trust taken back while an armed run goes on runs nothing and ends `unproven`
(`trust_revoked`) with a notice: the gate of a run does not go away in silence.

**The checks run without asking for permission**, in every mode but Read Only, plan mode and sandbox-only. The owner approved these exact
commands by the sha256 of the file. See "What it grants" below.

## Which runners are gated

| Runner | Gated | Why |
|---|---|---|
| the main chat (`AgentRunner`), also when an editor starts its tasks over ACP | yes | |
| a second chat a person starts (`ConcurrentApiAgent`, its own worktree) | yes | it is handed the Hub's own trust list; its worktree holds the file only if the repository tracks it |
| an agent started by a model (`spawn_agent`, a workflow) or by the coding orchestrator | **no**, a `skipped` / `subagent` event when the file is trusted | it does one narrow part of the work, and a part can be right while the whole does not pass yet; twelve workers would run the whole suite two dozen times. The chat that started it is gated on its own tree |
| the Browser Companion (ChatGPT Web) | **no** | the model lives in the chatgpt.com tab, and the Hub has no loop of its own to send it back into, as for the Stop hooks ([HOOKS.md](HOOKS.md)) |
| the MCP host (an external client of the Hub's tools) | **no** | the client has no final answer the Hub sees |
| `chatmcp verify exec` (an external agent) | its own rule ([PROOF-CLI.md](PROOF-CLI.md)): the pack is built after the agent ends, nobody is sent back | |

An ungated runner ends as it did before: nothing in its outcome says the checks passed.

## What a task is held to

**The acceptance file of the start.** The bytes of the file when the conversation first met a trusted one are kept in the task's folder
(`acceptance.yml`) and their sha256 in `task.proofBaseline`. They are the only source of checks, in that run and in the later runs of the
conversation:

- the file edited, replaced, deleted or turned into a link: nothing runs, the gate **fails** (`acceptance_edited`). The model is told to
  restore it if it changed it, and to leave it if it did not; the owner is told how to trust a new version of their own;
- the owner trusts another version: the **next run** is held to it, when the trust is newer than the last run that was held to the saved one
  (`task.proofBaseline.heldAt`). The run that was going on still fails. A version the owner trusted **before** that is an edit like any other:
  `git checkout HEAD~1 -- .chatmcp/acceptance.yml` puts back the bytes of an older, perhaps weaker version that is still on the list. Trusting it
  again (`chatmcp verify trust`) renews its time and is the owner's way out;
- the kept copy and the workspace file are both other bytes: `unproven` (`acceptance_lost`), nothing runs.

**The baseline of the workspace.** With a trusted file the gate takes a baseline (`snapshotBaseline`, [PROOF-BASELINE.md](PROOF-BASELINE.md))
before the first model turn, once per conversation, and keeps its anchor in `task.proofBaseline`. The report on the changes to the checks
([PROOF-TAMPER.md](PROOF-TAMPER.md)) compares it with the workspace at the answer, so a test weakened in an earlier run of the conversation is
still seen. It costs what a baseline costs (a full snapshot, and for a Git workspace an import of the whole tree into a private store, on disk too) and is
given up after 120 s; after 3 s an event says what the run is waiting for. Where it is kept, and when it is not there:

- `<data folder of the Hub>/proof/gate/proof/baselines/<workspace key>/`, for second chats too. It is the gate's own folder, so its retention
  (5 per workspace, 14 days: each baseline of a Git workspace is a whole store of it) never removes a baseline of `chatmcp verify`. Deleting a
  conversation removes its baseline. It is not in a second chat's own data folder: that one is nested
  so deep that Git on Windows refuses the store's path (measured: a data folder over about 138 characters);
- removed by the retention (or by hand): a new one is taken and an event says so (`rebaselined`; below for what it is worth);
- edited, not readable, too slow, or a Read Only run (which takes none): the changes to the checks are **unknown**, and a pass is `unproven`
  (`check_changes_unknown`), never clean;
- a plain folder (no Git): the baseline has the hashes and no old bytes, so a changed test cannot be looked into and counts as modified
  (`not_analyzed`).

An acceptance file that `.gitignore` leaves out of the tree is compared by its own bytes.

**Line ends.** Git for Windows checks files out with CRLF by default (`core.autocrlf=true`), so the worktree of a second chat holds other bytes
than the file the owner trusted. The gate alone (the trust list and `chatmcp verify` go by exact bytes) tries the LF and the CRLF form of the
file: when one of them is trusted and reads as the same criteria, the run is held to **those trusted bytes**, and a workspace file that differs
from them in nothing but LF / CRLF counts as them: no edit, no flagged change. One more changed byte or a lone CR is a difference.

**A baseline that is taken again knows nothing of what changed before it**, and unknown is never "nothing changed". The gate remembers in
`task.proofBaseline` the tree whose checks were last judged unmodified (`cleanTree`: at first the tree the first run started on) and what was
judged modified (`modified`). When a baseline is not the one of the conversation's first run (the old one is gone, or the first run had none:
Read Only, a time-out, a trust that came later):

- an earlier judgment said the checks were modified: they **stay modified** (`carried: 'modified'`), with their notice, and the criteria stay
  `checks_modified`;
- the new baseline's tree is `cleanTree`: it is as good as the old one;
- anything else: the changes before it are **unknown** for the rest of the conversation (`carried: 'unknown'`), so a pass is `unproven`
  (`check_changes_unknown`); a change that is seen after it is flagged all the same.

While the baseline is in place each judgment is made from it again: a test that was put back is not modified any more.

## The judgment

| `proofGate.status` | When | `requirements` |
|---|---|---|
| `passed` | every criterion with checks is `evidenced` by the roll-up of the pack (the strict pass rule: the passing runs started and ended on the final tree) | what the plan says |
| `passed`, `checksModified: true` | the same, but the checks were modified during the task (criteria `checks_modified`) | `unverified` |
| `failed` | the last attempt of a check did not pass, a check could not start, or the acceptance file was edited | **`failed`** |
| `unproven` | nothing failed, and the final tree is not shown to pass | `unverified` |
| `stale` | passed, and the run then ended on another tree (a Stop hook, a process left running, the person's editor) | `unverified` |
| `skipped` | nothing ran (the table above) | what the plan says |

- **A failure is the check's own.** A failing run that also wrote files is `stale` for the roll-up (its tree is gone); the gate counts it as
  a failure.
- **A pass is the roll-up's.** The gate never says `passed` where a pack of the same ledger and tree would not say `evidenced` or
  `checks_modified`.
- **Failed before on the same tree** (`failed_before_on_this_tree`): the checks pass now and failed earlier on this very tree, in this
  conversation. A re-run must not hide a failure (a flaky check), and the fix may be outside the tree (`npm install` into an ignored
  folder). The gate cannot tell, so it is `unproven`: not a pass, not a failure, and the agent is not sent back.
- **Stale checks get one more pass.** When nothing failed, but a later check changed the tree an earlier one ran on (a build that writes
  files), all checks run once more. A check that changes the tree every time (`unreliable`) does not, and ends `unproven`.
- **Other `unproven` reasons:** `tree_unknown` (no final tree: an unbounded workspace, a failed snapshot), `not_evidenced` (the codes of the
  roll-up are in `open`), `check_changes_unknown`, `trust_revoked`, `acceptance_lost`, `state_inside_workspace` (the Hub's data folder is in
  the workspace, so every ledger line would change the tree: nothing runs), `proof_unavailable`, `gate_error` (a ledger that refuses a
  record, a begin that failed; `error` has the code). None of them is a pass, and each has a notice.
- **Manual criteria** stay the owner's. The gate does not wait for them.

## Rounds, and what bounds the cost

A **round** is a failing evaluation (`GATE_ROUNDS` = 2 per run): the first failure sends the agent back, the second ends the run as failed.
Plan test: "fails twice and ends 'failed'". The next run of the conversation has rounds of its own.

- The agent is sent back only when the loop can take another turn (`#canTakeAnotherStep`: a step limit, the deadline, a stop, the 48 MiB
  context). Otherwise the run ends `failed` at once (`stopped: 'no_turn_left'`) instead of losing the answer at the limit. The Hub has no
  other request budget today (`RequestMeter` only counts).
- **A judgment is reused** while the tree, the bytes of the acceptance file and its trust are the same: a pass always, a failure after the
  last round. A Stop hook that blocks eight times does not run the suite nine times. A first failure is run again, since what it depends on
  can be outside the tree.
- After the last round an answer on another tree (a hook sent the agent back) is judged, never sent back.
- One evaluation runs every check of the file at most twice (the extra pass), each with the attempts of the check runner (`repeat`, at most
  two re-runs for a changed tree), each bounded by its `timeout` (15 minutes at most). The time is the task's: its deadline and the person's
  Stop cut the running check (its processes are killed, the attempt is recorded as cancelled), and the run is not judged.
- A question ("what does this do?") in a project with a trusted file runs the checks too. The gate does not guess which answers are about
  work. Read Only runs none.

## The order at a final answer

1. A message the person queued, or the notice of a finished background agent: the run goes on. An empty answer fails the run.
2. **The done-gate.** Failed and sent back: the host message goes into the history (kind `proof_gate`) and the loop continues; the refused
   answer is not in the dialogue.
3. A message the person queued while the checks ran: the run goes on.
4. The Stop / SubagentStop hooks, then TaskCompleted ([HOOKS.md](HOOKS.md)). A hook judges an answer the gate has judged:
   `chatmcp_completion.requirements` is `failed` after a failed gate and `chatmcp_verification.ready` is false.
5. The task completes; `ProofService.end()` takes the run's final tree, and a pass on another tree becomes `stale`.

While checks run, the task's state is `verifying`. **The stall counters** (`noProgress`, the recovery attempts) start again when the agent is
sent back: what it reads again was asked for. The counters of the run before are not a limit on a gate round, and rounds are bounded by the
gate itself.

## The host message

`[Done-gate · round 1 of 2]`, then: that it is host data and not the user, up to five failing checks with the criterion, the command, the
result (`exit 1 (expected 0)`, `timed out`, `could not start (bad_cwd)` ...) and the end of stdout and stderr, the other failing checks by
name, the changes to the checks if there are any, and the request to fix the cause without weakening the checks.

- **Output is untrusted data.** It is masked whole (`maskSecrets` with the Hub's registered secrets, and again by the runner's own
  redaction), stripped of escape sequences and control characters, its format characters (a bidi override, a zero-width one) written as
  `<U+202E>`, cut to its last 1,500 characters, and every line starts with `| `, so it
  cannot start a line of the host's own. The whole message is at most 12,000 characters.
- Output goes into this message only. The task's events and `proofGate` hold none; the ledger keeps its hashes and its 2 KiB preview.
- **No tree id reaches the model**, as for every record of the ledger ([PROOF-SERVICE.md](PROOF-SERVICE.md)).

## Modified checks

`detectCheckChanges` flags fewer assertions, skip markers, deleted tests, a changed test script and the like. The flag is neutral: it also
meets legitimate changes. It shows

- on the host message of a failing round;
- in the event (`checksModified`) and its `modifications` (path and codes);
- in the outcome: `completionOutcome.checksModified: true`, `requirements: 'unverified'`, `verificationOutcome.ready: false`;
- in `proofGate.criteria` as `checks_modified`, the status a pack gives;
- in the notice of the answer.

A pass with modified checks does not send the agent back. Not flagged ([PROOF-TAMPER.md](PROOF-TAMPER.md)): an expected value changed in place
(`assert.equal(add(2, 3), -1)`). Such a test file is listed in `proofGate.testChanges` and in the event's detail, without a flag. List the
tests under `protected` in the acceptance file to have every change to them flagged.

## Receipts: the gate's checks are the evidence

A **clean pass** (every criterion evidenced, no modified checks) leaves one verify receipt per check in the agent's progress
(`observeChecks`, [PROOF-RECEIPTS.md](PROOF-RECEIPTS.md)): bound to the final tree the gate saw, named by the first 16 hex digits of the hash of
its `check` line in the task's ledger. So a plan that asks for a passing check has its evidence without a command of the model's own, the
phase `verify` gets its receipt, and the owner can accept an objective with it (the owner's option "the Hub accepts the checks it ran" may).
A failed, unproven or modified result leaves no receipt. Whatever the result, the final tree the gate saw is the progress's current tree:
what its checks changed makes older receipts stale, and an unknown tree makes them of unknown freshness.

## What is recorded

- The ledger of the task: one `check` record per attempt, as the check runner writes them. No new record type.
- Events of type `proof_gate` in the transcript and the task, each with `gate`: `baseline` (it takes a while), `armed`, `rebaselined`, `baseline_unavailable` (the start of a
  run), `untrusted`, `invalid`, `skipped`, `running`, `passed`, `failed` (`sentBack`), `unproven`; with `rounds`, `limit`, `checksModified`,
  `reason`, and the criteria and checks in the detail.
- `task.proofGate` (public task; the list of tasks has `status`, `reason` and `checksModified`): `{status, reason, rounds, limit, passes, reused,
  tree, acceptanceSha256, criteria, checks, failing, open, checksModified, modifications, testChanges, stopped?, edit?, error?}`. It is set
  when the run completes and null at the start of the next one.
- `task.proofBaseline`: `{id, sha256, acceptanceSha256, at, heldAt, cleanTree, modified, carried}`. The `armed` event names the version the
  run is held to (the first 12 digits of its sha256).
- `completionOutcome.gate` and `.checksModified`; the gate's line in `verificationOutcome.missing`; `finalParts.gateNotice`
  (`lib/final-text.mjs`), written as `[Done-gate notice]` right behind the model's words.

The owner's acceptance of an objective does not undo a failed gate: `requirements` stays `failed` until a run that passes. The task's status
is `completed` (the run ended with an answer), as for every other verdict about evidence.

## What it grants, and what it does not stop

- **The trusted commands run what the workspace holds.** `npm test` runs the test script and the tests as the agent left them, on the host,
  without a question. In Autonomous a known check already runs that way; in Review the agent's edits are asked about one by one, and the gate's
  run of them is not. An owner who does not want that runs the project in Read Only or sandbox-only, or does not trust the file. Trust a file
  whose commands you would run yourself on the agent's changes (RR-45 in [THREAT-MODEL.md](THREAT-MODEL.md)).
- **Nothing here is out of reach of the same user.** An agent with an approved shell can edit the ledger, the kept bytes, the baseline or the
  trust list in the Hub's data folder; the file tools refuse it. What such an edit leads to is `unproven` with a notice, or a run that begins
  ungated with an `untrusted` event, not a clean pass. Evidence is tamper-evident, it is not tamper-proof.
- **An older version that is still trusted.** A new conversation that starts with an older version of the file in its tree has nothing to
  compare it with: it is held to that version. Revoke the versions that do not count any more (`chatmcp verify trust --revoke`); the `armed` event
  says which one counted.
- A check proves what it checks. A passing gate does not say that the request was done.

## Limits

- Two chats on one checkout (a plain folder) can run their checks at the same time; the check runner does not coordinate two runners. A tree
  that changes under a run makes the result `unproven`, never a pass.
- The page shows the notice and the missing evidence. It has no view of the criteria yet (the Proof tab is pod-34), and the header's
  "unverified" row does not know `failed`.
- A task saved before pod-23 has no `proofGate`.

## Tests

`tests/verify-proof-gate.mjs` (the rules alone), `tests/verify-proof-gate-agent.mjs` (the real HubManager, AgentRunner, check runner, baseline
store and hooks, a scripted model), `tests/verify-proof-gate-places.mjs` (where it runs and what interrupts it) and `tests/verify-proof-gate-e2e.mjs` (a real Hub process, the real `chatmcp verify trust`, the strict mock
model; the four scenarios of the plan). Mutation lists: `tests/mutation/proof-gate.json`,
`proof-gate-agent.json` and `proof-gate-places.json`.
